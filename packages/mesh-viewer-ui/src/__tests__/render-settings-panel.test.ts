// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshSession, RenderMode, MeshShadingMode, CinematicOptions, PhotoModePhase } from '@seer-project/engine-3d';

const { isPhotoModeAvailableMock, createTurntableMock, turntableMock } = vi.hoisted(() => {
  const turntableMock = {
    step: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    elapsedSeconds: 0,
  };
  return {
    isPhotoModeAvailableMock: vi.fn(async () => true),
    createTurntableMock: vi.fn(() => turntableMock),
    turntableMock,
  };
});

vi.mock('@seer-project/engine-3d', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@seer-project/engine-3d')>();
  return { ...actual, isPhotoModeAvailable: isPhotoModeAvailableMock, createTurntable: createTurntableMock };
});

const { recordClipMock, downloadScreenshotMock, downloadClipMock } = vi.hoisted(() => ({
  recordClipMock: vi.fn(async () => ({ blob: new Blob(['x']), mimeType: 'video/webm', durationSeconds: 4 })),
  downloadScreenshotMock: vi.fn(async () => {}),
  downloadClipMock: vi.fn(),
}));

vi.mock('@seer-project/canvas-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@seer-project/canvas-export')>();
  return {
    ...actual,
    recordClip: recordClipMock,
    downloadScreenshot: downloadScreenshotMock,
    downloadClip: downloadClipMock,
  };
});

const { RenderSettingsPanel } = await import('../render-settings-panel.js');
type RenderSettingsPanelElements = import('../render-settings-panel.js').RenderSettingsPanelElements;

function makeSelect(values: string[]): HTMLSelectElement {
  const select = document.createElement('select');
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    select.appendChild(opt);
  }
  return select;
}

function makeElements(): RenderSettingsPanelElements {
  return {
    toggleBtn: document.createElement('button'),
    panel: document.createElement('div'),
    qualitySelect: makeSelect(['flat', 'cinematic', 'photo']),
    shadowsCheckbox: document.createElement('input'),
    cinematicOptionsRow: document.createElement('div'),
    bloomCheckbox: document.createElement('input'),
    aoCheckbox: document.createElement('input'),
    dofCheckbox: document.createElement('input'),
    photoModeRow: document.createElement('div'),
    photoModeStatus: document.createElement('span'),
    screenshotBtn: document.createElement('button'),
    recordTurntableBtn: document.createElement('button'),
  };
}

function makeFakeSession(opts: { renderMode?: RenderMode; shading?: MeshShadingMode } = {}): MeshSession {
  const state = {
    renderMode: opts.renderMode ?? ('textured' as RenderMode | null),
    shading: opts.shading ?? ('lit' as MeshShadingMode),
    shadows: false,
    cinematic: false as false | CinematicOptions,
    photoMode: 'off' as PhotoModePhase,
  };
  return {
    viewport: { renderer: { domElement: document.createElement('canvas') }, renderNow: vi.fn() } as unknown as MeshSession['viewport'],
    model: null,
    animation: null,
    disposed: false,
    get renderMode() {
      return state.renderMode;
    },
    get shading() {
      return state.shading;
    },
    get shadows() {
      return state.shadows;
    },
    get cinematic() {
      return state.cinematic;
    },
    get photoMode() {
      return state.photoMode;
    },
    setShadows: vi.fn((v: boolean) => {
      state.shadows = v;
    }),
    setCinematic: vi.fn((opts: false | CinematicOptions) => {
      state.cinematic = opts;
    }),
    setPhotoMode: vi.fn(async (opts: false | object) => {
      state.photoMode = opts === false ? 'off' : 'tracing';
    }),
    fit: vi.fn(),
    stats: vi.fn(() => ({ verts: 0, tris: 0 })),
    dispose: vi.fn(),
    // Fields exercised by RenderSettingsPanel's own logic set above; the rest
    // of MeshSession's surface isn't touched by this panel.
  } as unknown as MeshSession;
}

let els: RenderSettingsPanelElements;

beforeEach(() => {
  els = makeElements();
  document.body.append(els.toggleBtn, els.panel);
  isPhotoModeAvailableMock.mockClear().mockResolvedValue(true);
  createTurntableMock.mockClear();
  turntableMock.step.mockClear();
  turntableMock.dispose.mockClear();
  recordClipMock.mockClear();
  downloadScreenshotMock.mockClear();
  downloadClipMock.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

const opts = { watermarkText: () => 'watermark', fileName: () => 'export-name' };

describe('RenderSettingsPanel — visibility', () => {
  it('starts with the toggle button and panel both hidden', () => {
    new RenderSettingsPanel(els, opts);
    expect(els.toggleBtn.classList.contains('hidden')).toBe(true);
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });

  it('attach() shows the toggle button without opening the panel', () => {
    const panel = new RenderSettingsPanel(els, opts);
    panel.attach(makeFakeSession());
    expect(els.toggleBtn.classList.contains('hidden')).toBe(false);
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });

  it('clicking the toggle button opens, then closes, the panel', () => {
    const panel = new RenderSettingsPanel(els, opts);
    panel.attach(makeFakeSession());
    els.toggleBtn.click();
    expect(els.panel.classList.contains('hidden')).toBe(false);
    els.toggleBtn.click();
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });

  it('detach() hides the toggle button, closes the panel, and forces photo mode off is left to the host (detach does not touch the session)', () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);
    els.toggleBtn.click();
    panel.detach();
    expect(els.toggleBtn.classList.contains('hidden')).toBe(true);
    expect(els.panel.classList.contains('hidden')).toBe(true);
  });
});

