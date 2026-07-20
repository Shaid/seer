# @seer/engine

PixiJS-based 2D runtime engine with camera, input, and display management.

Provides the core game loop, camera system, input handling, and helper
utilities for rendering reverse-engineered game content in the browser.
Intentionally minimal — it demonstrates the *shape* of a runtime engine
without assuming your game is a side-scroller, strategy map, or anything
else.

## Installation

```bash
npm install @seer/engine pixi.js
```

Requires `pixi.js ^8.9.0` as a peer dependency.

## Usage

```ts
import { createGame } from '@seer/engine';

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

### PixiJS Helpers (`@seer/engine/pixi-helpers`)

Import from the separate entry point to avoid pulling PixiJS into
non-rendering code:

```ts
import { sliceAtlas, screenToWorld } from '@seer/engine/pixi-helpers';
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
