/**
 * Authored alternates and the `Another correct solution:` note (INV-GRD-03, INV-GRD-27).
 *
 * > "A match against a non-preferred authored alternate is correct and emits
 * > `Another correct solution:` with the preferred rendering. Alternates are **authored
 * > in the pack**, never computed at runtime — a runtime alternate generator fails the
 * > test." (INV-GRD-03)
 *
 * > "The alternate-solution note fires **iff** the matched surface ranks below an
 * > already-introduced surface." (INV-GRD-27)
 *
 * There is no generator in this file and no generator in this package. `grade.ts` matches
 * the answer against `item.accepted` and nothing else, so the set of strings that can ever
 * be accepted is exactly the set the pack shipped. Two gates in `grade.test.ts` hold that
 * down, and each covers only one direction:
 *
 *  - `grade.test.ts:63` greps every source in this directory, comments included, for the
 *    generator names its own `forbidden` pattern lists, and fails if one appears. The names
 *    are deliberately not repeated here: the grep is over raw text, so a file that spells
 *    one in a comment fails it — which is the right strictness and is how this sentence was
 *    first written wrong;
 *  - `grade.test.ts:70` draws arbitrary text against each fixture pack and asserts that a
 *    tier-1 verdict names a member of `item.accepted`. That is a guard against
 *    OVER-acceptance only — random text essentially never equals an accepted surface, so
 *    the acceptance direction is carried by the hand-written cases (`heisst` in
 *    `grade.test.ts`, the tapped-tile cases in `wordbank.test.ts:118`), not by the property.
 *
 * The `iff` in INV-GRD-27 is the whole rule. EC-GRD-39: an A1 learner who types `ねこ`
 * must not be shown `猫`, because they have never seen it. The note therefore names the
 * highest-ranked surface that outranks the match AND is in the learner's introduced set;
 * when no such surface exists, there is no note.
 */
import { ANOTHER_CORRECT_SOLUTION } from './config.js';
import type { AcceptedForm, GradableItem, LearnerSurfaceState, Verdict } from './types.js';

/** The alternate-solution slot of a verdict, or `null` when the note must not fire. */
export function alternateSolutionFor(
  item: GradableItem,
  matched: AcceptedForm,
  learner: LearnerSurfaceState,
): Verdict['alternateSolution'] {
  let best: AcceptedForm | null = null;
  for (const candidate of item.accepted) {
    if (candidate.rank <= matched.rank) continue;
    if (!learner.introducedSurfaceIds.has(candidate.surfaceId)) continue;
    if (best === null || candidate.rank > best.rank) best = candidate;
  }
  if (best === null) return null;
  return { label: ANOTHER_CORRECT_SOLUTION, rendering: best.surface };
}

/**
 * The surface the banner calls "preferred" for this learner: the highest-ranked accepted
 * surface they have been introduced to, falling back to the matched one.
 *
 * EC-GRD-39 defines `preferred_surface` as "the most advanced surface **already
 * introduced to this learner**", which is a per-learner fact and so cannot be a pack
 * field. The pack ships the ranking; the learner state picks from it.
 */
export function preferredSurface(
  item: GradableItem,
  matched: AcceptedForm,
  learner: LearnerSurfaceState,
): AcceptedForm {
  let best = matched;
  for (const candidate of item.accepted) {
    if (!learner.introducedSurfaceIds.has(candidate.surfaceId)) continue;
    if (candidate.rank > best.rank) best = candidate;
  }
  return best;
}
