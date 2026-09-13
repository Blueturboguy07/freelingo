import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { BodyText, CARD, FONT, LAYOUT, SPACE, TYPE, useUiTheme } from '@freelingo/ui';

/** S118–128 implementation dimensions, 2026-09-13. Shared measured atoms supply
 * type/spacing; these local layout choices remain subject to reference/native QA. */
export const TAB_LAYOUT = {
  iconPx: 64,
  smallIconPx: 28,
  hitSizePx: 48,
  calendarColumns: 7,
} as const;
export function SectionTabs<T extends string>({
  value,
  choices,
  onChange,
}: {
  value: T;
  choices: readonly { id: T; label: string }[];
  onChange(value: T): void;
}) {
  const { colors } = useUiTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: 1 }}
      style={{ flexGrow: 0, flexShrink: 0 }}
    >
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: 'row',
          minWidth: '100%',
          borderBottomWidth: CARD.borderPx,
          borderBottomColor: colors.swan,
        }}
      >
        {choices.map((choice) => (
          <Pressable
            key={choice.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: choice.id === value }}
            {...(Platform.OS === 'web' ? { 'aria-selected': choice.id === value } : {})}
            onPress={() => onChange(choice.id)}
            style={{
              minHeight: TAB_LAYOUT.hitSizePx,
              flexGrow: 1,
              justifyContent: 'center',
              paddingHorizontal: SPACE.md,
              borderBottomWidth: CARD.borderPx,
              borderBottomColor: choice.id === value ? colors.macaw : 'transparent',
            }}
          >
            <BodyText
              style={{
                fontFamily: FONT.strong,
                textAlign: 'center',
                color: choice.id === value ? colors.macaw : colors.wolf,
              }}
            >
              {choice.label}
            </BodyText>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
export function Progress({
  value,
  target,
  label,
  color,
}: {
  value: number;
  target: number;
  label: string;
  color?: string;
}) {
  const { colors } = useUiTheme();
  const safeValue = Math.max(0, Math.min(value, target));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: target, now: safeValue }}
      {...(Platform.OS === 'web'
        ? { 'aria-valuemin': 0, 'aria-valuemax': target, 'aria-valuenow': safeValue }
        : {})}
      style={{
        height: LAYOUT.progressHeightPx,
        borderRadius: LAYOUT.progressRadiusPx,
        backgroundColor: colors.swan,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          height: '100%',
          width: `${target > 0 ? (safeValue / target) * 100 : 0}%`,
          backgroundColor: color ?? colors.bee,
          borderRadius: LAYOUT.progressRadiusPx,
        }}
      />
    </View>
  );
}
export function InlineStat({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={{ flex: 1, minWidth: 120, gap: SPACE.xxs }}>
      <BodyText style={{ fontFamily: FONT.heading, fontSize: TYPE.heading.fontSizePx }}>
        {value}
      </BodyText>
      <BodyText>{label}</BodyText>
    </View>
  );
}
export function Row({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md, flexWrap: 'wrap' }}>
      {children}
    </View>
  );
}
export function SmallText({ children }: { children: ReactNode }) {
  const { colors } = useUiTheme();
  return (
    <BodyText
      style={{
        color: colors.wolf,
        fontSize: TYPE.small.fontSizePx,
        lineHeight: TYPE.small.lineHeightPx,
      }}
    >
      {children}
    </BodyText>
  );
}
export type TabGlyphName = 'quest' | 'badge' | 'freeze' | 'boost' | 'outfit' | 'perch' | 'check';
/** Local vector pictograms; never a platform-dependent emoji. */
export function TabGlyph({
  name,
  size = TAB_LAYOUT.iconPx,
}: {
  name: TabGlyphName;
  size?: number;
}) {
  const { colors } = useUiTheme();
  const fill = name === 'freeze' ? colors.macaw : name === 'outfit' ? colors.owl : colors.bee;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      {...(Platform.OS === 'web' ? { 'aria-hidden': true } : { accessible: false })}
    >
      {name === 'quest' ? (
        <>
          <Rect x="10" y="23" width="44" height="31" rx="6" fill={fill} />
          <Path d="M10 29V20Q10 10 20 10H44Q54 10 54 20V29Z" fill={colors.macaw} />
          <Rect x="27" y="27" width="10" height="15" rx="3" fill={colors.snow} />
        </>
      ) : name === 'badge' ? (
        <>
          <Path d="M17 38L13 61 32 53 51 61 47 38" fill={colors.macaw} />
          <Circle cx="32" cy="26" r="23" fill={fill} />
          <Path
            d="M32 10L37 20 48 22 40 30 42 41 32 36 22 41 24 30 16 22 27 20Z"
            fill={colors.snow}
          />
        </>
      ) : name === 'freeze' ? (
        <Path
          d="M32 5V59M9 18L55 46M9 46L55 18M24 10L32 18 40 10M24 54L32 46 40 54M9 27L19 24 17 14M47 50L45 40 55 37M9 37L19 40 17 50M47 14L45 24 55 27"
          stroke={fill}
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : name === 'boost' ? (
        <Path d="M34 3L10 36H28L24 61 55 24H36L42 3Z" fill={fill} />
      ) : name === 'outfit' ? (
        <Path d="M21 9L9 15 2 30 15 35 18 56H46L49 35 62 30 55 15 43 9Q32 24 21 9Z" fill={fill} />
      ) : name === 'perch' ? (
        <>
          <Rect x="4" y="20" width="56" height="10" rx="5" fill={fill} />
          <Path d="M20 30V52M44 30V52" stroke={fill} strokeWidth="7" strokeLinecap="round" />
        </>
      ) : (
        <Path
          d="M12 33L26 47 53 17"
          stroke={colors.owl}
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </Svg>
  );
}
export function resetLabel(seconds: number): string {
  if (seconds <= 0) return 'Refreshing…';
  const hours = Math.ceil(seconds / 3600);
  if (seconds >= 3600) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
export function boostClock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
