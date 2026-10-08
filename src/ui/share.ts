import type { CircuitJSON } from '../engine/ir';
import type { EditorModel } from './editor';
import { decodeCircuit, encodeCircuit, MAX_SHARE_URL_LENGTH } from './permalink';

export const mountShareControls = (
  host: HTMLElement,
  editor: EditorModel,
  example: (name: string) => CircuitJSON | undefined,
): (() => void) => {
  const share = document.createElement('button'); share.type = 'button'; share.textContent = 'Share';
  share.dataset.fileAction = 'share';
  const error = document.createElement('span'); error.setAttribute('role', 'alert');
  const dialog = document.createElement('dialog'); dialog.className = 'chip-dialog share-dialog';
  dialog.setAttribute('aria-label', 'Share circuit');
  const hint = document.createElement('p');
  const link = document.createElement('input'); link.type = 'text'; link.readOnly = true;
  link.setAttribute('aria-label', 'Share link');
  const copied = document.createElement('p'); copied.setAttribute('role', 'status');
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy link';
  copy.addEventListener('click', () => {
    void Promise.resolve().then(() => navigator.clipboard.writeText(link.value)).then(() => { copied.textContent = 'Link copied.'; }).catch(() => {
      link.focus(); link.select(); copied.textContent = 'Copy the selected link with Ctrl/Cmd+C.';
    });
  });
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close share';
  close.addEventListener('click', () => dialog.close());
  dialog.append(hint, link, copied, copy, close); document.body.append(dialog);
  let busy = false;
  let disposed = false;
  const refresh = (): void => { share.disabled = busy || editor.state.editingChip !== null; };
  const unsub = editor.subscribe(refresh); refresh();
  share.addEventListener('click', () => {
    busy = true; refresh(); error.textContent = '';
    void editor.whenIdle().then(async () => {
      const hash = await encodeCircuit(editor.project);
      if (disposed) return;
      const url = new URL(window.location.href); url.hash = hash;
      if (url.href.length > MAX_SHARE_URL_LENGTH) {
        throw new Error(`Circuit is too large to share: ${url.href.length.toLocaleString()} characters (limit 16,000). Use Download JSON instead.`);
      }
      // Updating the address for sharing must not reopen/reset this circuit.
      window.history.replaceState(null, '', url.href);
      link.value = url.href;
      hint.textContent = `This link includes the circuit, probes and chip library (${url.href.length.toLocaleString()} / 16,000 characters).`;
      copied.textContent = '';
      dialog.showModal(); link.focus(); link.select();
    }).catch((reason: unknown) => {
      if (!disposed) error.textContent = reason instanceof Error ? reason.message : String(reason);
    }).finally(() => { busy = false; refresh(); });
  });

  const loadHash = (): void => {
    const hash = window.location.hash;
    let read: Promise<CircuitJSON | null> = Promise.resolve(null);
    if (/^#c(?:[0-9]|=|$)/.test(hash)) {
      read = window.location.href.length > MAX_SHARE_URL_LENGTH
        ? Promise.reject(new Error('Shared circuit link exceeds the 16,000-character URL limit. Use Open JSON instead.'))
        : decodeCircuit(hash);
    } else if (hash.startsWith('#example=')) {
      read = Promise.resolve().then(() => {
        const circuit = example(decodeURIComponent(hash.slice('#example='.length)));
        if (!circuit) throw new Error('Unknown shared example. Choose a circuit from Examples.');
        return structuredClone(circuit);
      });
    }
    // Reserve the revision immediately, just like Open JSON. Even clearing
    // the hash supersedes an older decompression which is still in flight.
    void editor.loadCircuit(read).catch((reason: unknown) => {
      if (!disposed) editor.reportError(`Cannot open shared circuit: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
  };
  window.addEventListener('hashchange', loadHash);
  if (window.location.hash) loadHash();
  host.append(share, error);
  return () => {
    disposed = true; unsub(); window.removeEventListener('hashchange', loadHash); dialog.remove();
  };
};
