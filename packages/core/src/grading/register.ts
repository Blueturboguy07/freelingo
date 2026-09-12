/**
 * Register — the fifth verdict class, and the advisory (INV-GRD-20, INV-GRD-21).
 *
 * > "An answer matching an accepted answer's lexemes but not the unit's declared register
 * > emits verdict class `register` with its own headline, never the wrong-word headline."
 * > (INV-GRD-20)
 *
 * > "For a pack declaring `register_slot`, a reply failing the register detector still
 * > grades correct and emits exactly one advisory note across all three grading paths,
 * > with zero mistake rows and no heart loss." (INV-GRD-21)
 *
 * Two different rules that share one detector, and the difference is the point. In a unit
 * that TEACHES the polite form, register is the lesson: `すしを食べる` for `すしを食べます`
 * costs a heart (EC-GRD-31) — but never under `You used the wrong word.`, because the
 * lexeme was right. In an open response, register is never the lesson: the family "is
 * non-binary and never punishes" (EC-GRD-32), so the reply passes and collects one note.
 *
 * The detector is a pack-shipped suffix table. Nothing here parses Japanese.
 */
import type { GradingPack, GradingUnit, RegisterDetector } from './types.js';

/** Which register a string's ending signals, or `null` when none matches. */
export function registerOf(text: string, detector: RegisterDetector): string | null {
  let best: { register: string; width: number } | null = null;
  for (const [register, suffixes] of Object.entries(detector.suffixesByRegister)) {
    for (const suffix of suffixes) {
      if (!text.endsWith(suffix)) continue;
      const width = [...suffix].length;
      if (best === null || width > best.width) best = { register, width };
    }
  }
  return best === null ? null : best.register;
}

/** The string with its register suffix removed, so two registers of one verb compare equal. */
export function registerStem(text: string, detector: RegisterDetector): string {
  let best = '';
  for (const suffixes of Object.values(detector.suffixesByRegister)) {
    for (const suffix of suffixes) {
      if (text.endsWith(suffix) && suffix.length > best.length) best = suffix;
    }
  }
  return best.length === 0 ? text : text.slice(0, text.length - best.length);
}

/**
 * Is this answer the right lexemes in the wrong register for this unit?
 *
 * Requires: the unit declares a register, the pack ships a detector, the stems agree, and
 * the answer's register is neither the declared one nor unknown. An answer whose register
 * cannot be read at all is NOT a register mismatch — it falls through to tier 3, because
 * guessing would put a heart on a detector's shrug.
 */
export function isRegisterMismatch(
  answer: string,
  target: string,
  pack: GradingPack,
  unit: GradingUnit,
): boolean {
  const detector = pack.registerSlot;
  if (detector === null || unit.register === null) return false;
  if (registerStem(answer, detector) !== registerStem(target, detector)) return false;
  const answerRegister = registerOf(answer, detector);
  return answerRegister !== null && answerRegister !== unit.register;
}

/**
 * The open-response advisory: exactly one note, or none (INV-GRD-21).
 *
 * "exactly one advisory note across all three grading paths" — so this is computed once,
 * from the pack, and appended by every path rather than by each path's own copy of the
 * rule. Returning an array of length at most one makes "exactly one" a type-level fact
 * rather than a convention.
 */
export function registerAdvisories(
  reply: string,
  pack: GradingPack,
  unit: GradingUnit,
): readonly string[] {
  const detector = pack.registerSlot;
  if (detector === null || unit.register === null) return [];
  const replyRegister = registerOf(reply, detector);
  if (replyRegister === null || replyRegister === unit.register) return [];
  return [detector.advisoryNote];
}
