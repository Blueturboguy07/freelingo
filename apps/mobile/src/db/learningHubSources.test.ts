import { expect, it } from 'vitest';
import { practiceModesFor } from './learningHubSources';
const typed = {
  type: 'typedTranslate',
  gradingFamily: 'typed-translate',
  targetItemIds: ['word-1'],
} as const;
it('[INV-HUB-04][INV-HUB-09] only an actual matching source can serve Words practice', () => {
  expect(practiceModesFor(typed, new Map())).not.toContain('words');
  expect(
    practiceModesFor({ ...typed, type: 'matchPairs', gradingFamily: 'match' }, new Map()),
  ).toContain('words');
  expect(practiceModesFor({ ...typed, type: 'matchPairs' }, new Map())).not.toContain('words');
});
it('[INV-HUB-09][INV-AUD-01] spoken and listening modes follow the actual exercise registry', () => {
  expect(practiceModesFor(typed, new Map())).not.toContain('listen');
  expect(
    practiceModesFor(
      { ...typed, type: 'listenTypeWhatYouHear', gradingFamily: 'listening' },
      new Map(),
    ),
  ).toContain('listen');
  expect(
    practiceModesFor({ ...typed, type: 'speakSentence', gradingFamily: 'speaking' }, new Map()),
  ).toContain('speak');
});
it('[INV-HUB-09][INV-MIS-07] Mistakes requires a declared different form for the exact missed target', () => {
  expect(practiceModesFor(typed, new Map([['word-1', 'wordBankTranslate']]))).toContain('mistakes');
  expect(practiceModesFor(typed, new Map([['word-1', 'typedTranslate']]))).not.toContain(
    'mistakes',
  );
  expect(practiceModesFor(typed, new Map([['word-1', 'matchPairs']]))).not.toContain('mistakes');
  expect(practiceModesFor(typed, new Map([['other', 'wordBankTranslate']]))).not.toContain(
    'mistakes',
  );
});
it('[INV-MIS-07][INV-HUB-03] a fixed multi-target source cannot hide a same-form missed child', () => {
  expect(
    practiceModesFor(
      { ...typed, targetItemIds: ['word-1', 'word-2'] },
      new Map([
        ['word-1', 'wordBankTranslate'],
        ['word-2', 'typedTranslate'],
      ]),
    ),
  ).not.toContain('mistakes');
});
