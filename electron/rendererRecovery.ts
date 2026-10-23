/**
 * When the renderer dies (crash, OOM kill, GPU reset...), the main process and tray icon keep
 * running, so a "keep boards online" computer would look fine while nothing syncs. The window is
 * therefore reloaded with a growing delay — never in a tight loop, and never given up on.
 */

/** Wait before each reload attempt; the last value repeats forever. */
export const RECOVERY_DELAYS_MS: readonly number[] = [5_000, 30_000, 2 * 60_000, 10 * 60_000]

/** A renderer that ran this long after a reload counts as recovered (the schedule restarts). */
export const STABLE_AFTER_MS = 10 * 60_000

/** After this many failed attempts in a row, people are told (tray tooltip / notification). */
export const REPORT_AFTER_FAILURES = 3

/**
 * Whether a renderer that went away should be brought back, whatever the reason: 'killed'
 * (SIGKILL, e.g. the Linux OOM killer), 'oom', 'crashed', 'memory-eviction', 'launch-failed' and
 * even an unexpected 'clean-exit' all leave the window without a page. Only shutdown is final.
 */
export function shouldRecoverRenderer(opts: { quitting: boolean; destroyed: boolean }): boolean {
  return !opts.quitting && !opts.destroyed
}

export class RecoverySchedule {
  private failures = 0
  private reloadedAt: number | null = null

  /** Records a renderer loss at `now`; returns how long to wait before reloading. */
  crashed(now: number): number {
    if (this.reloadedAt !== null && now - this.reloadedAt >= STABLE_AFTER_MS) this.failures = 0
    const delay = RECOVERY_DELAYS_MS[Math.min(this.failures, RECOVERY_DELAYS_MS.length - 1)]
    this.failures++
    return delay
  }

  /** Records that a reload was started at `now`. */
  reloaded(now: number): void {
    this.reloadedAt = now
  }

  /** Consecutive losses without a stable run in between. */
  get consecutiveFailures(): number {
    return this.failures
  }
}
