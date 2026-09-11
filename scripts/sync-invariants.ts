/**
 * pnpm invariants:sync   — recopy the registry from the research corpus
 * pnpm invariants:check  — fail if the committed registry has drifted
 *
 * `docs/invariants.md` is a VERBATIM copy of the research corpus registry. It is the
 * single source of invariant ids for `pnpm test:coverage-map`, so a stale copy silently
 * shrinks the registry and lets a phase "own" ids that are no longer the real ones.
 * That already happened once: a partial copy carried 293 ids while the corpus carried
 * 424, and nothing noticed.
 *
 * The corpus lives outside the repo (it is research, not code) so CI cannot see it.
 * `--check` therefore does two different jobs:
 *   - corpus present (a maintainer's machine): byte-compare against it.
 *   - corpus absent (CI): verify the committed copy still matches the recorded digest,
 *     which catches a hand-edit of a file that is supposed to be generated.
 *
 * Run with Node 24: `node --experimental-strip-types scripts/sync-invariants.ts [--check]`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Named config: where the registry comes from and where it lands. */
const CORPUS_REGISTRY = '/Users/mannbellani/duolingo-research/deep/00-INVARIANTS.md';
const REGISTRY_PATH = 'docs/invariants.md';
const DIGEST_PATH = 'docs/invariants.sha256';
const INVARIANT_ID = /INV-[A-Z0-9]+-\d+/g;

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');
const idCount = (text: string): number => new Set(text.match(INVARIANT_ID) ?? []).size;

const check = process.argv.includes('--check');
const registryFile = join(ROOT, REGISTRY_PATH);
const digestFile = join(ROOT, DIGEST_PATH);

if (!check) {
  if (!existsSync(CORPUS_REGISTRY)) {
    console.error(`invariants:sync: corpus not found at ${CORPUS_REGISTRY}`);
    process.exit(1);
  }
  const source = readFileSync(CORPUS_REGISTRY);
  writeFileSync(registryFile, source);
  writeFileSync(digestFile, `${sha256(source)}  ${REGISTRY_PATH}\n`);
  console.log(
    `invariants:sync: copied ${idCount(source.toString('utf8'))} ids into ${REGISTRY_PATH}`,
  );
  process.exit(0);
}

const committed = readFileSync(registryFile);
const committedDigest = sha256(committed);
const recorded = readFileSync(digestFile, 'utf8').trim().split(/\s+/)[0];

if (committedDigest !== recorded) {
  console.error(
    `invariants:check: ${REGISTRY_PATH} does not match ${DIGEST_PATH}.\n` +
      `  It is a generated verbatim copy — do not hand-edit it.\n` +
      `  recorded ${recorded}\n  actual   ${committedDigest}\n` +
      `  Run: pnpm invariants:sync`,
  );
  process.exit(1);
}

if (existsSync(CORPUS_REGISTRY)) {
  const corpus = readFileSync(CORPUS_REGISTRY);
  if (sha256(corpus) !== committedDigest) {
    console.error(
      `invariants:check: the research corpus has moved on.\n` +
        `  committed ${idCount(committed.toString('utf8'))} ids, corpus ${idCount(corpus.toString('utf8'))} ids.\n` +
        `  Run: pnpm invariants:sync`,
    );
    process.exit(1);
  }
  console.log(
    `invariants:check: in sync with the corpus (${idCount(committed.toString('utf8'))} ids)`,
  );
} else {
  console.log(
    `invariants:check: digest matches (${idCount(committed.toString('utf8'))} ids); corpus not on this machine`,
  );
}
