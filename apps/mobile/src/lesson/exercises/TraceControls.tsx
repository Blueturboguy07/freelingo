import { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import Svg, { Polyline, Text as SvgText } from 'react-native-svg';
import { tracePoints, traceRuntime } from '@freelingo/core/grading';
import type { TracePoint } from '@freelingo/core/grading';
import type { SessionEvent } from '@freelingo/core/session';
import { BodyText, CARD, useUiTheme } from '@freelingo/ui';
import type { ExerciseControlsProps } from './controls.js';
/** Implementation canvas size,2026-09-13; no captured trace frame claims a measured dimension. */
export const TRACE_CANVAS = { maximumWidth: 320, pathWidth: 3, ordinalSize: 7 };
export function TraceControls({
  challenge,
  input,
  disabled,
  onInput,
  onEvent,
}: ExerciseControlsProps & { readonly onEvent: (event: SessionEvent) => void }) {
  const { colors } = useUiTheme();
  const [width, setWidth] = useState(TRACE_CANVAS.maximumWidth);
  const definition = challenge.trace;
  const record = definition === undefined ? null : traceRuntime(definition, input.partialState);
  const restored = input.partialState['traceDraft'];
  const draft = useRef<readonly TracePoint[]>(tracePoints(restored, 1) ? restored : []);
  const dragging = useRef(false);
  const latest = useRef(input);
  latest.current = input;
  if (definition === undefined || record === null)
    return (
      <BodyText>Tracing data is unavailable. Return to the path to reload this lesson.</BodyText>
    );
  const height = (width * definition.viewBox.height) / definition.viewBox.width;
  const map = (x: number, y: number): TracePoint => ({
    x: (x / width) * definition.viewBox.width,
    y: (y / height) * definition.viewBox.height,
  });
  const save = (points: readonly TracePoint[]) => {
    draft.current = points;
    onInput('', 0, { ...latest.current.partialState, traceDraft: points }, false);
  };
  const begin = (point: TracePoint) => {
    if (disabled) return;
    dragging.current = true;
    save([...draft.current, point]);
  };
  const move = (point: TracePoint) => {
    if (dragging.current && !disabled) save([...draft.current, point]);
  };
  const finish = (point: TracePoint) => {
    if (!dragging.current || disabled) return;
    dragging.current = false;
    onEvent({
      type: 'traceStroke',
      attemptId: `${challenge.itemId}:stroke:${record.attempts.length}`,
      points: [...draft.current, point],
    });
    draft.current = [];
  };
  const nativePoint = (event: GestureResponderEvent) =>
    map(event.nativeEvent.locationX, event.nativeEvent.locationY);
  const webPoint = (event: {
    readonly clientX: number;
    readonly clientY: number;
    readonly currentTarget: { getBoundingClientRect: () => { left: number; top: number } };
  }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return map(event.clientX - rect.left, event.clientY - rect.top);
  };
  const handlers =
    Platform.OS === 'web'
      ? {
          onMouseDown: (event: Parameters<typeof webPoint>[0]) => begin(webPoint(event)),
          onMouseMove: (event: Parameters<typeof webPoint>[0]) => move(webPoint(event)),
          onMouseUp: (event: Parameters<typeof webPoint>[0]) => finish(webPoint(event)),
          onMouseLeave: () => {
            dragging.current = false;
          },
        }
      : {
          onStartShouldSetResponder: () => !disabled,
          onMoveShouldSetResponder: () => !disabled,
          onResponderGrant: (event: GestureResponderEvent) => begin(nativePoint(event)),
          onResponderMove: (event: GestureResponderEvent) => move(nativePoint(event)),
          onResponderRelease: (event: GestureResponderEvent) => finish(nativePoint(event)),
          onResponderTerminationRequest: () => false,
        };
  const renderedDraft = tracePoints(input.partialState['traceDraft'], 1)
    ? input.partialState['traceDraft']
    : [];
  return (
    <View style={{ alignItems: 'center', gap: 12 }}>
      <BodyText>
        {record.complete
          ? 'Character complete'
          : `Stroke ${record.accepted + 1} of ${definition.strokes.length}`}
      </BodyText>
      <View
        testID="trace-canvas"
        accessibilityLabel={`Trace stroke ${record.accepted + 1} of ${definition.strokes.length}`}
        style={{
          width: '100%',
          maxWidth: TRACE_CANVAS.maximumWidth,
          aspectRatio: definition.viewBox.width / definition.viewBox.height,
          borderWidth: CARD.borderPx,
          borderColor: colors.swan,
          borderRadius: CARD.radiusPx,
        }}
        onLayout={(event) => {
          if (event.nativeEvent.layout.width > 0) setWidth(event.nativeEvent.layout.width);
        }}
        {...handlers}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${definition.viewBox.width} ${definition.viewBox.height}`}
          pointerEvents="none"
        >
          {definition.strokes.map((stroke, index) => (
            <Polyline
              key={`stroke${index}`}
              points={stroke.points.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke={index < record.accepted ? colors.owl : colors.hare}
              strokeWidth={TRACE_CANVAS.pathWidth}
              strokeLinecap="round"
            />
          ))}
          {definition.strokes.map((stroke, index) => (
            <SvgText
              key={`ordinal${index}`}
              testID={`stroke-ordinal-${index}`}
              x={stroke.points[0]!.x}
              y={stroke.points[0]!.y}
              fill={colors.eel}
              fontSize={TRACE_CANVAS.ordinalSize}
            >
              {index + 1}
            </SvgText>
          ))}
          <Polyline
            points={renderedDraft.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none"
            stroke={colors.macaw}
            strokeWidth={TRACE_CANVAS.pathWidth}
          />
        </Svg>
      </View>
      {record.rejections > 0 && !record.complete ? (
        <BodyText>
          Follow the numbered stroke in the shown direction. Try this stroke again.
        </BodyText>
      ) : null}
    </View>
  );
}
