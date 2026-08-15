/**
 * Minimal spec-driven flag parser — deliberately dependency-free, like the
 * rest of the seer CLIs.
 */

export type FlagSpec = Record<string, 'string' | 'number' | 'bool'>;

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | number | boolean>;
}

/**
 * Parse `argv` against a flag spec. Accepts `--flag value` and
 * `--flag=value`; `bool` flags take no value. Numbers accept decimal or
 * `0x` hex. Throws on unknown flags or missing values so a typo'd probe
 * invocation fails loudly instead of silently sweeping the wrong thing.
 */
export function parseFlags(argv: string[], spec: FlagSpec): ParsedArgs {
  const positional: string[] = [];
  const flags: ParsedArgs['flags'] = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (!kind) throw new Error(`unknown flag --${name}`);

    if (kind === 'bool') {
      if (eq !== -1) throw new Error(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    const raw = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
    if (raw === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = kind === 'number' ? parseNumber(raw, name) : raw;
  }
  return { positional, flags };
}

/** Parse a decimal or `0x`-hex number, throwing on garbage. */
export function parseNumber(raw: string, context: string): number {
  const v = raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${context}: not a number: ${raw}`);
  return v;
}
