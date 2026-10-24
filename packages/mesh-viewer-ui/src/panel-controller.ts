import { createPopover } from '@seer-project/canvas-export';

/**
 * Shows/hides an element via the `.hidden { display: none }` class every seer
 * project's own `viewer.css` already defines — re-implemented here (rather
 * than imported) so this package has no dependency on any consumer project's
 * local module, same rationale as `@seer-project/audio-ui`'s own copy.
 */
export function setHidden(el: HTMLElement, hidden: boolean): void {
  el.classList.toggle('hidden', hidden);
}

/**
 * The lifecycle skeleton both of this package's settings panels are built on:
 * a toolbar toggle button, the popover panel it opens, a listener-teardown
 * list, and the `attach`/`refresh`/`detach`/`dispose` contract every seer
 * viewer panel follows (the same one `@seer-project/audio-ui`'s
 * `AudioBarController` follows for audio).
 *
 * Both panels had an independent, line-for-line identical copy of all of it;
 * this is that copy written once. It deliberately owns *only* the parts that
 * were identical — the controls inside the panel, and everything about what
 * `refresh()` means, stay with the subclass.
 *
 * Construction order matters and is preserved exactly: the base constructor
 * hides both elements and installs the popover handler *first*, so a
 * subclass's own `bindStaticControls()` (run from its constructor body, after
 * `super()`) still pushes its listeners after the popover's, exactly as when
 * each panel pushed `createPopover` as the first entry of its own
 * `bindStaticControls()`.
 *
 * `TSession` is the host object the panel drives — `MeshSession` for both of
 * today's subclasses, generic so the skeleton makes no engine-3d assumption.
 */
export abstract class PanelController<TSession> {
  protected session: TSession | null = null;
  // Declared, not a constructor parameter property: this workspace builds
  // with `erasableSyntaxOnly`, which rules those out.
  protected readonly toggleBtn: HTMLButtonElement;
  protected readonly panel: HTMLElement;
  private teardown: Array<() => void> = [];

  constructor(toggleBtn: HTMLButtonElement, panel: HTMLElement) {
    this.toggleBtn = toggleBtn;
    this.panel = panel;
    setHidden(toggleBtn, true);
    setHidden(panel, true);
    // Toggle-click / outside-click / Escape-to-close is shared chrome — see
    // @seer-project/canvas-export's createPopover, extracted from
    // MeshSettingsPanel's own original implementation.
    this.teardown.push(createPopover(toggleBtn, panel));
  }

  /** Binds a listener that `dispose()` will unbind. The only way a subclass should add one. */
  protected on(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.teardown.push(() => target.removeEventListener(type, fn));
  }

  /**
   * Points the panel at `session` and shows the toolbar toggle button. Does
   * not open the panel itself — `refresh()` runs here so the controls'
   * displayed values and disabled states reflect the session before the user
   * ever opens it.
   */
  attach(session: TSession): void {
    this.session = session;
    setHidden(this.toggleBtn, false);
    this.refresh();
  }

  /**
   * Closes the panel, hides the toolbar toggle button, and releases the
   * session reference. Call on every asset switch away from a mesh — does not
   * touch the session itself (a host still owns disposing it).
   */
  detach(): void {
    this.onDetach();
    this.session = null;
    setHidden(this.panel, true);
    setHidden(this.toggleBtn, true);
  }

  /**
   * Tears down the controller itself — unbinds every listener bound through
   * `on()` or in the constructor (including the document-level
   * outside-click/Escape handlers). Call when the panel's elements are being
   * removed from the page entirely; not needed for ordinary asset-to-asset
   * switching (use `detach()`/`attach()` for that).
   */
  dispose(): void {
    this.onDetach();
    this.session = null;
    for (const off of this.teardown) off();
    this.teardown = [];
  }

  /**
   * Re-syncs every control's displayed value and disabled state from the
   * attached session. Must be a no-op when nothing is attached.
   */
  abstract refresh(): void;

  /**
   * Per-subclass work shared by `detach()` and `dispose()` — stopping a
   * poll timer, aborting an in-flight recording. Runs before the session
   * reference is released, so it can still reach it. Default: nothing.
   */
  protected onDetach(): void {}
}
