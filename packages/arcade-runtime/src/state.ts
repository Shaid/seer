/**
 * Snapshot, restore and hashing for plain-data sim state.
 *
 * "Plain data" means what survives `structuredClone` unchanged and has one
 * canonical byte form: primitives, plain objects, arrays and typed arrays
 * (tile RAM, palette RAM, work RAM). No functions, class instances, Maps,
 * Sets or Dates — a sim whose state stays inside this set gets save
 * states, rewind, replays and per-frame hashes for free.
 */

type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

function isTypedArray(v: unknown): v is TypedArray {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Throws, naming the offending path, if `state` holds anything outside plain
 * data. Cheap enough for a debug build or a test, not for every frame.
 */
export function assertPlainData(state: unknown, path = 'state'): void {
  const seen = new Set<object>();
  const walk = (v: unknown, p: string): void => {
    switch (typeof v) {
      case 'undefined':
      case 'boolean':
      case 'number':
      case 'string':
      case 'bigint':
        return;
      case 'object':
        break;
      default:
        throw new Error(`arcade-runtime: ${p} is a ${typeof v}, not plain data`);
    }
    if (v === null || isTypedArray(v)) return;
    if (seen.has(v)) throw new Error(`arcade-runtime: ${p} is a repeated or cyclic reference`);
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`));
    } else if (isPlainObject(v)) {
      for (const [k, item] of Object.entries(v)) walk(item, `${p}.${k}`);
    } else {
      throw new Error(`arcade-runtime: ${p} is a ${v.constructor?.name ?? 'non-plain object'}, not plain data`);
    }
  };
  walk(state, path);
}

/** A deep, independent copy (typed arrays included) — a save state. */
export function snapshotState<T>(state: T): T {
  return structuredClone(state);
}

/**
 * Copies `snapshot` back into `target` **in place**: typed arrays are
 * `set()` rather than replaced, so a renderer or board view holding a
 * reference to `state.tileRam` keeps seeing live data after a load. Keys
 * absent from the snapshot are deleted; where the shapes differ (a typed
 * array of another length, an object replaced by a number) the snapshot's
 * value is cloned in. Returns `target`.
 */
export function restoreState<T extends object>(target: T, snapshot: T): T {
  restoreInto(target as Record<string, unknown>, snapshot as Record<string, unknown>);
  return target;
}

function restoreValue(cur: unknown, snap: unknown): unknown {
  if (isTypedArray(snap)) {
    if (isTypedArray(cur) && cur.constructor === snap.constructor && cur.length === snap.length) {
      (cur as Uint8Array).set(snap as Uint8Array);
      return cur;
    }
    return snap.slice();
  }
  if (snap !== null && typeof snap === 'object') {
    if (cur !== null && typeof cur === 'object' && !isTypedArray(cur) && Array.isArray(cur) === Array.isArray(snap)) {
      restoreInto(cur as Record<string, unknown>, snap as Record<string, unknown>);
      return cur;
    }
    return structuredClone(snap);
  }
  return snap;
}

function restoreInto(target: Record<string, unknown>, snap: Record<string, unknown>): void {
  if (Array.isArray(target) && Array.isArray(snap)) {
    target.length = snap.length;
    for (let i = 0; i < snap.length; i++) target[i] = restoreValue(target[i], snap[i]);
    return;
  }
  for (const key of Object.keys(target)) if (!(key in snap)) delete target[key];
  for (const key of Object.keys(snap)) target[key] = restoreValue(target[key], snap[key]);
}

// FNV-1a, 32-bit.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Type tags keep e.g. `[1]` vs `{0: 1}` and Uint8Array vs Int8Array apart.
const TAG = {
  undefined: 1,
  null: 2,
  false: 3,
  true: 4,
  number: 5,
  string: 6,
  bigint: 7,
  array: 8,
  object: 9,
  typed: 10,
} as const;

const f64 = new Float64Array(1);
const f64Bytes = new Uint8Array(f64.buffer);

/**
 * A stable 32-bit FNV-1a hash of plain-data state, for per-frame regression
 * tests ("frame 1200 of this replay hashes to 0x3c1f…"). The walk is
 * canonical: object keys are sorted, numbers hash their float64 bytes (with
 * `-0` folded to `0` and every NaN to one NaN), and typed arrays hash their
 * element type, length and raw bytes — so equal data hashes equal regardless
 * of key insertion order or which object a typed array's buffer belongs to.
 * Byte order is the platform's (little-endian everywhere that matters).
 */
export function hashState(state: unknown): number {
  let h = FNV_OFFSET;
  const byte = (b: number): void => {
    h = Math.imul(h ^ b, FNV_PRIME);
  };
  const u32 = (n: number): void => {
    byte(n & 0xff);
    byte((n >>> 8) & 0xff);
    byte((n >>> 16) & 0xff);
    byte((n >>> 24) & 0xff);
  };
  const str = (s: string): void => {
    u32(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      byte(c & 0xff);
      byte(c >>> 8);
    }
  };
  const walk = (v: unknown): void => {
    if (v === undefined) return byte(TAG.undefined);
    if (v === null) return byte(TAG.null);
    switch (typeof v) {
      case 'boolean':
        return byte(v ? TAG.true : TAG.false);
      case 'number':
        byte(TAG.number);
        f64[0] = v === 0 ? 0 : Number.isNaN(v) ? NaN : v;
        for (let i = 0; i < 8; i++) byte(f64Bytes[i]!);
        return;
      case 'string':
        byte(TAG.string);
        return str(v);
      case 'bigint':
        byte(TAG.bigint);
        return str(v.toString(16));
      case 'object':
        break;
      default:
        throw new Error(`arcade-runtime: cannot hash a ${typeof v}`);
    }
    if (isTypedArray(v)) {
      byte(TAG.typed);
      str(v.constructor.name);
      u32(v.length);
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, FNV_PRIME);
      return;
    }
    if (Array.isArray(v)) {
      byte(TAG.array);
      u32(v.length);
      for (const item of v) walk(item);
      return;
    }
    byte(TAG.object);
    const keys = Object.keys(v).sort();
    u32(keys.length);
    for (const key of keys) {
      str(key);
      walk((v as Record<string, unknown>)[key]);
    }
  };
  walk(state);
  return h >>> 0;
}

/** `hashState` as 8 lowercase hex digits, for logs and golden files. */
export function hashStateHex(state: unknown): string {
  return hashState(state).toString(16).padStart(8, '0');
}
