import type { LessonChallenge } from './index.js';
/** deep01 adversarial correction A2, strings captured2026-09-11. All13 supported; context selects. */
export const REPORT_REASONS = Object.freeze([
  'My answer should be accepted.',
  'My answer should not be accepted.',
  'The sentence is unnatural or has an error.',
  'The audio does not sound correct.',
  'The audio is missing.',
  'An image is missing.',
  'An image does not look quite right.',
  'The dictionary hints on hover are missing.',
  'The dictionary hints on hover are wrong.',
  'One or more of the options is offensive.',
  'One or more of the options is a duplicate.',
  "A character wasn't displayed correctly.",
  'Something else went wrong.',
]);
export function reportReasons(challenge: LessonChallenge): readonly string[] {
  const audio =
    challenge.audioRef !== undefined ||
    challenge.type.startsWith('listen') ||
    challenge.type === 'speakSentence';
  const images =
    challenge.type === 'pictureSelect' ||
    challenge.options?.some((option) => option.imageUri !== undefined);
  const hints = (challenge.hints?.length ?? 0) > 0;
  const options =
    (challenge.options?.length ?? 0) > 0 ||
    (challenge.bank?.length ?? 0) > 0 ||
    challenge.type === 'matchPairs';
  return REPORT_REASONS.filter((_, i) =>
    i === 3 || i === 4
      ? audio
      : i === 5 || i === 6
        ? images
        : i === 7 || i === 8
          ? hints
          : i === 9 || i === 10
            ? options
            : true,
  );
}
/** Resolves stored engine keys to source copy; no implementation key reaches the product. */
export function lessonInterstitialCopy(key: string, combo: number): string {
  const values: Readonly<Record<string, string>> = {
    'combo.5_in_a_row': '5 in a row!',
    'combo.10_in_a_row': '10 in a row!',
    'combo.amazing_n': `Amazing! ${combo} in a row!`,
    'combo.outstanding_n': `Outstanding! ${combo} in a row!`,
    'combo.cool_n': `Cool! ${combo} in a row!`,
    'combo.learned_so_much': `${combo} in a row! You've learned so much!`,
    'combo.worked_hard': `You worked hard and got ${combo} right in a row!`,
    'stepup.production': "Great work! Let's make this a bit harder…",
    'stepup.audio': "Great work! Let's make this more challenging with less sound!",
    'mistakeReview.one': "Let's review the exercise you missed!",
    'mistakeReview.many': "Let's review the exercises you missed!",
  };
  return values[key] ?? 'Keep going!';
}
