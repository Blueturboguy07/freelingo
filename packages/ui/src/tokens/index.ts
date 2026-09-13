/** Measured web guest EN→ES arm, 2026-09-10: scope/10 and deep/08 corrections. */
export const COLOR = {
  owl: '#58CC02',
  owlLip: '#58A700',
  duoShine: '#72D627',
  beetle: '#CE82FF',
  peacock: '#00CD9C',
} as const;
export const THEME = {
  light: {
    snow: '#FFFFFF',
    polar: '#F7F7F7',
    swan: '#E5E5E5',
    hare: '#AFAFAF',
    wolf: '#777777',
    eel: '#4B4B4B',
    owl: '#58CC02',
    owlLip: '#58A700',
    macaw: '#1CB0F6',
    macawLip: '#0096DD',
    cardinal: '#FF4B4B',
    cardinalLip: '#EA2B2B',
    bee: '#FFC800',
    onPrimary: '#FFFFFF',
    highContrastDisabled: '#4B4B4B',
  },
  dark: {
    snow: '#131F24',
    polar: '#202F36',
    swan: '#37464F',
    hare: '#52656D',
    wolf: '#DCE6EC',
    eel: '#F1F7FB',
    owl: '#93D333',
    owlLip: '#79B933',
    macaw: '#49C0F8',
    macawLip: '#0096DD',
    cardinal: '#EE5555',
    cardinalLip: '#BA3838',
    bee: '#FFC700',
    onPrimary: '#131F24',
    highContrastDisabled: '#DCE6EC',
  },
} as const;
/** 582×50 at reference width. CTA radius is 16; the card/header radius is 12. */
export const BUTTON = { lipHeightPx: 4, radiusPx: 16, minHeightPx: 50 } as const;
export const CARD = { radiusPx: 12, borderPx: 2, lipHeightPx: 2 } as const;
export const TYPE = {
  labelButton: { fontSizePx: 15, fontWeight: 700, letterSpacingPx: 0.8 },
  body: { fontSizePx: 19, lineHeightPx: 27, fontWeight: 500 },
  heading: { fontSizePx: 25, lineHeightPx: 32, fontWeight: 800 },
  subheading: { fontSizePx: 20, lineHeightPx: 27, fontWeight: 700 },
  small: { fontSizePx: 15, lineHeightPx: 21, fontWeight: 700 },
} as const;
export const SPACE = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;
export const LAYOUT = {
  lessonHeaderHeightPx: 66,
  progressHeightPx: 16,
  progressRadiusPx: 8,
  pageInsetPx: 16,
  contentMaxWidthPx: 614,
  feedbackMaxHeightFraction: 0.6,
  nodeWidthPx: 69.7,
  nodeHeightPx: 64.5,
  nodePitchPx: 94,
  nodeOffsetsPx: [0, -45, -70, -45, 0, 45, 70, 45],
} as const;
/** Keys supplied by expo-font from local, bundled font modules. */
export const FONT_FAMILY = 'Nunito' as const;
export const FONT = {
  body: 'Nunito_500Medium',
  strong: 'Nunito_700Bold',
  heading: 'Nunito_800ExtraBold',
  japanese: 'NotoSansJP_500Medium',
} as const;
export const REFERENCE_VIEWPORT = { widthCssPx: 614, heightCssPx: 811, dpr: 2 } as const;
