/**
 * Toggle/outside-click/Escape popover behavior, extracted from
 * `@seer-project/mesh-viewer-ui`'s `MeshSettingsPanel` (its original,
 * private implementation) so both that panel and this package's own export
 * controls — and any future settings-style popover, e.g. a render-quality
 * panel — share one implementation instead of three copies.
 *
 * This is an extraction, not a reimplementation: the toggle-click
 * `stopPropagation()`, the once-globally-bound outside-click/Escape
 * listeners (cheap no-ops while closed, so there's nothing to add/remove
 * per open/close cycle), and the `.hidden`-class-as-source-of-truth
 * convention are all preserved exactly.
 *
 * The one real change from the original: this returns an unsubscribe
 * function. The original's callers never needed one because they owned a
 * `teardown` array internally; a shared function has no such array to push
 * into, so the caller must be able to tear it down itself — a bare `void`
 * return here would silently break the panel's `dispose()` contract.
 */
export function createPopover(toggleBtn: HTMLButtonElement, panel: HTMLElement): () => void {
  const isOpen = (): boolean => !panel.classList.contains('hidden');
  const open = (): void => {
    panel.classList.remove('hidden');
  };
  const close = (): void => {
    panel.classList.add('hidden');
  };

  const onToggleClick = (e: Event): void => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  };
  const onDocumentPointerDown = (e: Event): void => {
    if (!isOpen()) return;
    const target = e.target as Node;
    if (panel.contains(target) || toggleBtn.contains(target)) return;
    close();
  };
  const onDocumentKeyDown = (e: Event): void => {
    if ((e as KeyboardEvent).key === 'Escape' && isOpen()) close();
  };

  toggleBtn.addEventListener('click', onToggleClick);
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);

  return () => {
    toggleBtn.removeEventListener('click', onToggleClick);
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    document.removeEventListener('keydown', onDocumentKeyDown);
  };
}
