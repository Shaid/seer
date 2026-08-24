// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshSettingsPanel, type MeshSettingsPanelElements } from '../mesh-settings-panel.js';
import type { MeshSession, Model3D, RenderMode, SpringBoneOptions } from '@seer-project/engine-3d';

function makeSelect(values: string[]): HTMLSelectElement {
  const select = document.createElement('select');
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    select.appendChild(opt);
  }
  return select;
}

function makeElements(): MeshSettingsPanelElements {
  return {
    toggleBtn: document.createElement('button'),
    panel: document.createElement('div'),
    renderModeSelect: makeSelect(['textured', 'faces', 'wireframe', 'points']),
    smoothCheckbox: document.createElement('input'),
    shadingSelect: makeSelect(['lit', 'unlit', 'normals', 'depth', 'toon']),
    subdivideSelect: makeSelect(['0', '1', '2', '4', '8']),
    textureFilterSelect: makeSelect(['nearest', 'linear', 'trilinear']),
    anisotropySelect: document.createElement('select'),
    resetCameraBtn: document.createElement('button'),
  };
}

/** A minimal fake `MeshSession` — just enough state + method stubs for the panel's own wiring, not a real three.js session (see `session.test.ts` in `@seer-project/engine-3d` for that). */
function makeFakeSession(maxAnisotropy = 8): MeshSession {
  const model: Model3D = {
    object: {} as Model3D['object'],
    source: 'gltf',
    animations: [],
    hasTextures: true,
    repr: { faces: null, lines: null, points: null, originalMaterials: new Map() },
  };
  const state = {
    renderMode: 'textured' as RenderMode | null,
    shading: 'lit' as MeshSession['shading'],
    smooth: false,
    subdivision: 0,
    textureFilter: { mode: 'trilinear' as const, anisotropy: 1 },
    springBones: false as false | SpringBoneOptions,
  };
  return {
    viewport: {} as MeshSession['viewport'],
    model,
    animation: null,
    disposed: false,
    get renderMode() { return state.renderMode; },
    get shading() { return state.shading; },
    get smooth() { return state.smooth; },
    get subdivision() { return state.subdivision; },
    get textureFilter() { return state.textureFilter; },
    get springBones() { return state.springBones; },
    setModel: vi.fn(),
    addModel: vi.fn(),
    setRenderMode: vi.fn((mode: RenderMode) => { state.renderMode = mode; }),
    setShading: vi.fn((mode) => { state.shading = mode; }),
    setSmooth: vi.fn((v: boolean) => { state.smooth = v; }),
    setSubdivision: vi.fn((v: number) => { state.subdivision = v; }),
    setTextureFilter: vi.fn((opts) => { state.textureFilter = { mode: opts.mode, anisotropy: opts.anisotropy ?? 1 }; }),
    getMaxAnisotropy: vi.fn(() => maxAnisotropy),
    setColorMode: vi.fn(),
    setSpringBones: vi.fn((opts: false | SpringBoneOptions) => { state.springBones = opts; }),
    stepSpringBones: vi.fn(),
    fit: vi.fn(),
    stats: vi.fn(() => ({ verts: 0, tris: 0 })),
    dispose: vi.fn(),
  } as unknown as MeshSession;
}

function withSpringBonesElements(base: MeshSettingsPanelElements): MeshSettingsPanelElements {
  const springBonesCheckbox = document.createElement('input');
  springBonesCheckbox.type = 'checkbox';
  const springBonesStrengthRange = document.createElement('input');
  springBonesStrengthRange.type = 'range';
  return { ...base, springBonesCheckbox, springBonesStrengthRange };
}

let els: MeshSettingsPanelElements;

