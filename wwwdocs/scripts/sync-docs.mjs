#!/usr/bin/env node
/**
 * sync-docs — pulls the real source-of-truth docs (root docs/ and each
 * package's README.md) into wwwdocs/src/content/docs/, deriving Starlight
 * frontmatter (title/description) from each file's own heading rather
 * than requiring the source files to carry website-specific metadata.
 *
 * Run automatically before `astro dev`/`astro build`/`astro preview` (see
 * package.json) — the site is always a fresh render of the real docs, never
 * a separately hand-maintained copy that can silently drift out of sync.
 *
 * Only touches the specific managed subdirectories listed in SOURCES below
 * (cleared and regenerated each run) — content authored directly in
 * wwwdocs/src/content/docs/ outside those directories (e.g. examples/) is left
 * alone.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..'); // seer repo root
const OUT_ROOT = resolve(__dirname, '../src/content/docs');
const GENERATED = resolve(__dirname, '../generated');

/**
 * Root docs to publish, and where each lands under OUT_ROOT.
 *
 * This list is explicit *because it is an editorial decision*: `docs/` also
 * holds internal planning and self-critique (`walker.md`'s implementation
 * plan, `weaknesses.md`, `todos.md`, `viewer-tooling-review.md`,
 * `common-tooling-candidates.md`) and superseded proposals
 * (`engine-3d-proposal.md`) that are useful in-repo but aren't reference
 * material for the site. Packages are the opposite case and are discovered
 * automatically — see PACKAGE_SOURCES below.
 */
const DOC_SOURCES = [
  { src: 'docs/architecture-overview.md', out: 'start-here/architecture-overview.md' },
  { src: 'docs/boilerplate-guide.md', out: 'start-here/boilerplate-guide.md' },
  { src: 'docs/viewer.md', out: 'guides/viewer.md' },
  { src: 'docs/audio-playback.md', out: 'guides/audio-playback.md' },
  { src: 'docs/project-status.md', out: 'start-here/project-status.md' },
  { src: 'docs/licensing.md', out: 'start-here/licensing.md' },
  { src: 'docs/framework-plan.md', out: 'roadmap/framework-plan.md' },
  // The recompilation survey series: one doc per platform plus two
  // cross-platform technique docs, all cross-linked to each other. Reference
  // material, and only useful as a set — publish or omit the whole series.
  { src: 'docs/engine-based-porting.md', out: 'recompilation/engine-based-porting.md' },
  { src: 'docs/amiga-recomp.md', out: 'recompilation/amiga.md' },
  { src: 'docs/dos-recomp.md', out: 'recompilation/dos.md' },
  { src: 'docs/snes-recomp.md', out: 'recompilation/snes.md' },
  { src: 'docs/megadrive-recomp.md', out: 'recompilation/megadrive.md' },
  { src: 'docs/gba-recomp.md', out: 'recompilation/gba.md' },
  { src: 'docs/nds-recomp.md', out: 'recompilation/nds.md' },
  { src: 'docs/3ds-recomp.md', out: 'recompilation/3ds.md' },
  { src: 'docs/psx-recomp.md', out: 'recompilation/psx.md' },
  { src: 'docs/ps2-recomp.md', out: 'recompilation/ps2.md' },
  { src: 'docs/ps3-recomp.md', out: 'recompilation/ps3.md' },
  { src: 'docs/ps4-recomp.md', out: 'recompilation/ps4.md' },
  { src: 'docs/saturn-recomp.md', out: 'recompilation/saturn.md' },
  { src: 'docs/gamecube-wii-recomp.md', out: 'recompilation/gamecube-wii.md' },
  { src: 'docs/wiiu-recomp.md', out: 'recompilation/wiiu.md' },
  { src: 'docs/switch-recomp.md', out: 'recompilation/switch.md' },
  { src: 'docs/arcade-recomp.md', out: 'recompilation/arcade.md' },
];

