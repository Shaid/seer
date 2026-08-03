/**
 * Tests for `Game`'s pluggable-camera resolution logic.
 *
 * `Game.init()` itself spins up a real PixiJS `Application` (which needs a
 * browser canvas/WebGL context) and an `InputManager` (which needs
 * `window`), neither of which is available in this project's Node-only test
 * environment (no jsdom/canvas is configured — see vite.config.ts). So
 * rather than mock PixiJS wholesale, these tests exercise `resolveCamera`
 * directly: it's the exact, pure logic `Game.init()` calls to decide what
 * `game.camera` becomes, extracted so it's testable without a DOM.
 */
import { describe, it, expect } from 'vitest';
import { resolveCamera, type GameOptions } from '../Game.ts';
import { TopDownCamera } from '../TopDownCamera.ts';
import { SideViewCamera } from '../SideViewCamera.ts';
import { DisplayMode } from '../DisplayMode.ts';
import type { BaseCamera } from '../BaseCamera.ts';

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
    const options: Pick<GameOptions<SideViewCamera>, 'camera' | 'worldWidth' | 'worldHeight'> = {
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

    const options: Pick<GameOptions<BaseCamera>, 'camera' | 'worldWidth' | 'worldHeight'> = {
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
