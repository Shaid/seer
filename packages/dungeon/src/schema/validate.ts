/**
 * Hand-written runtime validators for the three walker data files.
 *
 * Deliberately dependency-free (no zod/ajv/etc) so `@seer/dungeon/schema`
 * stays zero-dependency per its package.json — a Node-side exporter can
 * import just this subpath without pulling in anything else. Each
 * validator throws a descriptive `Error` on malformed input, and always
 * checks `schemaVersion` first since an unrecognised major version is the
 * one error every consumer must hard-fail on rather than guess through.
 */
import { SCHEMA_VERSION } from './version.ts';
import type { DungeonLevelFile, CellSpace, WallStorage, LevelUnit, Dir4 } from './level.ts';
import type { SlotTableFile, PieceBankRef, PieceDraw, Slot, BlendMode } from './slots.ts';
import type { SemanticsFile, WallMeaning, FeatureMeaning } from './semantics.ts';

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertSchemaVersion(v: unknown, context: string): asserts v is { schemaVersion: 1 } {
  if (!isPlainObject(v)) fail(context, `expected an object, got ${v === null ? 'null' : typeof v}`);
  const version = (v as Record<string, unknown>).schemaVersion;
  if (version !== SCHEMA_VERSION) {
    fail(
      context,
      `unrecognised schemaVersion ${JSON.stringify(version)} (expected ${SCHEMA_VERSION}) — refusing to guess at an unknown file shape`,
    );
  }
}

function assertString(v: unknown, context: string, field: string): string {
  if (typeof v !== 'string') fail(context, `"${field}" must be a string, got ${typeof v}`);
  return v;
}

function assertNumber(v: unknown, context: string, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(context, `"${field}" must be a finite number, got ${typeof v}`);
  return v;
}

function assertBoolean(v: unknown, context: string, field: string): boolean {
  if (typeof v !== 'boolean') fail(context, `"${field}" must be a boolean, got ${typeof v}`);
  return v;
}

function assertArray(v: unknown, context: string, field: string): unknown[] {
  if (!Array.isArray(v)) fail(context, `"${field}" must be an array, got ${typeof v}`);
  return v;
}

function assertObject(v: unknown, context: string, field: string): Record<string, unknown> {
  if (!isPlainObject(v)) fail(context, `"${field}" must be an object, got ${v === null ? 'null' : typeof v}`);
  return v;
}

function assertDir4(v: unknown, context: string, field: string): Dir4 {
  if (v !== 0 && v !== 1 && v !== 2 && v !== 3) fail(context, `"${field}" must be a Dir4 (0-3), got ${JSON.stringify(v)}`);
  return v;
}

// ---------------------------------------------------------------------------
// levels.json

function validateCellSpace(v: unknown, context: string): CellSpace {
  const o = assertObject(v, context, 'cellSpace');
  if (o.kind === 'flat') {
    return { kind: 'flat', width: assertNumber(o.width, context, 'cellSpace.width'), height: assertNumber(o.height, context, 'cellSpace.height') };
  }
  if (o.kind === 'regions') {
    return {
      kind: 'regions',
      regionCount: assertNumber(o.regionCount, context, 'cellSpace.regionCount'),
      regionSize: assertNumber(o.regionSize, context, 'cellSpace.regionSize'),
      worldWidth: assertNumber(o.worldWidth, context, 'cellSpace.worldWidth'),
      worldHeight: assertNumber(o.worldHeight, context, 'cellSpace.worldHeight'),
    };
  }
  fail(context, `cellSpace.kind must be "flat" or "regions", got ${JSON.stringify(o.kind)}`);
}

