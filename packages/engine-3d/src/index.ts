export type { PolygonFace, PolygonModel, ModelSource, ModelRepresentations, Model3D } from './types.ts';

export { createFrameLimiter } from './frame-limiter.ts';
export type { FrameLimiterOptions, FrameLimiter } from './frame-limiter.ts';

export { createViewport } from './viewport.ts';
export type { ViewportOptions, Viewport, ViewportLights, LightConfig, GridConfig } from './viewport.ts';

export { computeCameraFit, fitCameraToObject } from './camera-fit.ts';
export type { CameraFit, CameraFitOptions } from './camera-fit.ts';

export { disposeObject3D } from './dispose.ts';

export { normalizePolygonModel, normalizePolygonSet, buildPolygonModel, recolorPolygonModel, triangulateFan, computeModelEdges } from './polygon.ts';
export type { PolygonBuildOptions } from './polygon.ts';

export { createPaletteResolver, resolveColor } from './color-modes.ts';
export type { ColorMode, ColorResolver, ColorResolverContext, HeightRange } from './color-modes.ts';

export { supportedRenderModes, defaultRenderMode, applyRenderMode } from './render-modes.ts';
export type { RenderMode } from './render-modes.ts';

export { createAnimationController } from './animation.ts';
export type { AnimationController } from './animation.ts';

export { loadPlacedScene } from './placed-scene.ts';
export type { Placement, PlacedSceneResult, LoadPlacedSceneOptions } from './placed-scene.ts';

export { loadGltfModel, toModel3D } from './gltf.ts';

export { meshStats } from './stats.ts';
export type { MeshStats } from './stats.ts';

export { createMeshSession } from './session.ts';
export type { MeshSession, MeshSessionOptions, SetModelOptions } from './session.ts';
