// macOS notifications, so the server can reach you with the page closed.

import { spawn } from 'node:child_process';

const quote = (value) => `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function notify(title, message, { sound = 'Ping' } = {}) {
  if (process.platform !== 'darwin') return;

  const script = `display notification ${quote(message)} with title ${quote(title)} sound name ${quote(sound)}`;
  const proc = spawn('osascript', ['-e', script], { stdio: 'ignore' });
  // A missed notification must never take the server down with it.
  proc.on('error', () => {});
}
