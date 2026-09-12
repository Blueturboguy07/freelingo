/**
 * Everything the pack manifest decides: the section list, completion copy, the Score
 * ceiling, and the flavour entry points.
 *
 * INV-PACK-56 / EC-PACK-55: completion copy, the section list and the Score ceiling are
 * all functions of the manifest. The falsifier is "a three-section beta rendering eight
 * section cards, or completion copy contradicting a Score chip reading `29 / 160`".
 *
 * INV-PATH-17 / EC-PTH-35: every value of the launch-flavour enum is reachable from at
 * least one shipped entry point, and `sectionTest` resolves to the section-boundary
 * variant of the JUMP HERE node (S019) rather than a node type of its own.
 */
import type { LaunchFlavour, NodeType, PackManifest, PathModel } from './types.js';
import { LAUNCH_FLAVOURS } from './types.js';
import { specFor } from './registry.js';
import { bandOfScore, displayedScore } from './score.js';
import { sectionProgress } from './progress.js';
import { courseComplete } from './dailyRefresh.js';

/* --------------------------------------------------------------- section list */

export interface SectionCard {
  readonly index: number;
  readonly title: string;
  readonly cefrChip: string;
  /** `{{done}}/{{total}} Units` */
  readonly unitsLabel: string;
  /** `{{done}}/{{total}} Stories`, or null when the pack declares none. */
  readonly storiesLabel: string | null;
  readonly percent: number;
  /** Per-section Score: a pure clamp of the course Score into the band (INV-PATH-22). */
  readonly sectionScore: number;
  readonly action: 'JUMP HERE' | 'Go to current unit';
}

/**
 * The section list renders the sections the **pack** ships - never eight placeholders.
 * The CEFR chip reads `A1 - CEFR-checked` only where a CEFR lexicon backed the grading;
 * de and ja read `Beginner - frequency-ordered` (plan §Rulings, the licence split).
 */
export function sectionCards(model: PathModel): readonly SectionCard[] {
  const manifest = model.manifest;
  const score = displayedScore(model);
  return model.sections.map((section) => {
    const progress = sectionProgress(section, manifest);
    const unlockedByProgress = progress.fraction > 0;
    return {
      index: section.index,
      title: section.title,
      cefrChip: manifest.cefrChecked
        ? `${section.band} - CEFR-checked`
        : 'Beginner - frequency-ordered',
      unitsLabel: `${progress.unitsCompleted}/${progress.unitsTotal} Units`,
      storiesLabel:
        progress.storiesTotal === null
          ? null
          : `${progress.storiesCompleted ?? 0}/${progress.storiesTotal} Stories`,
      percent: Math.round(progress.fraction * 100),
      sectionScore: score,
      action: unlockedByProgress ? 'Go to current unit' : 'JUMP HERE',
    };
  });
}

/* ------------------------------------------------------------- completion copy */

export interface CompletionCopy {
  readonly headline: string;
  readonly body: string;
  /** The ceiling the copy claims. Must equal what the Score chip can reach. */
  readonly scoreCeiling: number;
  readonly bandReached: string;
  readonly sectionsShipped: number;
  readonly beta: boolean;
}

/**
 * EC-PACK-55: decouple pack-complete from Score-complete. A beta pack that ships three
 * A1 sections says so, names the band and the sections it actually shipped, and clamps the
 * Score to its declared ceiling, so the copy cannot contradict a chip reading `29 / 160`.
 */
export function completionCopy(model: PathModel): CompletionCopy | null {
  if (!courseComplete(model)) return null;
  const manifest = model.manifest;
  const ceiling = manifest.scoreCeiling;
  const beta = ceiling < 129;
  const band = bandOfScore(ceiling);
  return {
    headline: `Congrats on finishing the Freelingo ${manifest.languageName} course!`,
    body: beta
      ? `You finished all ${manifest.sectionTitles.length} sections shipped in this pack, up to ${band}.`
      : 'You unlocked Daily Refresh! Come back daily to practice fresh skills and stay sharp!',
    scoreCeiling: ceiling,
    bandReached: band,
    sectionsShipped: manifest.sectionTitles.length,
    beta,
  };
}

/* -------------------------------------------------------------- entry points */

export type EntryPoint =
  | { readonly kind: 'node'; readonly nodeType: NodeType }
  | { readonly kind: 'jump-here-node' }
  | { readonly kind: 'section-boundary-jump-here' }
  | { readonly kind: 'onboarding' }
  | { readonly kind: 'daily-refresh-section' }
  | { readonly kind: 'recovery-challenge' }
  | { readonly kind: 'endgame-ladder' };

/**
 * Every shipped entry point, and the flavours it can launch. This is the table
 * INV-PATH-17 enumerates against `LAUNCH_FLAVOURS`.
 */
export function shippedEntryPoints(manifest: PackManifest): readonly {
  readonly entry: EntryPoint;
  readonly flavours: readonly LaunchFlavour[];
}[] {
  const out: { entry: EntryPoint; flavours: readonly LaunchFlavour[] }[] = [];
  for (const type of manifest.declaredNodeTypes) {
    const spec = specFor(type);
    if (!spec.placeable) continue;
    out.push({ entry: { kind: 'node', nodeType: type }, flavours: spec.launchable });
  }
  // S019 in both variants: the mid-section jump, and the section-boundary variant that
  // IS the section test (EC-PTH-35) - one component, not a node type of its own.
  out.push({ entry: { kind: 'jump-here-node' }, flavours: ['jumpHere'] });
  out.push({ entry: { kind: 'section-boundary-jump-here' }, flavours: ['sectionTest'] });
  out.push({ entry: { kind: 'onboarding' }, flavours: ['placement'] });
  out.push({ entry: { kind: 'daily-refresh-section' }, flavours: ['dailyRefresh'] });
  out.push({ entry: { kind: 'recovery-challenge' }, flavours: ['recovery'] });
  out.push({ entry: { kind: 'endgame-ladder' }, flavours: ['endgame'] });
  return out;
}

/** Flavours with no shipped entry point. INV-PATH-17 asserts this is empty. */
export function unreachableFlavours(manifest: PackManifest): readonly LaunchFlavour[] {
  const reachable = new Set(shippedEntryPoints(manifest).flatMap((e) => e.flavours));
  return LAUNCH_FLAVOURS.filter((f) => !reachable.has(f));
}

/**
 * Surfaces that would render an empty state. INV-PACK-03 asserts this is empty for every
 * manifest: a pack that declares no stories degrades silently, it never shows `0/0
 * Stories` or an empty Stories row.
 */
export function emptyStates(model: PathModel): readonly string[] {
  const out: string[] = [];
  for (const card of sectionCards(model)) {
    if (card.storiesLabel !== null && card.storiesLabel.startsWith('0/0')) {
      out.push(`section ${card.index}: empty stories counter`);
    }
    if (card.unitsLabel.startsWith('0/0')) out.push(`section ${card.index}: empty units counter`);
  }
  return out;
}
