/**
 * Game — example top-level orchestrator wiring Camera, InputManager, and a
 * PixiJS Application together.
 *
 * This is intentionally minimal and renders nothing beyond a placeholder —
 * it demonstrates the *shape* of a runtime engine (async asset load, texture
 * load, camera/input wiring, ticker-driven update loop) without assuming
 * your game is a strategic map, a side-scroller, or anything else. Replace
 * the render setup in `init()` with whatever your reverse-engineered assets
 * actually need (tilemap, sprite layers, dialogue screens, etc).
 *
 * See docs/architecture-overview.md §8 for the architectural rationale.
 */

import { Application } from 'pixi.js';
import { Camera } from './Camera.ts';
import { DisplayMode } from './DisplayMode.ts';
import { InputManager } from './InputManager.ts';

export interface GameOptions {
  /** DOM element to mount the PixiJS canvas into. */
  container: HTMLElement;
  /** World size in pixels — replace with your actual content dimensions. */
  worldWidth: number;
  worldHeight: number;
}

export class Game {
  private app: Application;
  private camera!: Camera;
  private input!: InputManager;
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

    this.camera = new Camera(
      this.options.worldWidth,
      this.options.worldHeight,
      this.app.screen.width,
      this.app.screen.height,
      this.displayMode,
    );

    this.input = new InputManager(this.app.canvas, this.camera);

    // TODO: load preprocessed assets via your AssetLoader, build sprite
    // layers/tilemaps/entity renderers here, and add them to
    // `this.app.stage` — scaled/positioned according to `this.camera`.

    window.addEventListener('resize', () => {
      this.camera.setViewSize(this.app.screen.width, this.app.screen.height);
    });

    this.app.ticker.add(() => this.update());
  }

  private update(): void {
    this.input.update();
    // TODO: apply camera transform to your world container, update any
    // per-frame game logic (movement, animation, etc).
  }

  destroy(): void {
    this.input.destroy();
    this.app.destroy(true, { children: true });
  }
}
