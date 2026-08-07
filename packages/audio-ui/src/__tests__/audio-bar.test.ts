// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlaybackEngine, PlaybackState } from '@seer-project/core';
import { AudioBarController, type AudioBarElements } from '../audio-bar.ts';

/**
 * A minimal, fully controllable fake `PlaybackEngine` — real DOM elements
 * (via jsdom) exercise `AudioBarController`'s actual wiring, but the engine
 * itself is a hand-built stub rather than `NativeAudioEngine`, since jsdom
 * doesn't implement `HTMLMediaElement` playback (see vitest.config.ts).
 * This also lets tests exercise the optional-method branches (`stop`,
 * `seek`, `setVolume`) independently of each other, which a single real
 * engine wouldn't cover in one place.
 */
function makeFakeEngine(initial: Partial<PlaybackState>, opts: { stop?: boolean; seek?: boolean; setVolume?: boolean } = {}) {
  let state: PlaybackState = {
    isPlaying: false,
    currentTime: 0,
    duration: null,
    seekable: false,
    title: 'Test Track',
    ...initial,
  };
  const listeners = new Set<(s: PlaybackState) => void>();
  const fire = () => listeners.forEach((cb) => cb(state));

  const engine: PlaybackEngine & { setState(s: Partial<PlaybackState>): void } = {
    play: vi.fn(() => {
      state = { ...state, isPlaying: true };
      fire();
    }),
    pause: vi.fn(() => {
      state = { ...state, isPlaying: false };
      fire();
    }),
    getState: () => state,
    onStateChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: vi.fn(),
    setState(s: Partial<PlaybackState>) {
      state = { ...state, ...s };
      fire();
    },
  };

  if (opts.stop) engine.stop = vi.fn(() => engine.setState({ isPlaying: false, currentTime: 0 }));
  if (opts.seek) engine.seek = vi.fn((seconds: number) => engine.setState({ currentTime: seconds }));
  if (opts.setVolume) engine.setVolume = vi.fn((v: number) => engine.setState({ volume: v }));

  return engine;
}

function makeElements(withOptional = true): AudioBarElements {
  const bar = document.createElement('div');
  const toggleBtn = document.createElement('button');
  const seekInput = document.createElement('input');
  seekInput.type = 'range';
  // Matches every real project's markup (e.g. flower's `#audio-seek`): a
  // fixed 0-1000 scale so the controller's `value/1000 * duration` seek math
  // has sub-second resolution regardless of the track's actual length.
  seekInput.min = '0';
  seekInput.max = '1000';
  const timeLabel = document.createElement('span');
  const els: AudioBarElements = { bar, toggleBtn, seekInput, timeLabel };
  if (withOptional) {
    els.stopBtn = document.createElement('button');
    els.volumeInput = document.createElement('input');
    els.volumeInput.type = 'range';
  }
  return els;
}

