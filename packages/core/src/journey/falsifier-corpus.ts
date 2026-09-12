/**
 * The falsifier corpus: find the committed falsifying inputs, and prove they are RUN.
 *
 * Plan §Phases, P1 gate: "committed falsifier inputs per invariant". Plan §The build
 * workflow, step 2: "test first from the invariant's falsifier". An input that is
 * committed but never executed is a comment with a `.json` extension, and `docs/ci.md`
 * names the exact way that hides: *a scan that finds nothing passes for free*.
 *
 * ## What this gate checks, and what it deliberately does not
 *
 * Eight lanes wrote their corpora in parallel, and they chose three different payload
 * shapes: `{id, falsifier, source, input, mustNotBe, usedBy}` in `day/`, `{id, case, kind,
 * input, expect}` in `session/`, `{invariant, why, shape, expect}` in `path/`. Each shape
 * fits what its lane's runner needs, and a gate that rejected all three in favour of a
 * fourth would be a format war, not a check. So the payload is **not** prescribed. What is:
 *
 *   1. **discovery** — every `__falsifiers__/*.json` under `packages/`. Finding zero is a
 *      failure, not a pass.
 *   2. **identity** — the file parses, names its own invariant, and that id agrees with the
 *      file name. A fixture filed under the wrong id reads as coverage and is not.
 *   3. **a reason** — a sentence saying what the input falsifies (`falsifier`, `why` or
 *      `case`). A fixture with no sentence cannot be reviewed against the invariant text.
 *   4. **consumption** — some test file reads the directory this fixture lives in, and at
 *      least one of that file's test NAMES carries the filter term `pnpm test:falsify`
 *      selects by. This is what makes the script execute the corpus rather than select
 *      nothing and exit green.
 *   5. **execution here, when offered** — a fixture may additionally declare `check`
 *      (`{module, export}`); this gate then imports that module, calls that function with
 *      each case and compares structurally. Lanes that keep their own runner are not
 *      forced through it; lanes that want a runner get one free.
 *   6. **coverage** — every owned invariant id has at least one committed input.
 *
 * ## The optional executable contract
 *
 * ```json
 * {
 *   "invariant": "INV-DAY-02",
 *   "why": "a westward flight an hour before midnight: UTC advances, local_day goes back",
 *   "source": "EC-STK-02",
 *   "check": { "module": "../zone.js", "export": "classifyDayKey" },
 *   "cases": [
 *     { "name": "zone changed: honoured",  "args": [ … ], "expect": "travel-regression" },
 *     { "name": "same zone: refused",      "args": [ … ], "expect": "tamper" },
 *     { "name": "backwards UTC throws",    "args": [ … ], "throws": "monotonic" }
 *   ]
 * }
 * ```
 *
 * - `check.module` resolves **relative to the `__falsifiers__` directory**;
 * - `check.export` is called with `...case.args`, or with `case.input` under
 *   `"call": "single"`;
 * - a case declares **exactly one** of `expect` (deep-equal, JSON-shaped) or `throws` (a
 *   substring of the message). A case with neither cannot fail, so it is rejected.
 *
 * Everything here is pure and injectable (`load`) so the gate's own failure paths are
 * executed by its self-test rather than trusted.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './repo-paths.js';

/* --------------------------------------------------------------- named config */

/** Package source roots the walk enters. Nothing generated, nothing installed. */
export const CORPUS_ROOTS: readonly string[] = ['packages'];
/** The directory name that holds committed falsifying inputs. */
export const FALSIFIER_DIR = '__falsifiers__';
/** Directory names the walk never enters, wherever they appear. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.stryker-tmp']);
/** An invariant id as it appears in the registry and in a falsifier file name. */
export const INVARIANT_ID = /^INV-[A-Z0-9]+-\d+$/;
/** An edge-case id. Legal as a file name; it carries no invariant coverage. */
export const EDGE_CASE_ID = /^EC-[A-Z0-9]+-\d+$/;
/** Keys any lane may use for "what this input falsifies". */
const REASON_KEYS = ['falsifier', 'why', 'case', 'note'] as const;
/** Keys any lane may use for the invariant id. */
const ID_KEYS = ['invariant', 'id'] as const;

/* ---------------------------------------------------------------- the format */

export interface FalsifierCase {
  readonly name?: string;
  readonly args?: readonly unknown[];
  readonly input?: unknown;
  readonly expect?: unknown;
  readonly throws?: string;
}

export interface FalsifierCheck {
  readonly module: string;
  readonly export: string;
  readonly call?: 'apply' | 'single';
}

