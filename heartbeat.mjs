// Notices when this process was not running.
//
// Closing the lid suspends the process rather than killing it, so launchd sees
// nothing wrong and never restarts it. On wake the sweep timer simply resumes and
// the panel would say "swept just now", implying coverage that did not exist.
// Worse, the IMAP socket is stale after a suspend and can look connected until
// its own timeout, so the fast path is silently dead for minutes.
//
// A timer that measures how much wall clock passed against how much should have
// catches all of it: sleep, a suspended laptop, or the machine being so wedged
// that the event loop stalled.

export function createHeartbeat({
  intervalMs = 10000,
  toleranceMs = 30000,
  onGap,
  now = () => Date.now(),
}) {
  let last = now();
  let timer = null;

  // Exposed so a test can drive it without waiting on real timers.
  const beat = () => {
    const at = now();
    const gap = at - last;
    last = at;
    if (gap > toleranceMs) onGap?.(gap);
    return gap;
  };

  return {
    beat,

    start() {
      if (timer) return;
      last = now();
      timer = setInterval(beat, intervalMs);
      // Never hold the process open on account of a diagnostic.
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
