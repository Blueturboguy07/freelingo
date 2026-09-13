import { expect, it } from 'vitest';
import { newRow, introduceRow, reviewRow, projectStrengthAt } from './fsrs.js';
import { asItemId } from './types.js';
const day = 86400000,
  at = Date.parse('2026-09-01T00:00:00Z');
function taught() {
  return reviewRow(
    introduceRow(
      newRow({
        itemId: asItemId('word'),
        surface: 'gato',
        kind: 'lexeme',
        modalities: ['reading'],
      }),
      new Date(at),
    ),
    { now: new Date(at), grade: 3 },
  ).row;
}
it('[INV-HUB-07][INV-SCH-09] live strength decays without changing saved cards, introduction or Score', () => {
  const row = taught(),
    before = JSON.stringify(row);
  expect(projectStrengthAt(row, new Date(at + day), []).retrievability).toBeGreaterThan(
    projectStrengthAt(row, new Date(at + 10 * day), []).retrievability,
  );
  expect(JSON.stringify(row)).toBe(before);
});
it('[INV-SCH-08][INV-HUB-07] a fully held day adds no decay and shifts displayed due time by exactly that day', () => {
  const row = taught(),
    first = projectStrengthAt(row, new Date(at + day), []);
  const held = projectStrengthAt(row, new Date(at + 2 * day), [
    {
      scope: { kind: 'item', itemId: row.itemId },
      reason: 'report',
      from: new Date(at + day),
      until: new Date(at + 2 * day),
    },
  ]);
  expect(held.retrievability).toBe(first.retrievability);
  expect(held.dueAt.getTime()).toBe(first.dueAt.getTime() + day);
});
it('[INV-SCH-02] strength projection clamps backward clocks and never returns a negative or nonfinite value', () => {
  const row = taught();
  for (const time of [at - day, at, at + 10000 * day]) {
    const value = projectStrengthAt(row, new Date(time), []).retrievability;
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  }
  expect(() => projectStrengthAt(row, new Date(NaN), [])).toThrow();
});
