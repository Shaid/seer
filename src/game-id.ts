/**
 * game-id.ts — Browser-safe canonical game and platform identifiers.
 *
 * This is the single source of truth for GameId and PlatformId types. It
 * MUST NOT import any Node-only modules (fs, path) — it is bundled by Vite
 * and runs in the browser. Node-only config (tools/shared/game-config.ts)
 * imports these types on top of its own data. Never import the reverse
 * direction — see docs/architecture-overview.md §2 for the dependency rule.
 *
 * Replace the placeholder IDs below with your actual game(s) and
 * platform(s). If you're only ever targeting a single game/platform
 * combination, you can still keep this pattern (it costs nothing) — it pays
 * off the moment you add a second platform port or a second title.
 */

export const GAME_IDS = ['game1'] as const;
export type GameId = (typeof GAME_IDS)[number];

export const PLATFORM_IDS = ['platform1'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const DEFAULT_GAME: GameId = 'game1';
export const DEFAULT_PLATFORM: PlatformId = 'platform1';

export function isGameId(v: string | null): v is GameId {
  return v !== null && (GAME_IDS as readonly string[]).includes(v);
}

export function isPlatformId(v: string | null): v is PlatformId {
  return v !== null && (PLATFORM_IDS as readonly string[]).includes(v);
}

/** Human-readable names for UI display. */
export const GAME_DISPLAY_NAMES: Record<GameId, string> = {
  game1: 'Placeholder Game',
};
