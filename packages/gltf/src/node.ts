/**
 * Node-only glTF image decoding — reading an embedded PNG's pixels out of a
 * GLB. Kept out of the main browser-safe barrel (`./index.js`) since it
 * imports `pngjs`.
 */
import { PNG } from 'pngjs';
import { baseColorImageSource, type GlbFile, type GlbImage } from './reader.js';

export type { GlbImage };

/** Decode a PNG image from its `bufferView`, a base64 `data:` URI, or (via `GlbFile.resolveUri`) an external file. Throws for a non-PNG `mimeType` (declared explicitly, e.g. a Blender export that kept a source JPEG) rather than letting pngjs fail with an unrelated "invalid file signature", and throws if a `bufferView` image's bounds don't fit inside the BIN chunk rather than letting `Buffer.from` throw an unrelated bounds error — see `reader.ts`'s header doc for the overall image-support scope. */
export function readImage(glb: GlbFile, imageIndex: number): GlbImage {
  const img = glb.json.images?.[imageIndex];
  if (!img) throw new Error(`gltf-reader: no image ${imageIndex}`);
  if (img.mimeType !== undefined && img.mimeType !== 'image/png') {
    throw new Error(`gltf-reader: image ${imageIndex} has mimeType "${img.mimeType}", only image/png is supported`);
  }
  let pngBytes: Buffer;
  if (img.bufferView !== undefined) {
    const bv = glb.json.bufferViews[img.bufferView];
    if (!bv) throw new Error(`gltf-reader: image ${imageIndex} references missing bufferView ${img.bufferView}`);
    const start = bv.byteOffset ?? 0;
    if (start + bv.byteLength > glb.bin.byteLength) {
      throw new Error(`gltf-reader: image ${imageIndex}'s bufferView ${img.bufferView} (offset ${start}, length ${bv.byteLength}) extends past the end of the BIN chunk (${glb.bin.byteLength} bytes)`);
    }
    pngBytes = Buffer.from(glb.bin.buffer, glb.bin.byteOffset + start, bv.byteLength);
  } else if (img.uri !== undefined && img.uri.startsWith('data:')) {
    const comma = img.uri.indexOf(',');
    if (comma < 0 || !img.uri.slice(0, comma).endsWith(';base64')) throw new Error(`gltf-reader: image ${imageIndex} has a non-base64 data: URI`);
    pngBytes = Buffer.from(img.uri.slice(comma + 1), 'base64');
  } else if (img.uri !== undefined && glb.resolveUri) {
    const bytes = glb.resolveUri(img.uri);
    pngBytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else {
    throw new Error(`gltf-reader: image ${imageIndex} has no bufferView and its uri "${img.uri ?? ''}" cannot be resolved (pass GlbFile.resolveUri for a separate .gltf's external images)`);
  }
  const decoded = PNG.sync.read(pngBytes);
  return { rgba: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength), width: decoded.width, height: decoded.height };
}

/** The base-colour image for a material, or `undefined` if it has none (or no `pbrMetallicRoughness` at all). */
export function readBaseColorImage(glb: GlbFile, materialIndex: number): GlbImage | undefined {
  const source = baseColorImageSource(glb, materialIndex);
  if (source === undefined) return undefined;
  return readImage(glb, source);
}
