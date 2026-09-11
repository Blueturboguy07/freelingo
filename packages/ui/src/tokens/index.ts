/**
 * Design tokens — P0 seed.
 *
 * Source of truth: `deep/08-design-system-motion-sound.md` (measured) and `scope/10`
 * (the measured token table). Every value here carries its citation; P3 fills the table
 * out and gates it with Playwright token conformance at a 614×811 CSS px viewport.
 *
 * Nothing in the app may hard-code a colour, radius, size or duration.
 */

/** Brand palette (deep/08 §1). */
export const COLOR = {
  /** brand green, primary interactive fill */
  owl: '#58CC02',
  /** the 4 px lip under a primary button and the unit header */
  owlLip: '#58A700',
  duoShine: '#72D627',
  beetle: '#CE82FF',
  peacock: '#00CD9C',
} as const;

/** The 3D button atom: a 4 px lip that compresses on press (deep/08 §1, §4). */
export const BUTTON = {
  lipHeightPx: 4,
  radiusPx: 12,
} as const;

/**
 * `label-button` = 15px / 700 / 0.8px letter-spacing.
 * deep/08 §3 reconciliation: the app runs a compressed instance of the token ladder, so
 * button labels get their own role rather than reusing `label-medium`.
 * The adversarial pass (R9) rejected the 14px/0.5px "compensation"; do not reintroduce it.
 */
export const TYPE = {
  labelButton: { fontSizePx: 15, fontWeight: 700, letterSpacingPx: 0.8 },
} as const;

/** Nunito (SIL OFL), variable weight, bundled — never a Google Fonts URL (offline-first). */
export const FONT_FAMILY = 'Nunito' as const;

/** The reference viewport every curated parity frame is diffed at (plan §Pixel parity). */
export const REFERENCE_VIEWPORT = { widthCssPx: 614, heightCssPx: 811, dpr: 2 } as const;