function validateWallStorage(v: unknown, context: string): WallStorage {
  const o = assertObject(v, context, 'wallStorage');
  if (o.kind === 'bitflags') {
    const bits = assertArray(o.bits, context, 'wallStorage.bits');
    if (bits.length !== 4) fail(context, `wallStorage.bits must have exactly 4 entries, got ${bits.length}`);
    return {
      kind: 'bitflags',
      plane: assertString(o.plane, context, 'wallStorage.plane'),
      bits: bits.map((b, i) => assertNumber(b, context, `wallStorage.bits[${i}]`)) as [number, number, number, number],
    };
  }
  if (o.kind === 'shared-edge') {
    const planes = assertArray(o.planes, context, 'wallStorage.planes');
    const planeDirs = assertArray(o.planeDirs, context, 'wallStorage.planeDirs');
    if (planes.length !== 2) fail(context, `wallStorage.planes must have exactly 2 entries, got ${planes.length}`);
    if (planeDirs.length !== 2) fail(context, `wallStorage.planeDirs must have exactly 2 entries, got ${planeDirs.length}`);
    return {
      kind: 'shared-edge',
      planes: [assertString(planes[0], context, 'wallStorage.planes[0]'), assertString(planes[1], context, 'wallStorage.planes[1]')],
      planeDirs: [assertDir4(planeDirs[0], context, 'wallStorage.planeDirs[0]'), assertDir4(planeDirs[1], context, 'wallStorage.planeDirs[1]')],
      offMapValue: assertNumber(o.offMapValue, context, 'wallStorage.offMapValue'),
    };
  }
  if (o.kind === 'per-cell-4') {
    const planes = assertArray(o.planes, context, 'wallStorage.planes');
    if (planes.length !== 4) fail(context, `wallStorage.planes must have exactly 4 entries, got ${planes.length}`);
    return {
      kind: 'per-cell-4',
      planes: planes.map((p, i) => assertString(p, context, `wallStorage.planes[${i}]`)) as [string, string, string, string],
    };
  }
  fail(context, `wallStorage.kind must be "bitflags", "shared-edge" or "per-cell-4", got ${JSON.stringify(o.kind)}`);
}

function validateLevelUnit(v: unknown, context: string): LevelUnit {
  const o = assertObject(v, context, 'unit');
  const planesObj = assertObject(o.planes, context, 'unit.planes');
  const planes: Record<string, number[]> = {};
  for (const [key, arr] of Object.entries(planesObj)) {
    const list = assertArray(arr, context, `unit.planes.${key}`);
    planes[key] = list.map((n, i) => assertNumber(n, context, `unit.planes.${key}[${i}]`));
  }
  return {
    id: assertNumber(o.id, context, 'unit.id'),
    name: o.name === undefined ? undefined : assertString(o.name, context, 'unit.name'),
    planes,
    sublevelPlane: o.sublevelPlane === undefined ? undefined : assertString(o.sublevelPlane, context, 'unit.sublevelPlane'),
    sublevels: o.sublevels === undefined ? undefined : assertArray(o.sublevels, context, 'unit.sublevels').map((s, i) => {
      const so = assertObject(s, context, `unit.sublevels[${i}]`);
      return {
        id: assertNumber(so.id, context, `unit.sublevels[${i}].id`),
        label: so.label === undefined ? undefined : assertString(so.label, context, `unit.sublevels[${i}].label`),
        tileset: so.tileset === undefined ? undefined : assertString(so.tileset, context, `unit.sublevels[${i}].tileset`),
        paletteRamp: so.paletteRamp === undefined ? undefined : assertNumber(so.paletteRamp, context, `unit.sublevels[${i}].paletteRamp`),
      };
    }),
    tileset: o.tileset === undefined ? undefined : assertString(o.tileset, context, 'unit.tileset'),
    paletteRamp: o.paletteRamp === undefined ? undefined : assertNumber(o.paletteRamp, context, 'unit.paletteRamp'),
  };
}

export function validateDungeonLevelFile(v: unknown): DungeonLevelFile {
  const context = 'DungeonLevelFile';
  assertSchemaVersion(v, context);
  const o = v as Record<string, unknown>;
  const units = assertArray(o.units, context, 'units').map((u, i) => validateLevelUnit(u, `${context}.units[${i}]`));

  let entities: DungeonLevelFile['entities'];
  if (o.entities !== undefined) {
    const entitiesObj = assertObject(o.entities, context, 'entities');
    entities = {};
    for (const [key, rec] of Object.entries(entitiesObj)) {
      const ro = assertObject(rec, context, `entities.${key}`);
      entities[key] = {
        type: assertNumber(ro.type, context, `entities.${key}.type`),
        gfx: ro.gfx === undefined ? undefined : assertNumber(ro.gfx, context, `entities.${key}.gfx`),
        wallMask: ro.wallMask === undefined ? undefined : assertNumber(ro.wallMask, context, `entities.${key}.wallMask`),
        slotNibble: ro.slotNibble === undefined ? undefined : assertNumber(ro.slotNibble, context, `entities.${key}.slotNibble`),
        chainNext: ro.chainNext === undefined ? undefined : assertNumber(ro.chainNext, context, `entities.${key}.chainNext`),
        flags: ro.flags === undefined ? undefined : assertNumber(ro.flags, context, `entities.${key}.flags`),
        raw: ro.raw === undefined ? undefined : assertArray(ro.raw, context, `entities.${key}.raw`).map((n, i) => assertNumber(n, context, `entities.${key}.raw[${i}]`)),
      };
    }
  }

  return {
    schemaVersion: 1,
    game: assertString(o.game, context, 'game'),
    platform: assertString(o.platform, context, 'platform'),
    cellSpace: validateCellSpace(o.cellSpace, context),
    wallStorage: validateWallStorage(o.wallStorage, context),
    yAxisDown: assertBoolean(o.yAxisDown, context, 'yAxisDown'),
    units,
    entities,
    provenance: o.provenance === undefined ? undefined : (assertObject(o.provenance, context, 'provenance') as Record<string, string>),
  };
}

