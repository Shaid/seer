/**
 * 3DS crypto tests.
 *
 * The key-derivation cases need real console key material (keyX slots, a
 * ticket's encrypted title key, a title seed) with known-good expected
 * outputs cross-checked against pyctr. That material is not distributable,
 * so it's gated behind an optional, gitignored fixture
 * (`fixtures/key-vectors.json` — see any consumer game repo for the
 * `key-vectors.example.json` template) and skipped when it's absent, which it
 * always is in this package (packages must be fully testable with no game
 * data present). Everything that can be tested with synthetic values still
 * runs unconditionally.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAesKeys,
  parseTicket,
  decryptTitleKey,
  seedKeyY,
  keygenNormal,
  sectionCounter,
  ctrDecrypt,
  addToCounter,
} from '../crypto.js';

interface KeyVectors {
  aesKeysText: string;
  keygen: { keyX: string; keyY: string; expectedNormalKey: string };
  titleKey: {
    titleId: string;
    commonKeyIndex: number;
    encryptedTitleKey: string;
    commonKeyX: string;
    expectedTitleKey: string;
  };
  seed: { keyY: string; seed: string; expectedSeededKeyY: string };
}

function loadVectors(): KeyVectors | undefined {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/key-vectors.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as KeyVectors;
  } catch {
    return undefined;
  }
}

const vectors = loadVectors();

describe('parseAesKeys', () => {
  it('parses Citra-format key slots', () => {
    // Synthetic slot values — this exercises the parser, not the key data.
    const text = [
      'generator=000102030405060708090A0B0C0D0E0F',
      'slot0x2CKeyX=101112131415161718191A1B1C1D1E1F',
      'slot0x25KeyX=202122232425262728292A2B2C2D2E2F',
      'slot0x3DKeyX=303132333435363738393A3B3C3D3E3F',
      '',
    ].join('\n');
    const slots = parseAesKeys(text);
    expect(slots.get(0x2c)?.x?.toString('hex')).toBe('101112131415161718191a1b1c1d1e1f');
    expect(slots.get(0x25)?.x?.toString('hex')).toBe('202122232425262728292a2b2c2d2e2f');
    expect(slots.get(0x3d)?.x).toBeDefined();
    expect(slots.has(0x2d)).toBe(false);
  });

  it('ignores comments and unknown lines', () => {
    const slots = parseAesKeys(
      '# comment\nnonsense\nslot0x2CKeyX=0F0E0D0C0B0A09080706050403020100\n',
    );
    expect(slots.get(0x2c)?.x?.toString('hex')).toBe('0f0e0d0c0b0a09080706050403020100');
  });
});

describe.skipIf(!vectors)('key derivation (needs fixtures/key-vectors.json)', () => {
  it('parses the real Citra key file', () => {
    const slots = parseAesKeys(vectors!.aesKeysText);
    expect(slots.get(0x2c)?.x).toBeDefined();
    expect(slots.get(0x25)?.x).toBeDefined();
    expect(slots.get(0x3d)?.x).toBeDefined();
  });

  it('matches the reference 3DS key scramble', () => {
    const { keyX, keyY, expectedNormalKey } = vectors!.keygen;
    expect(keygenNormal(Buffer.from(keyX, 'hex'), Buffer.from(keyY, 'hex')).toString('hex')).toBe(
      expectedNormalKey,
    );
  });

  it('derives the title key from a ticket', () => {
    const t = vectors!.titleKey;
    const ticket = Buffer.alloc(0x2ac, 0);
    ticket.writeUInt32BE(t.commonKeyIndex + 1, 0x1f1);
    ticket.write(t.titleId, 0x1dc, 'hex');
    Buffer.from(t.encryptedTitleKey, 'hex').copy(ticket, 0x1bf);
    const info = parseTicket(ticket);
    expect(decryptTitleKey(info, Buffer.from(t.commonKeyX, 'hex')).toString('hex')).toBe(
      t.expectedTitleKey,
    );
  });

  it('derives the seeded keyY', () => {
    const s = vectors!.seed;
    expect(seedKeyY(Buffer.from(s.keyY, 'hex'), Buffer.from(s.seed, 'hex')).toString('hex')).toBe(
      s.expectedSeededKeyY,
    );
  });
});

describe('section counters', () => {
  it('builds the romfs counter from a partition id', () => {
    const pid = Buffer.from('00411b0000000400', 'hex'); // LE u64 of 0x00040000001B4100
    expect(sectionCounter(pid, 3).toString('hex')).toBe('00040000001b41000300000000000000');
  });

  it('increments counters', () => {
    const counter = Buffer.alloc(16);
    expect(addToCounter(counter, 1).toString('hex')).toBe('00000000000000000000000000000001');
  });

  it('carries across byte boundaries', () => {
    const counter = Buffer.alloc(16, 0xff);
    expect(addToCounter(counter, 1).toString('hex')).toBe('00000000000000000000000000000000');
  });
});

describe('ctrDecrypt', () => {
  it('round-trips an AES-CTR stream', () => {
    const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const counter = Buffer.alloc(16);
    const plain = Buffer.from('hello world hello world');
    const encrypted = ctrDecrypt(key, counter, plain);
    expect(encrypted).not.toEqual(plain);
    expect(ctrDecrypt(key, counter, encrypted).subarray(0, plain.length).toString()).toBe(
      plain.toString(),
    );
  });
});
