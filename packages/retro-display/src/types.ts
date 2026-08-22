export type DisplayProfile =
  | 'none'
  | 'crt-shadow-mask' // classic consumer CRT
  | 'crt-aperture-grille' // Trinitron-style
  | 'crt-slot-mask'
  | 'lcd-subpixel'; // handheld/early-flatscreen subpixel grid, no scanlines

export interface RetroDisplayOptions {
  profile: DisplayProfile;
  /** 0..1, default `0.3`. No-op for `'lcd-subpixel'`. */
  scanlineIntensity?: number;
  /** 0..1, default `0.25`. */
  maskIntensity?: number;
  /** 0 (flat, default) .. 1 (full barrel distortion). */
  curvature?: number;
  /** 0..1, default `0.15`. */
  vignette?: number;
  /** Phosphor bloom approximation, 0..1, default `0.2`. */
  glow?: number;
  /** 0..1, default `0`. */
  chromaticAberration?: number;
  /** Compensates for scanline/mask darkening, default `1.1`. */
  brightness?: number;
}

export type RequiredRetroDisplayOptions = Required<RetroDisplayOptions>;

/**
 * Sane per-profile defaults so the profile selector alone is a complete,
 * good-looking choice — the individual sliders are for fine-tuning
 * afterwards, not required inputs.
 */
export const DISPLAY_PROFILE_PRESETS: Record<DisplayProfile, Partial<RetroDisplayOptions>> = {
  none: {},
  'crt-shadow-mask': {
    scanlineIntensity: 0.3,
    maskIntensity: 0.25,
    vignette: 0.15,
    glow: 0.2,
    brightness: 1.1,
  },
  'crt-aperture-grille': {
    scanlineIntensity: 0.25,
    maskIntensity: 0.3,
    vignette: 0.12,
    glow: 0.15,
    brightness: 1.1,
  },
  'crt-slot-mask': {
    scanlineIntensity: 0.3,
    maskIntensity: 0.3,
    vignette: 0.15,
    glow: 0.18,
    brightness: 1.1,
  },
  'lcd-subpixel': {
    scanlineIntensity: 0,
    maskIntensity: 0.2,
    vignette: 0.05,
    glow: 0,
    brightness: 1.0,
  },
};

const DEFAULT_OPTIONS: RequiredRetroDisplayOptions = {
  profile: 'none',
  scanlineIntensity: 0.3,
  maskIntensity: 0.25,
  curvature: 0,
  vignette: 0.15,
  glow: 0.2,
  chromaticAberration: 0,
  brightness: 1.1,
};

/**
 * Merges `opts` over `DISPLAY_PROFILE_PRESETS[opts.profile]` over the
 * package-wide defaults — an explicit option always wins over that
 * profile's preset, and a preset value always wins over the bare default.
 */
export function resolveRetroDisplayOptions(opts: RetroDisplayOptions): RequiredRetroDisplayOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...DISPLAY_PROFILE_PRESETS[opts.profile],
    ...opts,
  };
}

export interface RetroDisplayRenderer {
  /** Draws `source` through the shader into the renderer's own output canvas. */
  render(source: HTMLCanvasElement | HTMLImageElement): void;
  /** The output — what `CaptureSource` points at when a profile is active. */
  readonly canvas: HTMLCanvasElement;
  setOptions(next: RetroDisplayOptions): void;
  dispose(): void;
}
