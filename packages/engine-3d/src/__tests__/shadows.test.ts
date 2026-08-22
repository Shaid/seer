import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyShadowSettings,
  applyLightShadowSettings,
  enableModelShadows,
  fitShadowCamera,
  createShadowCatcher,
  updateShadowCatcher,
} from '../shadows.js';

function fakeRenderer() {
  return {
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
  } as unknown as THREE.WebGLRenderer;
}

describe('applyShadowSettings', () => {
  it('enables the shadow map and sets PCFSoftShadowMap', () => {
    const renderer = fakeRenderer();
    applyShadowSettings(renderer, true);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
  });

  it('disables the shadow map without touching the type', () => {
    const renderer = fakeRenderer();
    applyShadowSettings(renderer, true);
    applyShadowSettings(renderer, false);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
  });
});

describe('applyLightShadowSettings', () => {
  it('applies documented defaults when no options are given', () => {
    const light = new THREE.DirectionalLight();
    applyLightShadowSettings(light);
    expect(light.shadow.mapSize.x).toBe(2048);
    expect(light.shadow.mapSize.y).toBe(2048);
    expect(light.shadow.bias).toBeCloseTo(-0.0005);
    expect(light.shadow.normalBias).toBeCloseTo(0.02);
    expect(light.shadow.radius).toBe(1);
  });

  it('applies explicit overrides', () => {
    const light = new THREE.DirectionalLight();
    applyLightShadowSettings(light, { mapSize: 512, bias: -0.001, normalBias: 0.05, radius: 3 });
    expect(light.shadow.mapSize.x).toBe(512);
    expect(light.shadow.mapSize.y).toBe(512);
    expect(light.shadow.bias).toBeCloseTo(-0.001);
    expect(light.shadow.normalBias).toBeCloseTo(0.05);
    expect(light.shadow.radius).toBe(3);
  });

  it('does not touch castShadow', () => {
    const light = new THREE.DirectionalLight();
    light.castShadow = false;
    applyLightShadowSettings(light);
    expect(light.castShadow).toBe(false);
  });
});

describe('enableModelShadows', () => {
  it('sets castShadow/receiveShadow (default true/true) on every mesh under the object, recursively', () => {
    const root = new THREE.Group();
    const child = new THREE.Group();
    const meshA = new THREE.Mesh(new THREE.BoxGeometry());
    const meshB = new THREE.Mesh(new THREE.BoxGeometry());
    root.add(meshA);
    root.add(child);
    child.add(meshB);

    enableModelShadows(root);

    expect(meshA.castShadow).toBe(true);
    expect(meshA.receiveShadow).toBe(true);
    expect(meshB.castShadow).toBe(true);
    expect(meshB.receiveShadow).toBe(true);
  });

  it('respects explicit cast/receive overrides independently', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    enableModelShadows(mesh, { cast: true, receive: false });
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(false);
  });

  it('does not touch non-mesh objects (lights, groups, empty transforms)', () => {
    const group = new THREE.Group();
    const light = new THREE.DirectionalLight();
    group.add(light);
    expect(() => enableModelShadows(group)).not.toThrow();
    // A DirectionalLight has no castShadow/receiveShadow mesh flags to
    // assert on — this test's value is that traversal doesn't throw when
    // it hits a non-mesh object.
  });

  it('is a no-op (does not throw) on an object with no meshes at all', () => {
    const empty = new THREE.Group();
    expect(() => enableModelShadows(empty)).not.toThrow();
  });
});

