#!/usr/bin/env node
/**
 * verify-consumer — typecheck the published packages from outside the workspace.
 *
 * Why this exists: the workspace cannot catch its own packaging bugs. Inside
 * it, imports resolve through npm symlinks straight to `src/`, and every
 * in-house consumer (crawl, middilgard) sets `allowImportingTsExtensions` in
 * its own tsconfig. Both mask problems that only a stranger hits.
 *
 * That is exactly how the packages once shipped `.d.ts` files importing
 * `./binary.ts` — a path `files` never included. Nothing in this repo failed;
 * every consumer installing from the registry would have.
 *
 * So: pack real tarballs, install them into a scratch project with a *default*
 * tsconfig, import from every published entry point, and run `tsc --noEmit`.
 * If the published types don't resolve, this fails.
 *
 * Usage: node scripts/verify-consumer.mjs [--keep]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

// Every package that publishes types, and one exported symbol to import from
// each. Type-only imports are enough: this checks declaration resolution, not
// runtime behaviour, and avoids needing a browser or real game data.
const IMPORTS = {
  '@seer-project/core': 'AtlasFrame',
  '@seer-project/iff': 'parseIff',
  '@seer-project/engine-2d': 'Camera',
  '@seer-project/engine-3d': 'createViewport',
  '@seer-project/pipeline': 'readBinary',
  '@seer-project/smus': 'parseSMUS',
  '@seer-project/tracker': 'Micromod',
  '@seer-project/audio-dsp': 'renderToStereoBuffers',
  '@seer-project/audio-ui': 'AudioBarController',
  '@seer-project/dungeon': 'WalkerOptions',
};

const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && readdirSync(join(ROOT, 'packages', e.name)).includes('package.json'))
  .map((e) => e.name);

const work = mkdtempSync(join(tmpdir(), 'seer-consumer-'));
const tarballs = join(work, 'tarballs');
mkdirSync(tarballs, { recursive: true });
console.log(`workspace: ${work}`);

// --- 1. Pack ----------------------------------------------------------------
// --ignore-scripts: prepack/prepublishOnly would rebuild and re-run the whole
// suite once per package. The caller has already built.
const files = {};
for (const name of packages) {
  const out = run('npm', ['pack', '--ignore-scripts', '--pack-destination', tarballs], join(ROOT, 'packages', name));
  const tgz = out.trim().split('\n').pop().trim();
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
  files[pkg.name] = join(tarballs, tgz);
}
console.log(`packed ${Object.keys(files).length} tarballs`);

// --- 1b. Structural assertion, independent of the typecheck -----------------
// A declaration that imports a `.ts` path is unresolvable for a consumer and is
// the specific regression this script was written for. Assert it directly as
// well as via tsc, so the guarantee does not depend on how much `skipLibCheck`
// happens to suppress in whatever TypeScript version runs below.
const badSpecifier = /from\s+['"]\.\.?\/[^'"]*\.ts['"]/;
const offenders = [];
for (const [name, tgz] of Object.entries(files)) {
  const listing = run('tar', ['-tzf', tgz]).split('\n').filter((p) => p.endsWith('.d.ts'));
  for (const entry of listing) {
    const body = run('tar', ['-xzOf', tgz, entry]);
    if (badSpecifier.test(body)) offenders.push(`${name}: ${entry}`);
  }
}
if (offenders.length) {
  console.error('\n✗ published declarations import .ts paths that are not shipped:');
  for (const o of offenders.slice(0, 20)) console.error(`    ${o}`);
  process.exit(1);
}
console.log('✓ no declaration imports a .ts path');

// --- 2. A scratch consumer, with a deliberately ordinary tsconfig -----------
const proj = join(work, 'consumer');
mkdirSync(proj, { recursive: true });

writeFileSync(
  join(proj, 'package.json'),
  JSON.stringify(
    {
      name: 'seer-consumer-check',
      private: true,
      type: 'module',
      // Cross-package deps pin ^0.1.0 and are not on the registry yet, so every
      // package is declared here as a file: tarball for npm to resolve against.
      dependencies: {
        ...Object.fromEntries(Object.entries(files).map(([n, p]) => [n, `file:${p}`])),
        // Declared peers of the packages above.
        'pixi.js': '^8.9.0',
        three: '^0.185.1',
      },
      devDependencies: { typescript: '~6.0.2' },
    },
    null,
    2,
  ),
);

// No allowImportingTsExtensions, no path mappings, no project references —
// what a consumer actually has.
writeFileSync(
  join(proj, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        // What `tsc --init` generates and what essentially every real consumer
        // uses. Turning it off makes this check fail on third-party conflicts
        // Seer does not control (pixi.js's bundled @webgpu/types colliding with
        // TypeScript's own WebGPU lib types, for one) rather than on Seer's own
        // packaging. Resolution failures inside Seer's declarations still
        // surface, because index.ts below imports a concrete symbol from each
        // package — TypeScript has to walk the declaration chain to find it.
        skipLibCheck: true,
      },
      include: ['index.ts'],
    },
    null,
    2,
  ),
);

writeFileSync(
  join(proj, 'index.ts'),
  Object.entries(IMPORTS)
    .map(([mod, sym]) => `import type { ${sym} as ${sym}_ } from '${mod}';`)
    .join('\n') + '\nexport {};\n',
);

// --- 3. Install and typecheck ----------------------------------------------
console.log('installing tarballs...');
run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], proj);

console.log('typechecking as a consumer...');
try {
  run('npx', ['tsc', '--noEmit'], proj);
} catch {
  console.error('\n✗ published types do NOT resolve for a consumer.');
  console.error(`  Kept for inspection: ${proj}`);
  process.exit(1);
}

console.log('✓ published types resolve with a default tsconfig');
if (!KEEP) rmSync(work, { recursive: true, force: true });
else console.log(`kept: ${work}`);
