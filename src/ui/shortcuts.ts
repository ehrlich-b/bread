export const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['Space', 'Run / pause'],
  ['.', 'Step one tick'],
  ['Ctrl/Cmd+Z', 'Undo'],
  ['Shift+Ctrl/Cmd+Z or Ctrl+Y', 'Redo'],
  ['Delete / Backspace', 'Remove selection'],
  ['R', 'Rotate selection 90°'],
  ['Escape', 'Cancel placement, wiring, probe or bus mode'],
  ['F', 'Fit circuit'],
  ['?', 'Show keyboard shortcuts'],
  ['+ / − / 0', 'Zoom in / out / reset view'],
];

export const shortcutBlocked = (event: KeyboardEvent): boolean => {
  if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return true;
  const active = document.activeElement;
  const target = event.target;
  return [active, target].some(element => element instanceof Element && (
    element.matches('input, textarea, select') || element.closest('[contenteditable]:not([contenteditable="false"])') !== null
  ));
};
