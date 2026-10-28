/**
 * The manifest-side half of the decoder stamp: a sidecar recording, per
 * stage, which decoder revision produced that stage's rows.
 *
 * What matters here is the *per-stage* granularity (one output directory,
 * many stages, only some of them decoder-dependent) and the conservative
 * reading of a missing or broken sidecar.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DECODER_STAMP_FILE,
  manifestStampMatches,
  readDecoderStamp,
  readDecoderStamps,
  recordDecoderStamp,
} from '../decoder-stamp.js';

const root = mkdtempSync(join(tmpdir(), 'seer-decoder-stamp-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
let dir: string;
beforeEach(() => {
  dir = join(root, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
});

describe('decoder stamp sidecar', () => {
  it('round-trips a stage stamp', () => {
    recordDecoderStamp(dir, 'textures', 'bc3.g1t2');
    expect(readDecoderStamp(dir, 'textures')).toBe('bc3.g1t2');
    expect(manifestStampMatches(dir, 'textures', 'bc3.g1t2')).toBe(true);
    expect(manifestStampMatches(dir, 'textures', 'bc4.g1t2')).toBe(false);
  });

  // Stages share one output directory and run in any order; recording one
  // must never be a whole-file overwrite.
  it('records stages independently', () => {
    recordDecoderStamp(dir, 'textures', 'bc3.g1t2');
    recordDecoderStamp(dir, 'meshes', 'bc3.g1t2');
    recordDecoderStamp(dir, 'textures', 'bc4.g1t2');
    expect(readDecoderStamps(dir)).toEqual({ meshes: 'bc3.g1t2', textures: 'bc4.g1t2' });
  });

  it('an unrecorded stage is unstamped, and unstamped never matches', () => {
    recordDecoderStamp(dir, 'textures', 'bc3.g1t2');
    expect(readDecoderStamp(dir, 'audio')).toBeUndefined();
    expect(manifestStampMatches(dir, 'audio', 'bc3.g1t2')).toBe(false);
  });

  it('a missing sidecar reads as nothing stamped rather than throwing', () => {
    expect(readDecoderStamps(dir)).toEqual({});
    expect(manifestStampMatches(dir, 'textures', 'bc3.g1t2')).toBe(false);
  });

  it('a corrupt or wrong-shaped sidecar also reads as nothing stamped', () => {
    writeFileSync(join(dir, DECODER_STAMP_FILE), 'not json at all');
    expect(readDecoderStamps(dir)).toEqual({});
    writeFileSync(join(dir, DECODER_STAMP_FILE), JSON.stringify({ stages: 'nope' }));
    expect(readDecoderStamps(dir)).toEqual({});
    writeFileSync(join(dir, DECODER_STAMP_FILE), JSON.stringify({ stages: { textures: 7 } }));
    expect(readDecoderStamps(dir)).toEqual({});
  });

  it('writes a stable, sorted, human-readable file', () => {
    recordDecoderStamp(dir, 'meshes', 'bc3.g1t2');
    recordDecoderStamp(dir, 'textures', 'bc3.g1t2');
    expect(readFileSync(join(dir, DECODER_STAMP_FILE), 'utf8')).toBe(
      `${JSON.stringify({ stages: { meshes: 'bc3.g1t2', textures: 'bc3.g1t2' } }, null, 2)}\n`,
    );
  });
});
