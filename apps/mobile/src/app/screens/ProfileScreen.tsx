import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { renderedAchievements } from '@freelingo/core/economy';
import type { Achievement } from '@freelingo/core/economy';
import { DAY_CELL_PROVENANCE, weekdayOf } from '@freelingo/core/day';
import type { DayCell, LocalDay } from '@freelingo/core/day';
import { BodyText, CARD, FONT, Heading, SPACE, useUiTheme } from '@freelingo/ui';
import { Action, ErrorNotice, Page, Panel, useLoopAction } from '../../loop/ui';
import type { MainTabsPorts, ProfileSnapshot } from './contracts';
import { InlineStat, Progress, Row, SectionTabs, SmallText, TAB_LAYOUT, TabGlyph } from './ui';

type ProfileTab = 'awards' | 'calendar' | 'report';
const DAY_LABELS: Readonly<Record<DayCell, string>> = {
  flame: 'Streak extended',
  'half-flame': 'Just made it!',
  snowflake: 'Streak frozen',
  grey: 'Missed day',
  outline: 'No completed lesson',
  unlived: 'Unlived date',
  recovered: 'Streak restored',
};
/** S127 seven engine states, including the source-backed recovery and zone-jump states. */
function DayMark({ cell }: { cell: DayCell }) {
  const { colors } = useUiTheme();
  return (
    <Svg
      width={TAB_LAYOUT.smallIconPx}
      height={TAB_LAYOUT.smallIconPx}
      viewBox="0 0 32 32"
      {...(Platform.OS === 'web' ? { 'aria-hidden': true } : { accessible: false })}
    >
      {cell === 'flame' || cell === 'half-flame' ? (
        <>
          <Path
            d="M18 2C25 10 29 13 28 20A12 12 0 014 20C4 15 8 11 11 9L13 17C18 15 19 7 18 2Z"
            fill={colors.bee}
          />
          {cell === 'half-flame' && <Path d="M16 4V29H29V4Z" fill={colors.snow} />}
        </>
      ) : cell === 'snowflake' ? (
        <Path
          d="M16 2V30M4 9L28 23M4 23L28 9M10 5L16 11 22 5M10 27L16 21 22 27"
          stroke={colors.macaw}
          strokeWidth="3"
          strokeLinecap="round"
        />
      ) : cell === 'recovered' ? (
        <>
          <Path
            d="M26 11A12 12 0 107 26M26 11V3M26 11H18"
            fill="none"
            stroke={colors.owl}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <Path
            d="M10 17L15 22 25 16"
            fill="none"
            stroke={colors.owl}
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <Circle
            cx="16"
            cy="16"
            r="12"
            fill={cell === 'grey' ? colors.swan : 'none'}
            stroke={cell === 'unlived' ? colors.macaw : colors.hare}
            strokeWidth="2"
            strokeDasharray={cell === 'unlived' ? '3 3' : undefined}
          />
          {cell === 'unlived' && <Path d="M10 16H22" stroke={colors.macaw} strokeWidth="2" />}
        </>
      )}
    </Svg>
  );
}
function Calendar({ calendar }: { calendar: ProfileSnapshot['calendar'] }) {
  const [selectedDay, setSelectedDay] = useState<LocalDay | null>(null);
  const { colors } = useUiTheme();
  const selected = calendar.cells.find((row) => row.day === selectedDay);
  const first = calendar.cells[0];
  const offset = first === undefined ? 0 : weekdayOf(first.day);
  return (
    <>
      <Heading level={2}>{calendar.monthLabel}</Heading>
      <View style={{ flexDirection: 'row' }}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => (
          <View
            key={index}
            style={{ width: `${100 / TAB_LAYOUT.calendarColumns}%`, alignItems: 'center' }}
          >
            <SmallText>{label}</SmallText>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {Array.from({ length: offset }, (_, index) => (
          <View key={`offset-${index}`} style={{ width: `${100 / TAB_LAYOUT.calendarColumns}%` }} />
        ))}
        {calendar.cells.map((row) => (
          <Pressable
            key={row.day}
            testID={`calendar-${row.cell}`}
            accessibilityRole="button"
            accessibilityLabel={`${row.day}: ${DAY_LABELS[row.cell]}${row.day === calendar.today ? ', today' : ''}`}
            accessibilityState={{ selected: selectedDay === row.day }}
            {...(Platform.OS === 'web' ? { 'aria-pressed': selectedDay === row.day } : {})}
            onPress={() => setSelectedDay(row.day)}
            style={{
              width: `${100 / TAB_LAYOUT.calendarColumns}%`,
              minHeight: TAB_LAYOUT.hitSizePx,
              paddingVertical: SPACE.xs,
              alignItems: 'center',
              gap: SPACE.xxs,
              borderWidth: CARD.borderPx,
              borderColor: selectedDay === row.day ? colors.macaw : 'transparent',
              borderRadius: CARD.radiusPx,
            }}
          >
            <DayMark cell={row.cell} />
            <SmallText>{Number(row.day.slice(-2))}</SmallText>
          </Pressable>
        ))}
      </View>
      {selected && (
        <Panel>
          <View style={{ gap: SPACE.xs }}>
            <Heading level={2}>{selected.day}</Heading>
            <BodyText>
              {selected.provenance ??
                DAY_CELL_PROVENANCE[selected.cell] ??
                DAY_LABELS[selected.cell]}
            </BodyText>
          </View>
        </Panel>
      )}
      {calendar.cells.length === 0 && (
        <BodyText>Your streak calendar will appear here when you start learning.</BodyText>
      )}
    </>
  );
}
function AwardDetails({
  award,
  count,
  close,
}: {
  award: Achievement;
  count: number;
  close(): void;
}) {
  const next = award.tiers.find((tier) => tier > count) ?? award.tiers[award.tiers.length - 1]!;
  return (
    <Panel>
      <View style={{ gap: SPACE.sm }}>
        <Row>
          <TabGlyph name="badge" />
          <Heading level={2}>{award.displayName}</Heading>
        </Row>
        <BodyText>{award.copy.replace('{{n}}', String(next))}</BodyText>
        <Progress value={count} target={next} label={award.displayName} />
        <BodyText>
          {count} / {next}
        </BodyText>
        <SmallText>{award.tiers.join(' · ')}</SmallText>
        <Action label="Close award details" onPress={close} tone="neutral" />
      </View>
    </Panel>
  );
}
export function ProfileScreen({
  snapshot,
  ports,
}: {
  snapshot: ProfileSnapshot;
  ports: MainTabsPorts;
}) {
  const [tab, setTab] = useState<ProfileTab>('awards');
  const [awardId, setAwardId] = useState<string | null>(null);
  const action = useLoopAction('profile');
  const { colors } = useUiTheme();
  const available = renderedAchievements(snapshot.installedFeatures);
  const missing = available.some(
    (award) =>
      snapshot.counters[award.counterColumn] === undefined ||
      snapshot.counterMaximums[award.counterColumn] === undefined,
  );
  const awards = available.filter((award) => {
    const max = snapshot.counterMaximums[award.counterColumn];
    return (
      snapshot.counters[award.counterColumn] !== undefined &&
      max !== undefined &&
      (max === null || max >= award.tiers[0]!)
    );
  });
  const selected = awards.find((award) => award.id === awardId);
  return (
    <Page title="Profile">
      <SmallText>{snapshot.joinedLabel}</SmallText>
      <Panel>
        <Row>
          <InlineStat value={snapshot.streak} label="Day streak" />
          <InlineStat value={snapshot.lifetimeXp} label="Total XP" />
        </Row>
      </Panel>
      {snapshot.societyBadge !== null && (
        <Panel>
          <Row>
            <TabGlyph name="badge" />
            <BodyText>{snapshot.societyBadge}</BodyText>
          </Row>
        </Panel>
      )}
      <SectionTabs<ProfileTab>
        value={tab}
        choices={[
          { id: 'awards', label: 'Awards' },
          { id: 'calendar', label: 'Calendar' },
          { id: 'report', label: 'Weekly report' },
        ]}
        onChange={setTab}
      />
      {tab === 'awards' ? (
        <>
          {missing && (
            <ErrorNotice message="Some award progress is unavailable. Reopen your profile to try again." />
          )}
          {selected && (
            <AwardDetails
              award={selected}
              count={snapshot.counters[selected.counterColumn]!}
              close={() => setAwardId(null)}
            />
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}>
            {awards.map((award) => {
              const count = snapshot.counters[award.counterColumn]!;
              const achieved = award.tiers.filter((tier) => tier <= count).length;
              const next = award.tiers[achieved] ?? award.tiers[award.tiers.length - 1]!;
              return (
                <Pressable
                  key={award.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${award.displayName}, tier ${achieved} of ${award.tiers.length}, ${count} of ${next}`}
                  onPress={() => setAwardId(award.id)}
                  style={{
                    flexGrow: 1,
                    flexBasis: '40%',
                    minHeight: TAB_LAYOUT.hitSizePx,
                    padding: SPACE.md,
                    borderRadius: CARD.radiusPx,
                    borderColor: colors.swan,
                    borderWidth: CARD.borderPx,
                    alignItems: 'center',
                    gap: SPACE.xs,
                  }}
                >
                  <TabGlyph name="badge" />
                  <BodyText style={{ fontFamily: FONT.strong }}>{award.displayName}</BodyText>
                  <SmallText>
                    {count} / {next}
                  </SmallText>
                </Pressable>
              );
            })}
          </View>
          <Heading level={2}>Personal Records</Heading>
          <Panel>
            <View style={{ gap: SPACE.md }}>
              <InlineStat value={snapshot.records.longestStreak} label="Longest streak" />
              <InlineStat value={snapshot.records.dailyMostXp} label="Most XP in a day" />
              <InlineStat value={snapshot.records.perfectLessons} label="Perfect lessons" />
            </View>
          </Panel>
        </>
      ) : tab === 'calendar' ? (
        <Calendar calendar={snapshot.calendar} />
      ) : (
        <>
          <Heading level={2}>Your weekly report</Heading>
          <SmallText>{snapshot.weeklyReport.periodLabel}</SmallText>
          <Panel>
            <View style={{ gap: SPACE.md }}>
              <Row>
                <InlineStat value={snapshot.weeklyReport.wordsStudied} label="Words studied" />
                <InlineStat
                  value={snapshot.weeklyReport.lessonsFinished}
                  label="Lessons finished"
                />
              </Row>
              <Row>
                <InlineStat value={snapshot.weeklyReport.streak} label="Day streak" />
                <BodyText>{snapshot.weeklyReport.studyMinutes} minutes studied</BodyText>
              </Row>
              <SmallText>{snapshot.weeklyReport.previousStudyMinutes} minutes last week</SmallText>
            </View>
          </Panel>
          <BodyText>{snapshot.weeklyReport.courseProgressLabel}</BodyText>
          <ErrorNotice message={action.error} />
          <Action
            label="Share stats"
            disabled={action.pending}
            onPress={() => action.run(() => ports.shareWeeklyReport())}
            tone="macaw"
          />
        </>
      )}
    </Page>
  );
}