/** The part of a fixture this gate understands. The rest is the lane's business. */
export interface FalsifierFile {
  readonly declaredId: string;
  readonly reason: string;
  readonly check?: FalsifierCheck;
  readonly cases?: readonly FalsifierCase[];
  /** Test files the fixture says consume it (`usedBy`), when it says. */
  readonly usedBy?: readonly string[];
}

/** A file on disk, parsed or not. `path` is repo-relative and is what errors name. */
export interface CorpusEntry {
  readonly path: string;
  readonly absolutePath: string;
  /** The id taken from the FILE NAME (`INV-DAY-02.tamper.json` -> `INV-DAY-02`). */
  readonly fileId: string;
  readonly parsed: FalsifierFile | null;
  readonly errors: readonly string[];
}

/* ----------------------------------------------------------------- discovery */

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === FALSIFIER_DIR) {
      for (const file of readdirSync(full).sort()) {
        if (file.endsWith('.json')) out.push(join(full, file));
      }
      continue;
    }
    walk(full, out);
  }
  return out;
}

/** Every `__falsifiers__/*.json` under the corpus roots, sorted. */
export function discoverCorpusFiles(root = repoRoot()): string[] {
  const found: string[] = [];
  for (const corpusRoot of CORPUS_ROOTS) walk(join(root, corpusRoot), found);
  return found.sort();
}

/* ---------------------------------------------------------------- validation */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A `{...}` object and nothing else.
 *
 * `isPlainObject` is not enough for the comparison below, and the difference is a real
 * bug this gate's own self-test caught: a `Map` is `typeof "object"` and has no own
 * enumerable keys, so `deepEqual(new Map([['a', 1]]), {})` returned **true** — a checker
 * that returns a Map would have compared equal to an empty committed expectation and the
 * falsifier would have passed for free. A prototype check is the whole fix.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function firstString(raw: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Validate one parsed JSON body. Returns the errors, never throws.
 *
 * `fileId` is the id in the file NAME; a file that says one invariant and is named for
 * another is the kind of thing that makes a corpus look complete when it is not.
 */
export function validateFalsifierFile(
  raw: unknown,
  fileId: string,
): { file: FalsifierFile | null; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return { file: null, errors: ['not a JSON object'] };

  const named = INVARIANT_ID.test(fileId);
  if (!named && !EDGE_CASE_ID.test(fileId)) {
    errors.push(
      `file name must start with an invariant or edge-case id, e.g. INV-DAY-02.json (got ${fileId})`,
    );
  }

  const declaredId = firstString(raw, ID_KEYS);
  if (declaredId === null) {
    errors.push(`no id: give it "invariant" (or "id") naming what it falsifies`);
  } else if (declaredId !== fileId) {
    errors.push(`declares ${JSON.stringify(declaredId)}, file name says ${fileId}`);
  }

  const reason = firstString(raw, REASON_KEYS);
  if (reason === null || reason.trim().length < 12) {
    errors.push(
      `no reason: give it "falsifier" (or "why"/"case") — a sentence saying what this input falsifies`,
    );
  }

  const usedByRaw = raw['usedBy'];
  if (usedByRaw !== undefined && !Array.isArray(usedByRaw)) {
    errors.push('"usedBy" must be an array of test paths when present');
  }

  /* -- the optional executable contract -------------------------------------- */
  let check: FalsifierCheck | undefined;
  let cases: readonly FalsifierCase[] | undefined;
  const rawCheck = raw['check'];
  if (rawCheck !== undefined) {
    if (!isPlainObject(rawCheck)) {
      errors.push('"check" must be { module, export } naming the function to run');
    } else {
      if (typeof rawCheck['module'] !== 'string' || rawCheck['module'].length === 0) {
        errors.push('"check.module" must be a module specifier relative to __falsifiers__/');
      }
      if (typeof rawCheck['export'] !== 'string' || rawCheck['export'].length === 0) {
        errors.push('"check.export" must name an exported function');
      }
      const call = rawCheck['call'];
      if (call !== undefined && call !== 'apply' && call !== 'single') {
        errors.push(`"check.call" must be "apply" or "single" (got ${JSON.stringify(call)})`);
      }
      check = rawCheck as unknown as FalsifierCheck;
    }

    const rawCases = raw['cases'];
    if (!Array.isArray(rawCases) || rawCases.length === 0) {
      errors.push('"cases" must be a non-empty array when "check" is declared');
    } else {
      rawCases.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          errors.push(`cases[${index}] is not an object`);
          return;
        }
        const hasExpect = 'expect' in entry;
        const hasThrows = 'throws' in entry;
        if (hasExpect === hasThrows) {
          errors.push(`cases[${index}] must declare exactly one of "expect" or "throws"`);
        }
        if (hasThrows && typeof entry['throws'] !== 'string') {
          errors.push(`cases[${index}].throws must be a substring of the error message`);
        }
        if (check?.call === 'single') {
          if (!('input' in entry)) {
            errors.push(`cases[${index}] needs "input" when call is "single"`);
          }
        } else if (!Array.isArray(entry['args'])) {
          errors.push(`cases[${index}].args must be an array of arguments`);
        }
      });
      cases = rawCases as unknown as readonly FalsifierCase[];
    }
  }

  if (errors.length > 0) return { file: null, errors };
  const file: FalsifierFile = {
    declaredId: declaredId!,
    reason: reason!,
    ...(check === undefined ? {} : { check }),
    ...(cases === undefined ? {} : { cases }),
    ...(usedByRaw === undefined ? {} : { usedBy: usedByRaw as readonly string[] }),
  };
  return { file, errors };
}

