// Property inspector. With nothing selected, shows a placeholder. With one
// component selected, shows id (read-only), type (read-only), position X/Y,
// rotation (0/90/180/270), and a JSON textarea for params. Memory chips that
// take initial contents (28C16 today) get an extra hex textarea and a .bin
// file input — easier than fighting JSON quoting for multi-kilobyte ROM
// images. The Apply button validates and issues an editor mutate. With
// multiple selected, summarises and exposes only batch operations (rotate,
// delete via keyboard).

import type { ComponentInstanceJSON } from '../../engine/ir';
import type { EditorModel, EditorState } from '../editor';

const ROTATIONS = [0, 90, 180, 270];

// Component types that accept `params.contents` as a hex ROM image. The
// inspector renders a friendlier textarea + file input for these instead of
// requiring the user to paste a multi-line string into the JSON params field.
const HEX_CAPABLE_TYPES = new Set(['mem.28C16']);

const bytesToHex = (bytes: Uint8Array): string => {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, Math.min(i + 16, bytes.length));
    const row = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    lines.push(row);
  }
  return lines.join('\n');
};

export const mountInspector = (host: HTMLElement, editor: EditorModel): (() => void) => {
  const render = (state: EditorState): void => {
    const { selection, circuit } = state;
    if (selection.size === 0) {
      host.innerHTML = '<div class="inspector-empty">Nothing selected</div>';
      return;
    }
    if (selection.size > 1) {
      const ids = [...selection].join(', ');
      host.innerHTML = `<div class="inspector-empty">Multiple selected: ${ids}<br/>Press R to rotate, Del to delete.</div>`;
      return;
    }
    const id = [...selection][0]!;
    const inst = circuit.components.find((c) => c.id === id);
    if (!inst) {
      host.innerHTML = `<div class="inspector-empty">Selected ${id} (no longer exists)</div>`;
      return;
    }
    host.replaceChildren(buildForm(editor, inst));
  };

  render(editor.state);
  return editor.subscribe(render);
};

const buildForm = (editor: EditorModel, inst: ComponentInstanceJSON): HTMLElement => {
  const form = document.createElement('form');
  form.className = 'inspector-form';
  // Distinct from data-comp-id (which lives on the SVG <g>) so test selectors
  // can target one or the other unambiguously.
  form.dataset.inspector = inst.id;
  form.addEventListener('submit', (e) => e.preventDefault());

  const ro = (label: string, value: string): HTMLLabelElement => {
    const l = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = label;
    const v = document.createElement('span');
    v.className = 'inspector-readonly';
    v.textContent = value;
    l.append(span, v);
    return l;
  };

  form.appendChild(ro('ID', inst.id));
  form.appendChild(ro('Type', inst.type));

  const pos = inst.position ?? [0, 0];

  const xInput = numberInput('X', pos[0]);
  const yInput = numberInput('Y', pos[1]);
  form.append(xInput.label, yInput.label);

  const rotSelect = document.createElement('select');
  rotSelect.dataset.field = 'rotation';
  for (const r of ROTATIONS) {
    const o = document.createElement('option');
    o.value = String(r);
    o.textContent = `${String(r)}°`;
    rotSelect.appendChild(o);
  }
  rotSelect.value = String(inst.rotation ?? 0);
  const rotLabel = wrapLabel('Rotation', rotSelect);
  form.append(rotLabel);

  // For hex-capable chips, we strip `contents` from the JSON params view and
  // surface it through a dedicated multi-line textarea below. This keeps the
  // JSON field focused on small structural params and the hex field focused
  // on the ROM image, with no quoting/escaping in either direction.
  const isHexCapable = HEX_CAPABLE_TYPES.has(inst.type);
  let paramsForJson: Record<string, unknown> | undefined = inst.params;
  let initialContents = '';
  if (isHexCapable && inst.params) {
    const { contents, ...rest } = inst.params;
    paramsForJson = Object.keys(rest).length > 0 ? rest : undefined;
    initialContents = typeof contents === 'string' ? contents : '';
  }

  const paramsArea = document.createElement('textarea');
  paramsArea.dataset.field = 'params';
  paramsArea.rows = 3;
  paramsArea.value = paramsForJson ? JSON.stringify(paramsForJson, null, 2) : '';
  paramsArea.placeholder = '{}';
  const paramsLabel = wrapLabel('Params (JSON)', paramsArea);
  form.append(paramsLabel);

  let romArea: HTMLTextAreaElement | null = null;
  let romStatus: HTMLDivElement | null = null;
  if (isHexCapable) {
    romArea = document.createElement('textarea');
    romArea.dataset.field = 'contents';
    romArea.rows = 8;
    romArea.value = initialContents;
    romArea.placeholder = 'DE AD BE EF  // hex bytes; // and # comments OK';
    form.append(wrapLabel('ROM contents (hex)', romArea));

    const binInput = document.createElement('input');
    binInput.type = 'file';
    binInput.accept = '.bin,application/octet-stream';
    binInput.dataset.field = 'contents-bin';
    romStatus = document.createElement('div');
    romStatus.className = 'inspector-substatus';
    romStatus.dataset.field = 'contents-status';
    binInput.addEventListener('change', () => {
      const file = binInput.files?.[0];
      if (!file) return;
      void file
        .arrayBuffer()
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          romArea!.value = bytesToHex(bytes);
          if (romStatus) romStatus.textContent = `Loaded ${String(bytes.length)} bytes from ${file.name}`;
        })
        .catch((err: unknown) => {
          if (romStatus) {
            romStatus.textContent = `read failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        })
        .finally(() => {
          binInput.value = '';
        });
    });
    form.append(wrapLabel('Upload .bin', binInput));
    form.append(romStatus);
  }

  const status = document.createElement('div');
  status.className = 'inspector-status';
  form.appendChild(status);

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.textContent = 'Apply';
  apply.dataset.action = 'apply';
  apply.addEventListener('click', () => {
    status.textContent = '';
    let params: Record<string, unknown> | undefined;
    const txt = paramsArea.value.trim();
    if (txt.length > 0) {
      try {
        params = JSON.parse(txt) as Record<string, unknown>;
      } catch (err) {
        status.textContent = `bad JSON: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }
    if (romArea) {
      const hex = romArea.value;
      // Empty ROM textarea drops the contents key entirely; otherwise the
      // textarea wins over anything in the JSON params blob.
      if (hex.trim().length > 0) {
        params = { ...(params ?? {}), contents: hex };
      } else if (params && 'contents' in params) {
        delete params.contents;
        if (Object.keys(params).length === 0) params = undefined;
      }
    }
    const patch: Partial<ComponentInstanceJSON> = {
      position: [Number(xInput.input.value) || 0, Number(yInput.input.value) || 0],
      rotation: Number(rotSelect.value) || 0,
      ...(params ? { params } : { params: undefined }),
    };
    void editor.updateComponent(inst.id, patch);
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = 'Delete';
  del.dataset.action = 'delete';
  del.className = 'inspector-delete';
  del.addEventListener('click', () => {
    void editor.removeComponent(inst.id);
  });

  const actions = document.createElement('div');
  actions.className = 'inspector-actions';
  actions.append(apply, del);
  form.append(actions);

  return form;
};

const numberInput = (label: string, value: number): { label: HTMLLabelElement; input: HTMLInputElement } => {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.step = '10';
  input.dataset.field = label.toLowerCase();
  return { label: wrapLabel(label, input), input };
};

const wrapLabel = (label: string, control: HTMLElement): HTMLLabelElement => {
  const l = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = label;
  l.append(span, control);
  return l;
};
