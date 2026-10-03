import { decodeWordContents, wordRomDimensions, type WordRomParams } from '../../engine/behavioral/mem_rom';

// Edits only the visible ROM draft. The inspector's Apply button remains the
// single circuit mutation, so word edits participate in normal undo/save.
export const buildWordRomEditor = (contents: HTMLTextAreaElement, params: HTMLTextAreaElement): HTMLElement => {
  const panel = document.createElement('fieldset');
  const legend = document.createElement('legend'); legend.textContent = 'ROM word editor'; panel.append(legend);
  const hint = document.createElement('p');
  hint.textContent = 'One hex word per address. SEL=1 reads; SEL=0 releases the data pins. Set a word, then Apply to save the draft.';
  panel.append(hint);
  const address = document.createElement('input');
  address.type = 'number'; address.min = '0'; address.step = '1'; address.value = '0'; address.dataset.field = 'word-address';
  const word = document.createElement('input'); word.dataset.field = 'word-value';
  const label = (name: string, input: HTMLElement): HTMLLabelElement => {
    const element = document.createElement('label'); const title = document.createElement('span'); title.textContent = name;
    element.append(title, input); return element;
  };
  panel.append(label('Preview address', address), label('Word (hex)', word));
  const preview = document.createElement('pre'); preview.dataset.field = 'word-preview'; preview.setAttribute('aria-live', 'polite');
  preview.style.whiteSpace = 'pre-wrap'; preview.style.overflowWrap = 'anywhere';
  panel.append(preview);
  const draft = (): { values: Uint32Array; dataBits: number; bitLabels?: string[] } => {
    const parsed: unknown = params.value.trim() ? JSON.parse(params.value) : {};
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ROM params must be a JSON object');
    const romParams = parsed as WordRomParams;
    const { size, dataBits } = wordRomDimensions(romParams);
    address.max = String(size - 1);
    const selected = Number(address.value);
    if (!Number.isInteger(selected) || selected < 0 || selected >= size) throw new Error(`Address must be from 0 to ${size - 1}`);
    return { values: decodeWordContents(contents.value, size, dataBits), dataBits, bitLabels: romParams.bitLabels };
  };
  const refresh = (): void => {
    try {
      const { values, dataBits, bitLabels } = draft();
      const selected = Number(address.value); const value = values[selected]!;
      word.value = value.toString(16).toUpperCase().padStart(Math.ceil(dataBits / 4), '0');
      const names: string[] = [];
      for (let bit = 0; bit < dataBits; bit++) if (((value >>> bit) & 1) === 1) names.push(bitLabels?.[bit] || `D${bit}`);
      preview.textContent = `Address ${selected} (0x${selected.toString(16).toUpperCase()}) = 0x${word.value}\n${value.toString(2).padStart(dataBits, '0')}\nSet bits: ${names.join(', ') || 'none'}`;
    } catch (error) { preview.textContent = error instanceof Error ? error.message : String(error); }
  };
  address.addEventListener('input', refresh); contents.addEventListener('input', refresh); params.addEventListener('input', refresh);
  const set = document.createElement('button'); set.type = 'button'; set.textContent = 'Set word in draft';
  set.dataset.action = 'set-rom-word';
  set.addEventListener('click', () => {
    try {
      const { values, dataBits } = draft();
      const entered = word.value.trim();
      if (!/^(?:0x)?[0-9a-f]+$/i.test(entered)) throw new Error('Enter one hex word');
      const value = decodeWordContents(entered, 1, dataBits)[0]!;
      values[Number(address.value)] = value;
      const digits = Math.ceil(dataBits / 4);
      contents.value = Array.from(values, (item) => item.toString(16).toUpperCase().padStart(digits, '0')).join('\n');
      refresh();
    } catch (error) { preview.textContent = error instanceof Error ? error.message : String(error); }
  });
  panel.append(set); refresh(); return panel;
};
