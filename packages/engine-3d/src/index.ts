export type {
  PolygonFace,
  PolygonModel,
  ModelSource,
  ModelRepresentations,
  Model3D,
} from './types.js';

export { createFrameLimiter } from './frame-limiter.js';
export type { FrameLimiterOptions, FrameLimiter } from './frame-limiter.js';

export type { RenderPath } from './render-path.js';

export {
  applyShadowSettings,
  applyLightShadowSettings,
  enableModelShadows,
  fitShadowCamera,
  createShadowCatcher,
  updateShadowCatcher,
} from './shadows.js';
export type { ShadowOptions, ModelShadowOptions, FitShadowCameraOptions, ShadowCatcherOptions } from './shadows.js';

export {
  planCinematicPasses,
  cinematicPlansEqual,
  createCinematicPath,
  applyToneMapping,
} from './postprocessing.js';
export type {
  CinematicOptions,
  CinematicPath,
  CinematicPassKind,
  CinematicPassPlan,
  BloomOptions,
  AOOptions,
  DOFOptions,
  ToneMappingOptions,
  AntialiasStrategy,
} from './postprocessing.js';

export { createPhotoMode, isPhotoModeAvailable } from './photo-mode.js';
export type { PhotoModeOptions, PhotoModeController, PhotoModePhase } from './photo-mode.js';

export { turntableAzimuth, createTurntable } from './turntable.js';
export type { Turntable, TurntableOptions, TurntableDirection, TurntableEasing } from './turntable.js';

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

export { applyMeshShading, clearGeneratedShadingMaterials, setToonRampLutImage } from './mesh-shading.js';
export type { MeshShadingMode, GeneratedShadingMaterials } from './mesh-shading.js';

export {
  applyMeshPolish,
  captureOriginalGeometry,
  disposeOriginalGeometry,
  applySmoothNormals,
  subdivideGeometry,
} from './mesh-polish.js';
export type { OriginalGeometryCache } from './mesh-polish.js';

export { applyTextureFilter } from './texture-filter.js';
export type { TextureFilterMode, TextureFilterOptions } from './texture-filter.js';

export { createAnimationController } from './animation.js';
export type { AnimationController } from './animation.js';

export {
  createSpringBoneSolver,
  readSpringBoneConfig,
  excludeAnimatedChains,
  deriveSpringBonesFromNames,
} from './spring-bones.js';
export type {
  SpringBoneJoint,
  SpringBoneChain,
  SpringBoneCollider,
  SpringBoneColliderGroup,
  SpringBoneConfig,
  SpringBoneSolver,
  SpringBoneSolverOptions,
  DeriveSpringBonesOptions,
} from './spring-bones.js';

export { loadPlacedScene } from './placed-scene.js';
export type { Placement, PlacedSceneResult, LoadPlacedSceneOptions } from './placed-scene.js';

export { loadGltfModel, toModel3D } from './gltf.js';

export { meshStats } from './stats.js';
export type { MeshStats } from './stats.js';

export { createMeshSession } from './session.js';
export type { MeshSession, MeshSessionOptions, SetModelOptions, SpringBoneOptions } from './session.js';

export { buildBoneCorrespondence, retargetClipsToSkeleton } from './retarget-animation.js';

export { validatePolygonObjects, hasIssues, describeIssues, MAX_COORD } from './polygon-validate.js';
export type { PolygonObject, PolygonModelIssues } from './polygon-validate.js';
