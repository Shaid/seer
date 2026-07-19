/**
 * hex-dump — CLI tool for inspecting binary game data files.
 *
 * Usage: npx tsx packages/pipeline/src/hex-dump.ts <file> [offset] [length]
 */
import { basename } from 'node:path';
import { readBinary } from './io.ts';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: npx tsx packages/pipeline/src/hex-dump.ts <file> [offset] [length]');
  process.exit(1);
}

const filePath = args[0];
const startOffset = args[1] ? parseInt(args[1], 0) : 0;
const maxLength = args[2] ? parseInt(args[2], 0) : 256;

const data = readBinary(filePath);

console.log(`File: ${basename(filePath)} (${data.length} bytes)`);
console.log(
  `Showing offset 0x${startOffset.toString(16)} – 0x${Math.min(startOffset + maxLength, data.length).toString(16)}\n`,
);

// Print header
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

  // Group with extra space at byte 8
  const hex = hexParts.slice(0, 8).join(' ') + '  ' + hexParts.slice(8).join(' ');
  const ascii = asciiParts.join('');
  console.log(`  ${addr}   ${hex}  ${ascii}`);
}

// Print first 4 bytes as a FourCC if at offset 0
if (startOffset === 0 && data.length >= 4) {
  const fourCC = String.fromCharCode(...data.slice(0, 4));
  const isPrintable = [...fourCC].every((c) => c >= ' ' && c <= '~');
  if (isPrintable) {
    console.log(`\nMagic / FourCC: "${fourCC}"`);
  }
}
