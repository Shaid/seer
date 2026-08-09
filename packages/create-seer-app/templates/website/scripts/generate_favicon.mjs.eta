// Generates public/favicon.png by extracting one frame out of a packed-frames
// sprite atlas (the same {frames:[{name,x,y,w,h}],width,height} shape used by
// the asset viewer and SpriteGallery). No hardcoded frame index or name —
// the atlas directory, manifest filename, and target frame name are all
// passed in from scripts/build.mjs, which reads them from this project's own
// config (see README.md "Pointing the favicon at a real sprite").
//
// Usage: node generate_favicon.mjs <atlasDir> <manifestFile> <frameName> <outputPath>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const [, , atlasDir, manifestFile, frameName, output] = process.argv;
if (!atlasDir || !manifestFile || !frameName || !output) {
	throw new Error('Usage: generate_favicon.mjs <atlasDir> <manifestFile> <frameName> <outputPath>');
}

const manifest = JSON.parse(readFileSync(join(atlasDir, manifestFile), 'utf8'));
const frame = manifest.frames.find((f) => f.name === frameName);
if (!frame) throw new Error(`Frame "${frameName}" not found in ${manifestFile}`);

const imageFile = manifestFile.replace(/\.json$/, '.png');

await sharp(join(atlasDir, imageFile))
	.extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
	.resize(64, 64, { kernel: sharp.kernel.nearest })
	.png()
	.toFile(output);

console.log(`Generated favicon from frame "${frameName}": ${output}`);
