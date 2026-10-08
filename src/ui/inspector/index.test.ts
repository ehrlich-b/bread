import { afterEach, expect, it, vi } from 'vitest';
import type { WorkerBus } from '../bus';
import { EditorModel } from '../editor';
import { mountInspector } from './index';

class TestElement {
  children: Array<TestElement | string> = [];
  textContent = ''; className = '';
  set innerHTML(_value: string) { this.children = []; }
  append(...children: Array<TestElement | string>): void { this.children.push(...children); }
  replaceChildren(...children: Array<TestElement | string>): void { this.children = children; }
}
afterEach(() => vi.unstubAllGlobals());

it('renders circuit-supplied IDs as text in missing and multiple selections', () => {
  vi.stubGlobal('document', { createElement: () => new TestElement() });
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  const editor = new EditorModel({} as WorkerBus,
    { version: 1, kind: 'circuit', name: 'untrusted IDs', components: [], nets: [] },
    { netIds: [], componentIds: [], netIndex: new Map(), netsView: new Uint8Array() },
  );
  const id = '<img src=x onerror="globalThis.sharedCodeRan=1">';
  editor.select(id);
  const host = new TestElement();
  const dispose = mountInspector(host as unknown as HTMLElement, editor);
  expect((host.children[0] as TestElement).textContent).toBe(`Selected ${id} (no longer exists)`);
  editor.select('second', 'add');
  const placeholder = host.children[0] as TestElement;
  expect(placeholder.textContent).toBe(`Multiple selected: ${id}, second`);
  expect(placeholder.children[1]).toBe('Press R to rotate, Del to delete.');
  dispose();
});
