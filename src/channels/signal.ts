import { execFile } from 'child_process';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const RECONNECT_DELAY_MS = 5000;

interface SignalGroup {
  id: string;
  name?: string;
}

interface SignalMessageGroupInfo {
  groupId?: string;
  title?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: SignalMessageGroupInfo;
}

interface SignalSentMessage extends SignalDataMessage {
  destination?: string;
  destinationNumber?: string;
}

interface SignalSyncMessage {
  sentMessage?: SignalSentMessage;
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  syncMessage?: SignalSyncMessage;
}

interface SignalReceiveNotification {
  envelope?: SignalEnvelope;
  account?: string;
}

interface NormalizedSignalMessage {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isGroup: boolean;
  isFromMe: boolean;
  chatName?: string;
}

interface SignalCliConfig {
  account: string;
  cliPath: string;
  receiveTimeoutSeconds: number;
  receiveMaxMessages: number;
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadSignalCliConfig(): SignalCliConfig {
  const env = readEnvFile([
    'SIGNAL_CLI_ACCOUNT',
    'SIGNAL_CLI_PATH',
    'SIGNAL_CLI_RECEIVE_TIMEOUT_SECONDS',
    'SIGNAL_CLI_RECEIVE_MAX_MESSAGES',
  ]);

  const account = process.env.SIGNAL_CLI_ACCOUNT || env.SIGNAL_CLI_ACCOUNT;
  if (!account) {
    throw new Error('SIGNAL_CLI_ACCOUNT is required for the Signal channel');
  }

  return {
    account,
    cliPath: process.env.SIGNAL_CLI_PATH || env.SIGNAL_CLI_PATH || 'signal-cli',
    receiveTimeoutSeconds: parsePositiveInt(
      process.env.SIGNAL_CLI_RECEIVE_TIMEOUT_SECONDS ||
        env.SIGNAL_CLI_RECEIVE_TIMEOUT_SECONDS,
      1,
    ),
    receiveMaxMessages: parsePositiveInt(
      process.env.SIGNAL_CLI_RECEIVE_MAX_MESSAGES ||
        env.SIGNAL_CLI_RECEIVE_MAX_MESSAGES,
      10,
    ),
  };
}

async function execSignalCli(
  config: SignalCliConfig,
  args: string[],
): Promise<string> {
  const { stdout, stderr } = await new Promise<{
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    execFile(
      config.cliPath,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, childStdout, childStderr) => {
        if (error) {
          const detail = [childStderr, childStdout, error.message].find(
            Boolean,
          );
          reject(new Error(`signal-cli ${args.join(' ')} failed: ${detail}`));
          return;
        }
        resolve({
          stdout: childStdout,
          stderr: childStderr,
        });
      },
    );
  });

  if (stderr?.trim()) {
    logger.debug({ stderr, args }, 'signal-cli emitted stderr');
  }

  return stdout;
}

function parseSignalJsonLines<T>(raw: string): T[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') || line.startsWith('['))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as T | T[];
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (err) {
        logger.warn({ err, line }, 'Failed to parse signal-cli JSON line');
        return [];
      }
    });
}

export class SignalChannel implements Channel {
  name = 'signal';

