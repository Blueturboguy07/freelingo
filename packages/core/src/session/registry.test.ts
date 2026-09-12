import { describe, expect, it } from 'vitest';
import {
  EXERCISE_REGISTRY,
  GRADING_RULES,
  NEVER_A_RECYCLE_TARGET,
  NODE_TYPE_EMITS,
  NODE_TYPES,
  emittableExerciseTypes,
  exerciseSpec,
  undeclaredShellStatesInRegistry,
} from './registry.js';
import { EXERCISE_TYPES, isDeclaredShellState } from './types.js';

describe('exercise-type registry (S032-S042)', () => {
  it('[INV-PACK-19] every exercise-type string the node-type registry can emit has a declared state machine, heart cost and grading rule', () => {
    const undeclared: string[] = [];
    for (const type of emittableExerciseTypes()) {
      const spec = EXERCISE_REGISTRY[type];
      if (spec === undefined) {
        undeclared.push(`${type}: no registry row`);
        continue;
      }
      if (spec.machine === undefined || spec.machine.states.length === 0) {
        undeclared.push(`${type}: no state machine`);
      }
      if (spec.heartCost === undefined) undeclared.push(`${type}: no heart cost`);
      if (!GRADING_RULES.includes(spec.grading)) undeclared.push(`${type}: no grading rule`);
    }
    expect(undeclared).toEqual([]);
    // The scan is only worth something if it found the whole inventory.
    expect(emittableExerciseTypes().length).toBeGreaterThanOrEqual(15);
  });

  it('[INV-PACK-19] falsifier: `Build the character` reaches generation with a declaration, and an undeclared type throws rather than being served', () => {
    // The falsifier names `characterBuild` specifically: the six-sub-form character family
    // is where the corpus found a type with no declared source.
    expect(EXERCISE_REGISTRY.characterBuild.grading).toBe('orderedComposition');
    expect(NODE_TYPE_EMITS.characters).toContain('characterBuild');
    expect(() => exerciseSpec('buildTheCharacter' as never)).toThrow(/no declaration/);
  });

  it('[INV-PACK-19] every node type declares what it emits, and emits nothing undeclared', () => {
    for (const nodeType of NODE_TYPES) {
      const emits = NODE_TYPE_EMITS[nodeType];
      expect(emits.length, `${nodeType} emits nothing`).toBeGreaterThan(0);
      for (const type of emits) expect(EXERCISE_TYPES).toContain(type);
    }
  });

  it('[INV-SESS-22] every state a challenge machine can be in is a declared shell state', () => {
    expect(undeclaredShellStatesInRegistry()).toEqual([]);
    for (const type of EXERCISE_TYPES) {
      for (const state of EXERCISE_REGISTRY[type].machine.states) {
        expect(isDeclaredShellState(state)).toBe(true);
      }
    }
  });

  it('[INV-MIS-07] every recycle target is itself a declared type, and Trace is never a target', () => {
    for (const type of EXERCISE_TYPES) {
      for (const target of EXERCISE_REGISTRY[type].recycleTargets) {
        expect(EXERCISE_TYPES).toContain(target);
        expect(NEVER_A_RECYCLE_TARGET).not.toContain(target);
      }
    }
  });

  it('[INV-MIS-08] non-punitive types are never scorable and never cost a heart (D-SKIPSPEAK)', () => {
    for (const type of EXERCISE_TYPES) {
      const spec = EXERCISE_REGISTRY[type];
      if (spec.punitive) continue;
      expect(spec.heartCost, `${type} is non-punitive but costs a heart`).toBe(0);
      expect(spec.scorable, `${type} is non-punitive but scorable`).toBe(false);
    }
  });
});
