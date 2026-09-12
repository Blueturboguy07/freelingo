/**
 * Grading types — the vocabulary the three-tier checker is written in.
 *
 * Everything here is data. No function in this file, and no rule; the rules live in
 * `normalise.ts`, `tier2.ts`, `typo.ts` and `grade.ts` and read these records.
 *
 * ## Why the pack carries so much
 *
 * Every behaviour the corpus found to differ by language is a FIELD on `GradingPack` or
 * `GradingUnit`, never a branch on a language code and never a module-level map. That is
 * INV-GRD-13's falsifier stated as a type: "a shared or hard-coded equivalence map" is a
 * failure, so there is nowhere in this package to put one. The grader takes the active
 * pack as an argument and reads it; two packs graded in the same process cannot influence
 * each other, because neither is reachable from the other.
 *
 * STUB NOTICE (filed in the task's blockers): `packages/core/src/types` and
 * `packages/core/src/economy` do not exist at this commit, so `HeartCost` and the attempt
 * row shape are declared locally. When the economy task lands, `HEART_COST_WRONG` should
 * come from the economy config table and this file should re-export rather than declare.
 */

/** A civil date in the learner's zone, `YYYY-MM-DD`. Mirrors `day/civil.ts`'s `LocalDay`. */
export type GradingLocalDay = string;

/**
 * The tier a verdict came from.
 *
 * `0` is not a tier: it is "no verdict was produced at all" (INV-GRD-14, an answer with
 * zero target-script characters). It is distinct from tier 3 because tier 3 writes an
 * attempt row and costs a heart, and tier 0 writes nothing.
 */
export type Tier = 0 | 1 | 2 | 3;

/**
 * Verdict classes the banner can render.
 *
 * `register` (EC-GRD-31, INV-GRD-20) is a fifth class and not a flavour of `wrong`: it
 * carries tier-3 cost but its own headline, because the lexeme WAS right.
 */
export type VerdictClass = 'correct' | 'soft-correct' | 'wrong' | 'register' | 'no-verdict';

/**
 * The six tier-2 classes, in classification order (INV-GRD-01).
 *
 * The invariant names five — whitespace-insertion → whitespace-omission →
 * capitalisation/terminal punctuation → non-contrastive diacritics → single-edit typo —
 * and the plan's EC-GRD-03 ruling adds a sixth, `dropped-token`, at the end of the ladder:
 * "soft-correct `You missed a word.` when exactly one function-class token is missing,
 * else hard wrong". Six classes, six entries in the note pool, "six notes, not four".
 *
 * The ja reading-vs-surface channel (INV-GRD-17) is deliberately NOT in this pool: its
 * note is authored on the item ("an authored note naming the right characters",
 * EC-GRD-28), so it is pack content, not a pooled string.
 */
export type Tier2Class =
  | 'whitespace-insertion'
  | 'whitespace-omission'
  | 'capitalisation'
  | 'diacritic'
  | 'typo'
  | 'dropped-token';

/** A tier-2 channel that is not one of the six pooled classes. */
export type Tier2Channel = Tier2Class | 'reading-surface';

/** Which family an item belongs to. Decides the accuracy denominator (INV-GRD-06). */
export type ItemFamily =
  | 'typed-translate'
  | 'word-bank'
  | 'gap-fill'
  | 'match'
  | 'select'
  | 'listening'
  | 'speaking'
  | 'character-trace'
  | 'character-select'
  | 'read-and-respond'
  | 'listen-and-respond';

/** How an attempt ended, for the accuracy denominator. */
export type AttemptOutcome =
  'graded' | 'skipped-speaking' | 'skipped-listening' | 'failed-speak' | 'trace-completed';

/**
 * The unit of the typo length guard.
 *
 * `characters` for Latin packs; `mora` for `ja`, because `がっこう` is four characters and
 * a five-character guard is structurally dead in a Japanese pack (EC-GRD-26).
 */
export type LengthUnit = 'characters' | 'mora';

