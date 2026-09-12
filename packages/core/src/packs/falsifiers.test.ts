import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pureEd25519Verifier } from './ed25519.js';
import { sha256Hex, utf8 } from './hashing.js';
import { installPack, planPackFetch, resolvePackOnSwitch, type InstallInput } from './install.js';
import {
  applyPackUpdate,
  additiveOnlyViolations,
  scoreFrom,
  wordsLearned,
  type ScheduledItem,
} from './items.js';
import { packSurface, resolvePackState, type PackFacts, type PackState } from './state.js';

/**
 * `pnpm test:falsify` — the committed falsifier input for every invariant this module
 * owns. Each case is a real edge case from `00-EDGE-CASES.md`, recorded as data so a
 * reviewer can read what is being protected without reading a test.
 */
const FALSIFIERS = fileURLToPath(new URL('./__falsifiers__/', import.meta.url));

function load<T>(id: string): T {
  return JSON.parse(readFileSync(`${FALSIFIERS}${id}.json`, 'utf8')) as T;
}

interface StateCase {
  readonly why: string;
  readonly facts: PackFacts;
  readonly state: PackState;
  readonly [extra: string]: unknown;
}

const SURFACE_KEYS = [
  'pathRendered',
  'lessonsPlayable',
  'perItemAudioFallback',
  'showsUnavailable',
  'action',
  'readOnly',
  'accountTotalsCounted',
  'progressRowsRetained',
] as const;

function checkStateCase(testCase: StateCase): void {
  const state = resolvePackState(testCase.facts);
  expect(state, testCase.why).toBe(testCase.state);
  const surface = packSurface(state) as unknown as Record<string, unknown>;
  for (const key of SURFACE_KEYS) {
    if (key in testCase) expect(surface[key], `${testCase.why} [${key}]`).toBe(testCase[key]);
  }
}

