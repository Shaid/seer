import { createGame } from '@seer/engine';

const container = document.getElementById('game-container');
if (!container) {
  throw new Error('Missing #game-container element in index.html');
}

createGame({
  container,
  worldWidth: 1024,
  worldHeight: 1024,
  onInit: () => {
    // TODO: load assets, build sprite layers, tilemaps, etc.
  },
  onUpdate: () => {
    // TODO: per-frame game logic.
  },
}).catch((err: unknown) => {
  console.error('Failed to initialise game:', err);
});
