# @seer-project/mesh-viewer-ui

Shared mesh-viewer settings-panel UI chrome.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

This package unifies the **UI layer only** — the settings-panel popover a
mesh viewer opens from one toolbar button, collecting render mode, shading
override, smooth/flat normals, subdivision, texture filtering + anisotropy,
and reset-camera into a single place instead of a row of individual toolbar
controls. It does **not** implement any of that behavior itself — every
control is a thin wire from a DOM element to the matching
`@seer-project/engine-3d` `MeshSession` method
(`setRenderMode`/`setShading`/`setSmooth`/`setSubdivision`/
`setTextureFilter`/`fit`). See that package's README for what each of those
actually does to a `Model3D`.

## Installation

```bash
npm install @seer-project/mesh-viewer-ui @seer-project/engine-3d three
```

## `MeshSettingsPanel` — the settings-popover controller

Construct once, against a fixed set of DOM elements the host already
authored (matching the shape a toolbar "⚙ Settings" button + popover
naturally has):

```html
<button id="mesh-settings-toggle" type="button">⚙ Settings</button>
<div id="mesh-settings-panel" class="hidden">
  <label>Render mode <select id="mesh-render-mode">
    <option value="textured">Textured</option>
    <option value="faces">Faces</option>
    <option value="wireframe">Wireframe</option>
    <option value="points">Points</option>
  </select></label>
  <label><input id="mesh-smooth" type="checkbox" /> Smooth shading</label>
  <label>Shading <select id="mesh-shading">
    <option value="lit">Lit</option>
    <option value="unlit">Unlit texture</option>
    <option value="normals">Normals</option>
    <option value="depth">Depth</option>
    <option value="toon">Toon</option>
  </select></label>
  <label>Subdivide <select id="mesh-subdivide">
    <option value="0">0×</option>
    <option value="1">1×</option>
    <option value="2">2×</option>
    <option value="4">4×</option>
    <option value="8">8×</option>
  </select></label>
  <label>Texture filter <select id="mesh-texture-filter">
    <option value="nearest">Pixelated</option>
    <option value="linear">Smooth</option>
    <option value="trilinear" selected>Smooth (mipmapped)</option>
  </select></label>
  <label>Anisotropy <select id="mesh-anisotropy"></select></label>
  <button id="mesh-reset-camera" type="button">Reset camera</button>
  <label><input id="mesh-spring-bones" type="checkbox" /> Cloth/hair physics</label>
  <label>Strength <input id="mesh-spring-bones-strength" type="range" min="0" max="1" step="0.01" value="1" /></label>
</div>
```

`textureFilterSelect`'s `<option>` values must be exactly
`'nearest'\|'linear'\|'trilinear'` (`TextureFilterMode`'s three values) —
label text is entirely up to the host. `anisotropySelect` should be created
empty; `refresh()` populates it from the attached session's own
`getMaxAnisotropy()`.

`springBonesCheckbox`/`springBonesStrengthRange` are **optional** — omit both
entirely for a host that doesn't want cloth/hair physics UI (every existing
consumer, until one opts in). See `MeshSettingsPanelOptions.springBoneOptions`
below for how the checkbox maps to `session.setSpringBones()`'s config.

```ts
import { MeshSettingsPanel } from '@seer-project/mesh-viewer-ui';

const settingsPanel = new MeshSettingsPanel({
  toggleBtn: document.getElementById('mesh-settings-toggle') as HTMLButtonElement,
  panel: document.getElementById('mesh-settings-panel')!,
  renderModeSelect: document.getElementById('mesh-render-mode') as HTMLSelectElement,
  smoothCheckbox: document.getElementById('mesh-smooth') as HTMLInputElement,
  shadingSelect: document.getElementById('mesh-shading') as HTMLSelectElement,
  subdivideSelect: document.getElementById('mesh-subdivide') as HTMLSelectElement,
  textureFilterSelect: document.getElementById('mesh-texture-filter') as HTMLSelectElement,
  anisotropySelect: document.getElementById('mesh-anisotropy') as HTMLSelectElement,
  resetCameraBtn: document.getElementById('mesh-reset-camera') as HTMLButtonElement,
  // Optional — omit both to leave cloth/hair physics out of the panel entirely.
  springBonesCheckbox: document.getElementById('mesh-spring-bones') as HTMLInputElement,
  springBonesStrengthRange: document.getElementById('mesh-spring-bones-strength') as HTMLInputElement,
}, {
  // A host whose rigs have real bone names (e.g. flower's Drakengard 3
  // `C_MANT1`/`L_HAIR1`-style chains) can ask engine-3d to guess a config;
  // one relying solely on a baked `SEER_spring_bones` glTF config (e.g.
  // chimera's nameless `bone0`/`bone1`/... rigs) omits this option entirely.
  springBoneOptions: () => ({ autoDerive: true }),
});
```