/**
 * The three typo guards, resolved per pack (INV-GRD-02, INV-GRD-15).
 *
 * These are booleans and a number rather than code because the corpus does not know which
 * guard is Duolingo's — "the single highest-value untested question in the entire corpus"
 * (EC-GRD-05). They ship as config so one measured session can settle it by editing a
 * pack, not the engine.
 */
export interface TypoGuards {
  /** Guard 1: the mistyped form must not itself be a word of the target language. */
  readonly rejectRealTargetWord: boolean;
  /** Guard 2: the edit must not fall on the item's target (newly taught) lexeme. */
  readonly rejectEditOnTargetLexeme: boolean;
  /** Guard 3: the word must be at least this long, measured in `lengthUnit`. */
  readonly minimumLength: number;
  /** What guard 3 counts. */
  readonly lengthUnit: LengthUnit;
  /**
   * Whether a single edit must preserve the reading's mora count.
   *
   * EC-GRD-30: "A *missing* 長音符 is tier 3, because vowel length is contrastive." A
   * dropped `ー`, `っ` or small kana is one edit by string distance and a different word
   * by ear, so mora-unit packs require the count to survive the edit. Latin packs set
   * this false: dropping a letter from `escribe` is an ordinary typo.
   */
  readonly preserveMoraCount: boolean;
}

/** An authored accepted surface. Authored in the pack — never generated (INV-GRD-03). */
export interface AcceptedForm {
  /** The surface as written. */
  readonly surface: string;
  /**
   * The baked reading, for packs with `noWordDelimiter` (INV-GRD-26). Baked at pack
   * build time; nothing at runtime derives it, because that would be a tokenizer.
   */
  readonly reading?: string;
  /**
   * How advanced this surface is. Higher ranks above lower. `Another correct solution:`
   * names the highest-ranked surface the learner has already been introduced to
   * (INV-GRD-27).
   */
  readonly rank: number;
  /** The surface's id, used against the learner's introduced-surface set. */
  readonly surfaceId: string;
}

/** One gap of a multi-gap item (INV-GRD-05). */
export interface Gap {
  readonly gapId: string;
  readonly accepted: readonly AcceptedForm[];
}

/** One left/right pair of a match exercise. */
export interface MatchPair {
  readonly leftLexemeId: string;
  readonly rightLexemeId: string;
  readonly left: string;
  readonly right: string;
  /**
   * `meaning` for a cross-language pair; `reading` when both columns are the same
   * language in different orthographies (INV-GRD-25, `学校`/`がっこう`).
   */
  readonly facet: 'meaning' | 'reading';
}

/** A word-bank tile. The grader sees ids and text, never a rendered position. */
export interface Tile {
  readonly tileId: string;
  readonly text: string;
}

/** A precomputed ruby span over the target string (INV-GRD-28). Baked, never derived. */
export interface RubySpan {
  /** Inclusive start index into the target string. */
  readonly start: number;
  /** Exclusive end index into the target string. */
  readonly end: number;
}

/** A gradable item, as the pack ships it. */
export interface GradableItem {
  readonly itemId: string;
  readonly family: ItemFamily;
  /** The accepted set for single-answer families. Authored, ordered by nothing. */
  readonly accepted: readonly AcceptedForm[];
  /** Gaps for `gap-fill`; empty otherwise. */
  readonly gaps?: readonly Gap[];
  /** Pairs for `match`; empty otherwise. */
  readonly pairs?: readonly MatchPair[];
  /** Tiles for `word-bank` / `character-select`; empty otherwise. */
  readonly tiles?: readonly Tile[];
  /** For `character-select`: the ordered tile ids that are correct (INV-GRD-24). */
  readonly orderedTileIds?: readonly string[];
  /** The lexeme this item teaches. Typo guard 2 protects it. */
  readonly targetLexemeId?: string;
  /** The surface of the target lexeme, for guard 2's span test. */
  readonly targetLexemeSurface?: string;
  /** The prompt, for `read-and-respond` / `listen-and-respond` (INV-GRD-10). */
  readonly prompt?: string;
  /** Required lexeme ids for the open-response keyword gate (INV-GRD-22). */
  readonly requiredLexemeIds?: readonly string[];
  /** Authored note for the reading-vs-surface channel (INV-GRD-17, EC-GRD-28). */
  readonly readingSurfaceNote?: string;
  /**
   * Surfaces that share this item's baked reading but are NOT accepted (INV-GRD-26).
   *
   * Baked per item at pack build. `橋を渡る` is accepted, `箸を渡る` reads the same and is
   * tier 2 showing the intended orthography (EC-GRD-38). Enumerated rather than derived,
   * because deriving it at runtime is the tokenizer INV-GRD-28 forbids.
   */
  readonly sameReadingSurfaces?: readonly string[];
  /** Ruby spans over the first accepted surface (INV-GRD-28). */
  readonly rubySpans?: readonly RubySpan[];
  /** The scheduler row this item advances. `reading` never advances `meaning`. */
  readonly schedulerFacet?: 'meaning' | 'reading';
}

