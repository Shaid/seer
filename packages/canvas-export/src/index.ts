export { createPopover } from './popover.js';
export type { CaptureSource } from './capture-source.js';
export {
  drawWatermark,
  composeCaptureCanvas,
  captureBlob,
  downloadScreenshot,
} from './screenshot.js';
export type { WatermarkOptions, CaptureOptions } from './screenshot.js';
export { pickVideoMimeType, createCaptureSurface, recordClip } from './video-export.js';
export type {
  CaptureSurface,
  RecordClipDriver,
  RecordClipOptions,
  RecordClipResult,
} from './video-export.js';