// Every package README, discovered rather than listed. A new package gets its
// docs page — and its homepage entry, via generated/packages.mjs — with no
// edit here and none in index.mdx. Hardcoding this list was a second drift
// vector alongside the homepage's own hand-written package bullets.
//
// (Line comments, not a block comment: the glob for these paths contains the
// characters that would close one early.)
const PACKAGE_SOURCES = readdirSync(resolve(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(resolve(ROOT, 'packages', e.name, 'README.md')))
  .map((e) => e.name)
  .sort()
  .map((name) => ({ src: `packages/${name}/README.md`, out: `packages/${name}.md`, pkg: name }));

const SOURCES = [...DOC_SOURCES, ...PACKAGE_SOURCES];

/** Directories under OUT_ROOT this script owns entirely — cleared each run
 * so a removed/renamed source doesn't leave an orphaned page behind. Content
 * authored directly in wwwdocs (e.g. content/docs/examples/) is never touched. */
const MANAGED_DIRS = ['start-here', 'guides', 'roadmap', 'recompilation', 'packages'];

/**
 * Turn a doc's opening paragraph into a plain-prose meta description.
 *
 * The raw paragraph is markdown, and in the recompilation series it is mostly
 * *links*: gba-recomp.md opens with one sentence followed by ten
 * `[`psx-recomp.md`](./psx-recomp.md)`-style companion links, so a naive
 * 160-char slice yields a description made almost entirely of link syntax.
 * Strip the markup, then prefer cutting at the first sentence boundary —
 * which for every doc in that series is exactly the one-line summary — and
 * only fall back to a hard truncation when the first sentence is itself long.
 */
function cleanDescription(text) {
  const plain = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> their text
    .replace(/[`*_]/g, '') // code ticks and emphasis
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= 160) return plain;

  // First sentence: a period followed by whitespace and a capital/quote, so
  // "psx-recomp.md, ps2-recomp.md" and "e.g." don't split it.
  const sentenceEnd = plain.search(/\.\s+(?=[A-Z"'(])/);
  if (sentenceEnd > 0 && sentenceEnd + 1 <= 160) return plain.slice(0, sentenceEnd + 1);

  return plain.slice(0, 157).trimEnd() + '...';
}

function frontmatterFor(markdown) {
  const lines = markdown.split('\n');
  let titleLine = -1;
  let title = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      // Strip inline-code backticks: Starlight renders the frontmatter title
      // as plain text in the <h1>, <title> and sidebar, so a heading written
      // as `# \`@seer-project/dungeon\`` otherwise shows its backticks
      // literally in all three places.
      title = m[1].replace(/`/g, '');
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
    description = cleanDescription(paragraphLines.join(' '));
  }

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

  return { page: frontmatter + body, title, description };
}

for (const dir of MANAGED_DIRS) {
  rmSync(resolve(OUT_ROOT, dir), { recursive: true, force: true });
}

let synced = 0;
let skipped = 0;
const packageEntries = [];
for (const { src, out, pkg } of SOURCES) {
  const srcPath = resolve(ROOT, src);
  if (!existsSync(srcPath)) {
    console.warn(`  ⚠ skip (not found): ${src}`);
    skipped++;
    continue;
  }
  const outPath = resolve(OUT_ROOT, out);
  mkdirSync(dirname(outPath), { recursive: true });
  const raw = readFileSync(srcPath, 'utf-8');
  const { page, title, description } = frontmatterFor(raw);
  writeFileSync(outPath, page);
  if (pkg) {
    packageEntries.push({
      name: pkg,
      // The README's own `# @seer-project/x` heading, so the homepage shows
      // the real published name rather than the directory name.
      title,
      description,
      href: `/packages/${pkg}/`,
    });
  }
  synced++;
}

// The homepage's package list, generated from the same READMEs the packages
// pages come from. index.mdx imports this instead of hand-maintaining its own
// bullet list, which had drifted to 6 of 13 packages (omitting engine-3d,
// tracker, audio-dsp, audio-ui, dungeon and both remaining scaffolders).
mkdirSync(GENERATED, { recursive: true });
writeFileSync(
  resolve(GENERATED, 'packages.mjs'),
  '// Generated by wwwdocs/scripts/sync-docs.mjs — do not edit by hand.\n' +
    '// Source: each packages/*/README.md heading and opening paragraph.\n' +
    `export const packages = ${JSON.stringify(packageEntries, null, 2)};\n`,
);

console.log(
  `sync-docs: ${synced} synced, ${skipped} skipped (source not found), ` +
    `${packageEntries.length} packages listed for the homepage`,
);
