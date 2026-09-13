/** P3 view data only. Session state, grading and persistence remain in their existing engines. */
import type { ExerciseType } from '../session/types.js';
export interface BankTile {
  readonly id: string;
  readonly text: string;
  readonly reading?: string;
}
export interface LessonOption extends BankTile {
  readonly imageUri?: string;
  readonly imageDescription?: string;
}
export interface LessonPair {
  readonly leftId: string;
  readonly left: string;
  readonly rightId: string;
  readonly right: string;
}
export interface LessonChallenge {
  readonly itemId: string;
  readonly type: ExerciseType;
  readonly instruction: string;
  readonly prompt: string;
  readonly language: string;
  readonly promptLanguage?: string;
  readonly acceptedAnswers: readonly string[];
  readonly options?: readonly LessonOption[];
  readonly bank?: readonly BankTile[];
  readonly pairs?: readonly LessonPair[];
  readonly audioRef?: string;
  readonly slowAudioRef?: string;
  readonly requiresIme?: boolean;
  readonly accentCharacters?: readonly string[];
  readonly introduction?: 'word' | 'phrase' | 'grammar' | 'character' | 'counter' | 'particle';
  readonly tip?: string;
  readonly hard?: boolean;
}
export function toggleBankTile(
  selected: readonly string[],
  id: string,
  bank: readonly BankTile[],
): readonly string[] {
  if (!bank.some((tile) => tile.id === id)) return selected;
  return selected.includes(id) ? selected.filter((tileId) => tileId !== id) : [...selected, id];
}
export function selectedBankText(selected: readonly string[], bank: readonly BankTile[]): string {
  return selected
    .map((id) => bank.find((tile) => tile.id === id)?.text ?? '')
    .filter(Boolean)
    .join(' ');
}
export function readSelectedTileIds(
  partial: Readonly<Record<string, unknown>>,
  bank: readonly BankTile[],
): readonly string[] {
  const value = partial['selectedTileIds'];
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (id): id is string => typeof id === 'string' && bank.some((tile) => tile.id === id),
          ),
        ),
      ]
    : [];
}
export function insertAtSelection(
  text: string,
  insert: string,
  selection: { readonly start: number; readonly end: number },
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(text.length, selection.start));
  const end = Math.max(start, Math.min(text.length, selection.end));
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}
export function rubyVisible(type: ExerciseType, role: 'prompt' | 'answer' | 'feedback'): boolean {
  return !(role === 'answer' && (type === 'characterSelect' || type === 'characterBuild'));
}
