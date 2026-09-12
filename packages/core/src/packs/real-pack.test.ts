import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson, isContentHashItemId } from './items.js';
import { sha256Hex, utf8 } from './hashing.js';
import { pureEd25519Verifier, verifyEd25519 } from './ed25519.js';
import { installPack, parsePackManifest } from './install.js';
import { openPack, readPackMeta, type PackReader } from './loader.js';

/**
 * The pack **CI actually built**, opened by the shipping loader.
 *
 * `loader.test.ts` discharges "the pack loads in `packages/core`'s pack loader tests"
 * against `__fixtures__/es-mini` — a real `coursekit` G9 output, and the right fixture for
 * a unit test, and 30 rows built by a different invocation on a different day. The pack
 * `pack-ci.yml`'s `build-es` produces was uploaded as `es-pack-<sha>` and never opened by
 * anything. So the P2 gate clause was true of a fixture and unproven of the artefact.
 *
 * This file closes that. `validate-es` sets `FREELINGO_REAL_PACK` to
 * `build/es/g9/pack.sqlite` and runs it, so the assertions below are about ~18,000 real
 * sentences, a real manifest and a real signature.
 *
 * **It fails, and never skips, when the variable is set and the pack is absent.** That is
 * the entire difference between a step that proves something and a step that is green on a
 * missing file — the failure mode `docs/ci.md` describes for `flows-present` (`maestro
 * test` over an empty directory exits 0) and for `pipeline-ready` (a skipped job is a green
 * job). With the variable UNSET — every developer run, `pnpm test`, `ci.yml` — the whole
 * describe is skipped, because there is no build tree on a laptop and a red suite that
 * means "you have not run a 90-minute pack build" teaches nobody anything.
 *
 * Env:
 *   FREELINGO_REAL_PACK           the pack database (required to run any of this)
 *   FREELINGO_REAL_PACK_MANIFEST  the manifest beside it; defaults to
 *                                 `<pack dir>/manifest.json`
 */

const REAL_PACK = process.env['FREELINGO_REAL_PACK'];

/** `.../g9/pack.sqlite` -> `.../g9/manifest.json`, with an env override. */
function manifestPath(pack: string): string {
  const override = process.env['FREELINGO_REAL_PACK_MANIFEST'];
  if (override !== undefined && override !== '') return override;
  const cut = pack.lastIndexOf('/');
  return `${cut === -1 ? '.' : pack.slice(0, cut)}/manifest.json`;
}

function open(pack: string): PackReader & { close(): void } {
  const handle = new DatabaseSync(pack, { readOnly: true });
  return {
    all: <T>(sql: string, params: readonly unknown[] = []) =>
      handle.prepare(sql).all(...(params as never[])) as T[],
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      handle.prepare(sql).get(...(params as never[])) as T | undefined,
    close: () => handle.close(),
  };
}

/**
 * The committed public key, parsed here rather than imported.
 *
 * `parseEd25519PublicKeyPem` lives in `@freelingo/schema`, and schema depends on core, so
 * core — tests included — cannot import it without making the arrow point both ways. The
 * shape is asserted rather than assumed: 44 bytes of ed25519 SPKI, of which the last 32
 * are the key. A PEM carrying an RSA or P-256 key fails the length check here, which is
 * the substitution that would otherwise verify nothing and pass.
 */
