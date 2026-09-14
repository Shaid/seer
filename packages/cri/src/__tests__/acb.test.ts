import { describe, it, expect } from 'vitest';
import { parseAcb, parseEmbeddedAwb, resolveAcbAwbOffsets } from '../acb.js';
import { parseAfs2 } from '../awb.js';
import { buildUtf, type UtfColSpec } from './utf-builder.js';

const WAVEFORM_COLS: UtfColSpec[] = [
  { name: 'Id', typ: 4 },
  { name: 'EncodeType', typ: 4 },
  { name: 'Streaming', typ: 4 },
  { name: 'NumChannels', typ: 4 },
  { name: 'SamplingRate', typ: 4 },
  { name: 'NumSamples', typ: 4 },
];
const CUE_NAME_COLS: UtfColSpec[] = [
  { name: 'CueName', typ: 0xa },
  { name: 'CueIndex', typ: 4 },
];

function buildAcb(opts: {
  waveforms: { id: number; encodeType: number; sampleRate: number; channels: number; samples: number }[];
  cueNames: { name: string; cueIndex: number }[];
  embeddedAwb?: Uint8Array;
}): Uint8Array {
  const waveformTable = buildUtf(
    WAVEFORM_COLS,
    opts.waveforms.map((w) => ({ Id: w.id, EncodeType: w.encodeType, Streaming: 0, NumChannels: w.channels, SamplingRate: w.sampleRate, NumSamples: w.samples })),
  );
  const cueNameTable = buildUtf(
    CUE_NAME_COLS,
    opts.cueNames.map((c) => ({ CueName: c.name, CueIndex: c.cueIndex })),
  );
  const cols: UtfColSpec[] = [
    { name: 'WaveformTable', typ: 0xb },
    { name: 'CueNameTable', typ: 0xb },
  ];
  const row: Record<string, Uint8Array> = { WaveformTable: waveformTable, CueNameTable: cueNameTable };
  if (opts.embeddedAwb) {
    cols.push({ name: 'AwbFile', typ: 0xb });
    row['AwbFile'] = opts.embeddedAwb;
  }
  return buildUtf(cols, [row]);
}

/** Minimal synthetic AFS2 wave bank (id table + offset table only), for embedded-AWB tests. */
function buildAfs2Bytes(ids: number[], offsets: number[]): Uint8Array {
  const idTableStart = 0x10;
  const idTableLen = ids.length * 2;
  const offsetTableStart = idTableStart + idTableLen;
  const buf = new Uint8Array(offsetTableStart + offsets.length * 4);
  const view = new DataView(buf.buffer);
  buf.set([0x41, 0x46, 0x53, 0x32], 0);
  buf[5] = 4;
  buf[6] = 2;
  view.setUint32(8, ids.length, true);
  ids.forEach((id, i) => view.setUint16(idTableStart + i * 2, id, true));
  offsets.forEach((off, i) => view.setUint32(offsetTableStart + i * 4, off, true));
  return buf;
}

describe('acb — positional cue/waveform pairing', () => {
  it('pairs CueNameTable row N with WaveformTable row N when counts match', () => {
    const acbBuf = buildAcb({
      waveforms: [
        { id: 0, encodeType: 2, sampleRate: 48000, channels: 2, samples: 3620736 },
        { id: 1, encodeType: 2, sampleRate: 44100, channels: 2, samples: 1000 },
      ],
      cueNames: [
        { name: 'BGM_000', cueIndex: 0 },
        { name: 'BGM_001', cueIndex: 1 },
      ],
    });
    const acb = parseAcb(acbBuf);
    expect(acb.waveformCount).toBe(2);
    expect(acb.cueCount).toBe(2);
    expect(acb.tracks.length).toBe(2);
    expect(acb.embeddedAwb).toBeUndefined();

    const t0 = acb.tracks.find((t) => t.waveform.id === 0)!;
    expect(t0.name).toBe('BGM_000');
    expect(t0.nameConfidence).toBe('cue-name');
    expect(t0.waveform.codec).toBe('hca');
    expect(t0.waveform.sampleRate).toBe(48000);
    expect(t0.waveform.channelCount).toBe(2);
    expect(t0.waveform.sampleCount).toBe(3620736);
    expect(t0.waveform.durationSeconds).toBeCloseTo(3620736 / 48000);

    const t1 = acb.tracks.find((t) => t.waveform.id === 1)!;
    expect(t1.name).toBe('BGM_001');
  });

  it('maps an unconfirmed EncodeType to unknown-<n> rather than guessing', () => {
    const acbBuf = buildAcb({
      waveforms: [{ id: 0, encodeType: 99, sampleRate: 44100, channels: 1, samples: 10 }],
      cueNames: [{ name: 'X', cueIndex: 0 }],
    });
    const acb = parseAcb(acbBuf);
    expect(acb.tracks[0]!.waveform.codec).toBe('unknown-99');
  });

  it('confirms EncodeType 8 maps to atrac3 (Grand Knights History convention)', () => {
    const acbBuf = buildAcb({
      waveforms: [{ id: 0, encodeType: 8, sampleRate: 44100, channels: 2, samples: 500 }],
      cueNames: [{ name: 'SE_01', cueIndex: 0 }],
    });
    const acb = parseAcb(acbBuf);
    expect(acb.tracks[0]!.waveform.codec).toBe('atrac3');
  });

  it('falls back to generic waveform_<id> names when cue/waveform counts diverge, without dropping any waveform', () => {
    const acbBuf = buildAcb({
      waveforms: [
        { id: 0, encodeType: 2, sampleRate: 44100, channels: 2, samples: 100 },
        { id: 1, encodeType: 2, sampleRate: 44100, channels: 2, samples: 200 },
        { id: 2, encodeType: 2, sampleRate: 44100, channels: 2, samples: 300 },
      ],
      cueNames: [{ name: 'ONLY_ONE', cueIndex: 0 }],
    });
    const acb = parseAcb(acbBuf);
    expect(acb.waveformCount).toBe(3);
    expect(acb.tracks.length).toBe(3);
    for (const t of acb.tracks) {
      expect(t.nameConfidence).toBe('positional-placeholder');
      expect(t.name).toBe(`waveform_${t.waveform.id}`);
    }
  });
});

