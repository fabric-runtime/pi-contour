import { observer } from "../verified/observer.js";

/** Quiet latest-generation scheduler. Polls do not preempt work; edit bursts debounce.
 * Only explicit checkpoints expose results. Timers cannot keep Pi alive after shutdown.
 */
export class SilentObserver {
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private generation = 0;
  private stopped = true;
  private pending = false;
  private preempt = false;
  private task?: Promise<void>;
  constructor(private scan: (signal: AbortSignal) => Promise<unknown>, private debounceMs = 400, private pollMs = 5000) {}
  start(immediate = true): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.poll = setInterval(() => { if (!this.controller && !this.timer) this.wake(); }, this.pollMs);
    this.poll.unref(); if (immediate) this.wake();
  }
  wake(preempt = true): void {
    if (this.stopped) return;
    this.generation++; this.preempt ||= preempt;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.begin(); }, this.debounceMs);
    this.timer.unref();
  }
  private decision(generation = this.generation) {
    return observer({ stopped: this.stopped, busy: !!this.controller, pending: this.pending, preempt: this.preempt, generationSame: generation === this.generation });
  }
  private begin(): void {
    const decision = this.decision();
    if (decision.queue) { this.pending = true; if (decision.abort) this.controller!.abort(); this.preempt = false; return; }
    if (!decision.launch) return;
    this.preempt = false;
    const generation = this.generation;
    const controller = this.controller = new AbortController();
    this.task = this.scan(controller.signal).then(() => {}, () => {}).finally(() => {
      this.controller = undefined;
      if (this.decision(generation).rescan) { this.pending = false; this.wake(); }
    });
  }
  async stop(): Promise<void> {
    this.stopped = true; this.generation++; this.pending = false; this.preempt = false;
    clearTimeout(this.timer); clearInterval(this.poll); this.timer = undefined; this.poll = undefined;
    this.controller?.abort(); await this.task;
  }
}
