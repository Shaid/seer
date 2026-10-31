/**
 * WebGL2 presenter: the indexed frame goes up as an R16UI texture, the
 * palette as a 256-wide RGBA8 texture, and one full-screen triangle looks
 * every output pixel's index up with `texelFetch` — nearest sampling by
 * construction, with no filtering state to get wrong. Lifted from the
 * create-seer-app viewer template's indexed-texture + palette shader, widened
 * from 8-bit to 16-bit indices.
 */

import { createRetroDisplayRenderer, type RetroDisplayOptions, type RetroDisplayRenderer } from '@seer-project/retro-display';
import { packPaletteTexture, type IndexedFrame, type PackedPalette, type RgbaPalette, type ScaleMode } from './frame.js';
import { PresenterLayout, type FramePresenter, type PresenterOptions } from './presenter.js';

// No vertex buffer: gl_VertexID 0..2 spans a triangle covering the viewport.
const VERTEX_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uIndex;
uniform sampler2D uPalette;
uniform ivec2 uFrameSize;
uniform vec4 uRect; // viewport x, y (GL bottom-left origin), width, height
out vec4 fragColor;
void main() {
  vec2 p = (gl_FragCoord.xy - uRect.xy) / uRect.zw;
  ivec2 src = clamp(ivec2(floor(vec2(p.x, 1.0 - p.y) * vec2(uFrameSize))), ivec2(0), uFrameSize - 1);
  uint idx = texelFetch(uIndex, src, 0).r;
  ivec2 pal = ivec2(int(idx & 255u), int(idx >> 8u));
  // Rows past the packed palette are out of range: opaque black, as indexedToRgba.
  fragColor = pal.y < textureSize(uPalette, 0).y ? vec4(texelFetch(uPalette, pal, 0).rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`arcade-runtime: shader compile error: ${info ?? '(no info)'}`);
  }
  return shader;
}

/** Throws if WebGL2 is unavailable; `createPresenter()` falls back instead. */
export function createWebGLPresenter(opts: PresenterOptions = {}): FramePresenter {
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false });
  if (!gl) throw new Error('arcade-runtime: WebGL2 unavailable');

  const program = gl.createProgram()!;
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`arcade-runtime: program link error: ${gl.getProgramInfoLog(program) ?? '(no info)'}`);
  }
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'uIndex'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'uPalette'), 1);
  const uFrameSize = gl.getUniformLocation(program, 'uFrameSize');
  const uRect = gl.getUniformLocation(program, 'uRect');
  const vao = gl.createVertexArray();

  const makeTexture = (): WebGLTexture => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Integer textures are only complete with NEAREST filtering.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };
  const indexTex = makeTexture();
  const paletteTex = makeTexture();
  let indexSize = { width: 0, height: 0 };
  let packed: PackedPalette | null = null;
  let paletteRows = 0;

  const sizing = new PresenterLayout(opts);
  const retro: RetroDisplayRenderer | null = opts.retro ? createRetroDisplayRenderer(opts.retro) : null;
  const canvas = retro ? retro.canvas : glCanvas;
  let disposed = false;

  // Arrow functions so the `if (!gl) throw` narrowing above carries into them.
  const present = (frame: IndexedFrame, palette: RgbaPalette): void => {
    if (disposed) throw new Error('arcade-runtime: present() called after dispose()');
    const { width, height } = frame;
    const { canvasWidth, canvasHeight, layout } = sizing.update(frame);
    if (glCanvas.width !== canvasWidth || glCanvas.height !== canvasHeight) {
      glCanvas.width = canvasWidth;
      glCanvas.height = canvasHeight;
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, indexTex);
    const pixels = frame.pixels.subarray(0, width * height);
    if (indexSize.width !== width || indexSize.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, pixels);
      indexSize = { width, height };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, pixels);
    }

    // Reuses one staging buffer for as long as the palette size holds.
    packed = packPaletteTexture(palette, packed?.data);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, paletteTex);
    if (paletteRows !== packed.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, packed.width, packed.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, packed.data);
      paletteRows = packed.height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, packed.width, packed.height, gl.RGBA, gl.UNSIGNED_BYTE, packed.data);
    }

    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const glY = canvasHeight - layout.y - layout.height;
    gl.viewport(layout.x, glY, layout.width, layout.height);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniform2i(uFrameSize, width, height);
    gl.uniform4f(uRect, layout.x, glY, layout.width, layout.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Same task as the draw, so the drawing buffer is still intact to copy.
    retro?.render(glCanvas);
  };

  return {
    kind: 'webgl2',
    canvas,
    present,
    resize(targetWidth, targetHeight) {
      sizing.target = { width: targetWidth, height: targetHeight };
    },
    setScale(mode: ScaleMode, pixelAspect?: number) {
      sizing.scale = mode;
      if (pixelAspect !== undefined) sizing.pixelAspect = pixelAspect;
    },
    setRetroOptions(next: RetroDisplayOptions) {
      retro?.setOptions(next);
    },
    get layout() {
      return sizing.current;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retro?.dispose();
      gl.deleteTexture(indexTex);
      gl.deleteTexture(paletteTex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
