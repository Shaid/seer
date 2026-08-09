export type {
  PolygonFace,
  PolygonModel,
  ModelSource,
  ModelRepresentations,
  Model3D,
} from './types.js';

export { createFrameLimiter } from './frame-limiter.js';
export type { FrameLimiterOptions, FrameLimiter } from './frame-limiter.js';

export { createViewport } from './viewport.js';
export type {
  ViewportOptions,
  Viewport,
  ViewportLights,
  LightConfig,
  GridConfig,
} from './viewport.js';

export { computeCameraFit, fitCameraToObject } from './camera-fit.js';
export type { CameraFit, CameraFitOptions } from './camera-fit.js';

export { disposeObject3D } from './dispose.js';

export {
  normalizePolygonModel,
  normalizePolygonSet,
  buildPolygonModel,
  recolorPolygonModel,
  triangulateFan,
  computeModelEdges,
} from './polygon.js';
export type { PolygonBuildOptions } from './polygon.js';

export { createPaletteResolver, resolveColor } from './color-modes.js';
export type { ColorMode, ColorResolver, ColorResolverContext, HeightRange } from './color-modes.js';

export { supportedRenderModes, defaultRenderMode, applyRenderMode } from './render-modes.js';
export type { RenderMode } from './render-modes.js';

export { createAnimationController } from './animation.js';
export type { AnimationController } from './animation.js';

export { loadPlacedScene } from './placed-scene.js';
export type { Placement, PlacedSceneResult, LoadPlacedSceneOptions } from './placed-scene.js';

export { loadGltfModel, toModel3D } from './gltf.js';

export { meshStats } from './stats.js';
export type { MeshStats } from './stats.js';

export { createMeshSession } from './session.js';
export type { MeshSession, MeshSessionOptions, SetModelOptions } from './session.js';