describe('AudioBarController', () => {
  let els: AudioBarElements;
  let controller: AudioBarController;

  beforeEach(() => {
    els = makeElements();
    controller = new AudioBarController(els);
  });

  it('hides the bar until an engine is attached', () => {
    expect(els.bar.classList.contains('hidden')).toBe(true);
  });

  it('shows the bar and renders initial state on attach', () => {
    const engine = makeFakeEngine({ title: 'Song A', isPlaying: true });
    controller.attach(engine);
    expect(els.bar.classList.contains('hidden')).toBe(false);
    expect(els.toggleBtn.textContent).toBe('⏸');
    expect(els.toggleBtn.classList.contains('playing')).toBe(true);
  });

  it('toggle button calls play() when paused and pause() when playing', () => {
    const engine = makeFakeEngine({ isPlaying: false });
    controller.attach(engine);
    els.toggleBtn.click();
    expect(engine.play).toHaveBeenCalledTimes(1);

    engine.setState({ isPlaying: true });
    els.toggleBtn.click();
    expect(engine.pause).toHaveBeenCalledTimes(1);
  });

  it('reflects a non-seekable engine by hiding the seek input and showing detail text', () => {
    const engine = makeFakeEngine({ seekable: false, detail: 'Order 2/9 · Row 12' });
    controller.attach(engine);
    expect(els.seekInput!.style.display).toBe('none');
    expect(els.timeLabel.textContent).toBe('Order 2/9 · Row 12');
  });

  it('reflects a seekable engine with a live time readout and a visible slider', () => {
    const engine = makeFakeEngine({ seekable: true, currentTime: 30, duration: 120 });
    controller.attach(engine);
    expect(els.seekInput!.style.display).toBe('');
    expect(els.seekInput!.value).toBe('250'); // 30/120 * 1000
    expect(els.timeLabel.textContent).toBe('0:30 / 2:00');
  });

  it('dragging the seek slider calls engine.seek() scaled by duration, only when seek() exists', () => {
    const seekable = makeFakeEngine({ seekable: true, duration: 100 }, { seek: true });
    controller.attach(seekable);
    els.seekInput!.value = '500';
    els.seekInput!.dispatchEvent(new Event('input'));
    expect(seekable.seek).toHaveBeenCalledWith(50);

    const notSeekable = makeFakeEngine({ seekable: false });
    controller.attach(notSeekable);
    els.seekInput!.value = '500';
    expect(() => els.seekInput!.dispatchEvent(new Event('input'))).not.toThrow();
  });

  it('shows the stop button only for an engine that implements stop()', () => {
    const withStop = makeFakeEngine({}, { stop: true });
    controller.attach(withStop);
    expect(els.stopBtn!.classList.contains('hidden')).toBe(false);
    els.stopBtn!.click();
    expect(withStop.stop).toHaveBeenCalledTimes(1);

    const withoutStop = makeFakeEngine({});
    controller.attach(withoutStop);
    expect(els.stopBtn!.classList.contains('hidden')).toBe(true);
  });

  it('shows the volume slider only for an engine that implements setVolume(), and forwards input events', () => {
    const withVolume = makeFakeEngine({ volume: 0.5 }, { setVolume: true });
    controller.attach(withVolume);
    expect(els.volumeInput!.classList.contains('hidden')).toBe(false);
    expect(els.volumeInput!.value).toBe('50');

    els.volumeInput!.value = '80';
    els.volumeInput!.dispatchEvent(new Event('input'));
    expect(withVolume.setVolume).toHaveBeenCalledWith(0.8);

    const withoutVolume = makeFakeEngine({});
    controller.attach(withoutVolume);
    expect(els.volumeInput!.classList.contains('hidden')).toBe(true);
  });

  it('disposes the previous engine when attach() is called again with a new one', () => {
    const first = makeFakeEngine({});
    const second = makeFakeEngine({});
    controller.attach(first);
    controller.attach(second);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it('re-attaching the same engine instance is a refresh, not a teardown (does not dispose/re-subscribe)', () => {
    const engine = makeFakeEngine({ isPlaying: false });
    controller.attach(engine);
    engine.setState({ isPlaying: true }); // simulate the engine changing state on its own
    controller.attach(engine); // e.g. wyrm reselecting an already-playing track
    expect(engine.dispose).not.toHaveBeenCalled();
    // Still reflects live state and still shows the bar.
    expect(els.toggleBtn.textContent).toBe('⏸');
    expect(els.bar.classList.contains('hidden')).toBe(false);
  });

  it('detach() disposes the engine and hides the bar', () => {
    const engine = makeFakeEngine({});
    controller.attach(engine);
    controller.detach();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(els.bar.classList.contains('hidden')).toBe(true);
  });

  it('autoplay:true on attach() calls play() immediately', () => {
    const engine = makeFakeEngine({});
    controller.attach(engine, { autoplay: true });
    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it('works with only the required elements (no stopBtn/volumeInput supplied)', () => {
    const minimalEls = makeElements(false);
    const minimalController = new AudioBarController(minimalEls);
    const engine = makeFakeEngine({}, { stop: true, setVolume: true });
    expect(() => minimalController.attach(engine)).not.toThrow();
    minimalController.detach();
  });

  it('works with no seekInput at all (wyrm\'s panel shape — tracker playback is never seekable) and falls back to detail text in timeLabel', () => {
    const bar = document.createElement('div');
    const toggleBtn = document.createElement('button');
    const timeLabel = document.createElement('span');
    const noSeekController = new AudioBarController({ bar, toggleBtn, timeLabel });
    const engine = makeFakeEngine({ seekable: false, detail: 'Ord 1/9 · Row 0 · PAL' });
    expect(() => noSeekController.attach(engine)).not.toThrow();
    expect(timeLabel.textContent).toBe('Ord 1/9 · Row 0 · PAL');
    noSeekController.detach();
  });
});
