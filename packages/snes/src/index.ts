/**
 * Barrel re-export for SNES hardware primitives.
 *
 * `akao-dsp.ts` is the one deliberate exception to "hardware only": a
 * driver's own note-to-pitch/tuning formula and BRR-blob container
 * convention are generally NOT hardware and would not normally belong in
 * this package's own project's driver-level module built on the
 * primitives here — but this specific module was confirmed byte-identical
 * across two independent AKAOSNES-driven consumers (ceres, chronotrigger),
 * so it is shared here rather than kept as two drifting copies. See that
 * file's own doc comment before assuming any *other* driver-specific code
 * belongs in this package too — it usually doesn't.
 */
export * from './spc700-cpu.js';
export * from './spc700-dsp.js';
export * from './envelope.js';
export * from './echo.js';
export * from './brr.js';
export * from './ppu.js';
export * from './akao-dsp.js';