Then, on every mesh asset selection (after `session.setModel()` resolves):

```ts
const session = createMeshSession(viewport, opts);
const model = await loadGltfModel(url);
session.setModel(model);
settingsPanel.attach(session); // shows the toggle button, syncs every control
```

And on switching away from a mesh asset:

```ts
settingsPanel.detach(); // hides the toggle button, closes the panel
session.dispose();
```

If the host loads a *second* model into an *already-attached* session (a
placed-scene host cycling models through one long-lived `MeshSession`, say),
call `settingsPanel.refresh()` after that `setModel()` too — a session's
`renderMode`/`shading`/`smooth`/`subdivision` all reset on every model load,
so the panel needs to be told to re-read them. `textureFilter` is the one
exception: it's a persisted viewer-wide preference (see
`MeshSession.setTextureFilter`'s docs in `@seer-project/engine-3d`), so it
survives model switches with no `refresh()` needed for it specifically.

### Reset-camera and per-asset camera persistence

The reset-camera button calls `session.fit()` by default. A host with its
own per-asset camera persistence (e.g. a `localStorage` entry keyed by asset
path — see flower's/hunter's original `saveMeshCamera`/`restoreMeshCamera`)
passes `onResetCamera` instead:

```ts
new MeshSettingsPanel(elements, {
  onResetCamera(session) {
    localStorage.removeItem(cameraKeyFor(currentAsset));
    session.fit();
    saveMeshCamera(session, cameraKeyFor(currentAsset));
  },
});
```

### Popover behavior

The panel opens on a `toggleBtn` click and closes on: a second click, a
pointerdown anywhere outside `panel`/`toggleBtn`, or `Escape`. All of this is
bound once in the constructor — a host never needs to wire it itself. The
toggle/outside-click/Escape logic itself is `@seer-project/canvas-export`'s
`createPopover`, shared with that package's own future export controls —
this package depends on the generic one, not the other way around.

### Keeping a sibling `RenderSettingsPanel` in sync

`MeshSettingsPanel` and `RenderSettingsPanel` are independent — neither
holds a reference to the other. But `RenderSettingsPanel.refresh()` gates
its `photo` quality option and shadows checkbox off `session.renderMode`/
`session.shading`, both of which only change through this panel's render
mode and shading controls. A host running both panels together (one
toolbar, two popovers) should wire `onChange` to the sibling's `refresh()`
so a change made in one panel is reflected in the other:

```ts
const meshPanel = new MeshSettingsPanel(meshElements, {
  onChange: () => renderPanel.refresh(),
});
const renderPanel = new RenderSettingsPanel(renderElements, {
  watermarkText: (session) => `${assetName} — ${gameName}`,
  onChange: () => meshPanel.refresh(),
});
```

`onChange` fires only after an interactive control change this panel itself
applies to the session (not from `refresh()` itself), so the two panels
can't recurse into each other. A host that only ever shows one of the two
panels can omit `onChange` entirely — the same optional, backward-compatible
allowance as `onResetCamera`/`springBoneOptions`.

## `RenderSettingsPanel` — cinematic rendering, photo mode, and export

A second, independent popover controller for the render-quality tiers
`@seer-project/engine-3d` adds on top of the plain `flat` renderer —
shadows, cinematic postprocessing (bloom/AO/DOF), progressive path-traced
photo mode — plus the two export actions (screenshot, turntable video).
Same host-owns-the-markup / `attach`/`refresh`/`detach`/`dispose` contract
as `MeshSettingsPanel`, built against its own toolbar toggle so the two
panels can be opened independently:

```html
<button id="render-settings-toggle" type="button">🎬 Render</button>
<div id="render-settings-panel" class="hidden">
  <label>Quality <select id="render-quality">
    <option value="flat">Flat</option>
    <option value="cinematic">Cinematic</option>
    <option value="photo">Photo</option>
  </select></label>
  <label><input id="render-shadows" type="checkbox" /> Shadows</label>
  <div id="render-cinematic-options" class="hidden">
    <label><input id="render-bloom" type="checkbox" /> Bloom</label>
    <label><input id="render-ao" type="checkbox" /> Ambient occlusion</label>
    <label><input id="render-dof" type="checkbox" /> Depth of field</label>
  </div>
  <div id="render-photo-status" class="hidden">
    <span id="render-photo-status-text"></span>
  </div>
  <button id="render-screenshot" type="button">📷 Screenshot</button>
  <button id="render-record-turntable" type="button">⏺ Record turntable</button>
</div>
```

