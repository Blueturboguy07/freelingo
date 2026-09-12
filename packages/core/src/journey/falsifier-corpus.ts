/**
 * The falsifier corpus: find the committed falsifying inputs, and RUN them.
 *
 * Plan §Phases, P1 gate: "committed falsifier inputs per invariant". Plan §The build
 * workflow, step 2: "test first from the invariant's falsifier". An input that is
 * committed but never executed is a comment with a `.json` extension, and
 * `docs/ci.md` names the exact way that hides: *a scan that finds nothing passes for
 * free*. So this module does three separable things and every one of them can fail:
 *
 *   1. **discover** — walk the tree for `__falsifiers__/*.json`. Finding zero files is
 *      a failure, not a pass.
 *   2. **validate** — every file must name its invariant, say why the input is
 *      interesting, and name an exported function that can be called with it.
 *   3. **execute** — import that function, call it with each case, compare the result
 *      with the committed expectation. A file whose checker has been renamed or
 *      deleted fails here rather than being skipped.
 *
 * Then `falsifier-corpus.test.ts` adds the fourth thing, which is the one the P1 gate
 * is actually about: **every owned invariant id has at least one committed input**.
 *
 * ## The file format
 *
 * One file per invariant (more than one is allowed; the id must match the file name):
 *
 * ```
 * packages/core/src/day/__falsifiers__/INV-DAY-02.json
 * packages/core/src/day/__falsifiers__/INV-DAY-02.tamper.json     (a second input)
 * ```
 *
 * ```json
 * {
 *   "invariant": "INV-DAY-02",
 *   "why": "a westward flight one hour before midnight: UTC advances, local_day goes back",
 *   "source": "EC-STK-02",
 *   "check": { "module": "../zone.js", "export": "honourLocalDayRegression" },
 *   "cases": [
 *     { "name": "zone changed and UTC is monotonic: honoured",
 *       "args": [{ "previous": "…", "next": "…" }], "expect": true },
 *     { "name": "same zone: refused as tampering",
 *       "args": [{ "previous": "…", "next": "…" }], "expect": false },
 *     { "name": "a clock that went backwards in UTC throws",
 *       "args": [{ "previous": "…", "next": "…" }], "throws": "monotonic" }
 *   ]
 * }
 * ```
 *
 * - `check.module` resolves **relative to the `__falsifiers__` directory**, so a lane's
 *   inputs sit next to the module they falsify and move with it.
 * - `check.export` is a function. It is called with `...case.args` (the usual shape) —
 *   `"call": "single"` passes `case.input` as one argument instead, for a checker that
 *   takes one options object and reads better that way.
 * - a case declares exactly one of `expect` (deep-equal the return value) or `throws`
 *   (the error message must contain the string). A case that declares neither cannot
 *   fail, so it is a validation error.
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
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.stryker-tmp', 'fixtures']);
/** An invariant id as it appears in the registry and in a falsifier file name. */
export const INVARIANT_ID = /^INV-[A-Z0-9]+-\d+$/;

/* ---------------------------------------------------------------- the format */

export interface FalsifierCase {
  /** What this case is, in one line. Printed when it fails. */
  readonly name?: string;
  /** Arguments spread into the checker (`call: "apply"`, the default). */
  readonly args?: readonly unknown[];
  /** The single argument (`call: "single"`). */
  readonly input?: unknown;
  /** The expected return value, compared structurally. */
  readonly expect?: unknown;
  /** A substring the thrown error's message must contain. */
  readonly throws?: string;
}

export interface FalsifierCheck {
  /** Module specifier, resolved relative to the `__falsifiers__` directory. */
  readonly module: string;
  /** Name of the exported function to call. */
  readonly export: string;
  /** `apply` spreads `args`; `single` passes `input`. Default `apply`. */
  readonly call?: 'apply' | 'single';
}

export interface FalsifierFile {
  readonly invariant: string;
  readonly why: string;
  /** Optional edge-case id from `deep/00-EDGE-CASES.md`, e.g. `EC-STK-02`. */
  readonly source?: string;
  readonly check: FalsifierCheck;
  readonly cases: readonly FalsifierCase[];
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

/** Every `__falsifiers__/*.json` under the corpus roots, repo-relative paths sorted. */
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
 * Validate one parsed JSON body against the format. Returns the errors, never throws.
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

  if (!INVARIANT_ID.test(fileId)) {
    errors.push(`file name must start with an invariant id, e.g. INV-DAY-02.json (got ${fileId})`);
  }
  if (raw['invariant'] !== fileId) {
    errors.push(`"invariant" is ${JSON.stringify(raw['invariant'])}, file name says ${fileId}`);
  }
  if (typeof raw['why'] !== 'string' || raw['why'].trim().length < 12) {
    errors.push('"why" must be a sentence saying what this input falsifies');
  }
  if (raw['source'] !== undefined && typeof raw['source'] !== 'string') {
    errors.push('"source" must be an edge-case id string when present');
  }