beforeEach(() => {
  els = makeElements();
  document.body.append(els.toggleBtn, els.panel);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MeshSettingsPanel — visibility', () => {
  it('starts with the toggle button and panel both hidden', () => {
    new MeshSettingsPanel(els);
    expect(els.toggleBtn.classList.contains('hidden')).toBe(true);
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });

  it('attach() shows the toggle button without opening the panel', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession());
    expect(els.toggleBtn.classList.contains('hidden')).toBe(false);
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });

  it('clicking the toggle button opens, then closes, the panel', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession());
    els.toggleBtn.click();
    expect(els.panel.classList.contains('hidden')).toBe(false);
    els.toggleBtn.click();
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });

  it('a pointerdown outside the panel/toggle button closes it', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession());
    els.toggleBtn.click();
    expect(els.panel.classList.contains('hidden')).toBe(false);

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });

  it('Escape closes the panel', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession());
    els.toggleBtn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });

  it('detach() hides the toggle button and closes the panel', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession());
    els.toggleBtn.click();
    panel.detach();
    expect(els.toggleBtn.classList.contains('hidden')).toBe(true);
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });
});

describe('MeshSettingsPanel — control wiring', () => {
  it('forwards each control change to the matching session setter', () => {
    const panel = new MeshSettingsPanel(els);
    const session = makeFakeSession();
    panel.attach(session);

    els.renderModeSelect.value = 'wireframe';
    els.renderModeSelect.dispatchEvent(new Event('change'));
    expect(session.setRenderMode).toHaveBeenCalledWith('wireframe');

    els.smoothCheckbox.checked = true;
    els.smoothCheckbox.dispatchEvent(new Event('change'));
    expect(session.setSmooth).toHaveBeenCalledWith(true);

    els.shadingSelect.value = 'toon';
    els.shadingSelect.dispatchEvent(new Event('change'));
    expect(session.setShading).toHaveBeenCalledWith('toon');

    els.subdivideSelect.value = '4';
    els.subdivideSelect.dispatchEvent(new Event('change'));
    expect(session.setSubdivision).toHaveBeenCalledWith(4);
  });

  it('does nothing when no session is attached', () => {
    const panel = new MeshSettingsPanel(els);
    expect(() => {
      els.renderModeSelect.dispatchEvent(new Event('change'));
      els.resetCameraBtn.click();
    }).not.toThrow();
    void panel;
  });

  it('reset-camera button calls session.fit() by default', () => {
    const panel = new MeshSettingsPanel(els);
    const session = makeFakeSession();
    panel.attach(session);
    els.resetCameraBtn.click();
    expect(session.fit).toHaveBeenCalled();
  });

  it('reset-camera button calls the onResetCamera hook instead, when provided', () => {
    const onResetCamera = vi.fn();
    const panel = new MeshSettingsPanel(els, { onResetCamera });
    const session = makeFakeSession();
    panel.attach(session);
    els.resetCameraBtn.click();
    expect(onResetCamera).toHaveBeenCalledWith(session);
    expect(session.fit).not.toHaveBeenCalled();
  });

  it('calls the onChange hook after an interactive render-mode or shading change, for a host wiring a sibling RenderSettingsPanel\'s refresh()', () => {
    const onChange = vi.fn();
    const panel = new MeshSettingsPanel(els, { onChange });
    const session = makeFakeSession();
    panel.attach(session);
    onChange.mockClear(); // attach()'s own refresh() must not count as a change

    els.renderModeSelect.value = 'wireframe';
    els.renderModeSelect.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledTimes(1);

    els.shadingSelect.value = 'toon';
    els.shadingSelect.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledTimes(2);

    // A control unrelated to RenderSettingsPanel's refresh() decisions must
    // not trigger it.
    els.smoothCheckbox.checked = true;
    els.smoothCheckbox.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not call onChange when no session is attached', () => {
    const onChange = vi.fn();
    const panel = new MeshSettingsPanel(els, { onChange });
    els.renderModeSelect.dispatchEvent(new Event('change'));
    expect(onChange).not.toHaveBeenCalled();
    void panel;
  });
});