`qualitySelect`'s `<option>` values must be exactly
`'flat'\|'cinematic'\|'photo'`. `cinematicOptionsRow`/`photoModeRow` are
whatever wrapper element holds each tier's sub-controls — `refresh()`
toggles their `hidden` class, it doesn't create or remove elements.

```ts
import { RenderSettingsPanel } from '@seer-project/mesh-viewer-ui';

const renderPanel = new RenderSettingsPanel(
  {
    toggleBtn: document.getElementById('render-settings-toggle') as HTMLButtonElement,
    panel: document.getElementById('render-settings-panel')!,
    qualitySelect: document.getElementById('render-quality') as HTMLSelectElement,
    shadowsCheckbox: document.getElementById('render-shadows') as HTMLInputElement,
    cinematicOptionsRow: document.getElementById('render-cinematic-options')!,
    bloomCheckbox: document.getElementById('render-bloom') as HTMLInputElement,
    aoCheckbox: document.getElementById('render-ao') as HTMLInputElement,
    dofCheckbox: document.getElementById('render-dof') as HTMLInputElement,
    photoModeRow: document.getElementById('render-photo-status')!,
    photoModeStatus: document.getElementById('render-photo-status-text')!,
    screenshotBtn: document.getElementById('render-screenshot') as HTMLButtonElement,
    recordTurntableBtn: document.getElementById('render-record-turntable') as HTMLButtonElement,
  },
  {
    // Only the host knows asset/game/platform names.
    watermarkText: (session) => `${assetName} — ${gameName} (${platformName}) — a seer project`,
    fileName: (session) => assetName,
    turntable: { durationSeconds: 4, fps: 30 },
  },
);

renderPanel.attach(session); // after session.setModel() resolves, same timing as MeshSettingsPanel
```

The **export buttons contain no capture/encoding logic** — they build a
`@seer-project/canvas-export` `CaptureSource`/watermark/recording driver
from the attached session and call straight into `downloadScreenshot`/
`recordClip`+`downloadClip`. The turntable recording is deterministic and
decoupled from wall-clock time (`recordClip` captures explicit frames, not
a real-time stream) — see `@seer-project/engine-3d`'s `turntable.ts` docs
for how `Turntable.step()` composes with it. The recording `CaptureSource`
also drives `session.animation?.update(1/fps)` and `session.stepSpringBones(1/fps)`
on every captured frame, alongside the turntable — `viewport.renderNow()`
deliberately skips every frame hook and `onFrame` (see its own doc comment),
so a recorded clip must advance the mixer and any active spring-bone solver
by hand or an animated/clothed asset would record as a single frozen frame
repeated for the whole clip.

Photo mode is an **optional feature**: `three-gpu-pathtracer` is an
optional peer dependency of `engine-3d`, and the `photo` `<option>` is
disabled (with a tooltip) whenever it isn't installed, or whenever the
session's current render mode is `'wireframe'`/`'points'` (nothing for a
path tracer to shade). The shadows checkbox is similarly disabled (with a
tooltip) under any shading mode that swaps in a material insensitive to
lighting (`'unlit'`/`'normals'`/`'depth'`) or under `'wireframe'`/`'points'`
render modes — toggling it there would be a real no-op, not just a
confusing one.

Elements past the required fields are optional the same way
`MeshSettingsPanel`'s are — a host can ship a reduced panel (e.g. no
bloom/AO/DOF sub-toggles, no photo-mode status text) by never wiring those
elements up in its own markup and simply not including them in the
`RenderSettingsPanelElements` object, as long as the required ones are
present.

## Testing

```bash
npm test
```

`jsdom`-based; no real three.js session or WebGL context is exercised here
(`@seer-project/engine-3d`'s own `session.test.ts` covers the state this
package's controls drive).

## Licensing & Commercial Use

Seer exists to reverse-engineer other people's work, and that is only possible
because the preservation and romhacking communities published what they found
instead of keeping it. The licence is chosen so that keeps happening: build on
Seer and your work stays open too, so the next person gets the same head start.

- **[AGPL-3.0-or-later](https://github.com/Shaid/seer/blob/main/LICENSE)** —
  free for personal, educational and open-source use. Note that the AGPL extends
  copyleft to **network use**: run a public web app or hosted service on this
  and you must publish your application's source under the AGPL.
- **Commercial licence** — waives that requirement so a proprietary or
  closed-source product can keep its codebase private. Flat-fee and subscription
  terms are available, and custom terms are negotiable.

If the copyleft doesn't fit what you're building, we would much rather have the
conversation than have you walk away — email
[dr.shaid@gmail.com](mailto:dr.shaid@gmail.com) with the subject
`[Commercial License Request - Project Name]`.

Full details: <https://seer.shaid.net/start-here/licensing/>.
