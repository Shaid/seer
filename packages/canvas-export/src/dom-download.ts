/**
 * The two browser mechanics every export path in this package ends in,
 * written once: handing a `Blob` to the user as a download, and creating the
 * offscreen 2D canvas a watermarked capture composites into.
 *
 * `downloadScreenshot` and `downloadClip` had byte-identical copies of the
 * first; `composeCaptureCanvas` and `createCaptureSurface` had byte-identical
 * copies of the second.
 */

/**
 * How long to hold the object URL before revoking it. The click only *starts*
 * the download; revoking synchronously after it cancels the transfer in some
 * browsers, so this is deliberately far longer than any of them needs.
 */
const REVOKE_DELAY_MS = 10_000;

/**
 * Triggers a browser download of `blob` named `filename` (passed through
 * verbatim — callers append their own extension), then revokes the object URL
 * on a timeout long enough for the download to have started in every browser
 * this project supports.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/**
 * Creates an offscreen `width`x`height` canvas and its 2D context. `label` is
 * the calling function's name, used only so a context-unavailable failure
 * still names the caller it came from.
 */
export function createCanvas2D(
  width: number,
  height: number,
  label: string,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`${label}: 2D context unavailable`);
  return { canvas, ctx };
}
