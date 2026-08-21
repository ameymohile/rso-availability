// Push instead of polling.
//
// A shift that lives for a second cannot be caught by a poll: at the server's
// own declared floor of 1.5s you are blind for 800ms on average, so you see
// roughly lifetime/interval of what gets posted. IMAP IDLE inverts that. The
// mail server pushes the moment it accepts a TeamWork notification, which is
// sub-second, costs no swapboard requests at all, and therefore cannot trip the
// rate limit that punishes fast polling.
//
// It is also the diagnostic. Every TeamWork mail that arrives is recorded with
// its subject, so if no notification fires when a shift is posted, the log says
// so plainly instead of leaving us to guess. Configure `mail.triggerSubject`
// once the real subject line is known.

import { ImapFlow } from 'imapflow';

// Reconnects back off, because a mail server refusing us in a loop is its own
// kind of abuse. Caps out so a long outage still recovers on its own.
const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

const matches = (value, pattern) => {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(value ?? '');
  } catch {
    // A bad regex in config must not silently match everything.
    return String(value ?? '').toLowerCase().includes(String(pattern).toLowerCase());
  }
};

export function createMailWatch({ config = {}, password, onTrigger, onEvent }) {
  const {
    host,
    port = 993,
    user,
    mailbox = 'INBOX',
    from = 'tmwork',
    triggerSubject = '',
  } = config;

  let client = null;
  let running = false;
  let failures = 0;
  let status = { state: 'off', since: null, lastMail: null, lastTrigger: null, seen: 0, triggers: 0 };

  const setStatus = (patch) => {
    status = { ...status, ...patch };
    onEvent?.({ kind: 'mail-status', ...status });
  };

  // Only the envelope, never the body. The subject is all this needs and a
  // mailbox is not something to read more of than the job requires.
  async function inspect(seq) {
    const message = await client.fetchOne(seq, { envelope: true });
    if (!message?.envelope) return;

    const subject = message.envelope.subject ?? '';
    const sender = (message.envelope.from ?? []).map((a) => a.address).join(', ');

    status.seen += 1;
    setStatus({ lastMail: { at: new Date().toISOString(), subject, from: sender } });

    if (!matches(sender, from) && !matches(subject, from)) return;

    onEvent?.({ kind: 'mail', subject, from: sender });

    // Anything from TeamWork is logged; only a subject that looks like a posting
    // wakes the claimer. Left empty, every TeamWork mail triggers, which is the
    // right default until the real subject line has been seen once.
    if (!matches(subject, triggerSubject)) return;

    status.triggers += 1;
    setStatus({ lastTrigger: { at: new Date().toISOString(), subject } });
    onTrigger?.(`mail: ${subject.slice(0, 80)}`);
  }

  async function connect() {
    client = new ImapFlow({
      host, port, secure: true,
      auth: { user, pass: password },
      logger: false,
      // If the server stops answering, fail fast and reconnect rather than
      // sitting on a dead socket believing we are still being pushed to.
      socketTimeout: 5 * 60 * 1000,
    });

    client.on('error', (err) => onEvent?.({ kind: 'mail-error', why: err.message }));

    await client.connect();
    await client.mailboxOpen(mailbox);

    failures = 0;
    setStatus({ state: 'watching', since: new Date().toISOString() });

    // `exists` fires on IDLE when the mailbox grows. imapflow keeps IDLE going
    // by itself, so this is the whole push path.
    client.on('exists', (update) => {
      const count = update?.count;
      if (!count) return;
      inspect(count).catch((err) => onEvent?.({ kind: 'mail-error', why: err.message }));
    });

    // Resolves only when the connection drops, which is what drives the retry.
    await new Promise((resolve) => {
      client.on('close', resolve);
      client.on('end', resolve);
    });
  }

  async function loop() {
    while (running) {
      try {
        await connect();
        if (running) onEvent?.({ kind: 'mail-error', why: 'connection closed, reconnecting' });
      } catch (err) {
        onEvent?.({ kind: 'mail-error', why: err.message });
      }

      if (!running) break;

      setStatus({ state: 'reconnecting' });
      const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures += 1;
      await new Promise((r) => setTimeout(r, wait));
    }

    setStatus({ state: 'off', since: null });
  }

  return {
    get status() {
      return { ...status, configured: Boolean(host && user && password) };
    },

    start() {
      if (running) return;
      if (!host || !user || !password) {
        setStatus({ state: 'unconfigured' });
        return;
      }
      running = true;
      loop();
    },

    async stop() {
      running = false;
      try {
        await client?.logout();
      } catch { /* closing a broken connection is not a failure */ }
      client = null;
    },
  };
}