describe('RenderSettingsPanel — tier selector wiring', () => {
  it('selecting cinematic calls setCinematic with the current toggle states and turns photo mode off', async () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);

    els.bloomCheckbox.checked = true;
    els.qualitySelect.value = 'cinematic';
    els.qualitySelect.dispatchEvent(new Event('change'));

    expect(session.setPhotoMode).toHaveBeenCalledWith(false);
    expect(session.setCinematic).toHaveBeenCalledWith(
      expect.objectContaining({ bloom: expect.any(Object), ao: false, dof: false }),
    );
  });

  it('selecting photo calls setPhotoMode and turns cinematic off', async () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);

    els.qualitySelect.value = 'photo';
    els.qualitySelect.dispatchEvent(new Event('change'));

    expect(session.setCinematic).toHaveBeenCalledWith(false);
    expect(session.setPhotoMode).toHaveBeenCalledWith({});
  });

  it('selecting flat forces both cinematic and photo mode off', () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);

    els.qualitySelect.value = 'flat';
    els.qualitySelect.dispatchEvent(new Event('change'));

    expect(session.setCinematic).toHaveBeenCalledWith(false);
    expect(session.setPhotoMode).toHaveBeenCalledWith(false);
  });

  it('toggling bloom/AO/DOF only calls setCinematic while the cinematic tier is selected', () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);

    els.aoCheckbox.checked = true;
    els.aoCheckbox.dispatchEvent(new Event('change'));
    expect(session.setCinematic).not.toHaveBeenCalled();

    els.qualitySelect.value = 'cinematic';
    els.qualitySelect.dispatchEvent(new Event('change'));
    (session.setCinematic as ReturnType<typeof vi.fn>).mockClear();

    els.dofCheckbox.checked = true;
    els.dofCheckbox.dispatchEvent(new Event('change'));
    expect(session.setCinematic).toHaveBeenCalledWith(
      expect.objectContaining({ ao: expect.any(Object), dof: expect.any(Object) }),
    );
  });

  it('shadows checkbox forwards to setShadows regardless of tier', () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);

    els.shadowsCheckbox.checked = true;
    els.shadowsCheckbox.dispatchEvent(new Event('change'));
    expect(session.setShadows).toHaveBeenCalledWith(true);
  });
});

describe('RenderSettingsPanel — sub-option rows shown per tier', () => {
  it('cinematicOptionsRow is only visible when the cinematic tier is active', () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);
    expect(els.cinematicOptionsRow.classList.contains('hidden')).toBe(true);

    els.qualitySelect.value = 'cinematic';
    els.qualitySelect.dispatchEvent(new Event('change'));
    expect(els.cinematicOptionsRow.classList.contains('hidden')).toBe(false);
    expect(els.photoModeRow.classList.contains('hidden')).toBe(true);
  });

  it('photoModeRow is only visible when the photo tier is active', () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);

    els.qualitySelect.value = 'photo';
    els.qualitySelect.dispatchEvent(new Event('change'));
    expect(els.photoModeRow.classList.contains('hidden')).toBe(false);
    expect(els.cinematicOptionsRow.classList.contains('hidden')).toBe(true);
  });
});

describe('RenderSettingsPanel — shadows greyed per shading mode', () => {
  it.each([
    ['unlit', 'textured', true],
    ['normals', 'textured', true],
    ['depth', 'textured', true],
    ['lit', 'textured', false],
    ['lit', 'wireframe', true],
    ['lit', 'points', true],
    ['toon', 'textured', false],
  ] as const)('shading=%s renderMode=%s -> disabled=%s', (shading, renderMode, expectedDisabled) => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession({ shading, renderMode });
    panel.attach(session);
    expect(els.shadowsCheckbox.disabled).toBe(expectedDisabled);
  });
});

describe('RenderSettingsPanel — photo mode availability', () => {
  it('disables the photo option when three-gpu-pathtracer is unavailable', async () => {
    isPhotoModeAvailableMock.mockResolvedValue(false);
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);
    await Promise.resolve();
    await Promise.resolve();

    const photoOption = Array.from(els.qualitySelect.options).find((o) => o.value === 'photo')!;
    expect(photoOption.disabled).toBe(true);
  });

  it('disables the photo option for wireframe/points render modes even when available', () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession({ renderMode: 'wireframe' });
    panel.attach(session);

    const photoOption = Array.from(els.qualitySelect.options).find((o) => o.value === 'photo')!;
    expect(photoOption.disabled).toBe(true);
  });
});

