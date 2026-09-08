import type { FastifyBaseLogger } from "fastify";

/**
 * The one shape behind every background poll loop the Sync Backend runs
 * (#188): snooze wake, notifier delivery, compose pending-send, protocol
 * write, draft push, search indexing and grant refresh were seven
 * hand-rolled copies of the same `setTimeout`/try-catch/stop dance before
 * this file existed. Calendar reminders (ADR-0028) is this helper's first
 * *new* caller rather than an eighth copy.
 *
 * The shape: a tick runs to completion before the next is scheduled (so
 * overlapping ticks are never a thing this loop has to reason about), errors
 * are caught and logged against the loop's own `label` rather than crashing
 * the process, the between-tick timer is `unref`'d so an idle loop never by
 * itself keeps the process alive, and `stop()` cancels the pending wait and
 * awaits whatever tick is already in flight before resolving.
 *
 * Two knobs cover every existing loop's own variation on that shape:
 * - `deferFirstTick` — most loops want their very first tick to run
 *   immediately (a container restart resumes whatever came due while it was
 *   down); `protocol-write-loop.ts`/`draft-push-loop.ts` instead wait out one
 *   interval before their first drain, and set this to skip the immediate one.
 * - `nextDelayMs` — `search-index-loop.ts`'s rebuild sweep picks a short
 *   pause while there's still stale rows, or a long idle poll once caught up,
 *   instead of one fixed interval; every other loop passes a plain
 *   `intervalMs` and leaves this unset.
 */

export interface PollLoopTickContext {
  /** True once `stop()` has been called — checked mid-tick by loops that walk a list of accounts, so a stop request cuts a long tick short instead of finishing every remaining item. */
  isStopped(): boolean;
}

export interface PollLoopOptions<T> {
  /** What the loop's own errors are logged against, e.g. "snooze wake loop". */
  label: string;
  /** One unit of work. A thrown error is caught, logged against `label`, and treated as this tick's result being absent — it never stops the loop. */
  tick: (ctx: PollLoopTickContext) => Promise<T>;
  /** Fixed delay between ticks. Ignored once a tick has run if `nextDelayMs` is given. */
  intervalMs: number;
  /** Computes the delay before the next tick from this tick's result — `undefined` if the tick threw. Defaults to always returning `intervalMs`. */
  nextDelayMs?: (result: T | undefined) => number;
  /** Skips the immediate first tick, so the loop instead waits out one `intervalMs` before ever ticking. Default: the first tick is immediate. */
  deferFirstTick?: boolean;
  logger?: FastifyBaseLogger;
}

export interface PollLoopHandle {
  /** Stops the loop: cancels the pending timer and awaits any tick already in flight. Idempotent. */
  stop(): Promise<void>;
}

export function startPollLoop<T = void>(options: PollLoopOptions<T>): PollLoopHandle {
  const { label, tick, intervalMs, nextDelayMs, deferFirstTick = false, logger } = options;

  let stopped = false;
  let cancelSleep: (() => void) | undefined;

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      cancelSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async function runTick(): Promise<T | undefined> {
    try {
      return await tick({ isStopped: () => stopped });
    } catch (err) {
      logger?.error({ err }, `${label}: tick failed`);
      return undefined;
    }
  }

  const loop = (async () => {
    let delay = intervalMs;
    let isFirstTick = true;
    while (!stopped) {
      if (!(isFirstTick && !deferFirstTick)) {
        await sleep(delay);
        if (stopped) break;
      }
      isFirstTick = false;
      const result = await runTick();
      delay = nextDelayMs ? nextDelayMs(result) : intervalMs;
    }
  })();

  return {
    async stop() {
      stopped = true;
      cancelSleep?.();
      await loop;
    },
  };
}
