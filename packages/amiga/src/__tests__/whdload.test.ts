import { describe, it, expect } from 'vitest';
import { buildHunkExe } from '../build.js';
import { parseWhdloadSlave } from '../whdload.js';

function makeSlavePayload(version: number, name?: string, copy?: string): Uint8Array {
  const payload = new Uint8Array(256);
  payload.set([0x60, 0x00, 0x00, 0x2a]); // ws_Security: BRA
  for (let i = 0; i < 8; i++) payload[4 + i] = 'WHDLOADS'.charCodeAt(i);
  payload[12] = version >> 8;
  payload[13] = version & 0xff;
  payload[16] = 0x00; // BaseMemSize
  payload[17] = 0x08;
  let cursor = 64;
  const putString = (at: number, s: string) => {
    payload[at] = cursor >> 8;
    payload[at + 1] = cursor & 0xff;
    for (const ch of s) payload[cursor++] = ch.charCodeAt(0);
    payload[cursor++] = 0;
  };
  if (name) putString(36, name);
  if (copy) putString(38, copy);
  return payload;
}

describe('parseWhdloadSlave', () => {
  it('extracts version and v10+ name/copy strings', () => {
    const exe = buildHunkExe([{ type: 'CODE', payload: makeSlavePayload(17, 'Test Game', '1991 TestSoft') }]);
    const slave = parseWhdloadSlave(exe)!;
    expect(slave.version).toBe(17);
    expect(slave.name).toBe('Test Game');
    expect(slave.copy).toBe('1991 TestSoft');
  });

  it('handles pre-v10 slaves without string fields', () => {
    const exe = buildHunkExe([{ type: 'CODE', payload: makeSlavePayload(8) }]);
    const slave = parseWhdloadSlave(exe)!;
    expect(slave.version).toBe(8);
    expect(slave.name).toBeNull();
  });

  it('rejects non-slave executables and non-hunk files', () => {
    const plain = buildHunkExe([{ type: 'CODE', payload: new Uint8Array(64).fill(0x4e) }]);
    expect(parseWhdloadSlave(plain)).toBeNull();
    expect(parseWhdloadSlave(new Uint8Array(64))).toBeNull();
  });
});