describe('MeshSettingsPanel — texture filter controls', () => {
  it('changing the filter select combines with the current anisotropy value into one setTextureFilter call', () => {
    const panel = new MeshSettingsPanel(els);
    const session = makeFakeSession();
    panel.attach(session);

    els.anisotropySelect.value = '4';
    els.textureFilterSelect.value = 'trilinear';
    els.textureFilterSelect.dispatchEvent(new Event('change'));
    expect(session.setTextureFilter).toHaveBeenCalledWith({ mode: 'trilinear', anisotropy: 4 });
  });

  it('disables the anisotropy select when "nearest" is chosen', () => {
    const panel = new MeshSettingsPanel(els);
    const session = makeFakeSession();
    panel.attach(session);

    els.textureFilterSelect.value = 'nearest';
    els.textureFilterSelect.dispatchEvent(new Event('change'));
    expect(els.anisotropySelect.disabled).toBe(true);

    els.textureFilterSelect.value = 'linear';
    els.textureFilterSelect.dispatchEvent(new Event('change'));
    expect(els.anisotropySelect.disabled).toBe(false);
  });
});

describe('MeshSettingsPanel — refresh()', () => {
  it('rebuilds the anisotropy options as powers of two up to getMaxAnisotropy()', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession(8));
    const values = Array.from(els.anisotropySelect.options).map((o) => o.value);
    expect(values).toEqual(['1', '2', '4', '8']);
  });

  it('appends a non-power-of-two max as its own trailing option', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession(6));
    const values = Array.from(els.anisotropySelect.options).map((o) => o.value);
    expect(values).toEqual(['1', '2', '4', '6']);
  });

  it('a device with no anisotropic filtering support ends up with only "Off"', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession(1));
    const values = Array.from(els.anisotropySelect.options).map((o) => o.value);
    expect(values).toEqual(['1']);
  });

  it('disables render-mode options the current model does not support', () => {
    const panel = new MeshSettingsPanel(els);
    const session = makeFakeSession();
    (session.model as { source: string }).source = 'polygon';
    (session.model!.repr as { faces: unknown }).faces = {};
    panel.attach(session);
    const disabled = Array.from(els.renderModeSelect.options)
      .filter((o) => o.disabled)
      .map((o) => o.value);
    expect(disabled).toEqual(expect.arrayContaining(['textured', 'wireframe', 'points']));
    expect(disabled).not.toContain('faces');
  });

  it('clamps a persisted anisotropy above this device\'s max to the largest available option instead of leaving the select blank (regression: Number(\'\') would then send anisotropy 0, clamped by the engine to 1x instead of the device\'s real max)', () => {
    const panel = new MeshSettingsPanel(els);
    const session = makeFakeSession(8);
    session.setTextureFilter({ mode: 'trilinear', anisotropy: 16 });
    panel.attach(session);

    expect(els.anisotropySelect.value).toBe('8');
  });

  it('syncs displayed values from the session on refresh', () => {
    const panel = new MeshSettingsPanel(els);
    const session = makeFakeSession();
    session.setShading('unlit');
    session.setSmooth(true);
    session.setSubdivision(2);
    panel.attach(session);

    expect(els.shadingSelect.value).toBe('unlit');
    expect(els.smoothCheckbox.checked).toBe(true);
    expect(els.subdivideSelect.value).toBe('2');
  });
});

