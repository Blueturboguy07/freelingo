import { describe, expect, it } from 'vitest';
import {
  toggleBankTile,
  selectedBankText,
  readSelectedTileIds,
  insertAtSelection,
  rubyVisible,
} from './index.js';

const bank = [
  { id: 'one', text: 'mi' },
  { id: 'two', text: 'casa' },
  { id: 'three', text: 'mi' },
];
describe('P3 persisted presentation', () => {
  it('[INV-TYP-06] [INV-TYP-12] selects stable tile IDs and leaves source order byte-identical', () => {
    const before = JSON.stringify(bank);
    const ids = toggleBankTile(toggleBankTile([], 'three', bank), 'two', bank);
    expect(ids).toEqual(['three', 'two']);
    expect(selectedBankText(ids, bank)).toBe('mi casa');
    expect(toggleBankTile(ids, 'three', bank)).toEqual(['two']);
    expect(toggleBankTile(ids, 'missing', bank)).toEqual(ids);
    expect(JSON.stringify(bank)).toBe(before);
  });
  it('[INV-SESS-15] restores valid partial IDs once and never invents a tile', () => {
    expect(
      readSelectedTileIds({ selectedTileIds: ['two', 'two', 5, 'missing', 'one'] }, bank),
    ).toEqual(['two', 'one']);
  });
  it('[INV-I18N-03] accent insertion preserves caret and replaces only selected text', () => {
    expect(insertAtSelection('senor', 'ñ', { start: 2, end: 3 })).toEqual({
      text: 'señor',
      caret: 3,
    });
    expect(insertAtSelection('a😀b', 'é', { start: 1, end: 3 })).toEqual({ text: 'aéb', caret: 2 });
  });
  it('[INV-TYP-18] ruby cannot reveal recognition answers but legendary prompts retain it', () => {
    expect(rubyVisible('characterSelect', 'answer')).toBe(false);
    expect(rubyVisible('characterSelect', 'prompt')).toBe(true);
    expect(rubyVisible('typedTranslate', 'prompt')).toBe(true);
    expect(rubyVisible('characterBuild', 'answer')).toBe(false);
  });
});