/**
 * The unit the item sits in. Two grading rules are unit-scoped, not pack-scoped.
 */
export interface GradingUnit {
  readonly unitId: string;
  /**
   * The register the unit is teaching, or `null`. When set, an answer that is right in
   * every way except register is class `register` (INV-GRD-20).
   */
  readonly register: string | null;
  /**
   * Characters that are interchangeable with each other AND with nothing, terminally
   * (INV-GRD-29). Read from the unit declaration, never a global regex: a quotation-
   * teaching unit declares an empty class and `「` becomes graded content.
   */
  readonly punctuationEquivalenceClass: readonly string[];
  /** Characters the unit grades as content even though another unit would fold them. */
  readonly gradedPunctuation: readonly string[];
  /**
   * Every inflected surface the unit has taught, keyed by lexeme id (INV-GRD-22). The
   * keyword gate matches against this set, never a substring: `行きました` satisfies a
   * `行く` requirement because the unit taught that surface.
   */
  readonly taughtInflections: Readonly<Record<string, readonly string[]>>;
  /** Minimum open-response length, in the pack's `openResponseLengthUnit`. */
  readonly openResponseMinimumLength: number;
}

/** Register detection for a pack that declares a register slot (INV-GRD-21). */
export interface RegisterDetector {
  /** Suffixes that mark each register, e.g. `{ polite: ['ます','です'] }`. */
  readonly suffixesByRegister: Readonly<Record<string, readonly string[]>>;
  /** The one advisory note appended to a green banner when the register is off. */
  readonly advisoryNote: string;
}

/**
 * Everything about grading that varies by pack.
 *
 * Read from the ACTIVE pack on every call. There is no default instance and no registry
 * keyed by language code, because a registry is the shared map INV-GRD-13 forbids.
 */
export interface GradingPack {
  readonly packId: string;
  /** Human label, for test failure messages only. */
  readonly label: string;

  // --- normalisation -------------------------------------------------------
  /**
   * Pairs applied before compare, longest source first (INV-GRD-13). German ships
   * `ß→ss`, `ä→ae`; Spanish ships none, because `ñ` is contrastive there.
   */
  readonly orthographicEquivalences: readonly (readonly [string, string])[];
  /** The script has no word spaces: strip all whitespace in tier 1 (INV-GRD-16). */
  readonly spaceless: boolean;
  /** The script has no word boundaries a diff can use (INV-GRD-28). */
  readonly noWordBoundaries: boolean;
  /** Listening is graded on baked readings, not orthography (INV-GRD-26). */
  readonly noWordDelimiter: boolean;
  /**
   * Surface → baked reading, for every orthography the pack teaches (INV-GRD-17,
   * INV-GRD-26).
   *
   * A LOOKUP TABLE baked at pack build, not a runtime analyser: this is how Freelingo
   * answers "what does this string read as?" without linking a Japanese tokenizer, which
   * `deep/10` §S9 forbids and INV-GRD-28 greps for. A surface the pack never taught has
   * no reading, and an answer whose reading is unknown simply falls through to tier 3.
   */
  readonly readingsBySurface: ReadonlyMap<string, string>;
  /** Run the ja tier-1 normalisation (INV-GRD-19). */
  readonly japaneseNormalisation: boolean;
  /**
   * Diacritics are contrastive across the whole pack (INV-GRD-18). When true the tier-2
   * `diacritic` class is empty and unreachable through any normalisation path.
   */
  readonly diacriticsContrastive: boolean;
  /**
   * Individual combining marks that stay contrastive when `diacriticsContrastive` is
   * false. Spanish puts the combining tilde here: `esta`/`está` is a soft correct and
   * `ano`/`año` is not (INV-GRD-13's falsifier).
   */
  readonly contrastiveDiacritics: readonly string[];

