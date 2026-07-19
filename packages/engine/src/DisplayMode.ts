/**
 * DisplayMode — Rendering configuration (always modern).
 */

export type DisplayModeType = 'modern';

export interface DisplayModeConfig {
  /** Minimum zoom (zoomed out, shows more map) */
  minZoom: number;
  /** Maximum zoom (zoomed in) */
  maxZoom: number;
  /** Texture filtering mode */
  scaleMode: 'nearest' | 'linear';
}

const MODERN_CONFIG: DisplayModeConfig = {
  minZoom: 0.25,
  maxZoom: 6,
  scaleMode: 'nearest',
};

export class DisplayMode {
  private _config: DisplayModeConfig;

  constructor() {
    this._config = { ...MODERN_CONFIG };
  }

  get config(): Readonly<DisplayModeConfig> {
    return this._config;
  }

  get mode(): DisplayModeType {
    return 'modern';
  }
}
