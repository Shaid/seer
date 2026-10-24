/**
 * The GLB container's own framing constants — the handful of magic numbers
 * that `parseGLB` reads and `assembleGLB` writes, named once so the two sides
 * can't drift. Internal: not re-exported from the package barrel, because
 * these are spec constants rather than API.
 *
 * Layout, for the sizes below: a 12-byte header (magic, version, total
 * length) followed by chunks, each an 8-byte header (payload length, type)
 * plus its 4-byte-aligned payload. glTF 2.0 defines exactly two chunk types,
 * JSON (padded with spaces) and BIN (padded with zeros).
 */
export const GLB_MAGIC = 0x46546c67; // "glTF"
export const GLB_VERSION = 2;
export const GLB_HEADER_BYTES = 12;
export const GLB_CHUNK_HEADER_BYTES = 8;
export const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"
export const GLB_CHUNK_BIN = 0x004e4942; // "BIN\0"
/** glTF 2.0 requires the JSON chunk be space-padded and the BIN chunk zero-padded to 4 bytes. */
export const GLB_JSON_PAD = 0x20;