/** Read, parse and validate one file. */
export function readCorpusEntry(absolutePath: string, root = repoRoot()): CorpusEntry {
  const path = relative(root, absolutePath);
  const fileId = absolutePath
    .split('/')
    .pop()!
    .replace(/\.json$/, '')
    .split('.')[0]!;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    return {
      path,
      absolutePath,
      fileId,
      parsed: null,
      errors: [`unparseable JSON: ${(error as Error).message}`],
    };
  }
  const { file, errors } = validateFalsifierFile(raw, fileId);
  return { path, absolutePath, fileId, parsed: file, errors };
}

/** The whole corpus on disk. */
export function readCorpus(root = repoRoot()): CorpusEntry[] {
  return discoverCorpusFiles(root).map((file) => readCorpusEntry(file, root));
}

/* --------------------------------------------------------------- consumption */

export interface ConsumerReport {
  /** Repo-relative `__falsifiers__` directory. */
  readonly directory: string;
  /** Test files that read it. */
  readonly consumers: readonly string[];
  /** Consumers with at least one test NAME carrying the `test:falsify` filter term. */
  readonly selectable: readonly string[];
}

function testFilesUnder(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) testFilesUnder(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every test name in a source: `it('…')`, `test('…')`, `describe('…')`. */
export function testNamesIn(source: string): string[] {
  const names: string[] = [];
  const pattern = /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) names.push(match[2] ?? '');
  return names;
}

/**
 * For every `__falsifiers__` directory: which tests read it, and which of those
 * `pnpm test:falsify` would actually select.
 *
 * "Reads it" is: a test file in the same package whose source mentions `__falsifiers__`.
 * That is a loose match on purpose — a lane may read the directory with `readdirSync`, an
 * `import.meta.glob` or a literal path, and prescribing one of those would be prescribing
 * a runner. What is not loose is the second half: `pnpm test:falsify` filters by test NAME,
 * so a consumer whose test names do not carry the filter term is never run by that script
 * and the corpus it reads is executed only by chance, under `pnpm test`.
 */
export function consumersFor(
  directories: readonly string[],
  filterTerm: string,
  root = repoRoot(),
): ConsumerReport[] {
  const reports: ConsumerReport[] = [];
  const sourceCache = new Map<string, string>();
  for (const directory of directories) {
    // The package this corpus belongs to: .../packages/<pkg>/src/...
    const absolute = join(root, directory);
    const packageRoot = absolute.slice(0, absolute.indexOf(`${join('', 'src')}`) + 4) || absolute;
    const consumers: string[] = [];
    const selectable: string[] = [];
    for (const file of testFilesUnder(packageRoot)) {
      let source = sourceCache.get(file);
      if (source === undefined) {
        source = readFileSync(file, 'utf8');
        sourceCache.set(file, source);
      }
      if (!source.includes(FALSIFIER_DIR)) continue;
      const relativePath = relative(root, file);
      consumers.push(relativePath);
      if (testNamesIn(source).some((name) => name.includes(filterTerm))) {
        selectable.push(relativePath);
      }
    }
    reports.push({ directory, consumers, selectable });
  }
  return reports;
}

/** The distinct `__falsifiers__` directories in a corpus, repo-relative. */
export function corpusDirectories(entries: readonly CorpusEntry[]): string[] {
  return [...new Set(entries.map((entry) => dirname(entry.path)))].sort();
}

/* ------------------------------------------------------------------ equality */

/**
 * Structural equality against a committed expectation.
 *
 * The expectation came out of JSON, so this is deliberately JSON-shaped: objects compare
 * by their own enumerable keys, arrays by length and elements, everything else by
 * `Object.is`. A checker that returns a `Map`, a class instance with private state, or a
 * function therefore does NOT quietly compare equal to `{}`.
 */
