/**
 * Tests for `Game`'s pluggable-camera resolution logic.
 *
 * `Game.init()` itself spins up a real PixiJS `Application` (which needs a
 * browser canvas/WebGL context) and an `InputManager` (which needs
 * `window`), neither of which is available in this project's Node-only test
 * environment (no jsdom/canvas is configured — see vite.config.ts). So
 * rather than mock PixiJS wholesale, these tests exercise `resolveCamera`
 * directly: it's the exact, pure logic `Game.init()` calls to decide what
 * `game.camera` becomes, and it lives in its own PixiJS-free module so this
 * file can import it without loading PixiJS at all.
 */
import { describe, it, expect } from 'vitest';
// Imported from resolve-camera.js, not Game.js: Game.ts pulls PixiJS in at
// module scope, and PixiJS reads `navigator`, which Node only defines from
// v21. Importing through Game.js made this DOM-free test fail on Node 20.
import { resolveCamera, type CameraOptions } from '../resolve-camera.js';
import { TopDownCamera } from '../TopDownCamera.js';
import { SideViewCamera } from '../SideViewCamera.js';
import { DisplayMode } from '../DisplayMode.js';
import type { BaseCamera } from '../BaseCamera.js';

describe('resolveCamera', () => {
  it('defaults to a TopDownCamera sized from worldWidth/worldHeight when no camera option is given', () => {
    const displayMode = new DisplayMode();
    const options: Pick<GameOptions, 'camera' | 'worldWidth' | 'worldHeight'> = {
      worldWidth: 2048,
      worldHeight: 1536,
    };
    const camera = resolveCamera(options, 800, 600, displayMode);

    expect(camera).toBeInstanceOf(TopDownCamera);
    expect(camera.kind).toBe('top-down');
    expect(camera.visibleWidth).toBe(800);
    expect(camera.visibleHeight).toBe(600);
  });

  it('uses a camera instance passed directly via the camera option', () => {
    const displayMode = new DisplayMode();
    const explicitCamera = new SideViewCamera(2048, 1536, 800, 600, displayMode);
    const options: Pick<CameraOptions<SideViewCamera>, 'camera' | 'worldWidth' | 'worldHeight'> = {
      worldWidth: 2048,
      worldHeight: 1536,
      camera: explicitCamera,
    };
    const camera = resolveCamera(options, 800, 600, displayMode);

    expect(camera).toBe(explicitCamera);
    expect(camera.kind).toBe('side-view');
  });

  it('invokes a camera factory with (viewWidth, viewHeight, displayMode) and uses its return value', () => {
    const displayMode = new DisplayMode();
    let calledWith: [number, number, DisplayMode] | undefined;

    const fakeCamera: BaseCamera = {
      kind: 'fake',
      setViewSize: () => {},
    };

    const options: Pick<CameraOptions<BaseCamera>, 'camera' | 'worldWidth' | 'worldHeight'> = {
      worldWidth: 2048,
      worldHeight: 1536,
      camera: (viewWidth, viewHeight, dm) => {
        calledWith = [viewWidth, viewHeight, dm];
        return fakeCamera;
      },
    };
    const camera = resolveCamera(options, 1024, 768, displayMode);

    expect(calledWith).toEqual([1024, 768, displayMode]);
    expect(camera).toBe(fakeCamera);
    expect(camera.kind).toBe('fake');
  });
});
