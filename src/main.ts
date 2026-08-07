/**
 * Browser entry point.
 *
 * Reads ?game=&platform= from the URL if your project supports multiple
 * games/platforms (see src/game-id.ts), then boots the Game engine.
 *
 * Uses `createGame()` (composition-over-inheritance) from @seer-project/engine-2d.
 * For the subclass approach, import `Game` directly instead.
 */
import { createGame } from '@seer-project/engine-2d';

const container = document.getElementById('game-container');
if (!container) {
  throw new Error('Missing #game-container element in index.html');
}

createGame({
  container,
  // Replace with your actual content dimensions once known.
  worldWidth: 1024,
  worldHeight: 1024,

  onInit: () => {
    // TODO: load assets via loadGameAssets(), build sprite layers,
    // tilemaps, entity renderers here, and add them to game.stage.
  },

  onUpdate: () => {
    // TODO: apply camera transform to your world container, update any
    // per-frame game logic (movement, animation, etc).
  },
}).catch((err: unknown) => {
  console.error('Failed to initialise game:', err);
});
