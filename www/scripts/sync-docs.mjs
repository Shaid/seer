#!/usr/bin/env node
/**
 * sync-docs — pulls the real source-of-truth docs (root docs/ and each
 * package's README.md) into www/src/content/docs/, deriving Starlight
 * frontmatter (title/description) from each file's own heading rather
 * than requiring the source files to carry website-specific metadata.
 *
 * Run automatically before `astro dev`/`astro build`/`astro preview` (see
 * package.json) — the site is always a fresh render of the real docs, never
 * a separately hand-maintained copy that can silently drift out of sync.
 *
 * Only touches the specific managed subdirectories listed in SOURCES below
 * (cleared and regenerated each run) — content authored directly in
 * www/src/content/docs/ outside those directories (e.g. examples/) is left
 * alone.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..'); // seer repo root
const OUT_ROOT = resolve(__dirname, '../src/content/docs');

/** Each entry: a source file (relative to ROOT) and where it lands under OUT_ROOT. */
const SOURCES = [
  { src: 'docs/architecture-overview.md', out: 'start-here/architecture-overview.md' },
  { src: 'docs/boilerplate-guide.md', out: 'start-here/boilerplate-guide.md' },
  { src: 'docs/viewer.md', out: 'guides/viewer.md' },
  { src: 'docs/framework-plan.md', out: 'roadmap/framework-plan.md' },
  { src: 'packages/core/README.md', out: 'packages/core.md' },
  { src: 'packages/engine-2d/README.md', out: 'packages/engine-2d.md' },
  { src: 'packages/engine-3d/README.md', out: 'packages/engine-3d.md' },
  { src: 'packages/pipeline/README.md', out: 'packages/pipeline.md' },
  { src: 'packages/iff/README.md', out: 'packages/iff.md' },
  { src: 'packages/smus/README.md', out: 'packages/smus.md' },
  { src: 'packages/tracker/README.md', out: 'packages/tracker.md' },
  { src: 'packages/audio-dsp/README.md', out: 'packages/audio-dsp.md' },
  { src: 'packages/audio-ui/README.md', out: 'packages/audio-ui.md' },
  { src: 'packages/dungeon/README.md', out: 'packages/dungeon.md' },
  { src: 'packages/create-seer/README.md', out: 'packages/create-seer.md' },
  { src: 'packages/create-seer-viewer/README.md', out: 'packages/create-seer-viewer.md' },
  { src: 'packages/create-seer-website/README.md', out: 'packages/create-seer-website.md' },
];

/** Directories under OUT_ROOT this script owns entirely — cleared each run
 * so a removed/renamed source doesn't leave an orphaned page behind. Content
 * authored directly in www (e.g. content/docs/examples/) is never touched. */
const MANAGED_DIRS = ['start-here', 'guides', 'roadmap', 'packages'];

function frontmatterFor(markdown) {
  const lines = markdown.split('\n');
  let titleLine = -1;
  let title = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      title = m[1];
      titleLine = i;
      break;
    }
  }
  if (title === null) throw new Error('No leading "# Title" heading found');

  // Join the first paragraph's wrapped lines into one sentence-flowing
  // description, rather than just the first physical line (which is often
  // a mid-sentence fragment in hand-wrapped markdown).
  let description = '';
  let paragraphStart = -1;
  for (let i = titleLine + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line === '---') {
      if (paragraphStart >= 0) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('>') || line.startsWith('```')) break;
    if (paragraphStart < 0) paragraphStart = i;
  }
  if (paragraphStart >= 0) {
    const paragraphLines = [];
    for (let i = paragraphStart; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') break;
      paragraphLines.push(line);
    }
    description = paragraphLines.join(' ');
  }
  if (description.length > 160) description = description.slice(0, 157) + '...';

  const body = [...lines.slice(0, titleLine), ...lines.slice(titleLine + 1)].join('\n').trimStart();

  const yamlEscape = (s) => s.replace(/"/g, '\\"');
  const frontmatter = [
    '---',
    `title: "${yamlEscape(title)}"`,
    description ? `description: "${yamlEscape(description)}"` : null,
    '---',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');

  return frontmatter + body;
}

for (const dir of MANAGED_DIRS) {
  rmSync(resolve(OUT_ROOT, dir), { recursive: true, force: true });
}

let synced = 0;
let skipped = 0;
for (const { src, out } of SOURCES) {
  const srcPath = resolve(ROOT, src);
  if (!existsSync(srcPath)) {
    console.warn(`  ⚠ skip (not found): ${src}`);
    skipped++;
    continue;
  }
  const outPath = resolve(OUT_ROOT, out);
  mkdirSync(dirname(outPath), { recursive: true });
  const raw = readFileSync(srcPath, 'utf-8');
  writeFileSync(outPath, frontmatterFor(raw));
  synced++;
}

console.log(`sync-docs: ${synced} synced, ${skipped} skipped (source not found)`);
