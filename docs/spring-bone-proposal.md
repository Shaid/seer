# Cloth/hair spring-bone physics — scoping + implementation record

**Status: `engine-3d` runtime implemented and tested; chimera and flower
rollout both shipped.** This document replaces the single entry that used to
live in `docs/todos.md` — see that file's own history for the original
request.

## Context

Two seer-framework projects need cloth/hair to sway during animated
playback instead of staying frozen at rest pose:

- **`chimera`** (Fire Emblem: Three Houses / Warriors / Three Hopes / Engage
  character viewer) — the original requester. Koei Tecmo G1M models carry
  `ONUN`/`VNUN`/`SNUN` cloth-physics sections that `g1m.ts` skips entirely;
  chimera's own `docs/TODO.md` row `g1m-nun-cloth` tracks the format-level
  decode work, which stays out of scope here.
- **`flower`** (Drakengard/Drakengard 2/Drakengard 3/NieR/NieR
  Automata/Devil May Cry/Chaos Legion/Zone of the Enders 2) — named in the
  original request, confirmed by survey to have the strongest immediate
  payoff: Drakengard 3 alone has 501 of 1,122 skinned glTFs with real,
  semantic dangly-chain bone names (`C_MANT1..4`, `L_HAIR1..2`,
  `R_SLEEVE1..4`, `*_SKIRT*`, `*_TAIL*` — 14,266 name hits across the
  corpus), and 674 of those 1,122 skinned meshes ship with **zero** baked
  animation clips, rendering as a frozen bind pose today.

