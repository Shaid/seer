import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyToneMapping, cinematicPlansEqual, planCinematicPasses } from '../postprocessing.js';
import type { CinematicOptions, CinematicPassKind } from '../postprocessing.js';

function kinds(opts: CinematicOptions): CinematicPassKind[] {
  return planCinematicPasses(opts).map((p) => p.kind);
}

describe('planCinematicPasses', () => {
  it('with everything off: msaa-target, render, output — the minimum chain', () => {
    expect(kinds({})).toEqual(['msaa-target', 'render', 'output']);
  });

  it('antialias "none" omits msaa-target entirely, with no fxaa either', () => {
    expect(kinds({ antialias: 'none' })).toEqual(['render', 'output']);
  });

  it('antialias "fxaa" omits msaa-target and appends fxaa AFTER output, never before', () => {
    const result = kinds({ antialias: 'fxaa' });
    expect(result).toEqual(['render', 'output', 'fxaa']);
    expect(result.indexOf('output')).toBeLessThan(result.indexOf('fxaa'));
  });

  it('order with every effect on: msaa-target, render, gtao, bokeh, bloom, output — DOF before bloom', () => {
    const result = kinds({ ao: {}, dof: {}, bloom: {} });
    expect(result).toEqual(['msaa-target', 'render', 'gtao', 'bokeh', 'bloom', 'output']);
    expect(result.indexOf('bokeh')).toBeLessThan(result.indexOf('bloom'));
  });

  it('ao alone inserts gtao right after render', () => {
    expect(kinds({ ao: {} })).toEqual(['msaa-target', 'render', 'gtao', 'output']);
  });

  it('dof alone inserts bokeh right after render (no gtao)', () => {
    expect(kinds({ dof: {} })).toEqual(['msaa-target', 'render', 'bokeh', 'output']);
  });

  it('bloom alone inserts bloom right before output', () => {
    expect(kinds({ bloom: {} })).toEqual(['msaa-target', 'render', 'bloom', 'output']);
  });

  it('toneMapping does not add or remove any pass — OutputPass is always present regardless', () => {
    expect(kinds({ toneMapping: false })).toEqual(kinds({ toneMapping: { exposure: 2 } }));
  });

  it('every combination of fxaa + every effect keeps fxaa last, after output', () => {
    const result = kinds({ ao: {}, dof: {}, bloom: {}, antialias: 'fxaa' });
    expect(result[result.length - 1]).toBe('fxaa');
    expect(result[result.length - 2]).toBe('output');
  });
});

describe('cinematicPlansEqual', () => {
  it('true for two independently-built plans with identical options', () => {
    const opts: CinematicOptions = { ao: {}, bloom: {} };
    expect(cinematicPlansEqual(planCinematicPasses(opts), planCinematicPasses({ ...opts }))).toBe(true);
  });

  it('true when only numeric option VALUES differ (same shape) — the "just update uniforms" case', () => {
    const a = planCinematicPasses({ bloom: { strength: 0.2 } });
    const b = planCinematicPasses({ bloom: { strength: 0.9 } });
    expect(cinematicPlansEqual(a, b)).toBe(true);
  });

  it('false when an effect is toggled on/off — a real shape change', () => {
    const a = planCinematicPasses({ bloom: {} });
    const b = planCinematicPasses({});
    expect(cinematicPlansEqual(a, b)).toBe(false);
  });

  it('false when the antialias strategy changes', () => {
    const a = planCinematicPasses({ antialias: 'msaa' });
    const b = planCinematicPasses({ antialias: 'fxaa' });
    expect(cinematicPlansEqual(a, b)).toBe(false);
  });

  it('false when plans differ only in length', () => {
    const a = planCinematicPasses({});
    const b = planCinematicPasses({ ao: {} });
    expect(cinematicPlansEqual(a, b)).toBe(false);
  });

  it('true for two empty plans', () => {
    expect(cinematicPlansEqual([], [])).toBe(true);
  });
});

function fakeRenderer() {
  return {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
  } as unknown as THREE.WebGLRenderer;
}

describe('applyToneMapping', () => {
  it('sets ACESFilmicToneMapping and the given exposure', () => {
    const renderer = fakeRenderer();
    applyToneMapping(renderer, { exposure: 1.5 });
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(1.5);
  });

  it('defaults exposure to 1 when omitted', () => {
    const renderer = fakeRenderer();
    applyToneMapping(renderer, {});
    expect(renderer.toneMappingExposure).toBe(1);
  });

  it('restores NoToneMapping and exposure 1 when opts is false', () => {
    const renderer = fakeRenderer();
    applyToneMapping(renderer, { exposure: 2 });
    applyToneMapping(renderer, false);
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
    expect(renderer.toneMappingExposure).toBe(1);
  });
});