  private readonly opts: SignalChannelOpts;
  private readonly config: SignalCliConfig;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connected = false;
  private cliQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
    this.config = loadSignalCliConfig();
  }

  async connect(): Promise<void> {
    this.stopped = false;
    await this.execQueued(['--version']);
    this.connected = true;
    void this.syncGroups(false);
    void this.startPollLoop();
    logger.info(
      { account: this.config.account, cliPath: this.config.cliPath },
      'Connected to Signal',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const formatted = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (jid.startsWith('signal-group:')) {
      await this.execQueued([
        '-a',
        this.config.account,
        'send',
        '-g',
        jid.replace(/^signal-group:/, ''),
        '-m',
        formatted,
      ]);
    } else if (jid.startsWith('signal:')) {
      const recipient = jid.replace(/^signal:/, '');
      const args = ['-a', this.config.account, 'send'];
      if (recipient === this.config.account) {
        args.push('--notify-self');
      }
      args.push('-m', formatted, recipient);
      await this.execQueued(args);
    } else {
      throw new Error(`Unsupported Signal JID: ${jid}`);
    }
    logger.info({ jid, length: formatted.length }, 'Signal message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:') || jid.startsWith('signal-group:');
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: signal-cli has no typing API
  }

  async syncGroups(_force: boolean): Promise<void> {
    try {
      const output = await this.execQueued([
        '-a',
        this.config.account,
        '-o',
        'json',
        'listGroups',
      ]);
      const groups = parseSignalJsonLines<SignalGroup>(output);
      for (const group of groups) {
        if (!group.id || !group.name) continue;
        updateChatName(`signal-group:${group.id}`, group.name);
      }
      logger.info({ count: groups.length }, 'Signal group metadata synced');
    } catch (err) {
      logger.warn({ err }, 'Failed to sync Signal group metadata');
    }
  }

  private async startPollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const output = await this.execQueued([
          '-a',
          this.config.account,
          '-o',
          'json',
          'receive',
          '--timeout',
          String(this.config.receiveTimeoutSeconds),
          '--max-messages',
          String(this.config.receiveMaxMessages),
        ]);
        this.connected = true;
        this.handleReceiveOutput(output);
        if (!output.trim()) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } catch (err) {
        if (this.stopped) return;
        this.connected = false;
        logger.warn({ err }, 'Signal receive poll failed');
        await this.waitForReconnect();
      }
    }
  }

  private handleReceiveOutput(output: string): void {
    const events = parseSignalJsonLines<SignalReceiveNotification>(output);
    for (const event of events) {
      if (!event.envelope) continue;
      this.handleEnvelope(event.envelope);
    }
  }

  private async execQueued(args: string[]): Promise<string> {
    const run = this.cliQueue.then(() => execSignalCli(this.config, args));
    this.cliQueue = run.catch(() => undefined);
    return run;
  }

  private handleEnvelope(envelope: SignalEnvelope): void {
    const message = this.normalizeEnvelope(envelope);
    if (!message) return;

    this.opts.onChatMetadata(
      message.chatJid,
      message.timestamp,
      message.chatName,
      'signal',
      message.isGroup,
    );

    if (message.isGroup && message.chatName) {
      updateChatName(message.chatJid, message.chatName);
    }

    const groups = this.opts.registeredGroups();
    if (!groups[message.chatJid]) return;

    this.opts.onMessage(message.chatJid, {
      id: message.id,
      chat_jid: message.chatJid,
      sender: message.sender,
      sender_name: message.senderName,
      content: message.content,
      timestamp: message.timestamp,
      is_from_me: message.isFromMe,
      is_bot_message: ASSISTANT_HAS_OWN_NUMBER
        ? message.isFromMe
        : message.content.startsWith(`${ASSISTANT_NAME}:`),
    });
  }

  private normalizeEnvelope(
    envelope: SignalEnvelope,
  ): NormalizedSignalMessage | null {
    const sentMessage = envelope.syncMessage?.sentMessage;
    const dataMessage = envelope.dataMessage;
    const content = sentMessage?.message || dataMessage?.message;
    if (!content) return null;

    const groupInfo = sentMessage?.groupInfo || dataMessage?.groupInfo;
    const isGroup = !!groupInfo?.groupId;
    const chatJid = isGroup
      ? `signal-group:${groupInfo?.groupId}`
      : `signal:${sentMessage?.destinationNumber || sentMessage?.destination || envelope.sourceNumber || envelope.source || ''}`;
    if (!chatJid || chatJid.endsWith(':')) return null;

    const rawTimestamp =
      sentMessage?.timestamp ||
      dataMessage?.timestamp ||
      envelope.timestamp ||
      Date.now();
    const timestamp = new Date(rawTimestamp).toISOString();
    const isFromMe = !!sentMessage;
    const sender = isFromMe
      ? this.config.account || 'self'
      : envelope.sourceNumber || envelope.source || 'unknown';
    const senderName = isFromMe
      ? 'You'
      : envelope.sourceName ||
        envelope.sourceNumber ||
        envelope.source ||
        'unknown';

    return {
      id: `${chatJid}:${rawTimestamp}`,
      chatJid,
      sender,
      senderName,
      content,
      timestamp,
      isGroup,
      isFromMe,
      chatName: groupInfo?.title,
    };
  }

  private async waitForReconnect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        resolve();
      }, RECONNECT_DELAY_MS);
    });
  }
}

registerChannel('signal', (opts: ChannelOpts) => new SignalChannel(opts));
