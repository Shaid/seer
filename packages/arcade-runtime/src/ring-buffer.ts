/**
 * Fixed-capacity ring buffer — the rewind history. Pushing past capacity
 * drops the oldest entry, so memory stays bounded however long a session
 * runs.
 */
export class RingBuffer<T> {
  readonly capacity: number;
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`arcade-runtime: ring buffer capacity must be a positive integer (got ${capacity})`);
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Appends `item`; returns the entry it evicted, if the buffer was full. */
  push(item: T): T | undefined {
    if (this.count < this.capacity) {
      this.items[(this.start + this.count) % this.capacity] = item;
      this.count++;
      return undefined;
    }
    const evicted = this.items[this.start];
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
    return evicted;
  }

  /** Removes and returns the newest entry — one rewind step. */
  pop(): T | undefined {
    if (this.count === 0) return undefined;
    this.count--;
    const i = (this.start + this.count) % this.capacity;
    const item = this.items[i];
    this.items[i] = undefined;
    return item;
  }

  /** The newest entry without removing it. */
  peek(): T | undefined {
    return this.count === 0 ? undefined : this.items[(this.start + this.count - 1) % this.capacity];
  }

  /** Entry `index` counted from the oldest (0); negative counts from the newest (-1). */
  at(index: number): T | undefined {
    const i = index < 0 ? this.count + index : index;
    if (i < 0 || i >= this.count) return undefined;
    return this.items[(this.start + i) % this.capacity];
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }
}
