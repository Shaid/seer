import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { newBuilder, addEmbeddedTexture, assembleGLB } from '../builder.js';
import { parseGLB } from '../reader.js';
import { readImage, readBaseColorImage } from '../node.js';

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba);
  return PNG.sync.write(png);
}

describe('readImage', () => {
  it('decodes a PNG embedded via bufferView', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]); // 2x2
    const png = encodePng(2, 2, rgba);
    const builder = newBuilder();
    addEmbeddedTexture(builder, { name: 'tex', png });
    const glb = parseGLB(assembleGLB(builder));
    const decoded = readImage(glb, 0);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });

  it('decodes a PNG from a base64 data: URI', () => {
    const rgba = new Uint8Array([10, 20, 30, 255]);
    const png = encodePng(1, 1, rgba);
    const glb = {
      json: {
        asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [],
        images: [{ uri: `data:image/png;base64,${Buffer.from(png).toString('base64')}` }],
      },
      bin: new Uint8Array(0),
    };
    const decoded = readImage(glb, 0);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });

  it('resolves an external uri via GlbFile.resolveUri', () => {
    const rgba = new Uint8Array([1, 2, 3, 255]);
    const png = encodePng(1, 1, rgba);
    const glb = {
      json: {
        asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [],
        images: [{ uri: 'tex.png' }],
      },
      bin: new Uint8Array(0),
      resolveUri: (uri: string) => {
        expect(uri).toBe('tex.png');
        return png;
      },
    };
    const decoded = readImage(glb, 0);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });

  it('rejects a non-base64 data: URI', () => {
    const glb = {
      json: {
        asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [],
        images: [{ uri: 'data:image/png,notbase64' }],
      },
      bin: new Uint8Array(0),
    };
    expect(() => readImage(glb, 0)).toThrow(/non-base64/);
  });

  it('throws when an image has no bufferView, no resolvable uri', () => {
    const glb = {
      json: { asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [], images: [{}] },
      bin: new Uint8Array(0),
    };
    expect(() => readImage(glb, 0)).toThrow(/cannot be resolved/);
  });

  it('throws a clear error for a declared non-PNG mimeType instead of an opaque pngjs signature error', () => {
    const glb = {
      json: {
        asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }], buffers: [],
        images: [{ bufferView: 0, mimeType: 'image/jpeg' }],
      },
      bin: new Uint8Array(4),
    };
    expect(() => readImage(glb, 0)).toThrow(/only image\/png is supported/);
  });

  it('throws when a bufferView image extends past the end of the BIN chunk', () => {
    const glb = {
      json: {
        asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 100 }], buffers: [],
        images: [{ bufferView: 0, mimeType: 'image/png' }],
      },
      bin: new Uint8Array(10), // far smaller than the declared bufferView
    };
    expect(() => readImage(glb, 0)).toThrow(/extends past the end of the BIN chunk/);
  });
});

describe('readBaseColorImage', () => {
  it('returns undefined when the material has no baseColor texture', () => {
    const glb = {
      json: { asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [], materials: [{}] },
      bin: new Uint8Array(0),
    };
    expect(readBaseColorImage(glb, 0)).toBeUndefined();
  });

  it('decodes the material baseColor texture end-to-end', () => {
    const rgba = new Uint8Array([9, 8, 7, 255]);
    const png = encodePng(1, 1, rgba);
    const builder = newBuilder();
    const texIdx = addEmbeddedTexture(builder, { name: 'tex', png });
    builder.json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: texIdx } } }];
    const glb = parseGLB(assembleGLB(builder));
    const decoded = readBaseColorImage(glb, 0);
    expect(decoded).toBeDefined();
    expect(Array.from(decoded!.rgba)).toEqual(Array.from(rgba));
  });
});
