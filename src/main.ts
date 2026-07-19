/**
 * Browser entry point.
 *
 * Reads ?game=&platform= from the URL if your project supports multiple
 * games/platforms (see src/game-id.ts), then boots the Game engine.
 */
import { Game } from '@seer/engine';

const container = document.getElementById('game-container');
if (!container) {
  throw new Error('Missing #game-container element in index.html');
}

const game = new Game({
  container,
  // Replace with your actual content dimensions once known.
  worldWidth: 1024,
  worldHeight: 1024,
});

game.init().catch((err: unknown) => {
  console.error('Failed to initialise game:', err);
});
