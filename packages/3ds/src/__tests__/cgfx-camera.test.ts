import { describe, expect, it } from 'vitest';
import { evaluateCgfxCameraCurve, parseCgfx, parseCgfxCameras } from '../cgfx.js';

/** Tiny CGFX writer: fields store offsets relative to their own position, as in the format. */
function buildCameraCgfx(): Uint8Array {
  const buf = new Uint8Array(0x440);
  const dv = new DataView(buf.buffer);
  const w32 = (o: number, v: number): void => dv.setUint32(o, v >>> 0, true);
  const wf = (o: number, v: number): void => dv.setFloat32(o, v, true);
  const rel = (field: number, target: number): void => w32(field, target - field);
  const str = (o: number, s: string): void => buf.set(new TextEncoder().encode(s), o);
  buf.set([0x43, 0x47, 0x46, 0x58], 0);
  dv.setUint16(6, 0x14, true);
  str(0x14, 'DATA'); // dataStart = 0x1c
  const dict = (o: number, name: number, value: number): void => {
    str(o, 'DICT');
    w32(o + 8, 1);
    w32(o + 0xc, 0xffffffff);
    // entry at o + 0x1c: refBit, l/r, name, value
    rel(o + 0x24, name);
    rel(o + 0x28, value);
  };
  // cameras dict (DATA + 40 = 0x44): count 1, dict at 0x100, value -> flags word at 0x180
  w32(0x44, 1);
  rel(0x48, 0x100);
  dict(0x100, 0x3c0, 0x180);
  // camera animation dict (DATA + 96 = 0x7c): dict at 0x140, CANM at 0x2a0
  w32(0x7c, 1);
  rel(0x80, 0x140);
  dict(0x140, 0x3d0, 0x2a0);
  // CCAM (magic at 0x184)
  w32(0x180, 0x4000000a);
  str(0x184, 'CCAM');
  w32(0x188, 0x07010000);
  const c = 0x184;
  [1, 1, 1].forEach((v, i) => wf(c + 0x2c + 4 * i, v));
  [10, 20, 30].forEach((v, i) => wf(c + 0x44 + 4 * i, v));
  rel(c + 0xb8, 0x250); // view
  rel(c + 0xbc, 0x270); // projection
  w32(0x250, 0x80000000);
  [1, 2, 3].forEach((v, i) => wf(0x250 + 8 + 4 * i, v));
  wf(0x250 + 0x14, 0.5);
  w32(0x270, 0x20000000);
  wf(0x274, 0.01);
  wf(0x278, 1000);
  wf(0x27c, 1.5);
  wf(0x280, 0.8);
  // CANM at 0x2a0: ViewUpdater.Twist member (type 0) with one curve at 0x300
  str(0x2a0, 'CANM');
  w32(0x2a4, 0x07000000);
  rel(0x2a8, 0x3e0);
  rel(0x2ac, 0x400);
  w32(0x2b0, 1); // loop
  wf(0x2b4, 100);
  w32(0x2b8, 1);
  rel(0x2bc, 0x2c0); // member dict
  dict(0x2c0, 0x3e0, 0x2f0);
  w32(0x2f0, 0);
  rel(0x2f4, 0x3e0);
  w32(0x2f8, 0);
  rel(0x2fc, 0x320);
  w32(0x320 + 0x20, 8); // hermite128
  w32(0x320 + 0x24, 2);
  [0, 0, 0, 0, 100, 10, 0, 0].forEach((v, i) => wf(0x320 + 0x2c + 4 * i, v));
  str(0x3c0, 'cam0');
  str(0x3d0, 'cam0anim');
  str(0x3e0, 'ViewUpdater.Twist');
  str(0x400, 'CameraAnimation');
  return buf;
}

describe('CGFX cameras', () => {
  it('parses a CCAM and a CANM twist curve from a synthetic file', () => {
    const { cameras, cameraAnimations } = parseCgfxCameras(buildCameraCgfx());
    expect(cameras).toHaveLength(1);
    const cam = cameras[0]!;
    expect(cam.name).toBe('cam0');
    expect(cam.translation).toEqual([10, 20, 30]);
    expect(cam.view).toEqual({ type: 'aim', target: [1, 2, 3], twist: 0.5 });
    expect(cam.projection.far).toBe(1000);
    expect(cam.projection.fovY).toBeCloseTo(0.8, 5);
    expect(cameraAnimations).toHaveLength(1);
    const a = cameraAnimations[0]!;
    expect(a.targetGroup).toBe('CameraAnimation');
    expect(a.frameCount).toBe(100);
    expect(a.twist?.keys).toHaveLength(2);
    expect(evaluateCgfxCameraCurve(a.twist!, 50)).toBeCloseTo(5, 5);
    expect(parseCgfx(buildCameraCgfx()).cameras).toHaveLength(1);
  });

  it('hermite evaluation passes through the keys and clamps outside the range', () => {
    const curve = {
      keys: [
        { frame: 0, value: 1, inSlope: 0, outSlope: 0 },
        { frame: 10, value: 3, inSlope: 0, outSlope: 0 },
      ],
    };
    expect(evaluateCgfxCameraCurve(curve, -5)).toBe(1);
    expect(evaluateCgfxCameraCurve(curve, 0)).toBe(1);
    expect(evaluateCgfxCameraCurve(curve, 10)).toBe(3);
    expect(evaluateCgfxCameraCurve(curve, 5)).toBeCloseTo(2, 6);
    expect(evaluateCgfxCameraCurve(curve, 99)).toBe(3);
  });
});
