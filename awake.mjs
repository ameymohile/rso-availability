// Holds macOS awake while the claimer is armed.
//
// An armed bot on a sleeping laptop is not a bot. Measured on this machine
// before this existed: 434 minutes asleep out of a 421 minute window, 28 wake
// blips, roughly zero board looks in seven hours. The panel said ARMED the whole
// time, which was true and useless.
//
// `caffeinate -i` prevents idle system sleep and works on battery; `-s` covers
// AC as well. Held only while armed, because a tool that quietly stops a laptop
// sleeping forever is worse than one that misses a shift.
//
// What this cannot do: closing the lid. Lid-close sleep ignores power assertions
// entirely. That needs clamshell mode (power plus an external display) or
// `sudo pmset -c disablesleep 1`, and neither is something a background server
// should be doing on its own.

import { spawn } from 'node:child_process';

export function createAwake({ reason = 'RSO claimer armed', onEvent, spawnFn = spawn } = {}) {
  let child = null;

  return {
    get held() {
      return Boolean(child);
    },

    hold() {
      if (child || process.platform !== 'darwin') return;

      try {
        child = spawnFn('caffeinate', ['-i', '-s'], { stdio: 'ignore' });

        // If it dies on its own the assertion is gone, so stop claiming to hold
        // one. Nothing tries to respawn: a caffeinate that will not stay up is a
        // reason to tell the truth, not to retry in a loop.
        child.on('exit', () => {
          const wasHeld = Boolean(child);
          child = null;
          if (wasHeld) onEvent?.({ kind: 'awake-lost', why: `${reason}: caffeinate exited` });
        });

        onEvent?.({ kind: 'awake-held', why: reason });
      } catch (err) {
        child = null;
        onEvent?.({ kind: 'awake-failed', why: err.message });
      }
    },

    release() {
      if (!child) return;
      const held = child;
      child = null;
      held.kill();
      onEvent?.({ kind: 'awake-released' });
    },
  };
}
