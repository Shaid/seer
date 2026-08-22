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
</div>
```

`textureFilterSelect`'s `<option>` values must be exactly
`'nearest'\|'linear'\|'trilinear'` (`TextureFilterMode`'s three values) —
label text is entirely up to the host. `anisotropySelect` should be created
empty; `refresh()` populates it from the attached session's own
`getMaxAnisotropy()`.

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
