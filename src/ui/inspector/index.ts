// Property inspector. With nothing selected, shows a placeholder. With one
// component selected, shows id (read-only), type (read-only), position X/Y,
// rotation (0/90/180/270), and a JSON textarea for params. The Apply button
// validates and issues an editor mutate. With multiple selected, summarises
// and exposes only batch operations (rotate, delete via keyboard).

import type { ComponentInstanceJSON } from '../../engine/ir';
import type { EditorModel, EditorState } from '../editor';

const ROTATIONS = [0, 90, 180, 270];

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

  const paramsArea = document.createElement('textarea');
  paramsArea.dataset.field = 'params';
  paramsArea.rows = 3;
  paramsArea.value = inst.params ? JSON.stringify(inst.params, null, 2) : '';
  paramsArea.placeholder = '{}';
  const paramsLabel = wrapLabel('Params (JSON)', paramsArea);
  form.append(paramsLabel);

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
