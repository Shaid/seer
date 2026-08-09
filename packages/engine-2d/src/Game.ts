/**
 * Game — top-level orchestrator wiring a camera, InputManager, and a
 * PixiJS Application together.
 *
 * This is intentionally minimal and renders nothing beyond a placeholder —
 * it demonstrates the *shape* of a runtime engine (async asset load, texture
 * load, camera/input wiring, ticker-driven update loop) without assuming
 * your game is a strategic map, a side-scroller, or anything else. Replace
 * the render setup in `onInit` with whatever your reverse-engineered assets
 * actually need (tilemap, sprite layers, dialogue screens, etc).
 *
 * Two usage patterns:
 *   - `new Game(opts)` + `game.init()` — direct instantiation
 *   - `createGame(opts)` — factory with `onInit`/`onUpdate` callbacks
 */

import { Application, type Container } from 'pixi.js';
import type { BaseCamera } from './BaseCamera.js';
import { DisplayMode } from './DisplayMode.js';
import { InputManager } from './InputManager.js';
import { TopDownCamera } from './TopDownCamera.js';
import { resolveCamera } from './resolve-camera.js';

// Re-exported so `resolveCamera` stays importable from this module's public
// surface, while living in a file that does not pull PixiJS in — see
// resolve-camera.ts for why that separation matters.
export { resolveCamera } from './resolve-camera.js';
export type { CameraOptions } from './resolve-camera.js';

export interface GameOptions<TCamera extends BaseCamera = TopDownCamera> {
  /** DOM element to mount the PixiJS canvas into. */
  container: HTMLElement;
  /** World size in pixels — replace with your actual content dimensions. */
  worldWidth: number;
  worldHeight: number;
  /**
   * Camera to use, or a factory to build one from the initial viewport size
   * and display mode. Omit to get a `TopDownCamera` sized from
   * `worldWidth`/`worldHeight` (the default today).
   */
  camera?: TCamera | ((viewWidth: number, viewHeight: number, displayMode: DisplayMode) => TCamera);
  /** Called once after PixiJS is initialised and camera/input are wired. */
  onInit?: (game: Game<TCamera>) => void | Promise<void>;
  /** Called every frame after input is polled, with the elapsed time in milliseconds. */
  onUpdate?: (game: Game<TCamera>, dtMs: number) => void;
}

export class Game<TCamera extends BaseCamera = TopDownCamera> {
  private app: Application;
  readonly camera!: TCamera;
  readonly input!: InputManager;
  /** The root PixiJS stage — add your sprite layers/tilemaps here. */
  readonly stage!: Container;
  private displayMode = new DisplayMode();
  private options: GameOptions<TCamera>;

  constructor(options: GameOptions<TCamera>) {
    this.options = options;
    this.app = new Application();
  }

  async init(): Promise<void> {
    await this.app.init({
      resizeTo: this.options.container,
      backgroundColor: 0x000000,
      antialias: false,
    });
    this.options.container.appendChild(this.app.canvas);

    (this as { stage: Container }).stage = this.app.stage;

    (this as { camera: TCamera }).camera = resolveCamera(
      this.options,
      this.app.screen.width,
      this.app.screen.height,
      this.displayMode,
    );

    (this as { input: InputManager }).input = new InputManager(
      this.app.canvas,
      // InputManager is TopDownCamera-specific (WASD pan, wheel zoom,
      // drag-to-pan). A future non-affine camera (e.g. a first-person grid
      // pose) will need its own input wiring — deferred to that work; for
      // every camera Game constructs today (TopDownCamera/SideViewCamera or
      // a factory returning one), this cast is accurate at runtime.
      this.camera as unknown as TopDownCamera,
    );

    window.addEventListener('resize', () => {
      this.camera.setViewSize(this.app.screen.width, this.app.screen.height);
    });

    this.app.ticker.add((ticker) => this.update(ticker.deltaMS));

    if (this.options.onInit) await this.options.onInit(this);
  }

  private update(dtMs: number): void {
    this.input.update();
    this.options.onUpdate?.(this, dtMs);
  }

  destroy(): void {
    this.input.destroy();
    this.app.destroy(true, { children: true });
  }
}

// ---------------------------------------------------------------------------
// Factory alternative — composition over inheritance
// ---------------------------------------------------------------------------

export type CreateGameOptions<TCamera extends BaseCamera = TopDownCamera> = GameOptions<TCamera>;

/**
 * Create and initialise a Game via callbacks, rather than subclassing.
 *
 * @example
 * ```ts
 * const game = await createGame({
 *   container,
 *   worldWidth: 2048,
 *   worldHeight: 2048,
 *   onInit: (g) => {
 *     const tilemap = new Container();
 *     g.stage.addChild(tilemap);
 *   },
 *   onUpdate: (g, dtMs) => {
 *     g.camera.moveTo(player.x, player.y);
 *   },
 * });
 * ```
 */
export async function createGame<TCamera extends BaseCamera = TopDownCamera>(
  options: CreateGameOptions<TCamera>,
): Promise<Game<TCamera>> {
  const game = new Game<TCamera>(options);
  await game.init();
  return game;
}
