/**
 * Presents an `IndexedSurface` as a single PixiJS v8 `Sprite`: the index
 * buffer is expanded to RGBA and uploaded to a `BufferImageSource` behind
 * one `nearest`-scaled sprite, integer-scaled to fit its container — no
 * fractional scale, so indexed pixel art stays crisp.
 */
import { BufferImageSource, Container, Sprite, Texture } from 'pixi.js';
import type { IndexedSurface } from '../raster/IndexedSurface.js';
import { indicesToRGBA, type RGBAColor } from '../raster/palette.js';

export class PixiPresenter {
  readonly sprite: Sprite;
  private readonly surface: IndexedSurface;
  private readonly source: BufferImageSource;
  /** The integer upscale factor `attachTo` picked (1 until attached). `Walker.pick`/`view/Hotspot.ts` need this to map a container-space click back to surface pixels. */
  scale = 1;

  constructor(surface: IndexedSurface) {
    this.surface = surface;
    this.source = new BufferImageSource({
      resource: new Uint8Array(surface.width * surface.height * 4),
      width: surface.width,
      height: surface.height,
      scaleMode: 'nearest',
    });
    this.sprite = new Sprite(new Texture({ source: this.source }));
  }

  /** Re-expand the surface through `palette` and re-upload it to the GPU. Call after every recomposite. */
  present(palette: RGBAColor[]): void {
    const rgba = indicesToRGBA(this.surface.data, palette);
    (this.source.resource as Uint8Array).set(rgba);
    this.source.update();
  }

  /** Add the sprite to `container`, scaled by the largest whole integer that fits `(targetWidth, targetHeight)`. */
  attachTo(container: Container, targetWidth: number, targetHeight: number): void {
    this.scale = Math.max(
      1,
      Math.floor(Math.min(targetWidth / this.surface.width, targetHeight / this.surface.height)),
    );
    this.sprite.scale.set(this.scale);
    container.addChild(this.sprite);
  }

  /** Map a point in the sprite's parent container's local space (e.g. a Pixi pointer event's `.getLocalPosition(sprite.parent)`) back to integer surface-pixel coordinates, per this presenter's current `scale`. */
  toSurfacePoint(containerX: number, containerY: number): { x: number; y: number } {
    return { x: Math.floor(containerX / this.scale), y: Math.floor(containerY / this.scale) };
  }
}
