/**
 * Turns sim-frame-stamped commands into sample positions inside the
 * worklet. The sim and the audio clock both run in real time but are not
 * locked together, so the first command anchors frame `F` to "now + lead",
 * and later commands keep their spacing relative to that anchor — two sound
 * commands three steps apart play three steps' worth of samples apart. When
 * the two clocks drift too far (the sim paused, fast-forwarded or hitched)
 * the scheduler re-anchors instead of playing a burst or a long silence.
 */

export interface CommandSchedulerOptions {
  sampleRate: number;
  hz: number;
  /** Default `2`. */
  leadFrames?: number;
  /** Re-anchor when a command lands further ahead than this many steps; default `leadFrames + 6`. */
  maxLeadFrames?: number;
}

interface Scheduled<C> {
  due: number;
  data: C;
}

export class CommandScheduler<C = unknown> {
  readonly samplesPerFrame: number;
  private readonly leadSamples: number;
  private readonly maxLeadSamples: number;
  private queue: Scheduled<C>[] = [];
  private head = 0;
  private anchor: { frame: number; sample: number } | null = null;

  constructor(opts: CommandSchedulerOptions) {
    if (!(opts.hz > 0) || !(opts.sampleRate > 0)) throw new Error('arcade-runtime: scheduler needs positive hz and sampleRate');
    const lead = opts.leadFrames ?? 2;
    this.samplesPerFrame = opts.sampleRate / opts.hz;
    this.leadSamples = lead * this.samplesPerFrame;
    this.maxLeadSamples = (opts.maxLeadFrames ?? lead + 6) * this.samplesPerFrame;
  }

  get pending(): number {
    return this.queue.length - this.head;
  }

  /** Queues `data` for sim step `frame`; `now` is the current sample position. */
  enqueue(frame: number, data: C, now: number): void {
    let due = this.dueFor(frame);
    if (due === null || due < now || due > now + this.maxLeadSamples) {
      this.anchor = { frame, sample: now + this.leadSamples };
      due = this.anchor.sample;
    }
    // Never schedule before an already-queued command: order is the sim's order.
    const last = this.queue.length > this.head ? this.queue[this.queue.length - 1]!.due : -Infinity;
    this.queue.push({ due: Math.round(Math.max(due, last)), data });
  }

  /** Sample position of the next command, or `Infinity` when none is queued. */
  nextDue(): number {
    return this.head < this.queue.length ? this.queue[this.head]!.due : Infinity;
  }

  /** Removes and returns the next command. */
  shift(): C | undefined {
    if (this.head >= this.queue.length) return undefined;
    const item = this.queue[this.head++]!;
    // Compact occasionally rather than shifting the array on every command.
    if (this.head > 64 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return item.data;
  }

  /** Drops queued commands and the anchor. */
  clear(): void {
    this.queue = [];
    this.head = 0;
    this.anchor = null;
  }

  private dueFor(frame: number): number | null {
    return this.anchor ? this.anchor.sample + (frame - this.anchor.frame) * this.samplesPerFrame : null;
  }
}
