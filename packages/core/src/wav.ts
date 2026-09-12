/**
 * Minimal RIFF/WAVE PCM encoder — a pure byte-buffer builder with no
 * filesystem access, so it runs in a browser viewer as well as offline
 * pipeline code. `@seer-project/pipeline`'s `writeWav` wraps this with a
 * `writeFileSync`; import from here directly when writing to disk isn't
 * an option (a browser asset viewer's "download WAV" button) or when the
 * caller already holds quantized `Int16Array` PCM rather than normalized
 * float samples.
 *
 * One array per channel — `[mono]` or `[left, right]`.
 */
export function encodeWav(channels: Uint8Array[], opts: { sampleRate: number; bits: 8 }): Uint8Array;
export function encodeWav(channels: Int16Array[], opts: { sampleRate: number; bits?: 16 }): Uint8Array;
export function encodeWav(
  channels: Uint8Array[] | Int16Array[],
  opts: { sampleRate: number; bits?: 8 | 16 },
): Uint8Array {
  const { sampleRate, bits = 16 } = opts;
  const numChannels = channels.length;
  const numSamples = channels[0]?.length ?? 0;
  const bytesPerSample = bits / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;

  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);
  let off = 0;

  const writeAscii = (s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
    off += s.length;
  };

  writeAscii('RIFF');
  view.setUint32(off, 36 + dataSize, true);
  off += 4;
  writeAscii('WAVE');
  writeAscii('fmt ');
  view.setUint32(off, 16, true);
  off += 4;
  view.setUint16(off, 1, true); // PCM
  off += 2;
  view.setUint16(off, numChannels, true);
  off += 2;
  view.setUint32(off, sampleRate, true);
  off += 4;
  view.setUint32(off, sampleRate * blockAlign, true);
  off += 4;
  view.setUint16(off, blockAlign, true);
  off += 2;
  view.setUint16(off, bits, true);
  off += 2;
  writeAscii('data');
  view.setUint32(off, dataSize, true);
  off += 4;

  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      if (bits === 8) {
        buf[off] = (channels[ch] as Uint8Array)[i] & 0xff;
        off += 1;
      } else {
        view.setInt16(off, (channels[ch] as Int16Array)[i], true);
        off += 2;
      }
    }
  }

  return buf;
}

/** Quantize normalized float samples in [-1, 1] (clamped) to signed 16-bit PCM. */
export function int16FromFloat32(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  }
  return out;
}

/** Sign-extend raw signed 8-bit PCM (the Amiga sample convention) to 16-bit PCM. */
export function int16FromSigned8(data: Uint8Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = ((data[i] << 24) >> 24) * 256;
  }
  return out;
}