// ---------------------------------------------------------------------------
// slots.json

const BLEND_MODES: BlendMode[] = ['replace', 'mask', 'or'];

function validatePieceBankRef(v: unknown, context: string): PieceBankRef {
  const o = assertObject(v, context, 'bank');
  return {
    id: assertString(o.id, context, 'bank.id'),
    atlas: assertString(o.atlas, context, 'bank.atlas'),
    image: assertString(o.image, context, 'bank.image'),
    indexed: o.indexed === undefined ? undefined : assertBoolean(o.indexed, context, 'bank.indexed'),
    palette: o.palette === undefined ? undefined : assertString(o.palette, context, 'bank.palette'),
  };
}

function validatePieceDraw(v: unknown, context: string): PieceDraw {
  const o = assertObject(v, context, 'draw');
  const blend = o.blend;
  if (typeof blend !== 'string' || !BLEND_MODES.includes(blend as BlendMode)) {
    fail(context, `draw.blend must be one of ${BLEND_MODES.join(', ')}, got ${JSON.stringify(blend)}`);
  }
  return {
    bank: assertString(o.bank, context, 'draw.bank'),
    frame: assertString(o.frame, context, 'draw.frame'),
    destX: assertNumber(o.destX, context, 'draw.destX'),
    destY: assertNumber(o.destY, context, 'draw.destY'),
    srcX: o.srcX === undefined ? undefined : assertNumber(o.srcX, context, 'draw.srcX'),
    srcY: o.srcY === undefined ? undefined : assertNumber(o.srcY, context, 'draw.srcY'),
    srcW: o.srcW === undefined ? undefined : assertNumber(o.srcW, context, 'draw.srcW'),
    srcH: o.srcH === undefined ? undefined : assertNumber(o.srcH, context, 'draw.srcH'),
    mirrorX: o.mirrorX === undefined ? undefined : assertBoolean(o.mirrorX, context, 'draw.mirrorX'),
    blend: blend as BlendMode,
    maskSource: o.maskSource === undefined ? undefined : (assertString(o.maskSource, context, 'draw.maskSource') as 'plane' | 'index'),
    maskIndex: o.maskIndex === undefined ? undefined : assertNumber(o.maskIndex, context, 'draw.maskIndex'),
    priority: o.priority === undefined ? undefined : assertNumber(o.priority, context, 'draw.priority'),
    hotspot: o.hotspot === undefined ? undefined : { code: assertNumber(assertObject(o.hotspot, context, 'draw.hotspot').code, context, 'draw.hotspot.code') },
    origin: o.origin === undefined ? undefined : assertString(o.origin, context, 'draw.origin'),
  };
}

function validateSlot(v: unknown, context: string): Slot | null {
  if (v === null) return null;
  const o = assertObject(v, context, 'slot');
  const draws = assertArray(o.draws, context, 'slot.draws');
  return { draws: draws.map((d, i) => validatePieceDraw(d, `${context}.draws[${i}]`)) };
}

