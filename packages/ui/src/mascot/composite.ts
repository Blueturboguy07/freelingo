import { MASCOT_OUTFITS, outfitIndex } from './model.js';
import type { MascotOutfit, MascotPose } from './model.js';
import { MASCOT_SOURCES } from './sources.js';

/** Original accessory art, 2026-09-13. 240-unit grid, solid two-tone fills, no gradients.
 * The face rectangle x70..170/y72..180 is reserved in every pose; accessories sit
 * above the eyes, below the beak or behind the body. Pixel tests enforce that boundary.
 */
const OUTFIT_LAYERS: Readonly<
  Record<Exclude<MascotOutfit, 'neutral'>, { behind: string; front: string }>
> = {
  'cosmetic-explorer-outfit': {
    behind: '',
    front:
      '<g id="mascot-outfit"><path d="M80 52L88 24H152L160 52Z" fill="#FFAB33"/><rect x="56" y="50" width="128" height="14" rx="7" fill="#E08A00"/><path d="M88 184H112V200H88ZM128 184H152V200H128Z" fill="#FFAB33"/></g>',
  },
  'cosmetic-snowfall-suit': {
    behind: '',
    front:
      '<g id="mascot-outfit"><path d="M78 52Q80 20 120 20Q160 20 162 52Z" fill="#49C0F8"/><rect x="72" y="50" width="96" height="14" rx="7" fill="#FFFFFF"/><circle cx="120" cy="19" r="10" fill="#FFFFFF"/><rect x="87" y="184" width="66" height="12" rx="6" fill="#49C0F8"/><rect x="145" y="190" width="12" height="23" rx="6" fill="#FFFFFF"/></g>',
  },
  'cosmetic-carnival-suit': {
    behind: '',
    front:
      '<g id="mascot-outfit"><path d="M76 56L62 18 105 39 120 8 135 39 178 18 164 56Z" fill="#CE82FF"/><rect x="72" y="52" width="96" height="12" rx="6" fill="#FFC700"/><path d="M90 184L120 190 150 184 145 200H95Z" fill="#CE82FF"/><circle cx="120" cy="191" r="8" fill="#FFC700"/></g>',
  },
  'cosmetic-brass-perch': {
    behind:
      '<g id="mascot-outfit"><rect x="40" y="211" width="160" height="15" rx="7" fill="#FFC700"/><rect x="58" y="223" width="13" height="17" fill="#E08A00"/><rect x="169" y="223" width="13" height="17" fill="#E08A00"/></g>',
    front: '',
  },
  'cosmetic-bamboo-perch': {
    behind:
      '<g id="mascot-outfit"><rect x="40" y="211" width="160" height="15" rx="7" fill="#58A700"/><rect x="61" y="208" width="10" height="23" rx="5" fill="#72D627"/><rect x="169" y="208" width="10" height="23" rx="5" fill="#72D627"/></g>',
    front: '',
  },
};
export interface MascotFrame {
  readonly pose: MascotPose;
  readonly outfitId: string | null;
  readonly blink?: number;
}
/** Sole composition boundary shared by the native renderer and web/snapshot output.
 * A saved id only selects a known constant; it can never become arbitrary SVG markup.
 * Neutral is byte-for-byte the source, including for an unknown/missing variant.
 */
export function renderMascotSvg({ pose, outfitId, blink = 0 }: MascotFrame): string {
  const source = MASCOT_SOURCES[pose];
  const outfit = MASCOT_OUTFITS[outfitIndex(outfitId ?? 'neutral')]!;
  if (outfit === 'neutral' && blink < 0.5) return source;
  const layer = outfit === 'neutral' ? { behind: '', front: '' } : OUTFIT_LAYERS[outfit];
  const eyelids =
    blink >= 0.5
      ? `<g id="mascot-blink"><rect x="70" y="72" width="100" height="53" rx="20" fill="${pose === 'phoenix' ? '#FFAB33' : '#58CC02'}"/><path d="M78 103Q94 119 110 103M130 103Q146 119 162 103" fill="none" stroke="#3C3C3C" stroke-width="10"/></g>`
      : '';
  const opening = source.indexOf('>') + 1;
  return (
    source.slice(0, opening) +
    layer.behind +
    source.slice(opening).replace('</svg>', layer.front + eyelids + '</svg>')
  );
}
