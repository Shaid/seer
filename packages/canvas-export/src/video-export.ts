import type { CaptureSource } from './capture-source.js';
import { drawWatermark, type WatermarkOptions } from './screenshot.js';
import { createCanvas2D, downloadBlob } from './dom-download.js';

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

  const { canvas: out, ctx } = createCanvas2D(source.canvas.width, source.canvas.height, 'createCaptureSurface');
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
 * at a time via on-demand `captureStream(0)` + `track.requestFrame()`.
 *
 * **Frames are timestamped at real wall-clock commit time** — the Media
 * Capture from DOM Elements spec gives `requestFrame()` no way to assign a
 * synthetic `1/fps` timestamp, and `MediaRecorder` encodes from whatever
 * timestamps the track actually reports. A tight commit loop with no
 * pacing (an earlier revision of this function) would therefore encode a
 * *sped-up* clip on any machine fast enough to render every frame in a
 * handful of milliseconds — the common case, not the exceptional one. This
 * function instead explicitly paces each frame's commit to
 * `frame * (1000 / fps)` ms of real time since the recording started,
 * sleeping the remainder of the budget when rendering finishes early. On a
 * machine slow enough that rendering alone exceeds the per-frame budget,
 * frames commit back-to-back as fast as they can (as before) — the pacing
 * can only slow a fast machine down to real time, not speed a slow one up,
 * so a sufficiently slow host still produces a longer-than-requested clip.
 * That asymmetry is inherent to timestamping via wall-clock `captureStream`
 * rather than an explicit-timestamp encoder (e.g. WebCodecs `VideoEncoder`
 * + a muxer); pacing fixes the common case without that larger rewrite.
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

  const frameDurationMs = 1000 / fps;
  const startTime = performance.now();
  let committedFrames = 0;

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (opts.signal?.aborted) break;
      // Pace this frame's commit to real wall-clock time, per the doc
      // comment above — a no-op wait (0ms) on a machine slow enough that
      // rendering alone already blew the budget.
      const waitMs = startTime + frame * frameDurationMs - performance.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      surface.render();
      track.requestFrame();
      committedFrames++;
      opts.onProgress?.((frame + 1) / totalFrames);
      // Cooperative yield so the encoder can drain this frame before the
      // next is queued, on top of whatever pacing wait already happened.
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
    // Reflects frames actually committed, not the request — an aborted
    // recording produced a shorter clip than `totalFrames / fps`.
    durationSeconds: committedFrames / fps,
  };
}

/**
 * Triggers a browser download of a `recordClip()` result, named `filename`
 * — the video counterpart to `screenshot.ts`'s `downloadScreenshot`. The
 * extension is derived from `result.mimeType` (`.mp4` for an mp4 mime
 * type, `.webm` otherwise) and appended only if `filename` doesn't already
 * end with it, so a caller can pass either a bare name or one it already
 * built with the right extension. Revokes the object URL after a timeout
 * long enough for the download to have started in every browser this
 * project supports, same as `downloadScreenshot`.
 */
export function downloadClip(result: RecordClipResult, filename: string): void {
  const ext = result.mimeType.includes('mp4') ? 'mp4' : 'webm';
  downloadBlob(result.blob, filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`);
}