describe('acb — embedded AWB', () => {
  it('reports embeddedAwb and parseEmbeddedAwb extracts the exact bytes back out', () => {
    const afs2 = buildAfs2Bytes([0, 1], [40, 60, 90]);
    const acbBuf = buildAcb({
      waveforms: [{ id: 0, encodeType: 2, sampleRate: 44100, channels: 2, samples: 10 }],
      cueNames: [{ name: 'X', cueIndex: 0 }],
      embeddedAwb: afs2,
    });
    const acb = parseAcb(acbBuf);
    expect(acb.embeddedAwb).toBeDefined();
    const extracted = acbBuf.subarray(acb.embeddedAwb!.offset, acb.embeddedAwb!.offset + acb.embeddedAwb!.length);
    expect(extracted).toEqual(afs2);

    const awb = parseEmbeddedAwb(acbBuf, acb.embeddedAwb!);
    expect(awb).not.toBeNull();
    expect(awb!.format).toBe('afs2');
    expect(awb!.entries).toEqual([
      { id: 0, offset: 40, size: 20 },
      { id: 1, offset: 60, size: 30 },
    ]);
  });

  it('parseEmbeddedAwb returns null for a bogus/empty slice', () => {
    const acbBuf = buildAcb({ waveforms: [], cueNames: [] });
    expect(parseEmbeddedAwb(acbBuf, { offset: 0, length: 16 })).toBeNull();
  });
});

describe('acb — resolveAcbAwbOffsets', () => {
  it('pairs tracks by waveform id (not array position) against an AwbTable', () => {
    const acbBuf = buildAcb({
      waveforms: [
        { id: 5, encodeType: 2, sampleRate: 44100, channels: 2, samples: 10 },
        { id: 2, encodeType: 2, sampleRate: 44100, channels: 2, samples: 20 },
      ],
      cueNames: [
        { name: 'A', cueIndex: 0 },
        { name: 'B', cueIndex: 1 },
      ],
    });
    const acb = parseAcb(acbBuf);
    const awb = parseAfs2(buildAfs2Bytes([2, 5], [0, 100, 250]))!;
    const resolved = resolveAcbAwbOffsets(acb.tracks, awb);
    const track5 = resolved.find((t) => t.waveform.id === 5)!;
    const track2 = resolved.find((t) => t.waveform.id === 2)!;
    expect(track2.awbOffset).toBe(0);
    expect(track2.awbLength).toBe(100);
    expect(track5.awbOffset).toBe(100);
    expect(track5.awbLength).toBe(150);
  });

  it('leaves awbOffset/awbLength undefined when a waveform id has no matching AWB entry', () => {
    const acbBuf = buildAcb({
      waveforms: [{ id: 42, encodeType: 2, sampleRate: 44100, channels: 2, samples: 10 }],
      cueNames: [{ name: 'A', cueIndex: 0 }],
    });
    const acb = parseAcb(acbBuf);
    const awb = parseAfs2(buildAfs2Bytes([0], [0, 10]))!;
    const resolved = resolveAcbAwbOffsets(acb.tracks, awb);
    expect(resolved[0]!.awbOffset).toBeUndefined();
    expect(resolved[0]!.awbLength).toBeUndefined();
  });
});