describe('RenderSettingsPanel — export buttons', () => {
  it('screenshot button delegates to downloadScreenshot with a CaptureSource over the renderer canvas and the built watermark/filename', async () => {
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);

    els.screenshotBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(downloadScreenshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ canvas: session.viewport.renderer.domElement }),
      'export-name',
      { watermark: { text: 'watermark' } },
    );
  });

  it('record-turntable button builds a turntable-driven CaptureSource, records, downloads, and disposes the turntable', async () => {
    const panel = new RenderSettingsPanel(els, { ...opts, turntable: { durationSeconds: 2, fps: 20 } });
    const session = makeFakeSession();
    panel.attach(session);

    els.recordTurntableBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createTurntableMock).toHaveBeenCalledWith(session.viewport, { durationSeconds: 2, loops: 1 });
    expect(recordClipMock).toHaveBeenCalledWith(
      expect.objectContaining({ canvas: session.viewport.renderer.domElement }),
      expect.objectContaining({ fps: 20, durationSeconds: 2, watermark: { text: 'watermark' } }),
    );

    // The CaptureSource's renderNow steps the turntable at exactly 1/fps before rendering.
    const source = recordClipMock.mock.calls[0][0];
    source.renderNow();
    expect(turntableMock.step).toHaveBeenCalledWith(1 / 20);
    expect(session.viewport.renderNow).toHaveBeenCalled();

    expect(downloadClipMock).toHaveBeenCalledWith(
      { blob: expect.any(Blob), mimeType: 'video/webm', durationSeconds: 4 },
      'export-name',
    );
    expect(turntableMock.dispose).toHaveBeenCalled();
    expect(els.recordTurntableBtn.disabled).toBe(false);
  });

  it('does nothing when no session is attached', () => {
    const panel = new RenderSettingsPanel(els, opts);
    expect(() => {
      els.screenshotBtn.click();
      els.recordTurntableBtn.click();
      els.qualitySelect.dispatchEvent(new Event('change'));
    }).not.toThrow();
    void panel;
  });
});

describe('RenderSettingsPanel — reduced panel (optional elements absent)', () => {
  function makeReducedElements(): RenderSettingsPanelElements {
    return {
      toggleBtn: document.createElement('button'),
      panel: document.createElement('div'),
      qualitySelect: makeSelect(['flat', 'cinematic', 'photo']),
      shadowsCheckbox: document.createElement('input'),
      screenshotBtn: document.createElement('button'),
      recordTurntableBtn: document.createElement('button'),
    };
  }

  it('constructs, attaches, and refreshes without throwing when every optional element is omitted', () => {
    const reduced = makeReducedElements();
    document.body.append(reduced.toggleBtn, reduced.panel);
    expect(() => {
      const panel = new RenderSettingsPanel(reduced, opts);
      panel.attach(makeFakeSession());
      panel.refresh();
    }).not.toThrow();
  });

  it('selecting cinematic with no per-effect checkboxes still enables the full bundle', () => {
    const reduced = makeReducedElements();
    document.body.append(reduced.toggleBtn, reduced.panel);
    const panel = new RenderSettingsPanel(reduced, opts);
    const session = makeFakeSession();
    panel.attach(session);

    reduced.qualitySelect.value = 'cinematic';
    reduced.qualitySelect.dispatchEvent(new Event('change'));

    expect(session.setCinematic).toHaveBeenCalledWith({
      bloom: expect.any(Object),
      ao: expect.any(Object),
      dof: expect.any(Object),
    });
  });

  it('reaching the photo tier with no photoModeStatus element still works (status text is simply not written)', async () => {
    const reduced = makeReducedElements();
    document.body.append(reduced.toggleBtn, reduced.panel);
    const panel = new RenderSettingsPanel(reduced, opts);
    const session = makeFakeSession();
    panel.attach(session);

    expect(() => {
      reduced.qualitySelect.value = 'photo';
      reduced.qualitySelect.dispatchEvent(new Event('change'));
    }).not.toThrow();
  });
});

describe('RenderSettingsPanel — dispose()', () => {
  it('unbinds listeners and stops the photo-mode poll', () => {
    vi.useFakeTimers();
    const panel = new RenderSettingsPanel(els, opts);
    const session = makeFakeSession();
    panel.attach(session);
    els.qualitySelect.value = 'photo';
    els.qualitySelect.dispatchEvent(new Event('change'));

    panel.dispose();

    els.panel.classList.remove('hidden');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(els.panel.classList.contains('hidden')).toBe(false);
    vi.useRealTimers();
  });
});