describe('fitShadowCamera', () => {
  it('is a no-op on an empty box', () => {
    const light = new THREE.DirectionalLight();
    const originalLeft = light.shadow.camera.left;
    fitShadowCamera(light, new THREE.Box3());
    expect(light.shadow.camera.left).toBe(originalLeft);
  });

  it('replaces the default [-5,5,5,-5,...] frustum to actually fit a larger model', () => {
    const light = new THREE.DirectionalLight();
    light.position.set(3, 5, 4);
    // A 20-unit model — bigger than three's default 10-unit-wide frustum.
    const box = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 5, 10));

    fitShadowCamera(light, box);

    expect(light.shadow.camera.right).toBeGreaterThan(10);
    expect(light.shadow.camera.left).toBeLessThan(-10);
    expect(light.shadow.camera.top).toBeGreaterThan(0);
    expect(light.shadow.camera.bottom).toBeLessThan(0);
  });

  it('points light.target at the box center', () => {
    const light = new THREE.DirectionalLight();
    const box = new THREE.Box3(new THREE.Vector3(2, 0, 2), new THREE.Vector3(6, 4, 6));
    fitShadowCamera(light, box);
    const center = box.getCenter(new THREE.Vector3());
    expect(light.target.position.x).toBeCloseTo(center.x);
    expect(light.target.position.y).toBeCloseTo(center.y);
    expect(light.target.position.z).toBeCloseTo(center.z);
  });

  it('a larger padding widens the frustum', () => {
    const light = new THREE.DirectionalLight();
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));

    fitShadowCamera(light, box, { padding: 0 });
    const tightRight = light.shadow.camera.right;

    fitShadowCamera(light, box, { padding: 1 });
    const paddedRight = light.shadow.camera.right;

    expect(paddedRight).toBeGreaterThan(tightRight);
  });

  it('applies a projection-matrix update (camera usable immediately, not stale until next render)', () => {
    const light = new THREE.DirectionalLight();
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const before = light.shadow.camera.projectionMatrix.clone();
    fitShadowCamera(light, box);
    expect(light.shadow.camera.projectionMatrix.equals(before)).toBe(false);
  });

  it('repositions the light outside a model large enough that the construction-time default position would sit inside it (regression: a big model contained the light, silently losing its shadow)', () => {
    const light = new THREE.DirectionalLight();
    light.position.set(3, 5, 4); // viewport.ts's own default key-light position, magnitude ~7.07
    // A model with a ~20-unit bounding-sphere radius -- comfortably bigger
    // than the default light position's own distance from the origin.
    const box = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 10, 20));

    fitShadowCamera(light, box);

    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    expect(light.position.distanceTo(center)).toBeGreaterThan(sphere.radius);
  });

  it('preserves the light\'s existing direction from its target — only the distance changes, not the angle', () => {
    const light = new THREE.DirectionalLight();
    light.position.set(3, 5, 4);
    const originalDirection = light.position.clone().normalize();
    const box = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 10, 20));

    fitShadowCamera(light, box);

    const center = box.getCenter(new THREE.Vector3());
    const newDirection = light.position.clone().sub(center).normalize();
    expect(newDirection.x).toBeCloseTo(originalDirection.x, 5);
    expect(newDirection.y).toBeCloseTo(originalDirection.y, 5);
    expect(newDirection.z).toBeCloseTo(originalDirection.z, 5);
  });

  it('uses the real bounding-sphere radius, not half the longest box dimension — a cube\'s corners are outside that half-dimension radius', () => {
    const light = new THREE.DirectionalLight();
    light.position.set(3, 5, 4);
    // A perfect cube: half-dimension is 5, but the true bounding-sphere
    // radius (reaching the corners) is 5 * sqrt(3) ~= 8.66.
    const box = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));

    fitShadowCamera(light, box, { padding: 0 });

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    expect(sphere.radius).toBeCloseTo(5 * Math.sqrt(3), 5);
    expect(light.shadow.camera.right).toBeCloseTo(sphere.radius, 5);
    // The old half-dimension formula would have produced exactly 5 here —
    // confirm the fix actually covers the cube's corners, not just its faces.
    expect(light.shadow.camera.right).toBeGreaterThan(5);
  });

  it('falls back to a default direction when the light already coincides with its target (degenerate case)', () => {
    const light = new THREE.DirectionalLight();
    light.position.set(0, 0, 0);
    light.target.position.set(0, 0, 0);
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2, 2));

    expect(() => fitShadowCamera(light, box)).not.toThrow();
    const center = box.getCenter(new THREE.Vector3());
    expect(light.position.distanceTo(center)).toBeGreaterThan(0);
  });
});

