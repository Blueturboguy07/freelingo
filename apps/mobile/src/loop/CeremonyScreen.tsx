import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, BackHandler, Platform, Text, View, findNodeHandle } from 'react-native';
import {
  ONE_TIME_SLOTS,
  STREAK_GOAL_OPTIONS,
  accuracyLabel,
  bundleCopy,
  sessionCard,
  type CeremonyResult,
  type CeremonySlot,
} from '@freelingo/core/ceremony';
import { LEGENDARY_XP } from '@freelingo/core/economy';
import type { CeremonyAdvance, CeremonyPresentation, LoopPorts } from './contracts';
import { Action, ErrorNotice, Label, LOOP_TOKENS, Page, Panel, styles, useLoopAction } from './ui';

/** scope/02 scripted beat, chosen2026-09-13. It changes tiles, never the route. */
export const CEREMONY_COMBO_BEAT_MS = 900;
export function nextCeremonyIndex(
  result: CeremonyResult,
  index: number,
  skipRepeated = false,
): number {
  if (!skipRepeated) return index + 1;
  for (let next = index + 1; next < result.chain.length; next++) {
    const slot = result.chain[next]!;
    if (ONE_TIME_SLOTS.includes(slot) || slot === 'S087_returnToPath') return next;
  }
  return result.chain.length;
}
type Committed = Extract<CeremonyPresentation, { status: 'committed' }>;
function titleFor(p: Committed, slot: CeremonySlot): string {
  const a = p.state.account;
  const f = p.facts;
  const titles: Record<CeremonySlot, string> = {
    S067_sessionComplete: cardFor(p).variant,
    S068_scoreUnlock: `You unlocked your ${f.courseName} Score!`,
    S069_scoreProgress: `You're a step closer to increasing your ${f.courseName} Score!`,
    S070_scoreMaxed: `You've reached the top of ${f.courseName} — Score ${f.score}`,
    S071_streakCountUp: `${a.streak} day streak`,
    S072_streakGoalPicker: "Let's commit to learning with a Streak Goal!",
    S073_streakGoalCheckpoint: 'You reached a Streak Goal checkpoint!',
    S074_streakStartsTomorrow: `Day ${a.streak + 1} of your streak starts tomorrow!`,
    S075_streakMilestone: `${a.streak} day streak!`,
    S076_streakSociety:
      a.streakSocietyBeat === 'induction'
        ? "You've been inducted into the Streak Society!"
        : 'Your Streak Society reward',
    S077_perfectStreak:
      a.perfectStreakBeat === 'earned'
        ? 'Way to earn your Perfect Streak!'
        : a.perfectStreakBeat === 'reset'
          ? "Skipping a day resets this week's Perfect Streak. Watch out!"
          : "You're halfway to keeping your Perfect Streak this week!",
    S078_quests: `${a.questsProgressed} Daily Quest${a.questsProgressed === 1 ? '' : 's'} updated!`,
    S079_achievement: 'Achievement unlocked!',
    S080_rewardBundle: bundleCopy(p.result.bundle, a.dailyGoalReachedThisSession),
    S081_nodeCompleteLegendaryOffer: "Prove you're a legend",
    S082_unitComplete: `You completed Unit ${f.unitIndex}!`,
    S083_sectionComplete: `${f.sectionName} complete!`,
    S084_courseComplete: `Congrats on finishing the ${f.courseName} course!`,
    S085_consolation: `Nice try! You earned ${p.state.session.xp} XP`,
    S087_returnToPath: 'Ready for your next lesson?',
  };
  return titles[slot];
}
/** The existing queue's historical 'practice' label is mapped from actual mode names. */
function cardFor(p: Committed) {
  const session = p.state.session;
  const flavour =
    session.flavour.startsWith('hub') ||
    ['nodePractice', 'dailyRefresh', 'endgameReview'].includes(session.flavour)
      ? 'practice'
      : session.flavour;
  return sessionCard({
    ...session,
    flavour: session.gradedItems === 0 && flavour === 'lesson' ? 'unscoredLesson' : flavour,
  });
}
function Tile({ title, value }: { title: string; value: string }) {
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        borderWidth: 2,
        borderColor:
          title === 'TOTAL XP' || title === 'COMBO' ? LOOP_TOKENS.gold : LOOP_TOKENS.primary,
        borderRadius: LOOP_TOKENS.cardRadius,
        padding: LOOP_TOKENS.space,
        gap: 12,
        alignItems: 'center',
      }}
    >
      <Label>{title}</Label>
      <Text style={[styles.heading, { fontSize: 32 }]}>{value}</Text>
    </View>
  );
}
export function CeremonyScreen({
  presentation,
  ports,
}: {
  presentation: CeremonyPresentation;
  ports: LoopPorts;
}) {
  if (presentation.status === 'saving')
    return (
      <Page title="Saving your lesson">
        <Label>Your progress is being saved.</Label>
      </Page>
    );
  if (presentation.status === 'failed')
    return <CommitFailure message={presentation.message} ports={ports} />;
  return (
    <CommittedCeremony
      key={presentation.state.session.sessionId}
      presentation={presentation}
      ports={ports}
    />
  );
}
function CommitFailure({ message, ports }: { message: string; ports: LoopPorts }) {
  const action = useLoopAction('commit-failure');
  return (
    <Page title="Couldn't save this session">
      <Label>{message}</Label>
      <ErrorNotice message={action.error} />
      <Action
        label="TRY AGAIN"
        disabled={action.pending}
        onPress={() => action.run(() => ports.retryCommit())}
      />
      <Action label="MANAGE STORAGE" tone="neutral" onPress={() => ports.navigate('data')} />
    </Page>
  );
}
function CommittedCeremony({
  presentation: p,
  ports,
}: {
  presentation: Committed;
  ports: LoopPorts;
}) {
  const slot = p.result.chain[p.index];
  const headline = slot ? titleFor(p, slot) : 'Your progress is saved';
  const action = useLoopAction(p.state.session.sessionId + '/' + p.index);
  const [goal, setGoal] = useState<number | null>(p.state.account.streakGoal.lastPicked);
  const [resolved, setResolved] = useState(!p.animations || p.reduceMotion);
  const headlineRef = useRef<Text>(null);
  const announcedXp = useRef<string | null>(null);
  useEffect(() => {
    setResolved(!p.animations || p.reduceMotion);
    if (!p.animations || p.reduceMotion) return;
    const timer = setTimeout(() => setResolved(true), CEREMONY_COMBO_BEAT_MS);
    return () => clearTimeout(timer);
  }, [p.state.session.sessionId, p.index, p.animations, p.reduceMotion]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (Platform.OS === 'web') headlineRef.current?.focus();
    else {
      const handle = findNodeHandle(headlineRef.current);
      if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
    }
  }, [headline]);
  useEffect(() => {
    if (
      slot === 'S067_sessionComplete' &&
      (resolved || cardFor(p).terminal) &&
      announcedXp.current !== p.state.session.sessionId
    ) {
      AccessibilityInfo.announceForAccessibility(`${p.state.session.xp} XP`);
      announcedXp.current = p.state.session.sessionId;
    }
  }, [p, resolved, slot]);
  const move = (skipRepeated = false, goalChoice: CeremonyAdvance['goalChoice'] = null) =>
    action.run(() =>
      ports.advanceCeremony({
        sessionId: p.state.session.sessionId,
        expectedIndex: p.index,
        nextIndex: nextCeremonyIndex(p.result, p.index, skipRepeated),
        goalChoice,
      }),
    );
  const card = cardFor(p);
  const score =
    slot === 'S068_scoreUnlock' || slot === 'S069_scoreProgress' || slot === 'S070_scoreMaxed';
  const showCombo = slot === 'S067_sessionComplete' && (card.terminal || !resolved);
  return (
    <Page
      title=""
      footer={
        <>
          <ErrorNotice message={action.error} />
          {slot !== 'S087_returnToPath' && (
            <Action
              label="Skip all"
              tone="neutral"
              disabled={action.pending}
              onPress={() =>
                move(true, slot === 'S072_streakGoalPicker' ? { kind: 'defer' } : null)
              }
            />
          )}
          <Action
            label="CONTINUE"
            testID="ceremony-continue"
            tone={score ? 'macaw' : 'primary'}
            disabled={action.pending || (slot === 'S072_streakGoalPicker' && goal === null)}
            hint={
              slot === 'S072_streakGoalPicker' && goal === null
                ? 'Choose a goal or select Not now'
                : undefined
            }
            onPress={() =>
              move(
                false,
                slot === 'S072_streakGoalPicker' && goal !== null
                  ? { kind: 'choose', days: goal }
                  : null,
              )
            }
          />
        </>
      }
    >
      <Text
        ref={headlineRef}
        accessible
        accessibilityRole="header"
        style={[
          styles.heading,
          {
            textAlign: 'center',
            paddingTop: 48,
            color: score ? LOOP_TOKENS.macaw : LOOP_TOKENS.gold,
          },
        ]}
      >
        {headline}
      </Text>
      {slot === 'S067_sessionComplete' && (
        <>
          {card.subtitle && <Label>{card.subtitle}</Label>}
          <View style={styles.row}>
            {showCombo ? (
              <Tile title="COMBO" value={String(p.facts.combo)} />
            ) : (
              <>
                <Tile title="TOTAL XP" value={String(p.state.session.xp)} />
                {p.facts.accuracy !== null && (
                  <Tile
                    title={accuracyLabel(p.facts.accuracy)}
                    value={`${Math.round(p.facts.accuracy * 100)}%`}
                  />
                )}
              </>
            )}
          </View>
          {p.facts.xpExplanation !== '' && <Label>{p.facts.xpExplanation}</Label>}
          {p.result.collapsedGoalRow && (
            <Panel>
              <Label>{p.result.collapsedGoalRow}</Label>
            </Panel>
          )}
        </>
      )}
      {score && (
        <Panel>
          <Text style={[styles.heading, { textAlign: 'center', fontSize: 56 }]}>
            {p.facts.score}
          </Text>
          <Label>{p.facts.courseName}</Label>
          {p.state.course.scoreEntries.some((e) => e.slot === slot && e.bandBeats > 0) && (
            <Label>You reached a new proficiency band!</Label>
          )}
        </Panel>
      )}
      {slot === 'S072_streakGoalPicker' && (
        <>
          {STREAK_GOAL_OPTIONS.map((option) => (
            <Action
              key={option.days}
              label={`${option.days} day streak · ${option.qualifier}`}
              tone={goal === option.days ? 'macaw' : 'neutral'}
              onPress={() => setGoal(option.days)}
            />
          ))}
          <Action
            label="Not now"
            tone="neutral"
            disabled={action.pending}
            onPress={() => move(false, { kind: 'defer' })}
          />
        </>
      )}
      {(slot === 'S071_streakCountUp' || slot === 'S074_streakStartsTomorrow') && (
        <Panel>
          <Label>
            {slot === 'S071_streakCountUp'
              ? "Practice each day so your streak won't reset!"
              : "But your streak will reset if you don't practice tomorrow. Watch out!"}
          </Label>
        </Panel>
      )}
      {slot === 'S079_achievement' &&
        p.result.achievements.screens
          .flatMap((screen) => screen.rows)
          .map((row) => (
            <Panel key={row.achievementId}>
              <Label>
                {row.achievementName} · Level {row.tier}
              </Label>
              {row.extraTiers > 0 && <Label>+{row.extraTiers} tiers</Label>}
            </Panel>
          ))}
      {slot === 'S081_nodeCompleteLegendaryOffer' && (
        <>
          <Label>Complete this extra-hard challenge and level up to Legendary!</Label>
          <Action
            label={`START +${LEGENDARY_XP} XP`}
            disabled={action.pending}
            onPress={() => action.run(() => ports.launchLegendary(p.state.session.sessionId))}
          />
        </>
      )}
      {slot === 'S082_unitComplete' && <Label>{p.facts.unitName}</Label>}
      {slot === 'S084_courseComplete' && <Label>You unlocked Daily Refresh!</Label>}
      {slot === 'S085_consolation' && (
        <Label>Try again with fewer mistakes to get closer to Legendary</Label>
      )}
      {(
        [
          'S075_streakMilestone',
          'S079_achievement',
          'S082_unitComplete',
          'S083_sectionComplete',
        ] as readonly string[]
      ).includes(slot ?? '') && (
        <Action
          label="SHARE"
          tone="neutral"
          disabled={action.pending}
          onPress={() => action.run(() => ports.shareCard(p.state.session.sessionId))}
        />
      )}
    </Page>
  );
}
