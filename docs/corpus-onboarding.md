# Seer corpus onboarding

This is the starting point for a person or agent joining the Seer reverse-
engineering corpus. It explains where the framework lives, how the game
projects are organised, how evidence is recorded, and which RE profiles to use
for Claude, Codex, and OpenCode.

The central rule is simple: reverse-engineer the original data first, convert
it offline into web-native assets, and make the browser consume those assets.
The extraction pipeline is the product; the browser is its consumer.

## 1. The workspace map

The shared framework is:

```text
~/Development/seer/
```

Its important areas are:

| Path | Role |
| --- | --- |
| `packages/` | Reusable `@seer-project/*` libraries and the app scaffolder |
| `docs/` | Framework architecture, package status, walker design, and RE guidance |
| `src/` | The browser-side starter runtime |
| `tools/` | The starter project's offline pipeline |
| `wwwdocs/` | The generated documentation site |

The currently integrated game/research repositories are:

| Repository | Main corpus | Corpus reference |
| --- | --- | --- |
| `~/Development/crawl` | Black Crypt, Eye of the Beholder 1–3, Lands of Lore, Dungeon Hack, Might & Magic 1–3, Wizardry 6 | `~/.claude/agents/game-re-corpora/crawl.md` |
| `~/Development/middilgard` | War in Middle Earth, Spirit/Vengeance of Excalibur, Conan, Warriors of Legend | `~/.claude/agents/game-re-corpora/middilgard.md` |
| `~/Development/wyrm` | Dune, KGB | `~/.claude/agents/game-re-corpora/wyrm.md` |
| `~/Development/hunter` | Carrier Command, Hunter, Epic, Frontier: Elite II, Wings, Gunship 2000 AGA, Midwinter, Embryo | `~/.claude/agents/game-re-corpora/hunter.md` |
| `~/Development/strike` | Desert, Jungle, and Urban Strike across Amiga, Genesis, and SNES | `~/.claude/agents/game-re-corpora/strike.md` |
| `~/Development/sorcery` | Wizardry 6: Bane of the Cosmic Forge | `~/.claude/agents/game-re-corpora/sorcery.md` |
| `~/Development/nicodemus` | Phantasie I–III | `~/.claude/agents/game-re-corpora/nicodemus.md` |
| `~/Development/ceres` | Final Fantasy IV–VI on SNES | `~/.claude/agents/game-re-corpora/ceres.md` |
| `~/Development/flower` | Drakengard, NieR, Dragon's Crown, ZOE2, Chaos Legion, Devil May Cry | `~/.claude/agents/game-re-corpora/flower.md` |
| `~/Development/valkyrie` | Valkyrie Profile, Valkyrie Profile 2, Lenneth | `~/.claude/agents/game-re-corpora/valkyrie.md` |
| `~/Development/vanille` | Odin Sphere, Grim Grimoire, and related Vanillaware titles | `~/.claude/agents/game-re-corpora/vanille.md` |
| `~/Development/chimera` | Astral Chain and Fire Emblem titles on Switch | `~/.claude/agents/game-re-corpora/chimera.md` |
| `~/Development/drakkhen` | Drakkhen on Amiga and Atari ST | `~/.claude/agents/game-re-corpora/drakkhen.md` |

The corpus table is maintained by the Claude `game-re` definition. If a
project has been merged or renamed, inspect its current repository README and
the corpus file before relying on historical notes.

## 2. Read this first

For framework orientation, read these in `~/Development/seer/`:

1. `README.md` — workspace commands and package overview.
2. `docs/architecture-overview.md` — data-file-first architecture and the
   four-zone dependency boundary.
3. `docs/project-status.md` — package stability and the pre-1.0 contract.
4. `docs/walker.md` — the shared first-person dungeon model and its evidence
   requirements.
5. `docs/common-tooling-candidates.md` — what has already been extracted into
   shared packages and what should remain game-specific.

