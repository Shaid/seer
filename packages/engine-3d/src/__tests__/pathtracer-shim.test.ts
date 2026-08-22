import { describe, expect, it } from 'vitest';
import { importPathTracer, isPhotoModeAvailable } from '../pathtracer-shim.js';

// three-gpu-pathtracer is a devDependency of this package specifically so
// this file can exercise the real literal dynamic import — the whole
// point of pathtracer-shim.ts's design (see its doc comment) is that a
// LITERAL specifier is what Vite actually code-splits; a computed one
// isn't resolvable at runtime at all. That claim is worth verifying
// against the real package, not just asserted.

describe('isPhotoModeAvailable', () => {
  it('resolves true when three-gpu-pathtracer is installed', async () => {
    expect(await isPhotoModeAvailable()).toBe(true);
  });
});

describe('importPathTracer', () => {
  it('resolves the real WebGLPathTracer and PhysicalCamera constructors', async () => {
    const mod = await importPathTracer();
    expect(typeof mod.WebGLPathTracer).toBe('function');
    expect(typeof mod.PhysicalCamera).toBe('function');
  });
});
