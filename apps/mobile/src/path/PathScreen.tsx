import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import {
  allUnits,
  nodeUnlocked,
  nodeVisual,
  popupFor,
  jumpHereOverlays,
  specFor,
} from '@freelingo/core/path';
import type { LaunchFlavour, PathNode, PathUnit } from '@freelingo/core/path';
import {
  BodyText,
  Button3D,
  CARD,
  COLOR,
  Heading,
  LAYOUT,
  Panel,
  SPACE,
  THEME,
  UiProvider,
  useUiTheme,
} from '@freelingo/ui';
import type { PathLaunch, PathScreenProps } from './ports.js';
/** Captured geometry,2026-09-10 guest614px, deep08 §6. Header78px/lip4; popup max45%. */
const PATH_STYLE = {
  headerHeight: 78,
  headerLip: 4,
  popupFraction: 0.45,
  popupGap: 12,
  headerText: 'SECTION',
  ringStroke: 8,
  popupDefaultHeight: 220,
};
const UNIT_PALETTE = [COLOR.owl, COLOR.beetle, COLOR.peacock, THEME.light.macaw] as const;
const NODE_GLYPH: Readonly<Record<PathNode['type'], string>> = {
  lesson: '★',
  practice: '◆',
  letters: 'あ',
  speaking: '●',
  radio: '◉',
  roleplay: '✦',
  story: '▤',
  chest: '▣',
  unitReview: '♜',
  jumpHere: '↑',
};
export function sessionLaunch(flavour: LaunchFlavour): PathLaunch['flavour'] {
  return flavour === 'practice'
    ? 'nodePractice'
    : flavour === 'endgame'
      ? 'endgameReview'
      : flavour;
}
/** Flip before clipping. Inputs are measured anchor coordinates, not an index guessed from scroll. */
export function popupTop(
  anchor: { y: number; height: number },
  viewportHeight: number,
  popupHeight: number,
): number {
  const below = anchor.y + anchor.height + PATH_STYLE.popupGap;
  return below + popupHeight <= viewportHeight - SPACE.md
    ? below
    : Math.max(SPACE.md, anchor.y - PATH_STYLE.popupGap - popupHeight);
}
export function PathScreen(props: PathScreenProps) {
  return (
    <UiProvider
      theme={props.theme ?? 'dark'}
      highContrast={props.highContrast ?? false}
      boldText={props.boldText ?? false}
    >
      <PathContent {...props} />
    </UiProvider>
  );
}
function PathContent({
  model,
  status = 'ready',
  selectedNodeId,
  onSelectNode,
  onLaunch,
  onOpenGuidebook,
  onOpenSections,
  onRepairPack,
  advertisedXpByNode = {},
  unavailableNodeIds = [],
  summary,
}: PathScreenProps) {
  const { colors } = useUiTheme();
  const { height } = useWindowDimensions();
  const scroll = useRef<ScrollView>(null);
  const refs = useRef(new Map<string, View>());
  const [anchor, setAnchor] = useState<{ y: number; height: number }>({
    y: 120,
    height: LAYOUT.nodeHeightPx,
  });
  const [popupHeight, setPopupHeight] = useState(PATH_STYLE.popupDefaultHeight);
  const [visibleUnit, setVisibleUnit] = useState<number | null>(null);
  const unitY = useRef(new Map<number, number>());
  if (status === 'loading')
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.snow,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <ActivityIndicator color={colors.owl} />
        <Heading>Loading your path…</Heading>
      </View>
    );
  if (model === null || status === 'pack-missing')
    return (
      <View style={{ flex: 1, backgroundColor: colors.snow, padding: SPACE.md }}>
        <Heading>Your course needs attention</Heading>
        <BodyText>Verify the installed course or download it again to continue.</BodyText>
        <Button3D label="Verify or download course" onPress={onRepairPack} />
      </View>
    );
  const section = model.sections.find((s) => s.index === model.viewingSection) ?? model.sections[0];
  const units = section?.units ?? [];
  const everyUnit = allUnits(model);
  const currentUnit = units.find((u) => u.index === visibleUnit) ?? units[0];
  const selectedUnit = everyUnit.find((unit) =>
    unit.nodes.some((node) => node.id === selectedNodeId),
  );
  const node = selectedUnit?.nodes.find((candidate) => candidate.id === selectedNodeId);
  const nodeIndex =
    selectedUnit?.nodes.findIndex((candidate) => candidate.id === selectedNodeId) ?? -1;
  const popup =
    node === undefined || selectedUnit === undefined
      ? null
      : popupFor(node, nodeUnlocked(model, everyUnit.indexOf(selectedUnit), nodeIndex), {
          unitTitle: selectedUnit.title,
          legendaryAvailable: model.manifest.legendaryDenominator.includes(node.type),
          advertisedXp: advertisedXpByNode[node.id] ?? {},
        });
  const unavailable = node !== undefined && unavailableNodeIds.includes(node.id);
  const overlays = jumpHereOverlays(model);
  const open = (item: PathNode) => {
    refs.current
      .get(item.id)
      ?.measureInWindow((_x, y, _width, nodeHeight) =>
        setAnchor({ y, height: nodeHeight || LAYOUT.nodeHeightPx }),
      );
    onSelectNode(item.id);
  };
  const header = (unit: PathUnit) => {
    const fill = UNIT_PALETTE[unit.colourIndex % UNIT_PALETTE.length] ?? COLOR.owl;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Unit ${unit.index + 1}, ${unit.title}. Opens Guidebook for this unit`}
        onPress={() => onOpenGuidebook(unit.index)}
        style={{
          backgroundColor: fill,
          minHeight: PATH_STYLE.headerHeight,
          borderRadius: CARD.radiusPx,
          borderBottomWidth: PATH_STYLE.headerLip,
          borderBottomColor:
            unit.colourIndex % UNIT_PALETTE.length === 0 ? COLOR.owlLip : colors.hare,
          padding: SPACE.md,
          justifyContent: 'center',
        }}
      >
        <BodyText
          style={{ color: THEME.dark.snow, fontSize: 15 }}
        >{`SECTION ${(section?.index ?? 0) + 1}, UNIT ${unit.index + 1}`}</BodyText>
        <Heading style={{ color: THEME.dark.snow, fontSize: 20 }}>{unit.title}</Heading>
      </Pressable>
    );
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.snow }} testID="path-screen">
      <View
        style={{ width: '100%', maxWidth: LAYOUT.contentMaxWidthPx, alignSelf: 'center', flex: 1 }}
      >
        <View
          style={{ flexDirection: 'row', padding: SPACE.md, gap: SPACE.lg, alignItems: 'center' }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sections"
            onPress={onOpenSections}
          >
            <BodyText>{model.manifest.languageName}</BodyText>
          </Pressable>
          {summary?.score !== undefined ? <BodyText>{summary.score}</BodyText> : null}
          <BodyText>{summary?.streak ?? 0} day streak</BodyText>
          <BodyText style={{ color: colors.macaw }}>
            {(summary?.gems ?? 0) > 9999 ? '9,999+' : (summary?.gems ?? 0)}
          </BodyText>
          <BodyText style={{ color: colors.cardinal }}>∞</BodyText>
        </View>
        <ScrollView
          ref={scroll}
          stickyHeaderIndices={[0]}
          scrollEventThrottle={16}
          onScroll={(event) => {
            const y = event.nativeEvent.contentOffset.y;
            const active = [...unitY.current]
              .filter(([, top]) => top <= y + PATH_STYLE.headerHeight)
              .at(-1);
            if (active) setVisibleUnit(active[0]);
          }}
          contentContainerStyle={{ paddingHorizontal: SPACE.md, paddingBottom: SPACE.xxl }}
        >
          <View style={{ backgroundColor: colors.snow, paddingBottom: SPACE.md }}>
            {currentUnit === undefined ? null : header(currentUnit)}
          </View>
          {units.map((unit) => (
            <View
              key={unit.index}
              onLayout={(event) => unitY.current.set(unit.index, event.nativeEvent.layout.y)}
            >
              {unit.index !== units[0]?.index ? (
                <View
                  style={{ height: PATH_STYLE.headerHeight + SPACE.md, justifyContent: 'center' }}
                >
                  <Heading>{unit.title}</Heading>
                </View>
              ) : null}
              <View style={{ height: SPACE.xxl, position: 'relative' }}>
                {overlays
                  .filter((overlay) => everyUnit[overlay.targetUnitIndex]?.index === unit.index)
                  .map((overlay) => (
                    <Pressable
                      key={overlay.targetUnitIndex}
                      accessibilityRole="button"
                      accessibilityLabel={overlay.copy}
                      onPress={() =>
                        onLaunch({
                          nodeId: `jump:${unit.index}`,
                          unitIndex: unit.index,
                          flavour: overlay.flavour,
                        })
                      }
                      style={{ alignSelf: 'center' }}
                    >
                      <BodyText style={{ color: colors.macaw }}>Jump here?</BodyText>
                    </Pressable>
                  ))}
              </View>
              {unit.nodes.map((item, index) => {
                const visual = nodeVisual(item);
                const unlocked = nodeUnlocked(model, everyUnit.indexOf(unit), index);
                const offset = LAYOUT.nodeOffsetsPx[index % LAYOUT.nodeOffsetsPx.length] ?? 0;
                const fill = unlocked
                  ? visual.gold
                    ? colors.bee
                    : (UNIT_PALETTE[unit.colourIndex % UNIT_PALETTE.length] ?? COLOR.owl)
                  : colors.swan;
                return (
                  <View
                    key={item.id}
                    style={{
                      height: LAYOUT.nodePitchPx,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <View
                      style={{
                        transform: [{ translateX: offset }],
                        width: LAYOUT.nodeWidthPx,
                        height: LAYOUT.nodeHeightPx,
                      }}
                    >
                      {visual.showsRing && unlocked ? (
                        <Svg
                          pointerEvents="none"
                          width={LAYOUT.nodeWidthPx + 16}
                          height={LAYOUT.nodeWidthPx + 16}
                          style={{ position: 'absolute', left: -8, top: -10 }}
                        >
                          <Circle
                            cx={(LAYOUT.nodeWidthPx + 16) / 2}
                            cy={(LAYOUT.nodeWidthPx + 16) / 2}
                            r={LAYOUT.nodeWidthPx / 2 + 4}
                            fill="none"
                            stroke={colors.swan}
                            strokeWidth={PATH_STYLE.ringStroke}
                          />
                          <Circle
                            cx={(LAYOUT.nodeWidthPx + 16) / 2}
                            cy={(LAYOUT.nodeWidthPx + 16) / 2}
                            r={LAYOUT.nodeWidthPx / 2 + 4}
                            fill="none"
                            stroke={colors.owl}
                            strokeWidth={PATH_STYLE.ringStroke}
                            strokeDasharray={`${visual.ringFraction * 2 * Math.PI * (LAYOUT.nodeWidthPx / 2 + 4)} ${2 * Math.PI * (LAYOUT.nodeWidthPx / 2 + 4)}`}
                            rotation={-90}
                            origin={`${(LAYOUT.nodeWidthPx + 16) / 2}, ${(LAYOUT.nodeWidthPx + 16) / 2}`}
                          />
                        </Svg>
                      ) : null}
                      <Pressable
                        ref={(ref) => {
                          if (ref) refs.current.set(item.id, ref);
                          else refs.current.delete(item.id);
                        }}
                        testID={`path-node-${item.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={`Unit ${unit.index + 1}, ${item.type} ${index + 1}, ${unlocked ? visual.state : 'locked'}`}
                        accessibilityState={{ expanded: selectedNodeId === item.id }}
                        onPress={() => open(item)}
                        style={({ pressed }) => ({
                          width: LAYOUT.nodeWidthPx,
                          height: LAYOUT.nodeHeightPx,
                          borderRadius: LAYOUT.nodeWidthPx / 2,
                          backgroundColor: fill,
                          borderBottomWidth: pressed ? 0 : 6,
                          borderBottomColor: unlocked ? COLOR.owlLip : colors.hare,
                          transform: [{ translateY: pressed ? 6 : 0 }],
                          alignItems: 'center',
                          justifyContent: 'center',
                        })}
                      >
                        <BodyText
                          style={{ fontSize: 31, color: unlocked ? '#FFFFFF' : colors.hare }}
                        >
                          {visual.showsCheck ? '✓' : NODE_GLYPH[item.type]}
                        </BodyText>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          ))}
          <Button3D
            label="Go to current unit"
            tone="neutral"
            onPress={() => {
              const current = everyUnit.find((unit) =>
                unit.nodes.some(
                  (item, index) =>
                    nodeUnlocked(model, everyUnit.indexOf(unit), index) &&
                    !nodeVisual(item).showsCheck,
                ),
              );
              scroll.current?.scrollTo({
                y: unitY.current.get(current?.index ?? 0) ?? 0,
                animated: false,
              });
            }}
          />
          {model.sections.some((s) => s.index > (section?.index ?? 0)) ? (
            <Button3D
              label={`Up next Section ${(section?.index ?? 0) + 2}`}
              tone="neutral"
              onPress={onOpenSections}
            />
          ) : null}
        </ScrollView>
      </View>
      <Modal
        visible={popup !== null}
        transparent
        animationType="none"
        onRequestClose={() => onSelectNode(null)}
      >
        <View style={{ flex: 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close node details"
            onPress={() => onSelectNode(null)}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
          />
          {popup !== null && node !== undefined && selectedUnit !== undefined ? (
            <View
              style={{
                position: 'absolute',
                top: popupTop(anchor, height, popupHeight),
                left: SPACE.md,
                right: SPACE.md,
                maxWidth: LAYOUT.contentMaxWidthPx - SPACE.lg * 2,
                alignSelf: 'center',
                maxHeight: height * PATH_STYLE.popupFraction,
              }}
              onLayout={(event) => {
                if (event.nativeEvent.layout.height > 0)
                  setPopupHeight(event.nativeEvent.layout.height);
              }}
            >
              <Panel>
                <ScrollView>
                  <Heading>{popup.title}</Heading>
                  {unavailable ? (
                    <>
                      <BodyText>{specFor(node.type).unavailableCopy}</BodyText>
                      <Button3D label="Verify or download course" onPress={onRepairPack} />
                    </>
                  ) : (
                    <>
                      {popup.subtitle ? <BodyText>{popup.subtitle}</BodyText> : null}
                      {popup.subLessonCounter ? (
                        <BodyText>{popup.subLessonCounter}</BodyText>
                      ) : null}
                      {node.legendary ? (
                        <BodyText style={{ color: colors.bee }}>Legendary</BodyText>
                      ) : null}
                      {popup.buttons.map((button) => (
                        <Button3D
                          key={button.flavour}
                          label={`${button.label[0]}${button.label.slice(1).toLowerCase()}${advertisedXpByNode[node.id]?.[button.flavour] === undefined ? '' : ` +${advertisedXpByNode[node.id]?.[button.flavour]} XP`}`}
                          tone="primary"
                          onPress={() =>
                            onLaunch({
                              nodeId: node.id,
                              unitIndex: selectedUnit.index,
                              flavour: sessionLaunch(button.flavour),
                            })
                          }
                        />
                      ))}
                    </>
                  )}
                </ScrollView>
              </Panel>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
