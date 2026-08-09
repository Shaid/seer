/**
 * hex-dump — inspect binary game data files.
 *
 * Exported `hexDump()` is the reusable implementation (parameterised).
 * When run directly as a standalone script, it reads from process.argv —
 * this preserves backward compat with `npx tsx packages/pipeline/src/hex-dump.ts`.
 */
import { basename } from 'node:path';
import { readBinary } from './io.js';

/** Print a hex+ASCII dump of `filePath` to stdout. */
export function hexDump(filePath: string, startOffset = 0, maxLength = 256): void {
  const data = readBinary(filePath);

  console.log(`File: ${basename(filePath)} (${data.length} bytes)`);
  console.log(
    `Showing offset 0x${startOffset.toString(16)} – 0x${Math.min(startOffset + maxLength, data.length).toString(16)}\n`,
  );

  console.log('  Offset   00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F  ASCII');
  console.log('  ------   -----------------------------------------------  ----------------');

  const end = Math.min(startOffset + maxLength, data.length);
  for (let row = startOffset; row < end; row += 16) {
    const addr = row.toString(16).padStart(8, '0');
    const hexParts: string[] = [];
    const asciiParts: string[] = [];

    for (let col = 0; col < 16; col++) {
      const idx = row + col;
      if (idx < end) {
        hexParts.push(data[idx].toString(16).padStart(2, '0'));
        asciiParts.push(
          data[idx] >= 0x20 && data[idx] <= 0x7e ? String.fromCharCode(data[idx]) : '.',
        );
      } else {
        hexParts.push('  ');
        asciiParts.push(' ');
      }
    }

    const hex = hexParts.slice(0, 8).join(' ') + '  ' + hexParts.slice(8).join(' ');
    const ascii = asciiParts.join('');
    console.log(`  ${addr}   ${hex}  ${ascii}`);
  }

  if (startOffset === 0 && data.length >= 4) {
    const fourCC = String.fromCharCode(...data.slice(0, 4));
    const isPrintable = [...fourCC].every((c) => c >= ' ' && c <= '~');
    if (isPrintable) {
      console.log(`\nMagic / FourCC: "${fourCC}"`);
    }
  }
}

// Standalone CLI mode
const isStandalone =
  process.argv[1] &&
  (process.argv[1].endsWith('hex-dump.ts') || process.argv[1].endsWith('hex-dump'));

if (isStandalone) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx packages/pipeline/src/hex-dump.ts <file> [offset] [length]');
    process.exit(1);
  }
  hexDump(args[0], args[1] ? parseInt(args[1], 0) : 0, args[2] ? parseInt(args[2], 0) : 256);
}
