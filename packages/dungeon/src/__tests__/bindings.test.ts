import { describe, expect, it } from 'vitest';
import { validateBindingsFile } from '../schema/validate.ts';
import { DEFAULT_BINDINGS, BINDING_ACTIONS } from '../schema/bindings.ts';

describe('DEFAULT_BINDINGS', () => {
  it('is positional (WASD + QE + arrows), and covers every action', () => {
    for (const action of BINDING_ACTIONS) {
      expect(DEFAULT_BINDINGS.bindings[action].length).toBeGreaterThan(0);
    }
    expect(DEFAULT_BINDINGS.bindings.forward).toContain('KeyW');
    expect(DEFAULT_BINDINGS.bindings.forward).toContain('ArrowUp');
    expect(DEFAULT_BINDINGS.bindings.strafeLeft).toContain('KeyA');
    expect(DEFAULT_BINDINGS.bindings.strafeRight).toContain('KeyD');
    expect(DEFAULT_BINDINGS.bindings.turnLeft).toContain('KeyQ');
    expect(DEFAULT_BINDINGS.bindings.turnRight).toContain('KeyE');
    expect(DEFAULT_BINDINGS.mode).toBe('positional');
  });

  it('round-trips through the validator unchanged', () => {
    const result = validateBindingsFile(JSON.parse(JSON.stringify(DEFAULT_BINDINGS)));
    expect(result).toEqual(DEFAULT_BINDINGS);
  });
});

describe('validateBindingsFile', () => {
  it('rejects a bad schemaVersion', () => {
    expect(() => validateBindingsFile({ ...DEFAULT_BINDINGS, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it('rejects a missing action', () => {
    const bad = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
    delete bad.bindings.forward;
    expect(() => validateBindingsFile(bad)).toThrow(/forward/);
  });

  it('rejects an unknown action', () => {
    const bad = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
    bad.bindings.jump = ['Space'];
    expect(() => validateBindingsFile(bad)).toThrow(/unknown action/);
  });

  it('rejects a bad mode', () => {
    expect(() => validateBindingsFile({ ...DEFAULT_BINDINGS, mode: 'vibes' })).toThrow(/mode/);
  });

  it('accepts a rebinding — changing which codes trigger an action is exactly what config-driven rebinding means', () => {
    const custom = {
      ...DEFAULT_BINDINGS,
      bindings: { ...DEFAULT_BINDINGS.bindings, forward: ['KeyI'], turnLeft: ['KeyJ'], turnRight: ['KeyL'] },
    };
    const result = validateBindingsFile(custom);
    expect(result.bindings.forward).toEqual(['KeyI']);
    expect(result.bindings.turnLeft).toEqual(['KeyJ']);
    expect(result.bindings.turnRight).toEqual(['KeyL']);
  });
});
