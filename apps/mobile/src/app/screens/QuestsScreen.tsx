import { useState } from 'react';
import { View } from 'react-native';
import { BodyText, Heading, Mascot, SPACE, useUiTheme } from '@freelingo/ui';
import { Page, Panel } from '../../loop/ui';
import type { QuestsSnapshot } from './contracts';
import { Progress, resetLabel, Row, SectionTabs, SmallText, TabGlyph } from './ui';

export function QuestsScreen({ snapshot }: { snapshot: QuestsSnapshot }) {
  const [tab, setTab] = useState<'daily' | 'badges'>('daily');
  const { colors } = useUiTheme();
  return (
    <Page title="Quests">
      <SectionTabs<'daily' | 'badges'>
        value={tab}
        choices={[
          { id: 'daily', label: 'Daily' },
          { id: 'badges', label: 'Badges' },
        ]}
        onChange={setTab}
      />
      {tab === 'daily' ? (
        <>
          <Row>
            <Mascot pose="happy" size={64} label="Happy parrot" />
            <View style={{ flex: 1, gap: SPACE.xs }}>
              <Heading level={2}>Welcome!</Heading>
              <BodyText>Complete quests to earn rewards! Quests refresh every day.</BodyText>
            </View>
          </Row>
          <Row>
            <View style={{ flex: 1 }}>
              <Heading level={2}>Daily Quests</Heading>
            </View>
            <SmallText>{resetLabel(snapshot.resetInSeconds)}</SmallText>
          </Row>
          {snapshot.quests.map((quest) => (
            <Panel key={quest.templateId}>
              <View style={{ gap: SPACE.sm }}>
                <Heading level={2}>{quest.copy}</Heading>
                <Progress value={quest.progress} target={quest.target} label={quest.copy} />
                {quest.completedAtUtc !== null ? (
                  <BodyText style={{ color: colors.owl }}>Completed</BodyText>
                ) : (
                  <SmallText>
                    {quest.progress} / {quest.target}
                  </SmallText>
                )}
              </View>
            </Panel>
          ))}
        </>
      ) : (
        <>
          <Row>
            <TabGlyph name="badge" />
            <View style={{ flex: 1, gap: SPACE.xs }}>
              <Heading level={2}>Monthly challenge</Heading>
              <BodyText>{snapshot.badge.monthKey}</BodyText>
            </View>
          </Row>
          <Panel>
            <View style={{ gap: SPACE.sm }}>
              <Heading level={2}>{snapshot.badge.tier} badge</Heading>
              <BodyText>
                {snapshot.badge.questsCompleted} / {snapshot.badge.targetQuests} quests
              </BodyText>
              <Progress
                value={snapshot.badge.questsCompleted}
                target={snapshot.badge.targetQuests}
                label="Monthly quests"
              />
            </View>
          </Panel>
          <Heading level={2}>Badge history</Heading>
          {snapshot.badgeHistory.length === 0 ? (
            <BodyText>Your monthly badges will appear here.</BodyText>
          ) : (
            snapshot.badgeHistory.map((badge) => (
              <Panel key={badge.monthKey}>
                <Row>
                  <TabGlyph name="badge" />
                  <View style={{ flex: 1 }}>
                    <Heading level={2}>{badge.monthKey}</Heading>
                    <BodyText>
                      {badge.tier} · {badge.questsCompleted} quests
                    </BodyText>
                  </View>
                </Row>
              </Panel>
            ))
          )}
        </>
      )}
    </Page>
  );
}
