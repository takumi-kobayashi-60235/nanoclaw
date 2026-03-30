/**
 * Step: signal-auth — Link NanoClaw as a Signal linked device via signal-cli.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import QRCode from 'qrcode';

import { logger } from '../src/logger.js';
import { openBrowser } from './platform.js';
import { emitStatus } from './status.js';

const QR_AUTH_TEMPLATE = `<!DOCTYPE html>
<html><head><title>NanoClaw - Signal Auth</title>
<meta http-equiv="refresh" content="3">
<style>
  body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); text-align: center; max-width: 420px; }
  h2 { margin: 0 0 8px; }
  .instructions { color: #666; font-size: 14px; margin-top: 16px; }
  .uri { word-break: break-all; font-size: 12px; margin-top: 12px; color: #666; }
  svg { width: 280px; height: 280px; }
</style></head><body>
<div class="card">
  <h2>Scan with Signal</h2>
  <div id="qr">{{QR_SVG}}</div>
  <div class="instructions">Signal アプリ → 設定 → リンク済みデバイス → 新しいデバイスをリンク</div>
  <div class="uri">{{DEVICE_URI}}</div>
</div></body></html>`;

function parseArgs(args: string[]): { method: string; deviceName: string } {
  let method = 'qr-browser';
  let deviceName = 'NanoClaw';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--method' && args[i + 1]) {
      method = args[i + 1];
      i++;
    }
    if (args[i] === '--device-name' && args[i + 1]) {
      deviceName = args[i + 1];
      i++;
    }
  }
  return { method, deviceName };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { method, deviceName } = parseArgs(args);

  if (!['qr-browser', 'qr-terminal'].includes(method)) {
    emitStatus('AUTH_SIGNAL', {
      AUTH_METHOD: method,
      AUTH_STATUS: 'failed',
      STATUS: 'failed',
      ERROR: 'unknown_method',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  await runSignalLink(projectRoot, method, deviceName);
}

async function runSignalLink(
  projectRoot: string,
  method: string,
  deviceName: string,
): Promise<void> {
  const logFile = path.join(projectRoot, 'logs', 'setup.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const child = spawn('signal-cli', ['link', '-n', deviceName], {
    cwd: projectRoot,
    stdio:
      method === 'qr-terminal'
        ? ['ignore', 'inherit', 'inherit']
        : ['ignore', 'pipe', 'pipe'],
  });

  let browserOpened = false;
  let stdoutBuffer = '';

  child.stdout?.on('data', async (chunk: Buffer | string) => {
    const text = String(chunk);
    logStream.write(text);
    stdoutBuffer += text;
    process.stdout.write(text);

    if (browserOpened) return;
    const match = stdoutBuffer.match(/sgnl:\/\/linkdevice\S+/);
    if (!match) return;
    browserOpened = true;
    try {
      const svg = await QRCode.toString(match[0], { type: 'svg' });
      const html = QR_AUTH_TEMPLATE.replace('{{QR_SVG}}', svg).replace(
        '{{DEVICE_URI}}',
        match[0],
      );
      const htmlPath = path.join(projectRoot, 'store', 'signal-auth.html');
      fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
      fs.writeFileSync(htmlPath, html);
      if (!openBrowser(htmlPath)) {
        logger.warn('Could not open browser for Signal QR, printed URI instead');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to render Signal QR in browser');
    }
  });

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = String(chunk);
    logStream.write(text);
    process.stderr.write(text);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  logStream.end();

  if (exitCode !== 0) {
    emitStatus('AUTH_SIGNAL', {
      AUTH_METHOD: method,
      AUTH_STATUS: 'failed',
      STATUS: 'failed',
      ERROR: `signal-cli link exited with code ${exitCode}`,
      LOG: 'logs/setup.log',
    });
    process.exit(exitCode);
  }

  emitStatus('AUTH_SIGNAL', {
    AUTH_METHOD: method,
    AUTH_STATUS: 'linked',
    DEVICE_NAME: deviceName,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });

  console.log('\n✓ Signal linked device authentication completed.');
}
