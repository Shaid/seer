/**
 * seer-probe command dispatch. The bin shim (bin/seer-probe.mjs) calls
 * `main(argv)`; each command module owns its own flags and usage text.
 *
 * The rule that governs every command: probe emits hypotheses, never
 * findings. A ranked contact sheet is a starting point for verification,
 * not a substitute for it. The one exception is `cnf --audit`, which
 * reports a measured quantity.
 */

import { runMap, MAP_USAGE } from './map.js';
import { runGfx, GFX_USAGE } from './gfx.js';
import { runStride, STRIDE_USAGE } from './stride.js';
import { runAudio, AUDIO_USAGE } from './audio.js';
import { runCnf, CNF_USAGE } from './cnf.js';
import { runTriage, TRIAGE_USAGE } from './triage.js';
import { defaultOutDir } from './out.js';

const COMMANDS: Record<string, { run: (argv: string[]) => number | Promise<number>; usage: string }> = {
  triage: { run: runTriage, usage: TRIAGE_USAGE },
  map: { run: runMap, usage: MAP_USAGE },
  gfx: { run: runGfx, usage: GFX_USAGE },
  stride: { run: runStride, usage: STRIDE_USAGE },
  audio: { run: runAudio, usage: AUDIO_USAGE },
  cnf: { run: runCnf, usage: CNF_USAGE },
};

export function printUsage(): void {
  console.log('seer-probe — exploratory binary recon. Emits hypotheses, never findings.\n');
  for (const { usage } of Object.values(COMMANDS)) console.log(usage + '\n');
  console.log(`Artifacts default to ${defaultOutDir()} (override with --out or SEER_PROBE_OUT).`);
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}\n`);
    printUsage();
    return 1;
  }
  try {
    return await entry.run(argv.slice(1));
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  }
}