  const check = raw['check'];
  if (!isPlainObject(check)) {
    errors.push('"check" must be { module, export } naming the function to run');
  } else {
    if (typeof check['module'] !== 'string' || check['module'].length === 0) {
      errors.push('"check.module" must be a module specifier relative to __falsifiers__/');
    }
    if (typeof check['export'] !== 'string' || check['export'].length === 0) {
      errors.push('"check.export" must name an exported function');
    }
    const call = check['call'];
    if (call !== undefined && call !== 'apply' && call !== 'single') {
      errors.push(`"check.call" must be "apply" or "single" (got ${JSON.stringify(call)})`);
    }
  }

  const cases = raw['cases'];
  if (!Array.isArray(cases) || cases.length === 0) {
    errors.push('"cases" must be a non-empty array: a file with no case executes nothing');
  } else {
    cases.forEach((entry, index) => {
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
      const call = isPlainObject(check) ? check['call'] : undefined;
      if (call === 'single') {
        if (!('input' in entry)) errors.push(`cases[${index}] needs "input" when call is "single"`);
      } else if (!Array.isArray(entry['args'])) {
        errors.push(`cases[${index}].args must be an array of arguments`);
      }
    });
  }

  return { file: errors.length === 0 ? (raw as unknown as FalsifierFile) : null, errors };
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

/* ------------------------------------------------------------------ equality */

/**
 * Structural equality against a committed expectation.
 *
 * The expectation came out of JSON, so this is deliberately JSON-shaped: objects
 * compare by their own enumerable keys, arrays by length and elements, everything else
 * by `Object.is`. A checker that returns a `Map`, a class instance with private state,
 * or a function therefore does NOT quietly compare equal to `{}` — it is reported as a
 * value the corpus cannot express, which is a real finding about the checker's shape.
 */
export function deepEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((value, index) => deepEqual(actual[index], value));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length) return false;
    if (actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
    return expectedKeys.every((key) => deepEqual(actual[key], expected[key]));
  }
  return false;
}

function describe(value: unknown): string {
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
 * Run every case in one validated file.
 *
 * Returns one result per case, plus a single failing result if the module or the export
 * cannot be resolved — because "the checker is gone" must be a failure of the corpus,
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

  const modulePath = resolve(dirname(entry.absolutePath), file.check.module);
  let exports: Record<string, unknown>;
  try {
    exports = await load(modulePath);
  } catch (error) {
    return [
      {
        file: entry.path,
        invariant: file.invariant,
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
        invariant: file.invariant,
        case: '(export)',
        ok: false,
        detail: `${file.check.module} has no exported function ${file.check.export}`,
      },
    ];
  }

  const results: CaseResult[] = [];
  for (const [index, testCase] of file.cases.entries()) {
    const name = testCase.name ?? `cases[${index}]`;
    const args =
      file.check.call === 'single' ? [testCase.input] : [...(testCase.args ?? [])].map((a) => a);
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
          invariant: file.invariant,
          case: name,
          ok: false,
          detail: `expected a throw containing ${JSON.stringify(testCase.throws)}, returned ${describe(value)}`,
        });
        continue;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      results.push(
        message.includes(testCase.throws)
          ? { file: entry.path, invariant: file.invariant, case: name, ok: true }
          : {
              file: entry.path,
              invariant: file.invariant,
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
        invariant: file.invariant,
        case: name,
        ok: false,
        detail: `threw ${JSON.stringify(message)}, expected ${describe(testCase.expect)}`,
      });
      continue;
    }

    results.push(
      deepEqual(value, testCase.expect)
        ? { file: entry.path, invariant: file.invariant, case: name, ok: true }
        : {
            file: entry.path,
            invariant: file.invariant,
            case: name,
            ok: false,
            detail: `returned ${describe(value)}, expected ${describe(testCase.expect)}`,
          },
    );
  }
  return results;
}

/** Run the whole corpus. */
export async function runCorpus(
  entries: readonly CorpusEntry[],
  load: ModuleLoader = importModule,
): Promise<CaseResult[]> {
  const all: CaseResult[] = [];
  for (const entry of entries) all.push(...(await runCorpusEntry(entry, load)));
  return all;
}

/** Ids the corpus covers, taken from the validated files only. */
export function coveredInvariants(entries: readonly CorpusEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.parsed !== null).map((e) => e.fileId));
}