describe('MeshSettingsPanel — spring bones controls (optional elements)', () => {
  it('is a no-op with the optional elements absent — every existing consumer keeps working unmodified', () => {
    const panel = new MeshSettingsPanel(els);
    const session = makeFakeSession();
    expect(() => panel.attach(session)).not.toThrow();
    expect(session.setSpringBones).not.toHaveBeenCalled();
  });

  it('checking the box enables physics with the host-provided options', () => {
    const elsWithSpringBones = withSpringBonesElements(els);
    const springBoneOptions = vi.fn(() => ({ autoDerive: true }) as SpringBoneOptions);
    const panel = new MeshSettingsPanel(elsWithSpringBones, { springBoneOptions });
    const session = makeFakeSession();
    panel.attach(session);

    elsWithSpringBones.springBonesCheckbox!.checked = true;
    elsWithSpringBones.springBonesCheckbox!.dispatchEvent(new Event('change'));

    expect(springBoneOptions).toHaveBeenCalledWith(session);
    expect(session.setSpringBones).toHaveBeenCalledWith({ autoDerive: true, strength: 1 });
  });

  it('defaults to {} (baked config only) when no springBoneOptions hook is provided', () => {
    const elsWithSpringBones = withSpringBonesElements(els);
    const panel = new MeshSettingsPanel(elsWithSpringBones);
    const session = makeFakeSession();
    panel.attach(session);

    elsWithSpringBones.springBonesCheckbox!.checked = true;
    elsWithSpringBones.springBonesCheckbox!.dispatchEvent(new Event('change'));

    expect(session.setSpringBones).toHaveBeenCalledWith({ strength: 1 });
  });

  it('unchecking the box disables physics', () => {
    const elsWithSpringBones = withSpringBonesElements(els);
    const panel = new MeshSettingsPanel(elsWithSpringBones);
    const session = makeFakeSession();
    panel.attach(session);

    elsWithSpringBones.springBonesCheckbox!.checked = false;
    elsWithSpringBones.springBonesCheckbox!.dispatchEvent(new Event('change'));

    expect(session.setSpringBones).toHaveBeenCalledWith(false);
  });

  it('moving the strength slider forwards its value while checked', () => {
    const elsWithSpringBones = withSpringBonesElements(els);
    const panel = new MeshSettingsPanel(elsWithSpringBones);
    const session = makeFakeSession();
    panel.attach(session);

    elsWithSpringBones.springBonesCheckbox!.checked = true;
    elsWithSpringBones.springBonesStrengthRange!.value = '0.4';
    elsWithSpringBones.springBonesStrengthRange!.dispatchEvent(new Event('input'));

    expect(session.setSpringBones).toHaveBeenCalledWith({ strength: 0.4 });
  });

  it('refresh() syncs the checkbox and strength slider from session state', () => {
    const elsWithSpringBones = withSpringBonesElements(els);
    const panel = new MeshSettingsPanel(elsWithSpringBones);
    const session = makeFakeSession();
    session.setSpringBones({ strength: 0.7 });
    panel.attach(session);

    expect(elsWithSpringBones.springBonesCheckbox!.checked).toBe(true);
    expect(elsWithSpringBones.springBonesStrengthRange!.value).toBe('0.7');
    expect(elsWithSpringBones.springBonesStrengthRange!.disabled).toBe(false);
  });

  it('refresh() disables the strength slider while physics is off', () => {
    const elsWithSpringBones = withSpringBonesElements(els);
    const panel = new MeshSettingsPanel(elsWithSpringBones);
    panel.attach(makeFakeSession());

    expect(elsWithSpringBones.springBonesCheckbox!.checked).toBe(false);
    expect(elsWithSpringBones.springBonesStrengthRange!.disabled).toBe(true);
  });

  it('checking the box interactively enables the strength slider immediately, without waiting for a later refresh() (regression: the slider stayed disabled until some unrelated future refresh())', () => {
    const elsWithSpringBones = withSpringBonesElements(els);
    const panel = new MeshSettingsPanel(elsWithSpringBones);
    const session = makeFakeSession();
    panel.attach(session);
    expect(elsWithSpringBones.springBonesStrengthRange!.disabled).toBe(true);

    elsWithSpringBones.springBonesCheckbox!.checked = true;
    elsWithSpringBones.springBonesCheckbox!.dispatchEvent(new Event('change'));
    expect(elsWithSpringBones.springBonesStrengthRange!.disabled).toBe(false);

    elsWithSpringBones.springBonesCheckbox!.checked = false;
    elsWithSpringBones.springBonesCheckbox!.dispatchEvent(new Event('change'));
    expect(elsWithSpringBones.springBonesStrengthRange!.disabled).toBe(true);
  });
});

describe('MeshSettingsPanel — dispose()', () => {
  it('unbinds the document-level outside-click listener', () => {
    const panel = new MeshSettingsPanel(els);
    panel.attach(makeFakeSession());
    els.toggleBtn.click();
    panel.dispose();

    // The panel element itself still has the 'hidden' class removed from
    // the open click above; dispose() doesn't touch visibility, only
    // listeners — a later outside click should no longer be able to close
    // it, since nothing is listening anymore.
    els.panel.classList.remove('hidden');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(els.panel.classList.contains('hidden')).toBe(false);
  });
});
