/**
 * DIP-switch settings as a typed, serialisable record.
 *
 * A schema lists each setting's choices once; from it come the defaults, a
 * forgiving parser for stored settings (unknown keys dropped, invalid values
 * reset to the default), and — when the schema carries bank/mask/bits — the
 * raw DSW bytes, so a port can read DIP ports the way the original code did.
 */

export type DipValue = string | number | boolean;

export interface DipOption<V extends DipValue = DipValue> {
  value: V;
  label: string;
  /** Raw switch bits for this choice, within the field's `mask`. */
  bits?: number;
}

export interface DipField<V extends DipValue = DipValue> {
  label: string;
  options: readonly DipOption<V>[];
  default: V;
  /** Switch bank index (DSW A = 0, DSW B = 1, …). Needed for `toBanks`/`fromBanks`. */
  bank?: number;
  /** Bits of the bank this field occupies. */
  mask?: number;
}

export type DipSchema = Record<string, DipField>;

/** The settings record a schema describes: one chosen value per field. */
export type DipSettings<S extends DipSchema> = { [K in keyof S]: S[K]['options'][number]['value'] };

export interface DipSwitches<S extends DipSchema> {
  readonly schema: S;
  defaults(): DipSettings<S>;
  /** Validates stored settings (e.g. `JSON.parse` output), filling gaps with defaults. */
  parse(input: unknown): DipSettings<S>;
  /** The option record for a field's current value. */
  option<K extends keyof S>(settings: DipSettings<S>, key: K): S[K]['options'][number];
  /**
   * Packs settings into raw bank bytes, starting from `initial` (default
   * all-ones, as unset active-low switches read). Fields without
   * `bank`/`mask` or an option without `bits` are skipped.
   */
  toBanks(settings: DipSettings<S>, banks?: number, initial?: number): number[];
  /** The inverse of `toBanks`: decodes raw bank bytes, defaulting fields that match no option. */
  fromBanks(banks: readonly number[]): DipSettings<S>;
}

/**
 * Declares a DIP schema. Declare options `as const` (or with literal values)
 * so `DipSettings` narrows to the exact choices:
 *
 * ```ts
 * const dips = defineDipSwitches({
 *   lives: { label: 'Lives', default: 3, bank: 1, mask: 0x03,
 *            options: [{ value: 2, label: '2', bits: 0x02 }, { value: 3, label: '3', bits: 0x03 }] },
 * } as const);
 * ```
 */
export function defineDipSwitches<const S extends DipSchema>(schema: S): DipSwitches<S> {
  for (const [key, field] of Object.entries(schema)) {
    if (!field.options.some((o) => o.value === field.default)) {
      throw new Error(`arcade-runtime: DIP field "${key}" default ${String(field.default)} is not one of its options`);
    }
  }
  const keys = Object.keys(schema) as (keyof S & string)[];

  const defaults = (): DipSettings<S> => {
    const out: Record<string, DipValue> = {};
    for (const key of keys) out[key] = schema[key]!.default;
    return out as DipSettings<S>;
  };

  const option = <K extends keyof S>(settings: DipSettings<S>, key: K): S[K]['options'][number] => {
    const field = schema[key]!;
    return field.options.find((o) => o.value === settings[key]) ?? field.options.find((o) => o.value === field.default)!;
  };

  return {
    schema,
    defaults,
    parse(input) {
      const out = defaults() as Record<string, DipValue>;
      if (input && typeof input === 'object') {
        const rec = input as Record<string, unknown>;
        for (const key of keys) {
          const v = rec[key];
          if (schema[key]!.options.some((o) => o.value === v)) out[key] = v as DipValue;
        }
      }
      return out as DipSettings<S>;
    },
    option,
    toBanks(settings, banks, initial = 0xff) {
      let count = banks ?? 0;
      if (banks === undefined) for (const key of keys) count = Math.max(count, (schema[key]!.bank ?? -1) + 1);
      const out = new Array<number>(count).fill(initial);
      for (const key of keys) {
        const field = schema[key]!;
        const bits = option(settings, key).bits;
        if (field.bank === undefined || field.mask === undefined || bits === undefined || field.bank >= count) continue;
        out[field.bank] = (out[field.bank]! & ~field.mask) | (bits & field.mask);
      }
      return out;
    },
    fromBanks(banks) {
      const out = defaults() as Record<string, DipValue>;
      for (const key of keys) {
        const field = schema[key]!;
        if (field.bank === undefined || field.mask === undefined) continue;
        const raw = (banks[field.bank] ?? 0) & field.mask;
        const match = field.options.find((o) => o.bits !== undefined && (o.bits & field.mask!) === raw);
        if (match) out[key] = match.value;
      }
      return out as DipSettings<S>;
    },
  };
}
