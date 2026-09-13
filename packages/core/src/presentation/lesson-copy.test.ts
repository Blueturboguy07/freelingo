import { describe, expect, it } from 'vitest';
import { REPORT_REASONS, reportReasons, lessonInterstitialCopy } from './lesson-copy.js';
import type { LessonChallenge } from './index.js';
const challenge: LessonChallenge = {
  itemId: 'i',
  type: 'pictureSelect',
  prompt: '¿Dónde?',
  language: 'es',
  instruction: 'Choose',
  acceptedAnswers: ['a'],
  audioRef: 'clip',
  options: [{ id: 'a', text: 'a', imageUri: 'image' }],
  hints: [{ token: 'Dónde', meanings: ['where'] }],
};
describe('source copy resolution', () => {
  it('[INV-GRD-12] all13 report reasons are reachable in applicable contexts, including missing hints and escape', () => {
    expect(REPORT_REASONS).toHaveLength(13);
    expect(new Set(REPORT_REASONS).size).toBe(13);
    expect(reportReasons(challenge)).toEqual(REPORT_REASONS);
    const { audioRef: _audio, options: _options, hints: _hints, ...simple } = challenge;
    expect(reportReasons({ ...simple, type: 'typedTranslate' })).toEqual([
      REPORT_REASONS[0],
      REPORT_REASONS[1],
      REPORT_REASONS[2],
      REPORT_REASONS[11],
      REPORT_REASONS[12],
    ]);
  });
  it('[INV-COM-08] stored interstitial keys resolve to learner copy with the current count', () => {
    expect(lessonInterstitialCopy('combo.amazing_n', 30)).toBe('Amazing! 30 in a row!');
    expect(lessonInterstitialCopy('stepup.audio', 10)).toContain('less sound');
    expect(lessonInterstitialCopy('mistakeReview.one', 0)).not.toContain('exercises');
    expect(lessonInterstitialCopy('not-a-copy-key', 0)).not.toContain('not-a-copy-key');
  });
});
