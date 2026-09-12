/**
 * INV-SEC-01 — the storage-time sanitiser for **every** user-text field.
 *
 * The corrected invariant (plan §Corrections, EC-GRD-24, EC-SEC-06) widened EC-SEC-01's
 * original claim that the report note is "the only place user text enters a shared
 * surface". It is not. Four more fields carry text a learner typed:
 *
 * | field              | where it is stored                        |
 * |--------------------|-------------------------------------------|
 * | `typed-answer`     | the attempt row, and the S038 answer strip |
 * | `tier3-diff`       | the wrong-answer diff kept with the attempt|
 * | `report-note`      | `item_report`, exportable to a GitHub issue|
 * | `read-and-respond` | the attempt row, and the model prompt      |
 * | `roleplay`         | the turn log, and the model prompt         |
 *
 * **At storage time, not at render.** Sanitising on the way out means the raw bytes are
 * still in the DB, still in the export archive, and still in the string handed to a model
 * or pasted into an issue — and every *new* render site has to remember to do it. One
 * write path is auditable; N read paths are not.
 *
 * What the treatment is, in order, and why the order is the order:
 *
 * 1. **Whitespace controls become spaces** (`\t \n \r \f \v`). They are `Cc` and would be
 *    stripped by step 2, which would silently glue two words together: `"uno\ndos"` must
 *    not be stored as `"unodos"`.
 * 2. **Strip `Cc`, `Cf` and lone surrogates.** `Cf` is the whole bidi-override family
 *    (U+202A–U+202E, U+2066–U+2069, U+200E/F, U+061C), the zero-width family
 *    (U+200B–U+200D, U+FEFF) and the rest of the format block. Category, not a
 *    hand-written list: a list goes stale the next time Unicode adds a format character.
 * 3. **NFC**, *after* stripping. A zero-width joiner sitting between a base letter and a
 *    combining mark blocks composition; normalising first would preserve the decomposed
 *    form and `sanitise("e" + ZWNJ + U+0301)` would not equal `sanitise("e" + U+0301)`.
 *    Stripping first makes the zero-width insertion invisible to grading, which is
 *    exactly what the invariant asks for.
 * 4. **Collapse whitespace runs and trim.** Uniform across all five fields, including the
 *    multi-line-looking ones: a report note is a few hundred characters and the layout of
 *    its whitespace is not worth a second code path that can disagree with the first.
 * 5. **Cap by code point**, never by UTF-16 unit — a cap that can split a surrogate pair
 *    stores half an emoji and re-introduces a lone surrogate one step after step 2
 *    removed them (EC-SEC-06: 40,000 pasted characters).
 *
 * Named config only: no cap and no character class is written anywhere else.
 */

export const USER_TEXT_FIELDS = [
  'typed-answer',
  'tier3-diff',
  'report-note',
  'read-and-respond',
  'roleplay',
] as const;

export type UserTextField = (typeof USER_TEXT_FIELDS)[number];

/**
 * Hard caps, in code points (EC-SEC-06). Typed answers are bounded by the exercise; the
 * free-text fields are bounded by "a few hundred characters" and by what a model call can
 * be asked to read without a token count nobody budgeted for.
 */
export const USER_TEXT_MAX_CODE_POINTS: Readonly<Record<UserTextField, number>> = {
  'typed-answer': 300,
  'tier3-diff': 300,
  'report-note': 500,
  'read-and-respond': 500,
  roleplay: 500,
} as const;

/**
 * The bidi controls by name. The strip is by Unicode *category* (`Cf` covers all of
 * these); this list exists so a test can assert the named characters are gone without
 * re-deriving the category, and so the invariant's phrase "bidi-control" has a referent
 * in the code.
 */
export const BIDI_CONTROLS: readonly string[] = [
  '\u061C', // ARABIC LETTER MARK
  '\u200E', // LEFT-TO-RIGHT MARK
  '\u200F', // RIGHT-TO-LEFT MARK
  '\u202A', // LEFT-TO-RIGHT EMBEDDING
  '\u202B', // RIGHT-TO-LEFT EMBEDDING
  '\u202C', // POP DIRECTIONAL FORMATTING
  '\u202D', // LEFT-TO-RIGHT OVERRIDE
  '\u202E', // RIGHT-TO-LEFT OVERRIDE
  '\u2066', // LEFT-TO-RIGHT ISOLATE
  '\u2067', // RIGHT-TO-LEFT ISOLATE
  '\u2068', // FIRST STRONG ISOLATE
  '\u2069', // POP DIRECTIONAL ISOLATE
] as const;

/** Zero-width characters a hostile or careless paste carries. All are `Cf`. */
export const ZERO_WIDTH_CHARACTERS: readonly string[] = [
  '\u200B', // ZERO WIDTH SPACE
  '\u200C', // ZERO WIDTH NON-JOINER
  '\u200D', // ZERO WIDTH JOINER
  '\uFEFF', // ZERO WIDTH NO-BREAK SPACE (BOM)
] as const;

/** Step 1: real whitespace, kept as a space rather than deleted with the other controls. */
const WHITESPACE_CONTROL = /[\t\n\r\f\v]+/gu;
/** Step 2: every remaining control, every format character, every lone surrogate. */
const FORBIDDEN_CLASS = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
/** Step 4. `\s` under `u` covers the Unicode space separators. */
const WHITESPACE_RUN = /\s+/gu;

/** True for any character step 2 removes. The property asserts this of stored values. */
export function containsForbiddenCharacter(text: string): boolean {
  FORBIDDEN_CLASS.lastIndex = 0;
  return FORBIDDEN_CLASS.test(text);
}

export function userTextCap(field: UserTextField): number {
  return USER_TEXT_MAX_CODE_POINTS[field];
}

/**
 * The one function every write path calls. Total: defined for every string, never throws,
 * and its output is always safe to store, export, render and put in a prompt.
 */
export function sanitiseUserText(field: UserTextField, raw: string): string {
  const spaced = raw.replace(WHITESPACE_CONTROL, ' ');
  const stripped = spaced.replace(FORBIDDEN_CLASS, '');
  const normalised = stripped.normalize('NFC');
  const collapsed = normalised.replace(WHITESPACE_RUN, ' ').trim();
  const points = [...collapsed];
  const cap = userTextCap(field);
  if (points.length <= cap) return collapsed;
  return points.slice(0, cap).join('').trimEnd();
}

/**
 * What a write path records: the stored value plus whether anything was removed, so a
 * surface can say `adjusted` rather than pretending the learner typed what is stored.
 */
export interface SanitisedUserText {
  readonly field: UserTextField;
  readonly stored: string;
  readonly truncated: boolean;
  readonly removedCharacters: number;
}

export function sanitiseUserTextRecord(field: UserTextField, raw: string): SanitisedUserText {
  const stored = sanitiseUserText(field, raw);
  const rawPoints = [...raw].length;
  const storedPoints = [...stored].length;
  return {
    field,
    stored,
    truncated: rawPoints > userTextCap(field),
    removedCharacters: Math.max(0, rawPoints - storedPoints),
  };
}
