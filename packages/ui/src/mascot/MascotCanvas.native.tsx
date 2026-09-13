import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, ImageSVG, Skia } from '@shopify/react-native-skia';
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { SkSVG } from '@shopify/react-native-skia';

/** P3 D12 code-pose crossfade. 200ms is an implementation choice from deep/08's
 * house motion tokens (2026-09-13), not a claimed live-app mascot measurement. */
export const MASCOT_CROSSFADE_MS = 200;
export function MascotCanvas({
  xml,
  size,
  animationsEnabled,
}: {
  xml: string;
  size: number;
  animationsEnabled: boolean;
}) {
  const image = useMemo(() => {
    const result = Skia.SVG.MakeFromString(xml);
    if (result === null) throw new Error('Could not render the bundled parrot artwork');
    return result;
  }, [xml]);
  const last = useRef(image);
  const [previous, setPrevious] = useState<SkSVG | null>(null);
  const progress = useSharedValue(1);
  useEffect(() => {
    if (last.current === image) return;
    cancelAnimation(progress);
    setPrevious(animationsEnabled ? last.current : null);
    last.current = image;
    progress.value = animationsEnabled ? 0 : 1;
    if (animationsEnabled)
      progress.value = withTiming(1, {
        duration: MASCOT_CROSSFADE_MS,
        reduceMotion: ReduceMotion.System,
      });
  }, [image, animationsEnabled, progress]);
  useEffect(() => {
    if (!animationsEnabled) {
      cancelAnimation(progress);
      progress.value = 1;
      setPrevious(null);
    }
    return () => cancelAnimation(progress);
  }, [animationsEnabled, progress]);
  const oldStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  const newStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  return (
    <>
      {previous && (
        <Animated.View style={[{ position: 'absolute', width: size, height: size }, oldStyle]}>
          <Canvas style={{ width: size, height: size }}>
            <ImageSVG svg={previous} x={0} y={0} width={size} height={size} />
          </Canvas>
        </Animated.View>
      )}
      <Animated.View style={newStyle}>
        <Canvas style={{ width: size, height: size }}>
          <ImageSVG svg={image} x={0} y={0} width={size} height={size} />
        </Canvas>
      </Animated.View>
    </>
  );
}
