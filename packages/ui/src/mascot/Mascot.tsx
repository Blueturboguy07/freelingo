import { createContext, forwardRef, useContext, useImperativeHandle, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { renderMascotSvg } from './composite.js';
import { MASCOT_OUTFITS, MASCOT_POSES, poseIndex } from './model.js';
import type { MascotNumberInput, MascotPose, MascotRenderer } from './model.js';
import { MascotCanvas } from './MascotCanvas.js';
import { useMascotReducedMotion } from './reducedMotion.js';

const MascotContext = createContext({ outfitId: null as string | null, animationsEnabled: true });
export function MascotProvider({
  outfitId,
  animationsEnabled = true,
  children,
}: {
  outfitId: string | null;
  animationsEnabled?: boolean;
  children: ReactNode;
}) {
  return (
    <MascotContext.Provider value={{ outfitId, animationsEnabled }}>
      {children}
    </MascotContext.Provider>
  );
}
/** Bounds for direct rig inputs, 2026-09-13 implementation policy. The bounce
 * displacement uses deep/08's six-pixel decorative motion amplitude. */
const MASCOT_MOTION = { bouncePx: 6 } as const;
function unit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function index(value: number, length: number): number {
  return Number.isInteger(value) && value >= 0 && value < length ? value : 0;
}
interface RigOverrides {
  pose: MascotPose;
  outfitId: string | null;
  values: Partial<Record<MascotNumberInput, number>>;
}
export interface MascotProps {
  readonly pose?: MascotPose;
  /** undefined inherits the shared equipped snapshot; null is an explicit neutral preview. */
  readonly outfitId?: string | null;
  readonly size?: number;
  readonly label?: string;
}
export const Mascot = forwardRef<MascotRenderer, MascotProps>(function Mascot(
  { pose = 'idle', outfitId, size = 240, label },
  ref,
) {
  const context = useContext(MascotContext);
  const systemReducedMotion = useMascotReducedMotion();
  const animationsEnabled = context.animationsEnabled && !systemReducedMotion;
  const equipped = outfitId === undefined ? context.outfitId : outfitId;
  const [rig, setRig] = useState<RigOverrides>({ pose, outfitId: equipped, values: {} });
  // React applies this conditional same-component state adjustment before committing.
  // Clear the previous identity permanently: A→B→A must not resurrect A's old rig.
  const changed = rig.pose !== pose || rig.outfitId !== equipped;
  if (changed) setRig({ pose, outfitId: equipped, values: {} });
  const values = changed ? {} : rig.values;
  useImperativeHandle(ref, () => {
    const setNumber = (input: MascotNumberInput, value: number) =>
      setRig((previous) => ({
        pose,
        outfitId: equipped,
        values: {
          ...(previous.pose === pose && previous.outfitId === equipped ? previous.values : {}),
          [input]: value,
        },
      }));
    return {
      setNumber,
      fire: (trigger) =>
        setNumber(
          'pose',
          poseIndex(trigger === 'celebrate' ? 'cheer' : trigger === 'droop' ? 'sad' : 'idle'),
        ),
    };
  }, [pose, equipped]);
  const actualPose =
    values.pose === undefined ? pose : MASCOT_POSES[index(values.pose, MASCOT_POSES.length)]!;
  const actualOutfit =
    values.outfit === undefined
      ? equipped
      : MASCOT_OUTFITS[index(values.outfit, MASCOT_OUTFITS.length)]!;
  const blink = animationsEnabled ? unit(values.blink ?? 0) : 0;
  const xml = renderMascotSvg({ pose: actualPose, outfitId: actualOutfit, blink });
  return (
    <View
      accessible={label !== undefined}
      accessibilityRole={label === undefined ? undefined : 'image'}
      accessibilityLabel={label}
      {...(Platform.OS === 'web' && label === undefined ? { 'aria-hidden': true } : {})}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        transform: [
          {
            translateY: animationsEnabled ? -unit(values.bounce ?? 0) * MASCOT_MOTION.bouncePx : 0,
          },
        ],
      }}
    >
      <View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: size, height: size }}
      >
        <MascotCanvas xml={xml} size={size} animationsEnabled={animationsEnabled} />
      </View>
    </View>
  );
});
