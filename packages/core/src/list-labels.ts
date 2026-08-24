/**
 * Asset list rows are frequently named with heavy shared boilerplate —
 * e.g. every clip in a decoded audio archive coming out
 * `<game>_audio_<category>_synth_<id>_wav` — which buries the one part of
 * the name that actually varies once a viewer lists hundreds of them side
 * by side. These helpers strip a list's common `_`-delimited prefix/suffix
 * for display, without touching the underlying name used for search,
 * linking, or selection.
 */

/**
 * Longest common `_`-delimited prefix and suffix shared by every name in
 * `names`. Cut points always land on a `_` boundary (a shared word is
 * never sliced mid-token), and both come back empty if there are too few
 * names to compare or if the overlap would consume an entire name outright
 * (nothing would be left to show).
 */
export function computeCommonAffixes(names: string[]): { prefix: string; suffix: string } {
  if (names.length < 2) return { prefix: '', suffix: '' };
  let prefix = names[0]!;
  let suffix = names[0]!;
  for (let i = 1; i < names.length && (prefix.length > 0 || suffix.length > 0); i++) {
    const n = names[i]!;
    let p = 0;
    const maxP = Math.min(prefix.length, n.length);
    while (p < maxP && prefix[p] === n[p]) p++;
    prefix = prefix.slice(0, p);
    let s = 0;
    const maxS = Math.min(suffix.length, n.length);
    while (s < maxS && suffix[suffix.length - 1 - s] === n[n.length - 1 - s]) s++;
    suffix = suffix.slice(suffix.length - s);
  }
  const minLen = Math.min(...names.map((n) => n.length));
  if (prefix.length + suffix.length >= minLen) return { prefix: '', suffix: '' };
  const prefixCut = prefix.lastIndexOf('_');
  const suffixCut = suffix.indexOf('_');
  return {
    prefix: prefixCut >= 0 ? prefix.slice(0, prefixCut + 1) : '',
    suffix: suffixCut >= 0 ? suffix.slice(suffixCut) : '',
  };
}

/** Strips a precomputed common prefix/suffix (from {@link computeCommonAffixes}) from `name` for display — falls back to the full name if that would leave nothing. */
export function stripCommonAffixes(name: string, prefix: string, suffix: string): string {
  let n = name;
  if (prefix && n.startsWith(prefix)) n = n.slice(prefix.length);
  if (suffix && n.endsWith(suffix) && n.length > suffix.length) n = n.slice(0, n.length - suffix.length);
  return n || name;
}
