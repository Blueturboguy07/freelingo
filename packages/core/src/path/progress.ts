/**
 * Section fractions, completion transitions, and the viewport.
 *
 * INV-PATH-20 / EC-PTH-38: the section fraction counts only units with **every** node
 * complete, and `unitCompleted` fires only on an incomplete->complete transition. Two
 * flags per unit: `unit_advanced` drives the path viewport, `unit_completed` drives the
 * fraction, the percentage, the predicate and the trophy. Otherwise a section reads 100%
 * with an unearned trophy.
 *
 * INV-PATH-21 / EC-PTH-39: completion predicates fire only on a transition, and the
 * post-ceremony viewport equals the launching viewport - `viewing_section` is distinct
 * from the frontier, and a ceremony launched from a past section returns *there*.
 *
 * INV-PATH-09 / EC-PTH-18: an absence of any length changes **no** path state.
 */
import type { PackManifest, PathModel, PathSection } from './types.js';
import { allUnits } from './types.js';
import { unitAdvanced, unitCompleted } from './unlock.js';
import { frontierSection } from './score.js';

export interface SectionProgress {
  readonly sectionIndex: number;
  readonly unitsCompleted: number;
  readonly unitsTotal: number;
  /** `{{done}}/{{total}} Stories`, or null when the pack declares no stories. */
  readonly storiesCompleted: number | null;
  readonly storiesTotal: number | null;
  readonly fraction: number;
}

export function sectionProgress(section: PathSection, manifest: PackManifest): SectionProgress {
  const unitsTotal = section.units.length;
  const unitsCompleted = section.units.filter(unitCompleted).length;
  // INV-PACK-03, "no empty states anywhere": the counter is omitted both when the PACK
  // declares no stories and when this SECTION happens to contain none. `0/0 Stories` is
  // exactly the empty state the invariant forbids, and a pack that ships stories in
  // Section 2 but not Section 1 hits it without declaring anything unusual.
  const declaresStories = manifest.declaredNodeTypes.includes('story');
  const storyNodes = section.units.flatMap((u) => u.nodes.filter((n) => n.type === 'story'));
  const showStories = declaresStories && storyNodes.length > 0;
  return {
    sectionIndex: section.index,
    unitsCompleted,
    unitsTotal,
    storiesCompleted: showStories
      ? storyNodes.filter((n) => n.subLessonsDone >= n.subLessonsTotal).length
      : null,
    storiesTotal: showStories ? storyNodes.length : null,
    fraction: unitsTotal === 0 ? 0 : unitsCompleted / unitsTotal,
  };
}

export function sectionCompleted(section: PathSection): boolean {
  return section.units.length > 0 && section.units.every(unitCompleted);
}

/* ------------------------------------------------------------------ transitions */

export interface CompletionTransitions {
  /** Absolute unit indices that went incomplete -> complete. */
  readonly unitCompleted: readonly number[];
  /** Section indices that went incomplete -> complete. */
  readonly sectionCompleted: readonly number[];
  /** Units whose last node just completed, opening the next unit. */
  readonly unitAdvanced: readonly number[];
}

export const NO_TRANSITIONS: CompletionTransitions = {
  unitCompleted: [],
  sectionCompleted: [],
  unitAdvanced: [],
};

/**
 * What changed between two models. Re-entering an already-complete state produces
 * nothing: re-practising a node in a finished Section 1 must not fire a section-complete
 * screen (INV-PATH-21).
 */
export function transitionsBetween(before: PathModel, after: PathModel): CompletionTransitions {
  const beforeUnits = allUnits(before);
  const afterUnits = allUnits(after);
  const unitDone: number[] = [];
  const advanced: number[] = [];
  for (let u = 0; u < afterUnits.length; u += 1) {
    const b = beforeUnits[u];
    const a = afterUnits[u];
    if (a === undefined) continue;
    const wasComplete = b !== undefined && unitCompleted(b);
    if (!wasComplete && unitCompleted(a)) unitDone.push(u);
    const wasAdvanced = b !== undefined && unitAdvanced(b);
    if (!wasAdvanced && unitAdvanced(a)) advanced.push(u);
  }
  const sectionDone: number[] = [];
  for (let s = 0; s < after.sections.length; s += 1) {
    const b = before.sections[s];
    const a = after.sections[s];
    if (a === undefined) continue;
    const wasComplete = b !== undefined && sectionCompleted(b);
    if (!wasComplete && sectionCompleted(a)) sectionDone.push(s);
  }
  return { unitCompleted: unitDone, sectionCompleted: sectionDone, unitAdvanced: advanced };
}

/* -------------------------------------------------------------------- viewport */

export interface Viewport {
  /** The section whose canvas is rendered. */
  readonly viewingSection: number;
  /** The section the learner's frontier is in; drives `Go to current unit`. */
  readonly currentSection: number;
}

export function viewportOf(model: PathModel): Viewport {
  return { viewingSection: model.viewingSection, currentSection: frontierSection(model).index };
}

/**
 * Where the ceremony returns to. A ceremony launched from a past section returns there,
 * with the `Go to current unit` chip pinned - never a jump to the frontier
 * (INV-PATH-21). A section the learner just *completed* is the one exception: the model
 * switches sections **before** the return screen renders (EC-PTH-23), so the learner
 * lands already scrolled to the new section.
 */
export function viewportAfterCeremony(
  launching: Viewport,
  transitions: CompletionTransitions,
): Viewport {
  const completedTheViewedSection = transitions.sectionCompleted.includes(launching.viewingSection);
  if (!completedTheViewedSection) return launching;
  const next = launching.viewingSection + 1;
  return { viewingSection: next, currentSection: Math.max(launching.currentSection, next) };
}

/* --------------------------------------------------------------------- absence */

/**
 * INV-PATH-09: an absence of any length changes no path state. No forced review, no
 * relocking, same current node. The model has no time input at all, so this is the
 * identity - and returning the *same reference* lets the test assert it without deep
 * equality, which a mutant cannot fake.
 */
export function applyAbsence(model: PathModel, _days: number): PathModel {
  return model;
}
