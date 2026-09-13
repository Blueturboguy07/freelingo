import { Fragment } from 'react';
import { View } from 'react-native';
import { GEM_DISPLAY_CLAMP, SHOP_CATALOGUE } from '@freelingo/core/economy';
import { BodyText, Heading, SPACE } from '@freelingo/ui';
import { Action, ErrorNotice, Page, Panel, useLoopAction } from '../../loop/ui';
import type { MainTabsPorts, ShopSnapshot } from './contracts';
import { boostClock, Row, SmallText, TabGlyph } from './ui';

export function ShopScreen({ snapshot, ports }: { snapshot: ShopSnapshot; ports: MainTabsPorts }) {
  const action = useLoopAction('shop');
  return (
    <Page title="Shop">
      <BodyText>
        {snapshot.gems > GEM_DISPLAY_CLAMP ? `${GEM_DISPLAY_CLAMP}+` : snapshot.gems} gems
      </BodyText>
      <ErrorNotice message={action.error} />
      <Heading level={2}>Power-ups</Heading>
      {SHOP_CATALOGUE.map((entry, index) => {
        const freeze = entry.sink === 'streakFreeze';
        const owned = !freeze && snapshot.ownedCosmeticIds.includes(entry.id);
        const equipped = freeze
          ? snapshot.freezes.held >= snapshot.freezes.cap
          : snapshot.equippedCosmeticId === entry.id;
        const affordable = snapshot.gems >= entry.priceGems;
        return (
          <Fragment key={entry.id}>
            {!freeze && SHOP_CATALOGUE[index - 1]?.sink !== 'cosmetic' && (
              <Heading level={2}>Parrot wardrobe</Heading>
            )}
            <Panel>
              <View style={{ gap: SPACE.md }}>
                <Row>
                  <TabGlyph
                    name={freeze ? 'freeze' : entry.id.endsWith('perch') ? 'perch' : 'outfit'}
                  />
                  <View style={{ flex: 1, gap: SPACE.xs }}>
                    <Heading level={2}>{entry.displayName}</Heading>
                    {freeze ? (
                      <>
                        <BodyText>
                          {snapshot.freezes.held} / {snapshot.freezes.cap} EQUIPPED
                        </BodyText>
                        <SmallText>
                          Streak Freeze allows your streak to remain in place for one full day of
                          inactivity.
                        </SmallText>
                        {snapshot.freezes.refillInDays !== null && (
                          <SmallText>Next refill in {snapshot.freezes.refillInDays} days</SmallText>
                        )}
                      </>
                    ) : (
                      <SmallText>{owned ? 'Owned' : 'A new look for your parrot.'}</SmallText>
                    )}
                  </View>
                </Row>
                <Action
                  label={
                    equipped
                      ? 'Equipped'
                      : owned
                        ? `Equip ${entry.displayName}`
                        : `Get ${entry.displayName} for ${entry.priceGems} gems`
                  }
                  disabled={action.pending || equipped || (!owned && !affordable)}
                  tone={equipped ? 'neutral' : 'macaw'}
                  hint={
                    action.pending
                      ? 'Saving your change'
                      : equipped
                        ? freeze
                          ? `Your Streak Freezes are at the ${snapshot.freezes.cap}-freeze limit`
                          : 'This look is already equipped'
                        : !owned && !affordable
                          ? `${entry.priceGems - snapshot.gems} more gems needed`
                          : owned
                            ? 'Apply this look to your parrot'
                            : `Spend ${entry.priceGems} gems`
                  }
                  onPress={() =>
                    action.run(() =>
                      owned ? ports.equipCosmetic(entry.id) : ports.purchaseShopEntry(entry.id),
                    )
                  }
                />
                {!owned && !equipped && !affordable && <SmallText>Not enough gems</SmallText>}
              </View>
            </Panel>
          </Fragment>
        );
      })}
      <Heading level={2}>XP Boosts</Heading>
      {snapshot.activeBoost && (
        <Panel>
          <Row>
            <TabGlyph name="boost" />
            <BodyText>
              {snapshot.activeBoost.multiplier}× XP ·{' '}
              {boostClock(snapshot.activeBoost.remainingSeconds)} remaining
            </BodyText>
          </Row>
        </Panel>
      )}
      {snapshot.boostInventory.length === 0 ? (
        <BodyText>Earn XP Boosts by completing quests and lessons.</BodyText>
      ) : (
        snapshot.boostInventory.map((boost) => (
          <Panel key={boost.id}>
            <View style={{ gap: SPACE.sm }}>
              <Row>
                <TabGlyph name="boost" />
                <View style={{ flex: 1 }}>
                  <Heading level={2}>{boost.multiplier}× XP Boost</Heading>
                  <BodyText>{boost.durationMinutes} minutes</BodyText>
                </View>
              </Row>
              <Action
                label={`Use ${boost.durationMinutes}-minute XP Boost`}
                disabled={action.pending || snapshot.activeBoost !== null}
                hint={
                  action.pending
                    ? 'Saving your change'
                    : snapshot.activeBoost !== null
                      ? 'Use this boost when the active boost ends'
                      : `Start ${boost.durationMinutes} minutes of ${boost.multiplier} times XP`
                }
                onPress={() => action.run(() => ports.activateHeldBoost(boost.id))}
              />
            </View>
          </Panel>
        ))
      )}
      {snapshot.activeBoost && snapshot.boostInventory.length > 0 && (
        <SmallText>Use your next boost when this one ends.</SmallText>
      )}
    </Page>
  );
}
