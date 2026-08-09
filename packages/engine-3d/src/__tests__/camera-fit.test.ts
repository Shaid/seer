import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { computeCameraFit } from '../camera-fit.js';

describe('computeCameraFit', () => {
  it('returns null for an empty Box3', () => {
    const box = new THREE.Box3(); // default-constructed Box3 is empty (min=+Inf, max=-Inf)
    expect(computeCameraFit(box, 45)).toBeNull();
  });

  it('frames a unit box centered at the origin', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );
    const fit = computeCameraFit(box, 45);

    expect(fit).not.toBeNull();
    expect(fit!.target.x).toBeCloseTo(0);
    expect(fit!.target.y).toBeCloseTo(0);
    expect(fit!.target.z).toBeCloseTo(0);
    expect(fit!.distance).toBeGreaterThan(0);
    expect(fit!.near).toBeGreaterThan(0);
    expect(fit!.far).toBeGreaterThan(fit!.near);
    // Camera position sits `distance` away from target along the default direction.
    expect(fit!.position.distanceTo(fit!.target)).toBeCloseTo(fit!.distance, 5);
  });

  it('centers on an off-center box, not the origin', () => {
    const box = new THREE.Box3(new THREE.Vector3(9, 19, 29), new THREE.Vector3(11, 21, 31));
    const fit = computeCameraFit(box, 45);

    expect(fit).not.toBeNull();
    expect(fit!.target.x).toBeCloseTo(10);
    expect(fit!.target.y).toBeCloseTo(20);
    expect(fit!.target.z).toBeCloseTo(30);
  });

  it('scales distance to the larger extent of an asymmetric box', () => {
    const narrow = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const wide = new THREE.Box3(new THREE.Vector3(-50, -1, -1), new THREE.Vector3(50, 1, 1));

    const narrowFit = computeCameraFit(narrow, 45)!;
    const wideFit = computeCameraFit(wide, 45)!;

    expect(wideFit.distance).toBeGreaterThan(narrowFit.distance);
  });

  it('respects a custom padding multiplier', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const tight = computeCameraFit(box, 45, { padding: 1 })!;
    const padded = computeCameraFit(box, 45, { padding: 2 })!;
    expect(padded.distance).toBeCloseTo(tight.distance * 2, 5);
  });
});
