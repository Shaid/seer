/**
 * Schema major version shared by all three walker data files
 * (`levels.json`, `slots.json`, `semantics.json`). Bump this — and the
 * validators in `validate.ts` — whenever a breaking shape change lands.
 * The loader hard-fails on an unrecognised version rather than guessing.
 */
export const SCHEMA_VERSION = 1;
