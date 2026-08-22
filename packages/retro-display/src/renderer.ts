import {
  resolveRetroDisplayOptions,
  type RetroDisplayOptions,
  type RetroDisplayRenderer,
} from './types.js';

/**
 * Profile ids as understood by the shader below — `'none'` maps to 0 and
 * is never sampled for mask/scanline/vignette/glow/chromatic-aberration
 * work, so the ordering of the other four only needs to match
 * `PROFILE_IDS`, not any particular semantic order.
 */
const PROFILE_IDS: Record<string, number> = {
  none: 0,
  'crt-shadow-mask': 1,
  'crt-aperture-grille': 2,
  'crt-slot-mask': 3,
  'lcd-subpixel': 4,
};

const VERTEX_SRC = `#version 300 es
in vec2 aPos;
in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Post-display simulation — well-trodden public-domain shader territory
 * (see e.g. Timothy Lottes' CRT shader writeups and the many derivatives
 * in the emulator/shader community), not novel research here:
 *
 * - Scanlines: a per-row sine-wave darkening.
 * - Shadow mask / aperture grille / slot mask: an RGB subpixel triad
 *   pattern tiled across screen-space pixel columns. Three geometries:
 *   shadow-mask staggers the triad columns every other scanline row (the
 *   physical mask is a perforated sheet with staggered round holes);
 *   aperture-grille and lcd-subpixel use plain unstaggered columns (real
 *   aperture-grille CRTs and LCD panels are both continuous vertical
 *   stripes); slot-mask reuses the plain columns but adds periodic
 *   horizontal darkening bands to suggest slot boundaries.
 * - Curvature: a barrel-distortion UV remap, applied before every other
 *   sample so the whole effect (mask, glow, chromatic aberration) curves
 *   with it; UV that lands outside [0,1] after the remap renders black.
 * - Vignette: radial darkening toward the corners.
 * - Glow: a cheap 4-tap plus-shaped kernel, weighted toward bright pixels
 *   (`smoothstep`-gated by luminance) rather than a full gaussian — a
 *   phosphor-bloom approximation, not `UnrealBloomPass`-equivalent work.
 * - Chromatic aberration: R/G/B sampled at UVs offset radially from
 *   center by different amounts.
 * - Brightness: a flat multiplier compensating for the scanline/mask
 *   darkening above (`RetroDisplayOptions.brightness`'s stated purpose).
 */
const FRAGMENT_SRC = `#version 300 es
precision mediump float;
uniform sampler2D uSource;
uniform int uProfile;
uniform float uScanlineIntensity;
uniform float uMaskIntensity;
uniform float uCurvature;
uniform float uVignette;
uniform float uGlow;
uniform float uChromaticAberration;
uniform float uBrightness;
uniform vec2 uResolution;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 fragColor;

vec2 applyCurvature(vec2 uv, float amount) {
  if (amount <= 0.0) return uv;
  vec2 cc = uv * 2.0 - 1.0;
  float r2 = dot(cc, cc);
  cc *= 1.0 + amount * 0.3 * r2;
  return cc * 0.5 + 0.5;
}

vec3 sampleChromatic(vec2 uv, float amount) {
  if (amount <= 0.0) return texture(uSource, uv).rgb;
  vec2 dir = (uv - 0.5) * amount * 0.01;
  float r = texture(uSource, uv - dir).r;
  float g = texture(uSource, uv).g;
  float b = texture(uSource, uv + dir).b;
  return vec3(r, g, b);
}

vec3 sampleGlow(vec2 uv, float amount) {
  if (amount <= 0.0) return vec3(0.0);
  vec3 sum = vec3(0.0);
  sum += texture(uSource, uv + vec2(uTexel.x * 2.0, 0.0)).rgb;
  sum += texture(uSource, uv - vec2(uTexel.x * 2.0, 0.0)).rgb;
  sum += texture(uSource, uv + vec2(0.0, uTexel.y * 2.0)).rgb;
  sum += texture(uSource, uv - vec2(0.0, uTexel.y * 2.0)).rgb;
  sum *= 0.25;
  float lum = dot(sum, vec3(0.299, 0.587, 0.114));
  return sum * smoothstep(0.6, 1.0, lum) * amount;
}

vec3 sampleMask(vec2 fragCoord, float maskIntensity) {
  float col;
  if (uProfile == 1) {
    float rowOffset = mod(floor(fragCoord.y / 2.0), 2.0) * 1.5;
    col = mod(fragCoord.x + rowOffset, 3.0);
  } else {
    col = mod(fragCoord.x, 3.0);
  }
  vec3 mask = col < 1.0
    ? vec3(1.0, maskIntensity, maskIntensity)
    : col < 2.0
      ? vec3(maskIntensity, 1.0, maskIntensity)
      : vec3(maskIntensity, maskIntensity, 1.0);
  if (uProfile == 3) {
    float band = step(0.5, fract(fragCoord.y / 6.0));
    mask = mix(mask, mask * 0.85, band);
  }
  return mask;
}

void main() {
  if (uProfile == 0) {
    fragColor = texture(uSource, vUV);
    return;
  }

  vec2 uv = applyCurvature(vUV, uCurvature);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 color = sampleChromatic(uv, uChromaticAberration);
  color += sampleGlow(uv, uGlow);

  float scanline = sin(uv.y * uResolution.y * 3.14159265) * 0.5 + 0.5;
  color *= mix(1.0, scanline, uScanlineIntensity);

  color *= sampleMask(gl_FragCoord.xy, uMaskIntensity);

  vec2 centered = uv - 0.5;
  float vignette = 1.0 - dot(centered, centered) * uVignette * 2.0;
  color *= clamp(vignette, 0.0, 1.0);

  color *= uBrightness;

  float alpha = texture(uSource, uv).a;
  fragColor = vec4(color, alpha);
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
  const uProfile = gl.getUniformLocation(program, 'uProfile');
  const uScanlineIntensity = gl.getUniformLocation(program, 'uScanlineIntensity');
  const uMaskIntensity = gl.getUniformLocation(program, 'uMaskIntensity');
  const uCurvature = gl.getUniformLocation(program, 'uCurvature');
  const uVignette = gl.getUniformLocation(program, 'uVignette');
  const uGlow = gl.getUniformLocation(program, 'uGlow');
  const uChromaticAberration = gl.getUniformLocation(program, 'uChromaticAberration');
  const uBrightness = gl.getUniformLocation(program, 'uBrightness');
  const uResolution = gl.getUniformLocation(program, 'uResolution');
  const uTexel = gl.getUniformLocation(program, 'uTexel');

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
    gl.uniform1i(uProfile, PROFILE_IDS[options.profile] ?? 0);
    gl.uniform1f(uScanlineIntensity, options.scanlineIntensity);
    gl.uniform1f(uMaskIntensity, options.maskIntensity);
    gl.uniform1f(uCurvature, options.curvature);
    gl.uniform1f(uVignette, options.vignette);
    gl.uniform1f(uGlow, options.glow);
    gl.uniform1f(uChromaticAberration, options.chromaticAberration);
    gl.uniform1f(uBrightness, options.brightness);
    gl.uniform2f(uResolution, width, height);
    gl.uniform2f(uTexel, 1 / width, 1 / height);

    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const setOptions = (next: RetroDisplayOptions): void => {
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