describe('createShadowCatcher', () => {
  it('creates a ShadowMaterial plane that receives shadows', () => {
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 3, 2));
    const catcher = createShadowCatcher(box);
    expect(catcher.receiveShadow).toBe(true);
    expect(catcher.material).toBeInstanceOf(THREE.ShadowMaterial);
    expect((catcher.material as THREE.ShadowMaterial).opacity).toBeCloseTo(0.35);
  });

  it('sizes the plane to sizeFactor * the model footprint', () => {
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2)); // 4x4 footprint
    const catcher = createShadowCatcher(box, { sizeFactor: 3 });
    const geo = catcher.geometry as THREE.PlaneGeometry;
    expect(geo.parameters.width).toBeCloseTo(12);
    expect(geo.parameters.height).toBeCloseTo(12);
  });

  it('positions the plane below box.min.y, not coplanar with it (avoids z-fighting the auto grid)', () => {
    const box = new THREE.Box3(new THREE.Vector3(-2, 1, -2), new THREE.Vector3(2, 3, 2));
    const catcher = createShadowCatcher(box);
    expect(catcher.position.y).toBeLessThan(box.min.y);
  });

  it('the y offset scales with model size, staying visually negligible at very different scales', () => {
    const small = createShadowCatcher(new THREE.Box3(new THREE.Vector3(-0.01, 0, -0.01), new THREE.Vector3(0.01, 0.01, 0.01)));
    const large = createShadowCatcher(new THREE.Box3(new THREE.Vector3(-1000, 0, -1000), new THREE.Vector3(1000, 1000, 1000)));
    const smallOffset = Math.abs(small.position.y - 0);
    const largeOffset = Math.abs(large.position.y - 0);
    expect(largeOffset).toBeGreaterThan(smallOffset);
  });

  it('respects a custom opacity', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const catcher = createShadowCatcher(box, { opacity: 0.8 });
    expect((catcher.material as THREE.ShadowMaterial).opacity).toBeCloseTo(0.8);
  });
});

describe('updateShadowCatcher', () => {
  it('disposes the old geometry and replaces it with a newly-sized one, keeping the same mesh/material instance', () => {
    const box1 = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const catcher = createShadowCatcher(box1);
    const originalGeometry = catcher.geometry;
    const originalMaterial = catcher.material;
    const disposeSpy = { called: false };
    originalGeometry.dispose = () => {
      disposeSpy.called = true;
    };

    const box2 = new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 2, 5));
    updateShadowCatcher(catcher, box2);

    expect(disposeSpy.called).toBe(true);
    expect(catcher.geometry).not.toBe(originalGeometry);
    expect(catcher.material).toBe(originalMaterial);
    const geo = catcher.geometry as THREE.PlaneGeometry;
    expect(geo.parameters.width).toBeCloseTo(20);
  });

  it('repositions to the new box.min.y', () => {
    const box1 = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const catcher = createShadowCatcher(box1);
    const box2 = new THREE.Box3(new THREE.Vector3(-1, 5, -1), new THREE.Vector3(1, 6, 1));
    updateShadowCatcher(catcher, box2);
    expect(catcher.position.y).toBeLessThan(5);
    expect(catcher.position.y).toBeGreaterThan(4);
  });

  it('updates opacity', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const catcher = createShadowCatcher(box, { opacity: 0.2 });
    updateShadowCatcher(catcher, box, { opacity: 0.9 });
    expect((catcher.material as THREE.ShadowMaterial).opacity).toBeCloseTo(0.9);
  });

  it('leaves position untouched on an empty box rather than snapping to y=0', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, 3, -1), new THREE.Vector3(1, 4, 1));
    const catcher = createShadowCatcher(box);
    const before = catcher.position.y;
    updateShadowCatcher(catcher, new THREE.Box3());
    expect(catcher.position.y).toBe(before);
  });
});
