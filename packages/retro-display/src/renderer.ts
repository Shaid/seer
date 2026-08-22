import {
  resolveRetroDisplayOptions,
  type DisplayProfile,
  type RetroDisplayOptions,
  type RetroDisplayRenderer,
} from './types.js';

/**
 * Profiles with a real shader implementation as of Phase 5 of
 * `2d-export-proposal.md` ("the package plus the crt-shadow-mask profile
 * only, to prove the pipeline end-to-end"). `crt-aperture-grille`,
 * `crt-slot-mask`, and `lcd-subpixel` are Phase 6 scope — requested now,
 * they fall back to `'none'` (an unmodified passthrough) rather than
 * throwing, so a caller wiring the profile selector early doesn't crash.
 */
const IMPLEMENTED_PROFILES: ReadonlySet<DisplayProfile> = new Set(['none', 'crt-shadow-mask']);

const VERTEX_SRC = `#version 300 es
in vec2 aPos;
in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Cheap CRT shadow-mask simulation — well-trodden public-domain shader
 * territory (see e.g. Timothy Lottes' CRT shader writeups and the many
 * derivatives in the emulator/shader community), not novel research here:
 * a per-row sine-wave scanline darkening, an RGB subpixel triad shadow
 * mask tiled across screen-space pixel columns, and a radial vignette,
 * with a brightness multiplier to compensate for the scanline/mask
 * darkening (mirroring `RetroDisplayOptions.brightness`'s stated purpose).
 * Curvature/glow/chromatic-aberration are accepted as options (for a
 * stable public API across Phase 5/6) but not yet implemented in the
 * shader — Phase 6 scope per `2d-export-proposal.md` Part 5/6.
 */
const FRAGMENT_SRC = `#version 300 es
precision mediump float;
uniform sampler2D uSource;
uniform bool uActive;
uniform float uScanlineIntensity;
uniform float uMaskIntensity;
uniform float uVignette;
uniform float uBrightness;
uniform vec2 uResolution;
in vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 src = texture(uSource, vUV);
  vec3 color = src.rgb;

  if (uActive) {
    float scanline = sin(vUV.y * uResolution.y * 3.14159265) * 0.5 + 0.5;
    color *= mix(1.0, scanline, uScanlineIntensity);

    float col = mod(gl_FragCoord.x, 3.0);
    vec3 mask = col < 1.0
      ? vec3(1.0, uMaskIntensity, uMaskIntensity)
      : col < 2.0
        ? vec3(uMaskIntensity, 1.0, uMaskIntensity)
        : vec3(uMaskIntensity, uMaskIntensity, 1.0);
    color *= mask;

    vec2 centered = vUV - 0.5;
    float vignette = 1.0 - dot(centered, centered) * uVignette * 2.0;
    color *= clamp(vignette, 0.0, 1.0);

    color *= uBrightness;
  }

  fragColor = vec4(color, src.a);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`retro-display: shader compile error: ${info ?? '(no info)'}`);
  }
  return shader;
}

/**
 * Creates a `RetroDisplayRenderer` — a fullscreen-quad WebGL2 pass that
 * takes whatever's currently drawn on `source` (any canvas or image, not
 * mesh- or sprite-specific) and re-renders it into this renderer's own
 * persistent output canvas with a period-display simulation applied.
 *
 * The output canvas is owned by this renderer for its whole lifetime —
 * callers that mount it into the DOM must not also wipe/replace it on
 * every redraw (the same persistent-canvas constraint Phase 2 of
 * `2d-export-proposal.md` established for the 2D draw path itself).
 */
export function createRetroDisplayRenderer(opts: RetroDisplayOptions = { profile: 'none' }): RetroDisplayRenderer {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('retro-display: WebGL2 unavailable');

  const program = gl.createProgram()!;
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`retro-display: program link error: ${gl.getProgramInfoLog(program) ?? '(no info)'}`);
  }
  gl.useProgram(program);

  // Full-screen quad in clip space; UV 0..1 (Y flipped so image top-left maps to canvas top-left).
  const quad = new Float32Array([
    -1, -1, 0, 1,
    1, -1, 1, 1,
    -1, 1, 0, 0,
    -1, 1, 0, 0,
    1, -1, 1, 1,
    1, 1, 1, 0,
  ]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(program, 'aPos');
  const aUV = gl.getAttribLocation(program, 'aUV');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(aUV);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);

  const sourceTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sourceTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const uSource = gl.getUniformLocation(program, 'uSource');
  const uActive = gl.getUniformLocation(program, 'uActive');
  const uScanlineIntensity = gl.getUniformLocation(program, 'uScanlineIntensity');
  const uMaskIntensity = gl.getUniformLocation(program, 'uMaskIntensity');
  const uVignette = gl.getUniformLocation(program, 'uVignette');
  const uBrightness = gl.getUniformLocation(program, 'uBrightness');
  const uResolution = gl.getUniformLocation(program, 'uResolution');

  let options = resolveRetroDisplayOptions(opts);
  let disposed = false;

  // Arrow function expressions, not `function` declarations — TS's control-flow
  // narrowing of `gl` (from the `if (!gl) throw` above) does not extend into a
  // hoisted function declaration (it could, in principle, run before the
  // narrowing check), but it does extend into a closure defined after that
  // check, which these are.
  const render = (source: HTMLCanvasElement | HTMLImageElement): void => {
    if (disposed) throw new Error('retro-display: render() called after dispose()');
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (width === 0 || height === 0) return;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);

    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(uSource, 0);
    gl.uniform1i(uActive, IMPLEMENTED_PROFILES.has(options.profile) && options.profile !== 'none' ? 1 : 0);
    gl.uniform1f(uScanlineIntensity, options.scanlineIntensity);
    gl.uniform1f(uMaskIntensity, options.maskIntensity);
    gl.uniform1f(uVignette, options.vignette);
    gl.uniform1f(uBrightness, options.brightness);
    gl.uniform2f(uResolution, width, height);

    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const setOptions = (next: RetroDisplayOptions): void => {
    if (!IMPLEMENTED_PROFILES.has(next.profile) && next.profile !== options.profile) {
      console.warn(`retro-display: profile "${next.profile}" is not yet implemented (Phase 6) — rendering as 'none'.`);
    }
    options = resolveRetroDisplayOptions(next);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    gl.deleteTexture(sourceTex);
    gl.deleteBuffer(buf);
    gl.deleteProgram(program);
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  };

  return { render, canvas, setOptions, dispose };
}
