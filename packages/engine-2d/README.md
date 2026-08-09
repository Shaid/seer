# @seer-project/engine-2d

PixiJS-based 2D runtime engine with camera, input, and display management.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Provides the core game loop, camera system, input handling, and helper
utilities for rendering reverse-engineered game content in the browser.
Intentionally minimal — it demonstrates the *shape* of a runtime engine
without assuming your game is a side-scroller, strategy map, or anything
else.

Named `-2d` to sit alongside [`@seer-project/engine-3d`](https://www.npmjs.com/package/@seer-project/engine-3d)
(a Three.js-based counterpart for games with true 3D/vector models — glTF
and a `{verts,edges,faces}` polygon adapter, extracted from the `flower` and
`hunter` sibling projects) as a separate package rather than a subpath of
one — each pulls in a different heavy rendering dependency (`pixi.js` here,
`three` there), and most consuming projects only ever need one of the two.

## Installation

```bash
npm install @seer-project/engine-2d pixi.js
```

Requires `pixi.js ^8.9.0` as a peer dependency.

## Usage

```ts
import { createGame } from '@seer-project/engine-2d';

const game = await createGame({
  container: document.getElementById('game-container')!,
  worldWidth: 2048,
  worldHeight: 2048,
  onInit: (g) => {
    // Load assets, build sprite layers, tilemaps, etc.
  },
  onUpdate: (g) => {
    // Per-frame game logic.
  },
});
```

### `Game` class

The `Game` class orchestrates a PixiJS `Application`, wiring together
the camera, input manager, and ticker-driven update loop.

| Property | Type | Description |
| --- | --- | --- |
| `stage` | `Container` | Root PixiJS stage — add your sprites here |
| `camera` | `Camera` | Viewport pan/zoom controller |
| `input` | `InputManager` | Unified keyboard + mouse input |

### `Camera`

Viewport management with pan, zoom (cursor-anchored), and bounds clamping.
Tracks dirty state for rendering optimizations.

| Method | Description |
| --- | --- |
| `pan(dx, dy)` | Move the camera by a delta |
| `zoomTo(newZoom, cx, cy?)` | Zoom to a level, anchored at a point |
| `follow(x, y)` | Center the camera on a world coordinate |
| `setViewSize(w, h)` | Update viewport dimensions (call on resize) |
| `clampToBounds()` | Enforce world bounds |

### `InputManager`

Unified input handling with keyboard panning (WASD/arrows), edge scrolling,
click/drag-to-scroll, wheel zoom, and key action bindings.

| Method | Description |
| --- | --- |
| `onClick(handler)` | Register a click handler (receives world coordinates) |
| `onKeyAction(key, action)` | Bind a key to a callback |
| `update()` | Poll input state (called automatically each frame) |

### PixiJS Helpers (`@seer-project/engine-2d/pixi-helpers`)

Import from the separate entry point to avoid pulling PixiJS into
non-rendering code:

```ts
import { sliceAtlas, screenToWorld } from '@seer-project/engine-2d/pixi-helpers';
```

| Function | Description |
| --- | --- |
| `sliceAtlas(image, meta)` | Slice a texture atlas into individual textures |
| `sliceAtlasKeyed(image, meta)` | Same, but returns a `Record<string, Texture>` |
| `screenToWorld(x, y, camera)` | Convert screen coordinates to world space |
| `computeUIScale(screenWidth)` | Compute a responsive UI scale factor |
| `makeLabelStyle(opts)` | Create a PixiJS text style for labels |
| `createDiamondMarker(color)` | Create a diamond-shaped marker graphic |
| `findNearestByWorldCoord(items, x, y)` | Find the nearest item by world position |

## Testing

```bash
npm test
npm run lint
```

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
