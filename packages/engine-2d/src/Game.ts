/**
 * Game — top-level orchestrator wiring Camera, InputManager, and a
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
import { Camera } from './Camera.ts';
import { DisplayMode } from './DisplayMode.ts';
import { InputManager } from './InputManager.ts';

export interface GameOptions {
  /** DOM element to mount the PixiJS canvas into. */
  container: HTMLElement;
  /** World size in pixels — replace with your actual content dimensions. */
  worldWidth: number;
  worldHeight: number;
  /** Called once after PixiJS is initialised and camera/input are wired. */
  onInit?: (game: Game) => void | Promise<void>;
  /** Called every frame after input is polled. */
  onUpdate?: (game: Game) => void;
}

export class Game {
  private app: Application;
  readonly camera!: Camera;
  readonly input!: InputManager;
  /** The root PixiJS stage — add your sprite layers/tilemaps here. */
  readonly stage!: Container;
  private displayMode = new DisplayMode();
  private options: GameOptions;

  constructor(options: GameOptions) {
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

    (this as { camera: Camera }).camera = new Camera(
      this.options.worldWidth,
      this.options.worldHeight,
      this.app.screen.width,
      this.app.screen.height,
      this.displayMode,
    );

    (this as { input: InputManager }).input = new InputManager(
      this.app.canvas,
      this.camera,
    );

    window.addEventListener('resize', () => {
      this.camera.setViewSize(this.app.screen.width, this.app.screen.height);
    });

    this.app.ticker.add(() => this.update());

    if (this.options.onInit) await this.options.onInit(this);
  }

  private update(): void {
    this.input.update();
    this.options.onUpdate?.(this);
  }

  destroy(): void {
    this.input.destroy();
    this.app.destroy(true, { children: true });
  }
}

// ---------------------------------------------------------------------------
// Factory alternative — composition over inheritance
// ---------------------------------------------------------------------------

export type CreateGameOptions = GameOptions;

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
 *   onUpdate: (g) => {
 *     g.camera.follow(player.x, player.y);
 *   },
 * });
 * ```
 */
export async function createGame(options: CreateGameOptions): Promise<Game> {
  const game = new Game(options);
  await game.init();
  return game;
}