For a specific game, enter its repository and read, before touching bytes:

1. `AGENTS.md`, if present.
2. The project `README.md` and package scripts.
3. The project corpus reference listed above.
4. `docs/<game>/TODO.md` — the current open-work surface.
5. `docs/<game>/<platform>/data-structure.md` — the format source of truth.
6. The relevant platform and method references under
   `~/.claude/agents/game-re-tooling/` and
   `~/.claude/agents/game-re-method/`.

Do not start with an old session note or a speculative comment in a disassembly
file when a current format specification exists. Historical notes are useful
for paths tried, not authoritative status.

## 3. Seer project anatomy

Each game repository normally separates work as follows:

```text
data/<game>/<platform>/       original files; user-supplied and ignored
tools/                        committed TypeScript extraction and rendering
scripts/                      committed Python or specialised offline tools
src/                          committed browser runtime
public/assets/<game>/<platform>/ generated JSON, PNG, WAV, and manifests
build/cache/<game>/           decompressed and other non-web intermediates
docs/<game>/<platform>/       byte-level format specifications
```

Original files must not be modified by extractors and must not be committed.
Generated assets are reproducible output. Browser code must not import Node-only
pipeline code. Shared game-agnostic logic belongs in the appropriate
`@seer-project/*` package; game-specific decoders stay in the consuming
repository.

The shared package most relevant to dungeon crawlers is
`@seer-project/dungeon`. It provides level/schema types, poses, collision,
view-list construction, raster compositing, animation, props, interaction,
automaps, presenters, and the `Walker` facade. `crawl` links the local Seer
packages with `file:../seer/...`, so build the Seer packages before diagnosing
consumer import failures.

## 4. A first working session

Use this sequence for a new task:

```bash
cd ~/Development/<project>
git status --short --branch
rg --files docs tools scripts src | sed -n '1,160p'
sed -n '1,220p' AGENTS.md                 # if present
sed -n '1,220p' docs/<game>/TODO.md       # if present
```

Then:

- identify the exact game/platform and original-data directory;
- inspect file sizes, magic, strings, likely containers, and sibling-file
  differences;
- find the game's reader and consumer before guessing a format;
- search the corpus and sibling repositories for the same engine or codec;
- read any matching lesson before trusting a decode;
- record every failed approach in the format's paths-tried table;
- implement the smallest reusable extractor and add a structural or external
  oracle;
- regenerate only the scoped assets and merge manifests safely;
- run the narrowest relevant test first, then the project suite;
- update `docs/<game>/TODO.md` last.

Common commands include:

```bash
# Seer framework
cd ~/Development/seer
npm test
npm run build
npm run probe -- triage <corpus>

# A consuming project
cd ~/Development/crawl
npm test
npm run extract-data -- --game wizardry6
npx tsx tools/wizardry6/export-dungeon-levels.ts data/wizardry6/amiga
npm run mm2:data
```

Check each repository's `package.json` before using a command; extraction
scripts and required original files differ by game and platform.

## 5. Evidence and documentation rules

Use these confidence labels consistently:

- **confirmed** — verified against an emulator screenshot or memory dump, a
  cross-platform port, a trusted third-party decoder, or a zero-deviation
  structural invariant;
- **rendered** — produces coherent pixels or audio but lacks an independent
  oracle;
- **hypothesis** — plausible, unresolved, or inferred from weak evidence.

The game's reader is the authoritative specification. Follow data from file
bytes through loader, endian conversion, relocation, decompression, fixups, and
the final blitter/DMA/field consumer. State whether every offset is file,
segment-relative, runtime, or decompressed-buffer-relative.

Format specs should use byte-level tables and cite disassembly labels plus
file/line. When a premise is overturned, retain the old path as a documented
dead end and add a `> **Correction:**` block. Keep one current status row per
open item in `docs/<game>/TODO.md`; put detailed evidence and paths tried in
`data-structure.md`. A solved TODO row is removed rather than left as stale
history.

