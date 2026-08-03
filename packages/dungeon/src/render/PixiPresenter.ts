/**
 * Presents an `IndexedSurface` as a single PixiJS v8 `Sprite`: the index
 * buffer is expanded to RGBA and uploaded to a `BufferImageSource` behind
 * one `nearest`-scaled sprite, integer-scaled to fit its container — no
 * fractional scale, so indexed pixel art stays crisp.
 */
import { BufferImageSource, Container, Sprite, Texture } from 'pixi.js';
import type { IndexedSurface } from '../raster/IndexedSurface.ts';
import { indicesToRGBA, type RGBAColor } from '../raster/palette.ts';

export class PixiPresenter {
  readonly sprite: Sprite;
  private readonly surface: IndexedSurface;
  private readonly source: BufferImageSource;

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
    const scale = Math.max(1, Math.floor(Math.min(targetWidth / this.surface.width, targetHeight / this.surface.height)));
    this.sprite.scale.set(scale);
    container.addChild(this.sprite);
  }
}
