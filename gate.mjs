// One queue in front of every swapboard read.
//
// The server declares 1.5s as the minimum spacing between swap requests, and for
// a long time nothing enforced it across callers: the UI poll and the armed
// sweep drifted into each other and landed reads a second apart. Adding a push
// trigger makes that worse, because mail can arrive at any instant, including
// just after a scheduled sweep. Spacing cannot be left to whoever happens to be
// calling, so it lives here instead.

export function createGate({ spacingMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  let lastAt = 0;
  let queue = Promise.resolve();
  let waiting = 0;

  return {
    get depth() {
      return waiting;
    },

    // Serialised, not just rate limited. Two reads in flight at once would each
    // start their own throttled sequence inside the client and blow the spacing
    // from the other side.
    run(fn) {
      waiting += 1;

      const result = queue.then(async () => {
        const wait = lastAt + spacingMs - now();
        if (wait > 0) await sleep(wait);
        lastAt = now();
        return fn();
      });

      // The queue has to keep moving through a failed read, so it advances on a
      // swallowed copy while the caller still sees the real rejection.
      queue = result.then(() => {}, () => {});
      result.then(() => { waiting -= 1; }, () => { waiting -= 1; });

      return result;
    },
  };
}
