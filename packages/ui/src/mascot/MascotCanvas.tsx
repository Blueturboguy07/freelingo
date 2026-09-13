import { SvgXml } from 'react-native-svg';
/** The browser draws the exact same composed SVG; native uses Skia/Reanimated.
 * No remote CanvasKit/WASM fetch is required for an offline web render. */
export function MascotCanvas({
  xml,
  size,
}: {
  xml: string;
  size: number;
  animationsEnabled: boolean;
}) {
  return <SvgXml xml={xml} width={size} height={size} aria-hidden />;
}