describe('pack falsifiers', () => {
  for (const id of ['INV-PACK-01', 'INV-PACK-04', 'INV-PACK-18'] as const) {
    const file = load<{ cases: readonly StateCase[] }>(id);
    for (const [index, testCase] of file.cases.entries()) {
      it(`[${id}] falsifier ${index + 1}: ${testCase.why}`, () => {
        checkStateCase(testCase);
      });
    }
  }

  it('[INV-PACK-18] falsifier: every committed install mutation refuses before the install step', () => {
    interface InstallCase {
      readonly why: string;
      readonly mutate: string;
      readonly state: PackState;
      readonly installed: boolean;
      readonly installStepRan: boolean;
    }
    const file = load<{ installCases: readonly InstallCase[] }>('INV-PACK-18');
    const payload = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
    const manifest = {
      packId: 'es-ES@1.0.0',
      courseId: 'en-es',
      major: 1,
      version: '1.0.0',
      payloadSha256: sha256Hex(payload),
      payloadBytes: payload.length,
      audioBytes: 1000,
      itemIds: [],
    };
    const manifestBytes = utf8(JSON.stringify(manifest));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })).subarray(12);
    const signature = new Uint8Array(
      sign(
        null,
        Buffer.from(manifestBytes),
        createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
      ),
    );
    const base: InstallInput = {
      manifestBytes,
      signature,
      publicKey: raw,
      verifier: pureEd25519Verifier,
      stagedPayloadSha256: manifest.payloadSha256,
      stagedAudioBytes: manifest.audioBytes,
    };

    for (const testCase of file.installCases) {
      let input = base;
      if (testCase.mutate === 'wrong-key') {
        const other = generateKeyPairSync('ed25519').publicKey;
        input = {
          ...base,
          publicKey: new Uint8Array(other.export({ type: 'spki', format: 'der' })).subarray(12),
        };
      } else if (testCase.mutate === 'truncated-signature') {
        input = { ...base, signature: signature.subarray(0, 32) };
      } else if (testCase.mutate === 'tampered-manifest') {
        const tampered = Uint8Array.from(manifestBytes);
        tampered[10] = tampered[10]! ^ 0x01;
        input = { ...base, manifestBytes: tampered };
      } else if (testCase.mutate === 'wrong-payload') {
        input = { ...base, stagedPayloadSha256: sha256Hex('a different payload') };
      }
      const result = installPack(input);
      expect(result.state, testCase.why).toBe(testCase.state);
      expect(result.installed, testCase.why).toBe(testCase.installed);
      expect(result.steps.includes('install'), testCase.why).toBe(testCase.installStepRan);
      expect(result.state, testCase.why).not.toBe('corrupt');
    }
  });

  it('[INV-PACK-27] falsifier: the switch starts no fetch on any link, shows the size, and opens no lesson', () => {
    interface SwitchCase {
      readonly why: string;
      readonly facts: PackFacts;
      readonly connection: 'metered' | 'unmetered' | 'offline';
      readonly bytesRemaining: number;
      readonly state: PackState;
      readonly sessionLaunchable: boolean;
      readonly fetchStarts: boolean;
      readonly confirmRequired: boolean;
      readonly offerBytes: number;
      readonly refusal: string;
    }
    interface StartCase {
      readonly why: string;
      readonly connection: 'metered' | 'unmetered' | 'offline';
      readonly trigger: 'explicit-tap' | 'auto-resume' | 'course-switch' | 'session-start';
      readonly userConfirmedMetered: boolean;
      readonly starts: boolean;
    }
    const file = load<{
      cases: readonly SwitchCase[];
      explicitStartCases: readonly StartCase[];
    }>('INV-PACK-27');

    for (const testCase of file.cases) {
      const result = resolvePackOnSwitch(
        testCase.facts,
        testCase.connection,
        testCase.bytesRemaining,
      );
      expect(result.state, testCase.why).toBe(testCase.state);
      expect(result.sessionLaunchable, testCase.why).toBe(testCase.sessionLaunchable);
      expect(result.fetch.start, testCase.why).toBe(testCase.fetchStarts);
      expect(result.fetch.confirmRequired, testCase.why).toBe(testCase.confirmRequired);
      // "with the size shown": the offer carries the byte count, or there is no offer.
      expect(result.offerBytes, testCase.why).toBe(testCase.offerBytes);
      expect(result.fetch.refusal, testCase.why).toBe(testCase.refusal);
    }

    // ...and the rule is not a permanent no: these are the triggers that do start one.
    for (const testCase of file.explicitStartCases) {
      expect(
        planPackFetch({
          connection: testCase.connection,
          userConfirmedMetered: testCase.userConfirmedMetered,
          trigger: testCase.trigger,
          bytesRemaining: 38_000_000,
        }).start,
        testCase.why,
      ).toBe(testCase.starts);
    }
  });

  it('[INV-PACK-02] falsifier: every committed update quarantines exactly what it says and deletes nothing', () => {
    interface UpdateCase {
      readonly why: string;
      readonly fromMajor: number;
      readonly toMajor: number;
      readonly rows: readonly ScheduledItem[];
      readonly packItemIds: readonly string[];
      readonly retired: number;
      readonly notice: string | null;
      readonly rowsKept: number;
      readonly score: number;
      readonly wordsLearned: number;
      readonly additiveOnlyViolations?: readonly string[];
    }
    const file = load<{ cases: readonly UpdateCase[] }>('INV-PACK-02');
    for (const testCase of file.cases) {
      const itemIds = new Set(testCase.packItemIds);
      const result = applyPackUpdate(testCase.rows, {
        fromMajor: testCase.fromMajor,
        toMajor: testCase.toMajor,
        itemIds,
      });
      expect(result.retired, testCase.why).toBe(testCase.retired);
      expect(result.notice, testCase.why).toBe(testCase.notice);
      expect(result.rows, testCase.why).toHaveLength(testCase.rowsKept);
      expect(scoreFrom(result.rows), testCase.why).toBe(testCase.score);
      expect(wordsLearned(result.rows), testCase.why).toBe(testCase.wordsLearned);
      if (testCase.additiveOnlyViolations !== undefined) {
        expect(
          additiveOnlyViolations(
            testCase.rows.map((row) => row.itemId),
            itemIds,
            { fromMajor: testCase.fromMajor, toMajor: testCase.toMajor },
          ),
          testCase.why,
        ).toEqual([...testCase.additiveOnlyViolations]);
      }
    }
  });
});