A three-survey pass (engine-3d's animation architecture, flower's D3 corpus,
chimera's G1M/glTF pipeline) surfaced two facts that shaped the design:

- **The two projects have exactly opposite inputs.** flower's rigs have real
  bone names but zero authored physics parameters (umodel `PROP_DROP`s every
  UE3 cloth property at parse time, and the corpus's `ApexClothingAsset`
  objects never survive extraction). chimera's rigs have authored physics
  data waiting to be decoded (`NUN` sections) but **no bone names at all** —
  the exporter synthesizes `bone0`, `bone1`, ... — and worse, the same index
  (`bone124`) names a *different* physics chain in different GLBs for the
  same character (Byleth's body vs. head skin, confirmed by chimera's own
  measurement). A name-keyed config is therefore only ever valid for the one
  GLB it describes.
- **A large slice of the payoff needs no reverse engineering at all.**
  chimera already has a corpus-verified, 100%-precise discriminator for
  NUN-driven cloth (`world[boneId] × matrices[matrixId] != identity` — 9,332
  of 117,842 bone binds, 661 of 3,125 LOD0 submeshes across 167 models) that
  identifies *which* bones are cloth without decoding what drives them.

**Decision:** the config belongs baked into the asset (glTF `extras`), not
authored per-character, with an explicit opt-in name-based guess as a
fallback for rigs (like flower's) that have real names but no baked data.
Decoding `NUN`/APEX stays separate follow-up work in each consumer's own
TODO.

## What shipped in `engine-3d`

`packages/engine-3d/src/spring-bones.ts` — a dependency-free, hand-rolled
verlet solver (no `@pixiv/three-vrm`; three's math classes are pure JS, so
the whole thing unit-tests under plain Node, no jsdom):

- `createSpringBoneSolver(root, config, opts?)` — resolves `config`'s chains
  against real nodes under `root`. A chain's joints must form an actual
  parent→child line in the scene graph (the technique works by rotating
  joint `i` to reposition joint `i+1`); a joint whose declared next joint
  doesn't resolve becomes that chain's effective tip rather than failing the
  whole chain. `solver.step(dt)` integrates via a **fixed-timestep
  accumulator** (default `1/60`, capped at 4 sub-steps per call) so behavior
  doesn't change under the frame-limiter's adaptive 60→30fps fallback —
  verified by a determinism test (two `1/60` steps bit-match one `1/30`
  step) and a stall-clamp test (a 250ms gap simulates exactly 4 sub-steps,
  not 15).
- Sphere and capsule colliders, resolved twice per sub-step (once after the
  force integration, once more after the length re-anchor pulls the tail
  back toward a collider it was just pushed out of) — cheap
  positional-constraint-style iteration, not a second physical effect.
- `readSpringBoneConfig(object)` reads `object.userData.SEER_spring_bones` —
  a plain custom-data key, not a registered glTF extension. Confirmed
  (Phase 0 probe) that three 0.185.1's `GLTFLoader` already copies scene-
  and node-level `extras` into `userData` (`GLTFLoader.js:4439`, `:4368`),
  so no loader changes were needed.
- `deriveSpringBonesFromNames(root, opts?)` guesses a config from the common
  `hair`/`mant`/`cape`/`skirt`/`sleeve`/`tail`/`wing`/`scarf`/`cloth`/
  `ribbon`/`chain`/`belt`/`rope`/`swing`/`jiggle` vocabulary, following
  single-child `THREE.Bone` descent. Correctly returns `null` for chimera's
  `bone0..N` rigs — there's nothing to pattern-match, and guessing off pure
  indices would be a coin flip, not an approximation. Never applied
  automatically.
- `excludeAnimatedChains(config, animatedNodeNames)` — pure, drops any chain
  containing a bone the active clip already keyframes. Needed because 448 of
  flower's D3 skeletal meshes have cape/hair motion **already fully baked**
  into their clips (one sampled clip keyframes all 40 mantle/hair/sleeve
  bones, rotating 30°–80.6°); simulating on top would double the motion.

`session.ts` wiring: `setSpringBones(opts)` / `springBones` getter /
`stepSpringBones(dt)`, plus `AnimationController.animatedNodeNames(clipName?)`
(via `THREE.PropertyBinding.parseTrackName`, not a naive
`track.name.split('.')`, since a node name can itself contain dots). Spring
bones **reset to `false` on every `setModel`** — a third category alongside
the existing "resets" (shading/smooth/subdivision) vs. "persists"
(textureFilter/shadows/cinematic) axis, since a cloth rig is resolved
against one specific model's bone names and isn't portable to the next.
Re-resolved automatically by `setExternalAnimations`, since the
animated-bone exclusion set can change with the clips.

`mesh-viewer-ui`: optional `springBonesCheckbox`/`springBonesStrengthRange`
elements on `MeshSettingsPanel` (omitted by every existing consumer's
markup — purely additive) and a `springBoneOptions(session)` hook so a host
decides whether to pass `{ autoDerive: true }`. `RenderSettingsPanel`'s
turntable-recording `CaptureSource` now also drives
`session.animation?.update(1/fps)` and `session.stepSpringBones(1/fps)` —
**a pre-existing, unrelated bug found during this work**: the recording
driver only ever advanced the turntable, never the animation mixer, so an
animated asset recorded as a single frozen frame repeated for the whole
clip's duration. Fixed alongside the new spring-bones call, since both are
the same "`renderNow()` skips every frame hook, so an exporter must drive
per-frame state by hand" issue.

## Known gaps — stated, not papered over

- No authored cloth parameter from either game is used; every stiffness/
  damping/gravity value is a chosen default. This is an approximation, the
  same honesty standard `mesh-shading.ts`'s `'indexedRamp'` mode holds
  itself to.
- Koei Tecmo `ONUN`/`VNUN`/`SNUN` stay undecoded — chimera's `g1m-nun-cloth`
  TODO row, including the open hypothesis that NUN appends virtual driver
  bones past `totalBoneCount`. Three Hopes' `QGWS` "swing data" resource
  (399 records, one preset `def014` shared by 219 of them) is the strongest
  lead that this engine family stores cloth as named presets rather than
  per-bone values.
- UE3 cloth needs a `PROP_DROP`→real-field patch to flower's vendored
  UEViewer, or a UELib-driver property walk, to recover anything real from
  `ApexClothingAsset`/legacy `SkeletalMeshCloth` data.
- **Pre-existing, unrelated, found during the survey:**
  `mesh-polish.ts`'s `subdivideGeometry` rebuilds geometry copying only
  `position` and `uv` — `skinIndex`/`skinWeight` are dropped, so
  `session.setSubdivision(n > 0)` already breaks skinning on any
  `SkinnedMesh`. Not caused by this work and not fixed by it; worth its own
  TODO row.

## Rollout

chimera and flower each adopted this in their own commit, independently
verified — same discipline as the render-quality-proposal.md rollout. See
each project's own TODO for status.

- **flower**: `autoDerive: true` wired into `tools/viewer/viewer.ts` — D3's
  real bone names (`C_MANT1..4`/`L_HAIR1..2`/etc.) are guessed at load time,
  no format-level change needed. Not wired into `MeshViewer.astro` (every
  mesh that component ships already has cape/hair baked into clips). TODO row:
  `docs/drakengard3/TODO.md`'s `dod3-cloth-physics-authored-params`.
- **chimera**: no bone names to guess from, so this is baked-config only.
  `src/data/formats/gltf-builder.ts` gained scene-level `extras` support (a
  new "additive and optional" `GltfJson` field, following the
  `normalTexture`/`occlusionTexture` precedent); `src/data/formats/g1m-gltf.ts`
  gained an opt-in `clothConfig` gate (mirroring `rampTextures`'s per-game
  gating) that groups the existing MM1G non-identity-composite discriminator's
  flagged bones into `SEER_spring_bones` chains — no NUN decode. Wired only
  from `tools/fe-threehouses/build-meshes.ts` (Three Houses only; FE Warriors
  and Three Hopes omit it, byte-identical output preserved). TODO row:
  `docs/TODO.md`'s `fe3h-cloth-physics-approximation`.