## 6. Agent and skill routing

These profiles share the same RE discipline but are installed for different
hosts. Supporting corpus, tooling, method, and lesson files should be read in
place rather than copied.

### Claude

- Main agent: `~/.claude/agents/game-re.md`
- Bounded escalation: `~/.claude/skills/re-codebreaker/SKILL.md`
- Last-resort synthesis: `~/.claude/skills/re-oracle/SKILL.md`
- Corpus index: `~/.claude/agents/game-re-corpora/`
- Platform/tooling: `~/.claude/agents/game-re-tooling/`
- Techniques: `~/.claude/agents/game-re-method/`
- Pitfalls: `~/.claude/agents/game-re-lessons/`

Claude's escalation ladder is base `game-re` → `re-codebreaker` for a hard,
bounded problem → `re-oracle` for corpus-wide synthesis, contradictions, or a
problem that defeated codebreaker. Escalations must receive a self-contained
brief with exact paths, offsets, attempts, invariants, oracle, and one question.

### Codex

The Codex copies for this workspace are:

- `~/Development/crawl/codex-skills/game-re/SKILL.md`
- `~/Development/crawl/codex-skills/re-codebreaker/SKILL.md`
- `~/Development/crawl/codex-skills/re-oracle/SKILL.md`

Their configured routing is `game-re` → `luna` with high reasoning,
`re-codebreaker` → `terra`, and `re-oracle` → `sol`. These copies reference the
Claude corpus/tooling/lesson libraries in place. They are stored in the crawl
repository because the managed `~/.codex/skills/` directory is read-only in the
current environment; do not assume they are globally installed for another
Codex workspace.

### OpenCode

The global OpenCode profiles are:

- Main agent: `~/.config/opencode/agents/game-re.md`
- Bounded escalation: `~/.config/opencode/skills/re-codebreaker/SKILL.md`
- Last-resort synthesis: `~/.config/opencode/skills/re-oracle/SKILL.md`
- Amiga specialist: `~/.config/opencode/agents/amiga-disasm.md`

The current OpenCode model routing is recorded in those files: the main agent
(`game-re`) uses `opencode-go/deepseek-v4-pro`; the escalation skills declare
their own stronger models in front-matter (`re-codebreaker` = `open-ai/terra`,
`re-oracle` = `open-ai/sol`). **Known routing caveat (2026-08-20):** invoking a
codebreaker/oracle escalation as a `game-re` subagent with instructions to
load the skill does **not** honor the skill's `model:` field — the fork runs
on the `game-re` agent's own model (`deepseek-v4-pro`) instead of terra/sol.
To guarantee the declared model, the skill must be invoked in a way that
honours its front-matter `model` (or the routing fixed so the subagent path
picks it up). The crawl repository also has `.opencode/skills/amiga-re.md`, a
project-local Amiga profile; it is not a replacement for the global generic
`game-re` agent.

## 7. Escalation brief template

Before escalating, write down at least two genuinely different failed paths.
Use this shape:

```text
Project root:
Game/platform:
Single question:
Exact files and offsets:
Known invariants:
Ground-truth oracle:
Attempt 1 and concrete failure:
Attempt 2 and concrete failure:
What the specialist must return:
```

The specialist is not a substitute for verification. Integrate its finding,
check it against the available oracle, update the format spec and TODO, and
report the exact TODO delta.

## 8. Safety and handoff

Preserve existing worktree changes and inspect `git status` before and after a
task. Never use destructive repository commands without explicit authorization.
Never overwrite original data. Treat generated assets and caches as
regenerable. If live ground truth is unavailable, say exactly which measurement
is missing and label the result honestly rather than upgrading a plausible
render to confirmed.

A good handoff contains the decoded format and confidence, quantitative
verification, open questions and paths tried, files written, tests run, and
the exact TODO row changes. The next agent should be able to continue from the
docs without reconstructing the session from chat history.
