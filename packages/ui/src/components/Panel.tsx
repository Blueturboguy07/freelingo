import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { CARD, SPACE } from '../tokens/index.js';
import { useUiTheme } from './theme.js';
export function Panel({
  children,
  style,
  testID,
}: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}) {
  const { colors } = useUiTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: colors.polar,
          borderColor: colors.swan,
          borderWidth: CARD.borderPx,
          borderRadius: CARD.radiusPx,
          padding: SPACE.md,
          gap: SPACE.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
