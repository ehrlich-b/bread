import type { EditorModel } from './editor';

// The hosts remain mounted inside native details, so collapsing a panel
// preserves form edits, waveform state and editor subscriptions.
export const mountResponsivePanels = (editor: EditorModel): (() => void) => {
  const compact = window.matchMedia('(max-width: 1024px)');
  const panels = [...document.querySelectorAll<HTMLDetailsElement>('.workspace-panel')];
  const tutorial = document.querySelector<HTMLDetailsElement>('.panel-tutorial')!;
  const palette = document.getElementById('palette')!;
  const inspector = document.querySelector<HTMLDetailsElement>('.panel-inspector')!;
  const waveforms = document.querySelector<HTMLDetailsElement>('.panel-waveforms')!;
  const layout = (): void => {
    for (const panel of panels) panel.open = !compact.matches || panel === tutorial;
  };
  layout(); compact.addEventListener('change', layout);
  const place = (event: MouseEvent): void => {
    if (!compact.matches || !editor.state.placement || !(event.target as Element).closest('[data-palette-type]')) return;
    document.querySelector<HTMLDetailsElement>('.panel-palette')!.open = false;
    document.getElementById('schematic')!.scrollIntoView({ block: 'start' });
  };
  palette.addEventListener('click', place);
  const showTutorial = (event: MouseEvent): void => {
    if ((event.target as Element).closest('[aria-controls="tutorial"]')) tutorial.open = true;
  };
  document.querySelector('header')!.addEventListener('click', showTutorial, { capture: true });
  let selection = editor.state.selection;
  let probes = editor.state.circuit.probes;
  const unsubscribe = editor.subscribe(state => {
    if (compact.matches) {
      if (state.selection !== selection && state.selection.size > 0) inspector.open = true;
      if (state.circuit.probes !== probes && state.circuit.probes?.length) waveforms.open = true;
    }
    selection = state.selection; probes = state.circuit.probes;
  });
  return () => {
    unsubscribe(); compact.removeEventListener('change', layout);
    palette.removeEventListener('click', place);
    document.querySelector('header')!.removeEventListener('click', showTutorial, { capture: true });
  };
};
