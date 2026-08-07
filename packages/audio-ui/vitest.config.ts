import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // AudioBarController wires real DOM elements (classList, addEventListener,
    // input events) — jsdom exercises that faithfully. HTMLMediaElement
    // playback itself is NOT implemented by jsdom (play()/pause() throw
    // "not implemented"), so NativeAudioEngine's own tests drive it through a
    // hand-built stub that satisfies the same duck-typed surface instead of
    // a real <audio> element — see native-audio-engine.test.ts.
    environment: 'jsdom',
  },
});
