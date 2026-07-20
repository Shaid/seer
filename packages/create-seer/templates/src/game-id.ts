/**
 * Browser-safe canonical game and platform identifiers.
 */

export const GAME_IDS = ['<%= it.game %>'] as const;
export type GameId = (typeof GAME_IDS)[number];

export const PLATFORM_IDS = ['<%= it.platform %>'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const DEFAULT_GAME: GameId = '<%= it.game %>';
export const DEFAULT_PLATFORM: PlatformId = '<%= it.platform %>';

export function isGameId(v: string | null): v is GameId {
  return v !== null && (GAME_IDS as readonly string[]).includes(v);
}

export function isPlatformId(v: string | null): v is PlatformId {
  return v !== null && (PLATFORM_IDS as readonly string[]).includes(v);
}

export const GAME_DISPLAY_NAMES: Record<GameId, string> = {
  <%= it.game %>: '<%= it.displayName %>',
};
