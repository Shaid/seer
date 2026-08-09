import { describe, expect, it } from 'vitest';
import { disposeObject3D } from '../dispose.js';
import type * as THREE from 'three';

/**
 * Hand-built fake `Object3D` tree (audio-ui's fake-object precedent —
 * `native-audio-engine.test.ts`'s `FakeAudioElement` — rather than mocking
 * three itself) with spy `dispose()` methods on geometry/material/texture,
 * so this exercises `disposeObject3D`'s real traversal/duck-typing logic
 * without needing a real WebGL-backed three.js object graph.
 */
class FakeTexture {
  isTexture = true;
  disposeCalls = 0;
  dispose(): void {
    this.disposeCalls++;
  }
}

class FakeMaterial {
  disposeCalls = 0;
  constructor(public textures: Record<string, FakeTexture> = {}) {
    Object.assign(this, textures);
  }
  dispose(): void {
    this.disposeCalls++;
  }
}

class FakeGeometry {
  disposeCalls = 0;
  dispose(): void {
    this.disposeCalls++;
  }
}

class FakeObject3D {
  isMesh = false;
  isPoints = false;
  isLineSegments = false;
  isLine = false;
  children: FakeObject3D[] = [];
  geometry?: FakeGeometry;
  material?: FakeMaterial | FakeMaterial[];

  add(child: FakeObject3D): this {
    this.children.push(child);
    return this;
  }

  // Mirrors THREE.Object3D.traverse: visits `this`, then recurses into
  // children depth-first — the exact shape `disposeObject3D` relies on.
  traverse(callback: (obj: FakeObject3D) => void): void {
    callback(this);
    for (const child of this.children) child.traverse(callback);
  }
}

function fakeMesh(material: FakeMaterial | FakeMaterial[]): FakeObject3D {
  const obj = new FakeObject3D();
  obj.isMesh = true;
  obj.geometry = new FakeGeometry();
  obj.material = material;
  return obj;
}

describe('disposeObject3D', () => {
  it('disposes geometry and every texture on a Mesh material, including a non-MeshStandardMaterial and a non-standard texture-slot name', () => {
    // This is the specific bug being fixed vs. flower's original
    // fixed-6-texture-key `disposeMeshTree`, which only ever checked
    // `map`/`normalMap`/`emissiveMap`/`metalnessMap`/`roughnessMap`/`aoMap`
    // on a hard `instanceof MeshStandardMaterial` — anything else (a plain
    // MeshBasicMaterial's `map`, or a custom shader material's differently
    // named texture uniform) leaked silently. `weirdCustomMap` here stands
    // in for exactly that "not one of the six known keys" case.
    const knownMap = new FakeTexture();
    const weirdMap = new FakeTexture();
    const basicMaterial = new FakeMaterial({ map: knownMap, weirdCustomMap: weirdMap });
    const mesh = fakeMesh(basicMaterial);

    disposeObject3D(mesh as unknown as THREE.Object3D);

    expect(mesh.geometry!.disposeCalls).toBe(1);
    expect(basicMaterial.disposeCalls).toBe(1);
    expect(knownMap.disposeCalls).toBe(1);
    expect(weirdMap.disposeCalls).toBe(1);
  });

  it('disposes every material and its textures on a multi-material Mesh', () => {
    const texA = new FakeTexture();
    const texB = new FakeTexture();
    const matA = new FakeMaterial({ map: texA });
    const matB = new FakeMaterial({ emissiveMap: texB });
    const mesh = fakeMesh([matA, matB]);

    disposeObject3D(mesh as unknown as THREE.Object3D);

    expect(matA.disposeCalls).toBe(1);
    expect(matB.disposeCalls).toBe(1);
    expect(texA.disposeCalls).toBe(1);
    expect(texB.disposeCalls).toBe(1);
  });

  it('disposes a Points node (geometry + material + texture)', () => {
    const tex = new FakeTexture();
    const material = new FakeMaterial({ map: tex });
    const points = new FakeObject3D();
    points.isPoints = true;
    points.geometry = new FakeGeometry();
    points.material = material;

    disposeObject3D(points as unknown as THREE.Object3D);

    expect(points.geometry.disposeCalls).toBe(1);
    expect(material.disposeCalls).toBe(1);
    expect(tex.disposeCalls).toBe(1);
  });

  it('disposes a LineSegments node', () => {
    const material = new FakeMaterial();
    const lines = new FakeObject3D();
    lines.isLineSegments = true;
    lines.geometry = new FakeGeometry();
    lines.material = material;

    disposeObject3D(lines as unknown as THREE.Object3D);

    expect(lines.geometry.disposeCalls).toBe(1);
    expect(material.disposeCalls).toBe(1);
  });

  it('walks a mixed tree, disposing every renderable under it and skipping plain groups without throwing', () => {
    const root = new FakeObject3D(); // a plain Group: no geometry/material

    const texA = new FakeTexture();
    const meshA = fakeMesh(new FakeMaterial({ map: texA }));

    const nestedGroup = new FakeObject3D();
    const texB = new FakeTexture();
    const skinnedLikeMesh = fakeMesh(new FakeMaterial({ map: texB })); // isMesh true, same as a real SkinnedMesh

    const points = new FakeObject3D();
    points.isPoints = true;
    points.geometry = new FakeGeometry();
    points.material = new FakeMaterial();

    nestedGroup.add(skinnedLikeMesh);
    root.add(meshA);
    root.add(nestedGroup);
    root.add(points);

    expect(() => disposeObject3D(root as unknown as THREE.Object3D)).not.toThrow();

    expect(meshA.geometry!.disposeCalls).toBe(1);
    expect(texA.disposeCalls).toBe(1);
    expect(skinnedLikeMesh.geometry!.disposeCalls).toBe(1);
    expect(texB.disposeCalls).toBe(1);
    expect((points.geometry as FakeGeometry).disposeCalls).toBe(1);
  });

  it('does nothing to a node with no geometry/material (a plain Group)', () => {
    const group = new FakeObject3D();
    expect(() => disposeObject3D(group as unknown as THREE.Object3D)).not.toThrow();
  });
});