function committedPublicKey(repoRoot: string): Uint8Array {
  const pem = readFileSync(`${repoRoot}/packages/schema/keys/pack-signing.pub`, 'utf8');
  const body = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(pem)?.[1];
  expect(body, 'the committed key is not a PEM PUBLIC KEY block').toBeDefined();
  const spki = Uint8Array.from(atob((body as string).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  expect(spki.length, 'an ed25519 SPKI is 44 bytes').toBe(44);
  return spki.slice(12);
}

/** `packages/core/src/packs/real-pack.test.ts` -> four levels up is the repo root. */
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

describe.skipIf(REAL_PACK === undefined)('the pack this build produced', () => {
  const pack = REAL_PACK as string;

  it('[INV-PACK-14] exists, because a loader test over a missing pack proves nothing', () => {
    // The one assertion that must be an assertion and not a skip. If `FREELINGO_REAL_PACK`
    // is set and points at nothing, the build did not produce a pack and the gate clause
    // is unmet — so this is red, and the message says which file was expected.
    expect(existsSync(pack), `FREELINGO_REAL_PACK is set and there is no pack at ${pack}`).toBe(
      true,
    );
    expect(existsSync(manifestPath(pack)), `no manifest at ${manifestPath(pack)}`).toBe(true);
    expect(statSync(pack).size).toBeGreaterThan(0);
  });

  it('[INV-PACK-14] opens in the shipping loader with meta a device can read', () => {
    const reader = open(pack);
    try {
      const meta = readPackMeta(reader);
      // `readPackMeta` throws `PackFormatError` on an absent or empty field, so reaching
      // here is the claim. These four are the ones a surface renders before anything else.
      expect(meta.lang.length).toBeGreaterThan(0);
      expect(meta.packId.length).toBeGreaterThan(0);
      expect(meta.major).toBeGreaterThanOrEqual(0);
      expect(meta.ledgerUnit.length).toBeGreaterThan(0);

      const loaded = openPack(reader, { packRoot: pack.replace(/\/[^/]+$/, '') });
      const units = loaded.units();
      expect(units.length, 'a pack with no units is not a course').toBeGreaterThan(0);
      // Not "some lesson somewhere": the FIRST lesson of the FIRST unit, which is the one
      // a learner reaches from S010 before anything else in the course is reachable.
      const first = [...units].sort((a, b) => a.unitIndex - b.unitIndex)[0]!;
      const lesson = loaded.lesson(first.unitId, 1);
      expect(lesson.length, `unit ${first.unitIndex} lesson 1 is empty`).toBeGreaterThan(0);
      for (const exercise of lesson) {
        expect(exercise.acceptedAnswers.length).toBeGreaterThan(0);
        expect(isContentHashItemId(exercise.itemId)).toBe(true);
      }
      // And an FSRS row has something to resolve to: item ids are how a review finds an
      // exercise, so a pack whose ids resolve to nothing is a pack no scheduler can use.
      const ids = loaded.itemIds();
      expect(ids.length).toBeGreaterThan(0);
      expect(loaded.exercisesForItem(ids[0]!).length).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
  });

  it('[INV-PACK-13] every attributed row in the built pack is reachable from the credits', () => {
    const reader = open(pack);
    try {
      const loaded = openPack(reader, { packRoot: pack.replace(/\/[^/]+$/, '') });
      // The read-side half of the licence gate. V10 checks the artefacts; this checks the
      // database that shipped, which is the only artefact a learner ever has. An attributed
      // sentence or voice with no credit row is INV-PACK-17 failing at the surface, and an
      // unlicensed row could only get here by reaching around `resolve()` at ingest.
      expect(loaded.creditsViolations()).toEqual([]);
      expect(loaded.credits().length).toBeGreaterThan(0);
      const unlicensed = reader.all<{ sentence_id: string }>(
        `SELECT sentence_id FROM sentence
           WHERE licence IS NULL OR TRIM(licence) = ''
              OR (attribution_required = 1
                  AND (attribution_owner IS NULL OR TRIM(attribution_owner) = ''))`,
      );
      expect(unlicensed, 'a shipped sentence with no licence or no owner').toEqual([]);
    } finally {
      reader.close();
    }
  });

  it('[INV-PACK-06] the manifest carries a validator report whose hard gate is 100%', () => {
    const manifest = JSON.parse(readFileSync(manifestPath(pack), 'utf8')) as Record<
      string,
      unknown
    >;
    const report = manifest['validatorReport'] as
      { status?: string; hard_gate?: { ids?: string[]; passed?: boolean } } | undefined;
    // The pack a device installs carries the report S002 and S137 render. If the hard gate
    // is missing from it, "V1-V4 at 100%" is a claim the pack cannot substantiate — and a
    // reader of the card has no way to tell that from a pack that passed.
    expect(report, 'the manifest carries no validatorReport').toBeDefined();
    expect(report?.hard_gate?.ids).toEqual(['V1', 'V2', 'V3', 'V4']);
    expect(report?.hard_gate?.passed).toBe(true);
    expect(report?.status).toBe('green');
  });

  it('[INV-PACK-14] the manifest names the engines that ran, and none of them is a stand-in', () => {
    const manifest = JSON.parse(readFileSync(manifestPath(pack), 'utf8')) as Record<
      string,
      unknown
    >;
    const report = manifest['validatorReport'] as {
      validators?: { id: string; outcome: string; notes?: Record<string, unknown> }[];
    };
    const v8 = report.validators?.find((row) => row.id === 'V8');
    expect(v8, 'the report has no V8 row, so no engine record reached the pack').toBeDefined();
    const notes = (v8?.notes ?? {}) as Record<string, unknown>;
    const grammar = String(notes['grammar_engine'] ?? 'none');
    // "0 errors from nothing" is the exact reading INV-PACK-14 fails, and a mock engine is
    // the version of it that wears a label. `mock_lt` exists for tests; a pack validated
    // against it has had its grammar checked by a 40-line stand-in.
    expect(grammar).not.toBe('none');
    expect(grammar).not.toContain('mock');
    expect(String(notes['source'])).toBe('g6');
    expect(notes['ran']).toBe(true);
  });

  it('[INV-PACK-18] the built manifest is verified before install, and a bad signature is `unverified`', () => {
    const manifestBytes = new Uint8Array(readFileSync(manifestPath(pack)));
    const manifest = parsePackManifest(manifestBytes);
    expect(manifest, `the built manifest does not parse: ${manifestPath(pack)}`).not.toBeNull();

    // The digest is the half that is about THIS pack: a manifest that parses and declares
    // somebody else's payload is a manifest the install gate must refuse.
    const payload = new Uint8Array(readFileSync(pack));
    const stagedPayloadSha256 = sha256Hex(payload);
    expect(manifest?.payloadSha256).toBe(stagedPayloadSha256);
    expect(manifest?.payloadBytes).toBe(payload.length);
    expect(manifest?.itemIds.length).toBeGreaterThan(0);

    const publicKey = committedPublicKey(REPO_ROOT);

    // A wrong signature maps to `unverified` — never `corrupt`, never installed — and the
    // steps stop before `install`. This runs whether or not CI had the signing secret,
    // because refusing a bad signature is the invariant; accepting a good one is below.
    const refused = installPack({
      manifestBytes,
      signature: new Uint8Array(64),
      publicKey,
      verifier: pureEd25519Verifier,
      stagedPayloadSha256,
      stagedAudioBytes: manifest?.audioBytes ?? 0,
    });
    expect(refused.state).toBe('unverified');
    expect(refused.installed).toBe(false);
    expect(refused.steps).not.toContain('install');

    // And the real signature, when the run had the key. `coursekit sign` writes the block
    // INTO the manifest and signs the manifest without it, canonicalised as sorted-key
    // compact JSON — which is exactly `canonicalJson`. A run with no `PACK_SIGNING_KEY`
    // (a fork pull request) produces no block, and the pack is legitimately `unverified`.
    const raw = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
    const block = raw['signature'] as
      { algorithm?: string; public_key?: string; signature?: string } | undefined;
    if (block === undefined) {
      expect(
        process.env['FREELINGO_REAL_PACK_SIGNED'],
        'the manifest is unsigned; set FREELINGO_REAL_PACK_SIGNED=1 only where the secret exists',
      ).not.toBe('1');
      return;
    }
    expect(block.algorithm).toBe('ed25519');
    const signed = { ...raw };
    delete signed['signature'];
    const signature = Uint8Array.from(atob(block.signature ?? ''), (c) => c.charCodeAt(0));
    const embedded = Uint8Array.from(atob(block.public_key ?? ''), (c) => c.charCodeAt(0));
    // The embedded key is compared with the committed one FIRST. A manifest that verifies
    // against the key it carries proves only that somebody owned a key, which is what an
    // attacker re-signing a modified pack also has.
    expect([...embedded.slice(12)]).toEqual([...publicKey]);
    expect(verifyEd25519(signature, utf8(canonicalJson(signed)), publicKey)).toBe(true);
  });
});
