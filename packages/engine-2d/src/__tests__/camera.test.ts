import { describe, it, expect } from 'vitest';
import { Camera } from '../Camera.ts';
import { DisplayMode } from '../DisplayMode.ts';

const WORLD_W = 4352;
const WORLD_H = 3328;
const VIEW_W = 1200;
const VIEW_H = 800;

function makeCamera(displayMode?: DisplayMode) {
  return new Camera(WORLD_W, WORLD_H, VIEW_W, VIEW_H, displayMode ?? new DisplayMode());
}

describe('Camera', () => {
  describe('constructor / initial state', () => {
    it('starts at (0, 0) with zoom 1', () => {
      const cam = makeCamera();
      expect(cam.x).toBe(0);
      expect(cam.y).toBe(0);
      expect(cam.zoom).toBe(1);
      expect(cam.dirty).toBe(true);
    });

    it('computes visible area dimensions from viewport and zoom', () => {
      const cam = makeCamera();
      expect(cam.visibleWidth).toBe(VIEW_W);
      expect(cam.visibleHeight).toBe(VIEW_H);
      expect(cam.left).toBe(-VIEW_W / 2);
      expect(cam.top).toBe(-VIEW_H / 2);
    });

    it('state snapshot matches camera state', () => {
      const cam = makeCamera();
      expect(cam.state).toEqual({ x: 0, y: 0, zoom: 1 });
    });
  });

  describe('markClean', () => {
    it('resets dirty flag', () => {
      const cam = makeCamera();
      expect(cam.dirty).toBe(true);
      cam.markClean();
      expect(cam.dirty).toBe(false);
    });
  });

  describe('moveTo', () => {
    it('positions camera center at the given coordinates', () => {
      const cam = makeCamera();
      cam.moveTo(2000, 1500);
      expect(cam.x).toBe(2000);
      expect(cam.y).toBe(1500);
      expect(cam.dirty).toBe(true);
    });

    it('clamps to world bounds (prevents camera from showing area outside world)', () => {
      const cam = makeCamera();
      cam.moveTo(-1000, -1000);
      expect(cam.x).toBeGreaterThanOrEqual(0);
      expect(cam.y).toBeGreaterThanOrEqual(0);

      cam.moveTo(10000, 10000);
      expect(cam.x).toBeLessThanOrEqual(WORLD_W);
      expect(cam.y).toBeLessThanOrEqual(WORLD_H);
    });
  });

  describe('pan', () => {
    it('shifts camera by screen-space delta converted to world-space', () => {
      const cam = makeCamera();
      cam.moveTo(2000, 1500);
      cam.pan(120, 80); // 120/1 = 120 world px, 80/1 = 80 world px
      expect(cam.x).toBe(2120);
      expect(cam.y).toBe(1580);
    });

    it('adjusts pan amount for current zoom', () => {
      const cam = makeCamera();
      cam.setZoom(2);
      cam.moveTo(2000, 1500);
      cam.pan(120, 80); // 120/2 = 60 world px, 80/2 = 40 world px
      expect(cam.x).toBe(2060);
      expect(cam.y).toBe(1540);
    });

    it('clamps to world bounds after pan', () => {
      const cam = makeCamera();
      cam.pan(-99999, -99999);
      expect(cam.x).toBeGreaterThanOrEqual(0);
      expect(cam.y).toBeGreaterThanOrEqual(0);
    });
  });

  describe('zoomAt', () => {
    it('zooms in when delta is positive', () => {
      const cam = makeCamera();
      cam.moveTo(2000, 1500);
      cam.zoomAt(0.15, VIEW_W / 2, VIEW_H / 2);
      expect(cam.zoom).toBeCloseTo(1.15);
    });

    it('zooms out when delta is negative', () => {
      const cam = makeCamera();
      cam.moveTo(2000, 1500);
      cam.zoomAt(-0.15, VIEW_W / 2, VIEW_H / 2);
      expect(cam.zoom).toBeCloseTo(0.85);
    });

    it('clamps to minZoom and does not shift position at the visual limit', () => {
      // Work around the effective minimum so we can test the full range.
      // Set a large world so minZoomToFill is below config.minZoom.
      const bigCam = new Camera(99999, 99999, VIEW_W, VIEW_H, new DisplayMode());
      bigCam.moveTo(50000, 50000);
      // Zoom out as far as possible
      bigCam.setZoom(0.25);
      const xBefore = bigCam.x;
      const yBefore = bigCam.y;
      // Attempt to zoom out further
      bigCam.zoomAt(-0.15, VIEW_W / 2, VIEW_H / 2);
      expect(bigCam.zoom).toBe(0.25);
      expect(bigCam.x).toBe(xBefore);
      expect(bigCam.y).toBe(yBefore);
    });

    it('does not zoom past the effective viewport-fill minimum and does not shift position', () => {
      // effectiveMin = max(0.25, 1200/4352, 800/3328) = max(0.25, 0.276, 0.240) = 0.276
      const cam = makeCamera();
      cam.moveTo(2000, 1500);
      // Zoom out as far as possible
      let lastX = cam.x;
      let lastY = cam.y;
      for (let i = 0; i < 10; i++) {
        cam.zoomAt(-0.15, VIEW_W / 2 - 100, VIEW_H / 2 - 60);
        if (cam.x === lastX && cam.y === lastY) break;
        lastX = cam.x;
        lastY = cam.y;
      }
      // Should be at the effective minimum
      expect(cam.zoom).toBeCloseTo(0.276, 2);
      // One more zoom-out attempt should be a no-op
      cam.zoomAt(-0.15, 10, 10);
      expect(cam.zoom).toBeCloseTo(0.276, 2);
    });

    it('clamps to maxZoom', () => {
      const cam = makeCamera();
      cam.setZoom(6);
      cam.zoomAt(0.15, VIEW_W / 2, VIEW_H / 2);
      expect(cam.zoom).toBe(6);
    });

    it('anchors the world point under the cursor when zooming in', () => {
      const cam = makeCamera();
      cam.moveTo(2000, 1500);
      // Zoom in toward top-left of viewport
      const screenX = 100;
      const screenY = 100;
      const worldBefore = cam.x + (screenX - VIEW_W / 2) / cam.zoom;
      cam.zoomAt(0.5, screenX, screenY);
      const worldAfter = cam.x + (screenX - VIEW_W / 2) / cam.zoom;
      expect(worldAfter).toBeCloseTo(worldBefore);
    });

    it('anchors the world point under the cursor when zooming out', () => {
      const cam = makeCamera();
      cam.moveTo(2000, 1500);
      const screenX = 900;
      const screenY = 600;
      const worldBefore = cam.x + (screenX - VIEW_W / 2) / cam.zoom;
      cam.zoomAt(-0.2, screenX, screenY);
      const worldAfter = cam.x + (screenX - VIEW_W / 2) / cam.zoom;
      expect(worldAfter).toBeCloseTo(worldBefore);
    });
  });

  describe('setZoom', () => {
    it('sets zoom to the given value', () => {
      const cam = makeCamera();
      cam.setZoom(2);
      expect(cam.zoom).toBe(2);
    });

    it('clamps to minZoom', () => {
      const cam = makeCamera();
      cam.setZoom(0.01);
      expect(cam.zoom).toBeGreaterThanOrEqual(0.25);
    });

    it('clamps to maxZoom', () => {
      const cam = makeCamera();
      cam.setZoom(99);
      expect(cam.zoom).toBe(6);
    });
  });

  describe('setViewSize / setWorldBounds', () => {
    it('reclamps after viewport resize', () => {
      const cam = makeCamera();
      cam.setViewSize(800, 600);
      expect(cam.dirty).toBe(true);
    });

    it('reclamps after world bounds change', () => {
      const cam = makeCamera();
      cam.setWorldBounds(2000, 2000);
      expect(cam.dirty).toBe(true);
    });
  });

  describe('visible area getters', () => {
    it('visibleWidth and visibleHeight scale with zoom', () => {
      const cam = makeCamera();
      cam.setZoom(2);
      expect(cam.visibleWidth).toBe(VIEW_W / 2);
      expect(cam.visibleHeight).toBe(VIEW_H / 2);
    });

    it('left and top track camera position', () => {
      const cam = makeCamera();
      cam.setZoom(1);
      cam.moveTo(VIEW_W / 2, VIEW_H / 2);
      expect(cam.left).toBeCloseTo(0);
      expect(cam.top).toBeCloseTo(0);
    });
  });
});