export function deepEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((value, index) => deepEqual(actual[index], value));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length) return false;
    if (actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
    return expectedKeys.every((key) => deepEqual(actual[key], expected[key]));
  }
  return false;
}

function describeValue(value: unknown): string {
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ----------------------------------------------------------------- execution */

export interface CaseResult {
  readonly file: string;
  readonly invariant: string;
  readonly case: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** Imports a module specifier and returns its exports. Injectable for the self-test. */
export type ModuleLoader = (absoluteModulePath: string) => Promise<Record<string, unknown>>;

const importModule: ModuleLoader = async (absoluteModulePath) =>
  (await import(pathToFileURL(absoluteModulePath).href)) as Record<string, unknown>;

/**
 * Run every case in one validated file that declares `check`.
 *
 * A file without `check` returns no results: it is executed by its own lane's runner, and
 * the consumption check above is what holds that. A file WITH `check` that cannot be
 * imported, or whose export is gone, fails here — "the checker is gone" must be a failure,
 * not a quiet zero-case pass.
 */
export async function runCorpusEntry(
  entry: CorpusEntry,
  load: ModuleLoader = importModule,
): Promise<CaseResult[]> {
  const file = entry.parsed;
  if (file === null) {
    return [
      {
        file: entry.path,
        invariant: entry.fileId,
        case: '(file)',
        ok: false,
        detail: entry.errors.join('; '),
      },
    ];
  }
  if (file.check === undefined || file.cases === undefined) return [];

  const modulePath = resolve(dirname(entry.absolutePath), file.check.module);
  let exports: Record<string, unknown>;
  try {
    exports = await load(modulePath);
  } catch (error) {
    return [
      {
        file: entry.path,
        invariant: file.declaredId,
        case: '(import)',
        ok: false,
        detail: `cannot import ${file.check.module}: ${(error as Error).message}`,
      },
    ];
  }

  const checker = exports[file.check.export];
  if (typeof checker !== 'function') {
    return [
      {
        file: entry.path,
        invariant: file.declaredId,
        case: '(export)',
        ok: false,
        detail: `${file.check.module} has no exported function ${file.check.export}`,
      },
    ];
  }

  const results: CaseResult[] = [];
  for (const [index, testCase] of file.cases.entries()) {
    const name = testCase.name ?? `cases[${index}]`;
    const args = file.check.call === 'single' ? [testCase.input] : [...(testCase.args ?? [])];
    let value: unknown;
    let thrown: unknown;
    try {
      value = await (checker as (...a: unknown[]) => unknown)(...args);
    } catch (error) {
      thrown = error;
    }

    if (testCase.throws !== undefined) {
      if (thrown === undefined) {
        results.push({
          file: entry.path,
          invariant: file.declaredId,
          case: name,
          ok: false,
          detail: `expected a throw containing ${JSON.stringify(testCase.throws)}, returned ${describeValue(value)}`,
        });
        continue;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      results.push(
        message.includes(testCase.throws)
          ? { file: entry.path, invariant: file.declaredId, case: name, ok: true }
          : {
              file: entry.path,
              invariant: file.declaredId,
              case: name,
              ok: false,
              detail: `threw ${JSON.stringify(message)}, expected it to contain ${JSON.stringify(testCase.throws)}`,
            },
      );
      continue;
    }

    if (thrown !== undefined) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      results.push({
        file: entry.path,
        invariant: file.declaredId,
        case: name,
        ok: false,
        detail: `threw ${JSON.stringify(message)}, expected ${describeValue(testCase.expect)}`,
      });
      continue;
    }

    results.push(
      deepEqual(value, testCase.expect)
        ? { file: entry.path, invariant: file.declaredId, case: name, ok: true }
        : {
            file: entry.path,
            invariant: file.declaredId,
            case: name,
            ok: false,
            detail: `returned ${describeValue(value)}, expected ${describeValue(testCase.expect)}`,
          },
    );
  }
  return results;
}

/** Run every entry that offers the executable contract. */
export async function runCorpus(
  entries: readonly CorpusEntry[],
  load: ModuleLoader = importModule,
): Promise<CaseResult[]> {
  const all: CaseResult[] = [];
  for (const entry of entries) all.push(...(await runCorpusEntry(entry, load)));
  return all;
}

/** Invariant ids the corpus covers — file names only, and only INV ids. */
export function coveredInvariants(entries: readonly CorpusEntry[]): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.parsed !== null && INVARIANT_ID.test(entry.fileId))
      .map((entry) => entry.fileId),
  );
}
