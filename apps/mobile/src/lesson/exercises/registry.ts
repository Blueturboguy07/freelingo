import type { ExerciseType } from '@freelingo/core/session';
export type RendererKind =
  'picture' | 'choice' | 'bank' | 'typed' | 'chat' | 'match' | 'speak' | 'trace' | 'introduce';
interface RendererContract {
  readonly kind: RendererKind;
  readonly accessibilityInstructions: string;
}
const choice = {
  kind: 'choice',
  accessibilityInstructions: 'Choose one answer, then activate Check.',
} as const;
const typed = {
  kind: 'typed',
  accessibilityInstructions: 'Enter your answer, then activate Check.',
} as const;
const bank = {
  kind: 'bank',
  accessibilityInstructions:
    'Choose words in answer order. Activate an answer word to return it to its original bank position.',
} as const;
const speak = {
  kind: 'speak',
  accessibilityInstructions: 'Activate Tap to speak when ready. You can choose Can’t speak now.',
} as const;
export const EXERCISE_RENDERERS: Record<ExerciseType, RendererContract> = {
  pictureSelect: { ...choice, kind: 'picture' },
  matchPairs: {
    kind: 'match',
    accessibilityInstructions:
      'Choose a word in the first column and its matching word in the second column. Match all five pairs.',
  },
  meaningSelect: choice,
  wordBankTranslate: bank,
  typedTranslate: typed,
  completeChat: {
    kind: 'chat',
    accessibilityInstructions:
      'Read the first message, activate Next, and select a reply. Then activate Check.',
  },
  listenTapWhatYouHear: bank,
  listenTypeWhatYouHear: typed,
  listenMissingWord: typed,
  listenRepeat: speak,
  listenAndRespond: typed,
  gapFillSelect: choice,
  gapFillTyped: typed,
  completeWord: typed,
  typeWordEnding: typed,
  readAndRespond: typed,
  speakSentence: speak,
  pronunciationSelect: choice,
  characterSelect: choice,
  characterTrace: {
    kind: 'trace',
    accessibilityInstructions:
      'Follow the numbered strokes in order. Screen reader sessions use a generated recognition replacement.',
  },
  characterBuild: bank,
  learnCharacters: {
    kind: 'introduce',
    accessibilityInstructions: 'Read the character and its reading, then activate Continue.',
  },
};
