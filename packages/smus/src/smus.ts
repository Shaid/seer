/**
 * SMUS — IFF FORM SMUS (Simple Musical Score) decoder.
 *
 * Specification: EA IFF 85 "SMUS IFF Simple Musical Score"
 * (Jerry Morrison, Electronic Arts, Feb 1987)
 */

import { BinaryReader } from '@seer-project/core';
import { parseIff, findChunk, findChunks } from '@seer-project/iff';

// ─── SEvent type codes ────────────────────────────────────────────────

export const SID_FirstNote = 0;
export const SID_LastNote = 127;
export const SID_Rest = 128;
export const SID_Instrument = 129;
export const SID_TimeSig = 130;
export const SID_KeySig = 131;
export const SID_Dynamic = 132;
export const SID_MIDI_Chnl = 133;
export const SID_MIDI_Preset = 134;
export const SID_Clef = 135;
export const SID_Tempo = 136;

// ─── Parsed types ─────────────────────────────────────────────────────

export interface SScoreHeader {
  tempo: number; // 128ths of a quarter note per minute
  volume: number; // 0-127
  ctTrack: number; // number of tracks
}

export interface SEvent {
  sID: number;
  data: number;
}

export interface SNote extends SEvent {
  chord: boolean;
  tieOut: boolean;
  nTuplet: number; // 0=none, 1=triplet, 2=quintuplet, 3=septuplet
  dot: boolean;
  division: number; // 0=whole, 1=half, 2=quarter, 3=eighth, ...
  tone: number; // MIDI pitch 0-127, or SID_Rest (128)
}

export interface STimeSigEvent extends SEvent {
  timeNSig: number; // numerator = timeNSig + 1
  timeDSig: number; // denominator = 2^timeDSig
}

export interface SInstrumentRef {
  register: number;
  type: number;
  data1: number;
  data2: number;
  name: string;
}

export interface SEventStream {
  events: SEvent[];
}

export interface SSong {
  header: SScoreHeader;
  name: string | null;
  instruments: SInstrumentRef[];
  tracks: SEventStream[];
}

// ─── Decoder ──────────────────────────────────────────────────────────

function parseSNote(sID: number, data: number): SNote {
  return {
    sID,
    data,
    tone: sID,
    chord: !!(data & 0x80),
    tieOut: !!(data & 0x40),
    nTuplet: (data >> 4) & 0x03,
    dot: !!(data & 0x08),
    division: data & 0x07,
  };
}

function parseSTimeSig(sID: number, data: number): STimeSigEvent {
  return {
    sID,
    data,
    timeNSig: (data >> 3) & 0x1f,
    timeDSig: data & 0x07,
  };
}

function parseSEvent(sID: number, data: number): SEvent {
  if (sID === SID_TimeSig) return parseSTimeSig(sID, data);
  if (sID <= SID_LastNote || sID === SID_Rest) return parseSNote(sID, data);
  return { sID, data };
}

function parseTRAK(data: Uint8Array): SEventStream {
  // Slice to a tight buffer so BinaryReader.remaining doesn't overshoot into
  // later chunks — the Uint8Array may be a view over the entire file buffer.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const reader = new BinaryReader(buf);
  const events: SEvent[] = [];

  while (reader.remaining >= 2) {
    const sID = reader.readUint8();
    const dataByte = reader.readUint8();
    events.push(parseSEvent(sID, dataByte));
  }

  return { events };
}

function parseINS1(data: Uint8Array): SInstrumentRef {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const reader = new BinaryReader(buf);
  const register = reader.readUint8();
  const type = reader.readUint8();
  const data1 = reader.readUint8();
  const data2 = reader.readUint8();

  // Name occupies the remaining bytes of this chunk (not the whole file buffer).
  // BinaryReader's `remaining` reports the full backing buffer, not the subarray,
  // so we hard-limit to `data.length - 4`.
  const maxNameLen = data.length - 4;
  const nameBytes: number[] = [];
  for (let i = 0; i < maxNameLen; i++) {
    const b = reader.readUint8();
    if (b === 0) break;
    nameBytes.push(b);
  }
  const name = String.fromCharCode(...nameBytes);

  return { register, type, data1, data2, name };
}

export function parseSMUS(buffer: ArrayBuffer): SSong | null {
  const form = parseIff(buffer);
  if (!form || form.type !== 'SMUS') return null;

  // SHDR
  const shdrChunk = findChunk(form, 'SHDR');
  if (!shdrChunk) return null;

  const shdrReader = new BinaryReader(
    shdrChunk.data.buffer as ArrayBuffer,
    shdrChunk.data.byteOffset,
  );
  const tempo = shdrReader.readUint16();
  const volume = shdrReader.readUint8();
  const ctTrack = shdrReader.readUint8();

  const header: SScoreHeader = { tempo, volume, ctTrack };

  // NAME (optional)
  const nameChunk = findChunk(form, 'NAME');
  let name: string | null = null;
  if (nameChunk) {
    name = new TextDecoder().decode(nameChunk.data).replace(/\0+$/, '') || null;
  }

  // INS1 chunks (optional)
  const ins1Chunks = findChunks(form, 'INS1');
  const instruments = ins1Chunks.map((c) => parseINS1(c.data));

  // TRAK chunks
  const trakChunks = findChunks(form, 'TRAK');
  const tracks = trakChunks.map((c) => parseTRAK(c.data));

  return { header, name, instruments, tracks };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Decode a note's data byte into a human-readable duration name. */
const DIVISION_NAMES = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th', '128th'];

export function durationName(data: number): string {
  const division = data & 0x07;
  const dot = !!(data & 0x08);
  const nTuplet = (data >> 4) & 0x03;
  let name = DIVISION_NAMES[division] ?? `1/${1 << division}`;
  if (dot) name = `dotted ${name}`;
  if (nTuplet === 1) name = `triplet ${name}`;
  else if (nTuplet === 2) name = `quintuplet ${name}`;
  else if (nTuplet === 3) name = `septuplet ${name}`;
  return name;
}

/** Compute the duration multiplier for a note/rest data byte (in quarter-note units). */
export function eventDuration(data: number): number {
  const division = data & 0x07;
  const dot = !!(data & 0x08);
  const nTuplet = (data >> 4) & 0x03;

  let dur = 4 / (1 << division); // quarter = 1.0
  if (dot) dur *= 1.5;
  if (nTuplet === 1) dur *= 2 / 3;
  else if (nTuplet === 2) dur *= 4 / 5;
  else if (nTuplet === 3) dur *= 4 / 7;
  return dur;
}

/** Tempo from 128ths-of-QPM to BPM. */
export function tempoToBPM(tempo: number): number {
  return tempo / 128;
}