  // --- tier 2 --------------------------------------------------------------
  /** The three guards (INV-GRD-02, INV-GRD-15). */
  readonly typoGuards: TypoGuards;
  /** Words of the target language, for typo guard 1. A pack-shipped set. */
  readonly targetLanguageWords: ReadonlySet<string>;
  /** Function-class tokens whose omission is soft (EC-GRD-03 ruling). */
  readonly functionClassTokens: ReadonlySet<string>;

  // --- input ---------------------------------------------------------------
  /** Unicode ranges that count as target script, for INV-GRD-14. */
  readonly targetScriptRanges: readonly (readonly [number, number])[];
  /** The accepted set is script-only: a zero-script answer never arms CHECK. */
  readonly scriptOnlyAnswers: boolean;
  /** What word-bank tiles are joined with (INV-GRD-23). `''` for ja. */
  readonly wordBankJoinDelimiter: string;

  // --- open response -------------------------------------------------------
  /** Characters for ja, tokens for es/fr/de (INV-GRD-22). */
  readonly openResponseLengthUnit: 'characters' | 'tokens';
  /** The pack declares a register slot on open responses (INV-GRD-21). */
  readonly registerSlot: RegisterDetector | null;
}

/** What the learner has been shown, for the alternate-solution note (INV-GRD-27). */
export interface LearnerSurfaceState {
  readonly introducedSurfaceIds: ReadonlySet<string>;
}

/** A character range to bold in the red banner (INV-GRD-28). */
export interface HighlightRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The whole verdict. One record, every consequence explicit.
 *
 * `softCorrected` and `wrong` are TWO independent flags, not one boolean (INV-GRD-04):
 * a soft correct is `{ softCorrected: true, wrong: false }` and creates no mistake row,
 * so it never suppresses `Perfect lesson!`.
 */
export interface Verdict {
  readonly tier: Tier;
  readonly verdictClass: VerdictClass;
  /** Which tier-2 channel fired, or `null`. */
  readonly channel: Tier2Channel | null;
  /** The pooled or authored note, or `null` for a silent class. */
  readonly note: string | null;
  /** `Another correct solution:` plus its rendering, or `null` (INV-GRD-03/27). */
  readonly alternateSolution: { readonly label: string; readonly rendering: string } | null;
  /** Non-blocking advisories, e.g. the register slot's one note (INV-GRD-21). */
  readonly advisories: readonly string[];
  readonly softCorrected: boolean;
  readonly wrong: boolean;
  readonly heartCost: 0 | 1;
  readonly comboReset: boolean;
  /** Lexeme ids that become mistake rows. Empty for every non-wrong verdict. */
  readonly mistakeLexemeIds: readonly string[];
  /** Which accepted surface matched, if any. */
  readonly matchedSurfaceId: string | null;
  /** Character ranges to bold in a red banner. */
  readonly highlights: readonly HighlightRange[];
  /** Scheduler rows this answer advances, as `(itemId, facet)` (INV-GRD-25). */
  readonly schedulerTargets: readonly { readonly itemId: string; readonly facet: string }[];
  /** True when no attempt row is written at all (INV-GRD-14). */
  readonly writesAttemptRow: boolean;
  /** Why CHECK was never armed, when `tier === 0`. */
  readonly notArmedReason: string | null;
  /** The escape offered instead of a verdict, when `tier === 0`. */
  readonly escape: 'word-bank' | null;
}

/** The attempt row the session engine persists (INV-GRD-04). */
export interface AttemptRow {
  readonly itemId: string;
  readonly softCorrected: boolean;
  readonly wrong: boolean;
  readonly outcome: AttemptOutcome;
  readonly family: ItemFamily;
}
