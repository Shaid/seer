import type { CaptureSource } from './capture-source.js';
import { drawWatermark, type WatermarkOptions } from './screenshot.js';

/**
 * Picks the best supported video mime type from a fixed preference order —
 * `preferred` first if given, then vp9 → vp8 → av01 → generic webm → mp4
 * (Safari's `MediaRecorder` only emits mp4, which is why that's the final
 * fallback rather than being omitted). `isSupported` is injected — normally
 * `MediaRecorder.isTypeSupported`, bound so it's callable without `this` —
 * so this stays pure and testable without a real `MediaRecorder`. Returns
 * `null` if nothing in the list is supported.
 */
export function pickVideoMimeType(
  isSupported: (mimeType: string) => boolean,
  preferred?: string,
): string | null {
  const candidates = [
    preferred,
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm;codecs=av01',
    'video/webm',
    'video/mp4',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (isSupported(candidate)) return candidate;
  }
  return null;
}

export interface CaptureSurface {
  readonly canvas: HTMLCanvasElement;
  /** Re-renders `source` (calling `renderNow()` if present) into this
   *  surface's canvas, compositing the watermark if one was configured.
   *  Call once per frame to be captured. */
  render(): void;
  dispose(): void;
}

/**
 * Builds the canvas `recordClip` actually captures from.
 *
 * With no watermark, this is a zero-cost path: the returned surface's
 * `canvas` IS `source.canvas` (read once, at call time — see the caveat on
 * `recordClip` about a source whose canvas element itself gets replaced),
 * and `render()` only calls `source.renderNow()`. With a watermark, a
 * same-size offscreen canvas is created once and `render()` composites the
 * source onto it plus the watermark, every frame.
 */
export function createCaptureSurface(
  source: CaptureSource,
  opts: { watermark?: WatermarkOptions } = {},
): CaptureSurface {
  if (!opts.watermark) {
    return {
      canvas: source.canvas,
      render: () => {
        source.renderNow?.();
      },
      dispose: () => {},
    };
  }

  const out = document.createElement('canvas');
  out.width = source.canvas.width;
  out.height = source.canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('createCaptureSurface: 2D context unavailable');
  const watermark = opts.watermark;

  return {
    canvas: out,
    render: () => {
      source.renderNow?.();
      ctx.drawImage(source.canvas, 0, 0, out.width, out.height);
      drawWatermark(ctx, out.width, out.height, watermark);
    },
    dispose: () => {},
  };
}

/**
 * `HTMLCanvasElement.captureStream(0)` puts the track in on-demand mode;
 * the corresponding `MediaStreamTrack.requestFrame()` (Canvas Capture spec)
 * commits exactly one frame per call. Not yet in TypeScript's DOM lib.
 */
interface OnDemandVideoTrack extends MediaStreamTrack {
  requestFrame(): void;
}

export interface RecordClipDriver {
  start(): void;
  stop(): void;
}

export interface RecordClipOptions {
  /** Starts/stops whatever visual animation is being recorded (a turntable
   *  orbit, an animation-clip playback). Called once each, around the
   *  whole capture. */
  driver: RecordClipDriver;
  /** Frames per second sampled from the source. Default `30`. */
  fps?: number;
  durationSeconds: number;
  bitsPerSecond?: number;
  /** Explicit override; otherwise negotiated via `pickVideoMimeType`. */
  mimeType?: string;
  /** Composited into every captured frame (not just the final screenshot) —
   *  see `screenshot.ts`'s watermark-in-v1 rationale for video too. */
  watermark?: WatermarkOptions;
  onProgress?(fraction: number): void;
  signal?: AbortSignal;
}

export interface RecordClipResult {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

/**
 * Records `durationSeconds` of `source` as a video clip, one explicit frame
 * at a time — NOT a real-time `captureStream(fps)` capture. The output
 * canvas (via `createCaptureSurface`) is put into on-demand mode
 * (`captureStream(0)`) and each frame is committed with an explicit
 * `track.requestFrame()` call, so the exported clip's frame pacing is
 * exactly `1/fps` seconds apart regardless of how fast or slow the host
 * machine actually renders each frame — a slow machine takes longer to
 * produce the clip, but the clip itself comes out identical.
 *
 * This is a VIDEO-ONLY capture with no audio track. `driver` starts/stops
 * the animation; it is not a substitute for a real-time,
 * audio-synchronized recording (a live tracker/score playback with sound),
 * which this function does not attempt — see the 2D companion export
 * proposal for that case.
 *
 * `source.canvas`'s identity is read once, via `createCaptureSurface`, at
 * the start of recording — a host whose canvas element is replaced
 * mid-recording (e.g. a 2D viewer that rebuilds its canvas per redraw)
 * needs a stable canvas for the whole clip before this can be used
 * correctly; `renderNow()` refreshing the *same* element's pixels is fine,
 * swapping the element itself is not.
 */
export async function recordClip(
  source: CaptureSource,
  opts: RecordClipOptions,
): Promise<RecordClipResult> {
  const fps = opts.fps ?? 30;
  const totalFrames = Math.max(1, Math.round(opts.durationSeconds * fps));

  const mimeType = pickVideoMimeType(
    (candidate) => MediaRecorder.isTypeSupported(candidate),
    opts.mimeType,
  );
  if (!mimeType) throw new Error('recordClip: no supported video mime type in this browser');

  const surface = createCaptureSurface(source, { watermark: opts.watermark });
  const stream = surface.canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as OnDemandVideoTrack | undefined;
  if (!track || typeof track.requestFrame !== 'function') {
    surface.dispose();
    throw new Error('recordClip: this browser does not support on-demand captureStream frames');
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    ...(opts.bitsPerSecond ? { videoBitsPerSecond: opts.bitsPerSecond } : {}),
  });
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (e) => {
    const event = e as BlobEvent;
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
  });

  opts.driver.start();
  recorder.start();

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (opts.signal?.aborted) break;
      surface.render();
      track.requestFrame();
      opts.onProgress?.((frame + 1) / totalFrames);
      // Cooperative yield so the encoder can drain this frame before the
      // next is queued — not a frame-timing delay (on-demand mode has no
      // real-time pacing requirement at all, which is the entire point).
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    opts.driver.stop();
    recorder.stop();
    await stopped;
    surface.dispose();
  }

  return {
    blob: new Blob(chunks, { type: mimeType }),
    mimeType,
    durationSeconds: totalFrames / fps,
  };
}
