import { GOAL_TIERS, type GoalTierKey } from '@freelingo/core/economy';
import { packSurface, PackFormatError } from '@freelingo/core/packs';
import { displayedScore } from '@freelingo/core/path';
import type { AppRuntime, AppSnapshot, FreelingoServices } from '../app/ports';
import { SqlitePreferences } from '../db/SqlitePreferences';
import { SqliteAppState, AppDataError } from './SqliteAppState';
import { createOnboardingFlow } from './onboarding';
import { readPathModel, PathHistoryUnavailable } from './readPathModel';
import type { FactoryBindings, FactoryResources } from './factoryPorts';

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AppDataError(`Invalid saved ${label}.`);
  return value;
}
/** The application composition root, with mandatory real native bindings supplied by
 * the platform entry. The test harness injects explicit doubles only at those boundaries.
 * Reward/grading/path mutation remains in the durable learning runtime. This module
 * owns one database, source-backed read models, transport order and resource lifetime. */
export function createFreelingoServices(bindings: FactoryBindings): FreelingoServices {
  let opening: Promise<AppRuntime> | null = null;
  let ended = false;
  async function build(): Promise<AppRuntime> {
    const { opened, status } = await bindings.openPersistence();
    const db = opened.db;
    let resources: FactoryResources | null = null;
    let unsubscribe: (() => void) | null = null;
    let released = false;
    async function release(): Promise<void> {
      if (released) return;
      released = true;
      const errors: unknown[] = [];
      try {
        unsubscribe?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        await resources?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        resources?.packs.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        db.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; '),
        );
    }
    try {
      const state = new SqliteAppState(db);
      const existingSeed = db.get('SELECT selection_seed FROM account WHERE id=1')?.selection_seed;
      state.initialize(
        existingSeed === null
          ? bindings.newSelectionSeed()
          : nonnegative(existingSeed, 'selection seed'),
      );
      const native = await bindings.createResources(opened);
      resources = native;
      const preferences = new SqlitePreferences(db, native.learning.modalityClock);
      const learning = new bindings.LearningRuntime(db, {
        ...native.learning,
        packs: native.packs,
      });
      const nowUtc = () => new Date(native.learning.clock().utcMs).toISOString();
      function goal(): GoalTierKey {
        const account = db.get('SELECT daily_goal_tier,daily_goal_xp FROM account WHERE id=1');
        const tier = GOAL_TIERS.find((t) => t.key === account?.daily_goal_tier);
        if (!tier || tier.xp !== account?.daily_goal_xp)
          throw new AppDataError('Invalid saved daily goal.');
        return tier.key;
      }
      function activeCourse(): string {
        const id = state.read().activeCourseId;
        if (!id) throw new AppDataError('Select a course before starting a lesson.');
        return id;
      }
      async function refresh() {
        await native.packs.refresh(state.read().courseIds);
      }
      function requirePlayable(courseId: string) {
        const pack = native.packs.get(courseId);
        if (!pack || !packSurface(native.packs.state(courseId)).lessonsPlayable)
          throw new AppDataError(
            'A verified playable course pack is required. Download or repair the course first.',
          );
        return pack;
      }
      const onboarding = createOnboardingFlow({
        state,
        nowUtc,
        catalogue: native.catalogue,
        packs: native.packs,
        goal: { read: goal, choose: (key) => native.actions.setGoal(key) },
        notifications: {
          read: () => native.notifications.read(),
          requestPermission: () => native.notifications.requestPermission(),
          openSettings: () => native.notifications.openSettings('app'),
        },
        restore: native.restore,
        placement: {
          active: () => learning.readSession()?.state.flavour === 'placement',
          start: async () => {
            const id = state.read().selectedCourse?.courseId;
            if (!id) throw new AppDataError('Select a course before starting placement.');
            requirePlayable(id);
            await learning.start(id, { kind: 'placement' });
          },
        },
      });
      let queue: Promise<void> = Promise.resolve();
      let closing: Promise<void> | null = null;
      const listeners = new Set<() => void>();
      function invalidate() {
        if (closing) return;
        for (const listener of listeners) listener();
      }
      function perform<T>(operation: () => T | Promise<T>): Promise<T> {
        if (closing) return Promise.reject(new AppDataError('The application runtime is closed.'));
        const run = queue.then(operation);
        queue = run.then(
          () => {},
          () => {},
        );
        return run;
      }
      async function foreground() {
        await native.prepareForeground();
        await refresh();
        await learning.foreground();
        await native.publishAndRearm();
      }
      function snapshot(): AppSnapshot {
        const saved = state.read(),
          accountPreferences = preferences.readAccount();
        const deviceUi = native.readUi();
        const ui = {
          ...deviceUi,
          theme:
            accountPreferences.appearance === 'system'
              ? deviceUi.theme
              : accountPreferences.appearance,
        };
        const id = saved.activeCourseId;
        let path: AppSnapshot['path'] = { model: null, status: 'pack-missing' };
        const verified = id === null ? null : native.packs.get(id);
        if (verified) {
          try {
            const model = readPathModel(db, verified);
            const account = db.get('SELECT streak,gems FROM account WHERE id=1');
            path = {
              model,
              status: 'ready',
              summary: {
                streak: nonnegative(account?.streak, 'streak'),
                gems: nonnegative(account?.gems, 'gems'),
                score: displayedScore(model),
              },
            };
          } catch (error) {
            if (error instanceof PathHistoryUnavailable)
              path = { model: null, status: 'history-unavailable' };
            else if (!(error instanceof PackFormatError)) throw error;
          }
        }
        const catalogue = native.catalogue.read();
        const courses = saved.courseIds.map((courseId) => {
          const progress = db.get('SELECT xp FROM course_progress WHERE course_id=?', [courseId]);
          const observed = native.audioBytesPresent(courseId);
          return {
            courseId,
            name: catalogue.find((c) => c.id === courseId)?.languageName ?? courseId,
            progressLabel: `${nonnegative(progress?.xp, 'course XP')} XP`,
            audioBytes: observed === null ? null : nonnegative(observed, 'installed audio bytes'),
          };
        });
        const settings =
          id === null
            ? null
            : {
                courseId: id,
                nowUtc: nowUtc(),
                ...accountPreferences,
                ...preferences.readCourse(id),
                goalTier: goal(),
                courses,
                appVersion: bindings.appVersion,
              };
        return {
          activeCourseId: id,
          ui,
          onboarding: onboarding.read(),
          path,
          settings,
          hub:
            id !== null && verified !== null && path.status === 'ready'
              ? learning.readHub(id)
              : null,
          notifications: native.notifications.read(),
          lesson: learning.readSession(),
          ceremony: learning.readCeremony(),
          sessionOffer: learning.readOffer(),
        };
      }
      const runtime: AppRuntime = {
        opened,
        persistence: status,
        media: native.media,
        readSnapshot: async () => {
          await queue;
          if (closing) throw new AppDataError('The application runtime is closed.');
          return snapshot();
        },
        handleOnboarding: (event) => perform(() => onboarding.dispatch(event)),
        launchLesson: (request) =>
          perform(async () => {
            const id = activeCourse();
            await refresh();
            requirePlayable(id);
            await learning.start(id, request);
          }),
        resolveSessionOffer: (decision) => perform(() => learning.resolveOffer(decision)),
        dispatchLesson: (event) => perform(() => learning.dispatch(event)),
        recordExposure: (exposure) => perform(() => learning.recordExposure(exposure)),
        completeLesson: () =>
          perform(async () => {
            await learning.complete();
            await native.publishAndRearm();
          }),
        reportItem: (id, reason) => perform(() => native.actions.reportItem(id, reason)),
        snoozeItem: (id) => perform(() => native.actions.snoozeItem(id)),
        readSurface: (request) => perform(() => native.actions.readSurface(request)),
        repairPack: () =>
          perform(async () => {
            const id = activeCourse();
            await native.packs.refresh([id]);
            const surface = packSurface(native.packs.state(id));
            if (surface.readOnly)
              throw new AppDataError(
                'This withdrawn course cannot be downloaded again. Your saved progress is preserved.',
              );
            const installed = native.packs.get(id);
            if (surface.action === 'none' && installed) {
              try {
                installed.pack.path();
                return;
              } catch (error) {
                if (!(error instanceof PackFormatError)) throw error;
              }
            }
            // download resolves once the request is queued, not when all audio lands.
            // Refresh records only current facts; later completion invalidates again.
            await native.catalogue.download(id);
            await native.packs.refresh([id]);
          }),
        loop: {
          saveHubDaily: (daily) => perform(() => learning.saveHubDaily(daily)),
          switchCourse: (id) =>
            perform(async () => {
              state.switchCourse(id);
              await native.packs.refresh([id]);
            }),
          setPreference: (id, change) =>
            perform(() => preferences.setCoursePreference(id, change.key, change.value)),
          setAppearance: (value) => perform(() => preferences.setAppearance(value)),
          setGoal: (key) => perform(() => native.actions.setGoal(key)),
          applyCourseAction: (plan) => perform(() => native.actions.applyCourseAction(plan)),
          advanceCeremony: (request) => perform(() => learning.advanceCeremony(request)),
          retryCommit: () =>
            perform(async () => {
              await learning.complete();
              await native.publishAndRearm();
            }),
          launchLegendary: (id) => perform(() => native.actions.launchLegendary(id)),
          shareCard: (id) => perform(() => native.actions.shareCard(id)),
          playWord: (courseId, itemId, ref) =>
            perform(() => native.actions.playWord(courseId, itemId, ref)),
        },
        notifications: {
          save: (change) => perform(() => native.notifications.save(change)),
          requestPermission: () => perform(() => native.notifications.requestPermission()),
          openSettings: (channel) => perform(() => native.notifications.openSettings(channel)),
          openExactAlarmSettings: () =>
            perform(() => native.notifications.openExactAlarmSettings()),
        },
        subscribe: (listener) => {
          if (closing) throw new AppDataError('The application runtime is closed.');
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        foreground: () => perform(foreground),
        background: () =>
          perform(async () => {
            const failures: unknown[] = [];
            try {
              await learning.background();
            } catch (error) {
              failures.push(error);
            } finally {
              try {
                await native.background();
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1)
              throw new AggregateError(
                failures,
                'The background checkpoint and native shutdown failed.',
              );
          }),
        close: () => {
          if (!closing) {
            ended = true;
            closing = queue.then(async () => {
              listeners.clear();
              await release();
            });
          }
          return closing;
        },
      };
      unsubscribe = native.subscribe(invalidate);
      await foreground();
      return runtime;
    } catch (error) {
      try {
        await release();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          `${error instanceof Error ? error.message : String(error)}; resource cleanup failed`,
        );
      }
      throw error;
    }
  }
  return {
    open() {
      if (ended) return Promise.reject(new AppDataError('The application runtime is closed.'));
      opening ??= build().catch((error) => {
        opening = null;
        throw error;
      });
      return opening;
    },
  };
}
