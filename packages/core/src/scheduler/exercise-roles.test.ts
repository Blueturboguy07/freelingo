import { describe, expect, it } from 'vitest';
import { EXERCISE_TYPES } from '../session/types.js';
import { roleOfExerciseType, asItemId, asSessionId } from './types.js';
import { applyEncounter, emptySchedulerState, introduce, registerRows } from './engine.js';

const PRODUCTION = [
  'wordBankTranslate',
  'typedTranslate',
  'completeChat',
  'listenTypeWhatYouHear',
  'listenMissingWord',
  'listenRepeat',
  'listenAndRespond',
  'gapFillTyped',
  'completeWord',
  'typeWordEnding',
  'readAndRespond',
  'speakSentence',
] as const;
const RECOGNITION = [
  'pictureSelect',
  'matchPairs',
  'meaningSelect',
  'listenTapWhatYouHear',
  'gapFillSelect',
  'pronunciationSelect',
  'characterSelect',
  'characterTrace',
  'characterBuild',
  'learnCharacters',
] as const;
describe('actual exercise types at the production delay boundary', () => {
  it.each(PRODUCTION)(
    '[INV-SCH-10] %s cannot produce a just-introduced item through the real scheduler caller',
    (type) => {
      const itemId = asItemId('lex:es:gato');
      const at = new Date('2026-09-13T12:00:00Z');
      const state = introduce(
        registerRows(emptySchedulerState('UTC'), [{ itemId, surface: 'gato', kind: 'lexeme' }]),
        itemId,
        'gato',
        at,
      );
      const encounter = {
        sessionId: asSessionId('session'),
        exerciseIndex: 1,
        itemId,
        surface: 'gato',
        role: roleOfExerciseType(type),
        grade: 3 as const,
        at: new Date(at.getTime() + 20 * 60_000),
      };
      const refused = applyEncounter(state, encounter);
      expect(refused.state.anomalies.map((row) => row.kind)).toContain('productionTooSoon');
      expect(refused.state.rows).toBe(state.rows);
      const allowed = applyEncounter(state, {
        ...encounter,
        at: new Date(at.getTime() + 4 * 3_600_000),
      });
      expect(allowed.state.anomalies.map((row) => row.kind)).not.toContain('productionTooSoon');
    },
  );
  it.each(RECOGNITION)(
    '[INV-SCH-10] the declared recognition shape %s stays available for early recall',
    (type) => {
      expect(roleOfExerciseType(type)).toBe('recognition');
    },
  );
  it('[INV-PACK-19] every current exercise has a reviewed classification', () => {
    expect([...PRODUCTION, ...RECOGNITION].sort()).toEqual([...EXERCISE_TYPES].sort());
  });
  it.each([
    'speak',
    'completeTheChat',
    'gapFill',
    'listening',
    'readRespond',
    'character',
    'unknown',
    '__proto__',
    'constructor',
  ])(
    '[INV-PACK-19] rejects unsupported exercise type %s before it can bypass production eligibility',
    (type) => {
      expect(() => roleOfExerciseType(type)).toThrow();
    },
  );
});
