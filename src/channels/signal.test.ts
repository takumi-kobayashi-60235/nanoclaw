import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    SIGNAL_CLI_ACCOUNT: '+15551234567',
  })),
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  ASSISTANT_HAS_OWN_NUMBER: false,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

import { SignalChannel, SignalChannelOpts } from './signal.js';
import { updateChatName } from '../db.js';

function createTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+15557654321': {
        name: 'Signal Main',
        folder: 'signal_main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
      'signal-group:group-123': {
        name: 'Family',
        folder: 'signal_family',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function mockExecFileSuccess(stdout = '', stderr = ''): void {
  execFileMock.mockImplementationOnce(
    (
      _file: string,
      _args: string[],
      _options:
        | { maxBuffer?: number }
        | ((error: Error | null, stdout: string, stderr: string) => void),
      callback?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const cb = typeof _options === 'function' ? _options : callback;
      cb?.(null, stdout, stderr);
      return {} as never;
    },
  );
}

function setExecFileImplementation(
  handler: (args: string[]) => { stdout?: string; stderr?: string },
): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      args: string[],
      _options:
        | { maxBuffer?: number }
        | ((error: Error | null, stdout: string, stderr: string) => void),
      callback?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const cb = typeof _options === 'function' ? _options : callback;
      const result = handler(args);
      cb?.(null, result.stdout || '', result.stderr || '');
      return {} as never;
    },
  );
}

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends DM messages via signal-cli and notifies self-chat', async () => {
    mockExecFileSuccess('');
    const channel = new SignalChannel(createTestOpts());
    await channel.sendMessage('signal:+15551234567', 'hello');

    expect(execFileMock).toHaveBeenCalledWith(
      'signal-cli',
      [
        '-a',
        '+15551234567',
        'send',
        '--notify-self',
        '-m',
        'Andy: hello',
        '+15551234567',
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('delivers incoming DM messages for registered chats', async () => {
    let receiveCalls = 0;
    setExecFileImplementation((args) => {
      if (args.includes('--version')) {
        return { stdout: 'signal-cli 0.14.1\n' };
      }
      if (args.includes('listGroups')) {
        return { stdout: '[]\n' };
      }
      if (args.includes('receive')) {
        receiveCalls += 1;
        return {
          stdout:
            receiveCalls === 1
              ? `${JSON.stringify({
                  envelope: {
                    source: '+15557654321',
                    sourceNumber: '+15557654321',
                    sourceName: 'Alice',
                    timestamp: 1710000000000,
                    dataMessage: {
                      timestamp: 1710000000000,
                      message: 'hello from signal',
                    },
                  },
                  account: '+15551234567',
                })}\n`
              : '',
        };
      }
      return { stdout: '' };
    });

    const opts = createTestOpts();
    const channel = new SignalChannel(opts);
    await channel.connect();
    await vi.waitFor(() => {
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15557654321',
        expect.objectContaining({
          sender_name: 'Alice',
          content: 'hello from signal',
          is_from_me: false,
        }),
      );
    });
    await channel.disconnect();
  });

  it('delivers incoming group messages and updates names', async () => {
    let receiveCalls = 0;
    setExecFileImplementation((args) => {
      if (args.includes('--version')) {
        return { stdout: 'signal-cli 0.14.1\n' };
      }
      if (args.includes('listGroups')) {
        return { stdout: '[]\n' };
      }
      if (args.includes('receive')) {
        receiveCalls += 1;
        return {
          stdout:
            receiveCalls === 1
              ? `${JSON.stringify({
                  envelope: {
                    source: '+15557654321',
                    sourceNumber: '+15557654321',
                    sourceName: 'Alice',
                    timestamp: 1710000000000,
                    dataMessage: {
                      timestamp: 1710000000000,
                      message: '@Andy ping',
                      groupInfo: {
                        groupId: 'group-123',
                        title: 'Family',
                      },
                    },
                  },
                  account: '+15551234567',
                })}\n`
              : '',
        };
      }
      return { stdout: '' };
    });

    const opts = createTestOpts();
    const channel = new SignalChannel(opts);
    await channel.connect();
    await vi.waitFor(() => {
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal-group:group-123',
        expect.objectContaining({
          sender_name: 'Alice',
          content: '@Andy ping',
        }),
      );
    });
    expect(updateChatName).toHaveBeenCalledWith(
      'signal-group:group-123',
      'Family',
    );
    await channel.disconnect();
  });

  it('owns signal JIDs', () => {
    const channel = new SignalChannel(createTestOpts());
    expect(channel.ownsJid('signal:+15557654321')).toBe(true);
    expect(channel.ownsJid('signal-group:group-123')).toBe(true);
    expect(channel.ownsJid('slack:C123')).toBe(false);
  });

  it('syncs group metadata via listGroups', async () => {
    setExecFileImplementation((args) => {
      if (args.includes('listGroups')) {
        return {
          stdout: JSON.stringify([{ id: 'group-123', name: 'Family' }]) + '\n',
        };
      }
      return { stdout: '' };
    });

    const channel = new SignalChannel(createTestOpts());
    await channel.syncGroups(false);
    expect(updateChatName).toHaveBeenCalledWith(
      'signal-group:group-123',
      'Family',
    );
  });
});
