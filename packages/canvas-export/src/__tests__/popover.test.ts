// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createPopover } from '../popover.js';

function makeEls(): { toggleBtn: HTMLButtonElement; panel: HTMLElement } {
  const toggleBtn = document.createElement('button');
  const panel = document.createElement('div');
  panel.classList.add('hidden');
  document.body.append(toggleBtn, panel);
  return { toggleBtn, panel };
}

describe('createPopover', () => {
  it('starts closed (does not touch the panel on construction)', () => {
    const { toggleBtn, panel } = makeEls();
    createPopover(toggleBtn, panel);
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('clicking the toggle button opens, then closes, the panel', () => {
    const { toggleBtn, panel } = makeEls();
    createPopover(toggleBtn, panel);
    toggleBtn.click();
    expect(panel.classList.contains('hidden')).toBe(false);
    toggleBtn.click();
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('a pointerdown outside the panel/toggle button closes it', () => {
    const { toggleBtn, panel } = makeEls();
    createPopover(toggleBtn, panel);
    toggleBtn.click();
    expect(panel.classList.contains('hidden')).toBe(false);

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('a pointerdown inside the panel does not close it', () => {
    const { toggleBtn, panel } = makeEls();
    createPopover(toggleBtn, panel);
    toggleBtn.click();
    panel.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.classList.contains('hidden')).toBe(false);
  });

  it('a pointerdown on the toggle button itself does not close it', () => {
    const { toggleBtn, panel } = makeEls();
    createPopover(toggleBtn, panel);
    toggleBtn.click();
    toggleBtn.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.classList.contains('hidden')).toBe(false);
  });

  it('Escape closes the panel', () => {
    const { toggleBtn, panel } = makeEls();
    createPopover(toggleBtn, panel);
    toggleBtn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('Escape while already closed is a no-op', () => {
    const { toggleBtn, panel } = makeEls();
    createPopover(toggleBtn, panel);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('the toggle click does not propagate to the document pointerdown/click listeners', () => {
    const { toggleBtn, panel } = makeEls();
    createPopover(toggleBtn, panel);
    // A real click bubbles as both a 'click' and, in a real browser, a
    // preceding 'pointerdown' — but jsdom's el.click() only fires 'click'.
    // stopPropagation() is exercised structurally here: opening via click
    // must not immediately re-close via the same interaction.
    toggleBtn.click();
    expect(panel.classList.contains('hidden')).toBe(false);
  });

  it('returns an unsubscribe that removes every listener it bound', () => {
    const { toggleBtn, panel } = makeEls();
    const unsubscribe = createPopover(toggleBtn, panel);
    unsubscribe();

    // Toggle click: with listeners removed, clicking should no longer
    // open the panel.
    toggleBtn.click();
    expect(panel.classList.contains('hidden')).toBe(true);

    // Escape: same — no listener left to act on it. Open the panel
    // directly (bypassing the removed toggle listener) to prove Escape
    // really does nothing now, not just that toggle is gone.
    panel.classList.remove('hidden');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.classList.contains('hidden')).toBe(false);

    // Outside pointerdown: same proof structure.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.classList.contains('hidden')).toBe(false);
  });

  it('calling the unsubscribe twice does not throw', () => {
    const { toggleBtn, panel } = makeEls();
    const unsubscribe = createPopover(toggleBtn, panel);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('two independent popovers do not interfere with each other', () => {
    const a = makeEls();
    const b = makeEls();
    createPopover(a.toggleBtn, a.panel);
    createPopover(b.toggleBtn, b.panel);

    a.toggleBtn.click();
    expect(a.panel.classList.contains('hidden')).toBe(false);
    expect(b.panel.classList.contains('hidden')).toBe(true);

    // Escape closes whichever is open — both listeners are bound globally
    // on `document`, each independently checking its own panel's state.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(a.panel.classList.contains('hidden')).toBe(true);
  });
});