export function validateSlotTableFile(v: unknown): SlotTableFile {
  const context = 'SlotTableFile';
  assertSchemaVersion(v, context);
  const o = v as Record<string, unknown>;

  const surface = assertObject(o.surface, context, 'surface');
  const viewport = assertObject(o.viewport, context, 'viewport');
  const banks = assertArray(o.banks, context, 'banks').map((b, i) => validatePieceBankRef(b, `${context}.banks[${i}]`));
  const lateralOffsets = assertArray(o.lateralOffsets, context, 'lateralOffsets').map((n, i) => assertNumber(n, context, `lateralOffsets[${i}]`));

  const slotsObj = assertObject(o.slots, context, 'slots');
  const slots: Record<string, Slot | null> = {};
  for (const [key, s] of Object.entries(slotsObj)) {
    slots[key] = validateSlot(s, `${context}.slots.${key}`);
  }

  const ordering = o.ordering === undefined ? undefined : assertString(o.ordering, context, 'ordering');
  if (ordering !== undefined && ordering !== 'array' && ordering !== 'painter-back-to-front') {
    fail(context, `ordering must be "array" or "painter-back-to-front", got ${JSON.stringify(ordering)}`);
  }

  return {
    schemaVersion: 1,
    surface: { width: assertNumber(surface.width, context, 'surface.width'), height: assertNumber(surface.height, context, 'surface.height') },
    viewport: {
      x: assertNumber(viewport.x, context, 'viewport.x'),
      y: assertNumber(viewport.y, context, 'viewport.y'),
      width: assertNumber(viewport.width, context, 'viewport.width'),
      height: assertNumber(viewport.height, context, 'viewport.height'),
    },
    depthCount: assertNumber(o.depthCount, context, 'depthCount'),
    lateralOffsets,
    frontWallMaxDepth: assertNumber(o.frontWallMaxDepth, context, 'frontWallMaxDepth'),
    banks,
    slots,
    staticSlots: o.staticSlots === undefined ? undefined : assertArray(o.staticSlots, context, 'staticSlots').map((s, i) => {
      const slot = validateSlot(s, `${context}.staticSlots[${i}]`);
      if (slot === null) fail(context, `staticSlots[${i}] cannot be null`);
      return slot;
    }),
    ordering: ordering as SlotTableFile['ordering'],
  };
}

// ---------------------------------------------------------------------------
// semantics.json

const CONFIDENCE_LEVELS = ['confirmed', 'rendered', 'hypothesis'];

function validateWallMeaning(v: unknown, context: string): WallMeaning {
  const o = assertObject(v, context, 'wall');
  return {
    label: assertString(o.label, context, 'wall.label'),
    blocksMovement: assertBoolean(o.blocksMovement, context, 'wall.blocksMovement'),
    blocksSight: assertBoolean(o.blocksSight, context, 'wall.blocksSight'),
    pieceKind: o.pieceKind === null ? null : assertString(o.pieceKind, context, 'wall.pieceKind'),
    discoveredPieceKind: o.discoveredPieceKind === undefined
      ? undefined
      : o.discoveredPieceKind === null
        ? null
        : assertString(o.discoveredPieceKind, context, 'wall.discoveredPieceKind'),
  };
}

function validateFeatureMeaning(v: unknown, context: string): FeatureMeaning {
  const o = assertObject(v, context, 'feature');
  return {
    label: assertString(o.label, context, 'feature.label'),
    pieceKind: o.pieceKind === null ? null : assertString(o.pieceKind, context, 'feature.pieceKind'),
    orientationGated: o.orientationGated === undefined ? undefined : assertBoolean(o.orientationGated, context, 'feature.orientationGated'),
    blocksMovement: o.blocksMovement === undefined ? undefined : assertBoolean(o.blocksMovement, context, 'feature.blocksMovement'),
    tag: o.tag === undefined ? undefined : assertString(o.tag, context, 'feature.tag'),
  };
}

export function validateSemanticsFile(v: unknown): SemanticsFile {
  const context = 'SemanticsFile';
  assertSchemaVersion(v, context);
  const o = v as Record<string, unknown>;

  if (typeof o.confidence !== 'string' || !CONFIDENCE_LEVELS.includes(o.confidence)) {
    fail(context, `confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}, got ${JSON.stringify(o.confidence)}`);
  }

  const wallsObj = assertObject(o.walls, context, 'walls');
  const walls: Record<string, WallMeaning> = {};
  for (const [key, w] of Object.entries(wallsObj)) walls[key] = validateWallMeaning(w, `${context}.walls.${key}`);

  const featuresObj = assertObject(o.features, context, 'features');
  const features: Record<string, FeatureMeaning> = {};
  for (const [key, f] of Object.entries(featuresObj)) features[key] = validateFeatureMeaning(f, `${context}.features.${key}`);

  let facingMap: SemanticsFile['facingMap'];
  if (o.facingMap !== undefined) {
    const arr = assertArray(o.facingMap, context, 'facingMap');
    if (arr.length !== 4) fail(context, `facingMap must have exactly 4 entries, got ${arr.length}`);
    facingMap = arr.map((d, i) => assertDir4(d, context, `facingMap[${i}]`)) as [Dir4, Dir4, Dir4, Dir4];
  }

  return {
    schemaVersion: 1,
    confidence: o.confidence as SemanticsFile['confidence'],
    source: assertString(o.source, context, 'source'),
    walls,
    features,
    facingMap,
    yAxisDown: o.yAxisDown === undefined ? undefined : assertBoolean(o.yAxisDown, context, 'yAxisDown'),
  };
}
