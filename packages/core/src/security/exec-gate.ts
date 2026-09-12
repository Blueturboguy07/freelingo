/**
 * INV-SEC-02 — `execAsync` is never called with interpolated input.
 *
 * `expo-sqlite`'s `execAsync` runs a whole script and **does not bind parameters**
 * (EC-SEC-02, `deep/09` S2). Every other entry point on the `Db` interface takes a
 * params array; `execAsync` takes a string. So the rule is not "escape carefully", it is
 * "the argument is a literal an author wrote, or it is a bug".
 *
 * This file is the *detector*, deliberately pure: it takes source text and returns the
 * offending call sites. `exec-gate.test.ts` walks the repository and feeds it every file,
 * because the gate is over the whole codebase — engine, app, scripts and config alike.
 *
 * Two failure modes this is shaped around, both of which have already happened in this
 * repo's P0 report:
 *
 * - **A scan that finds nothing passes for free.** A grep gate whose glob stops matching
 *   (a moved directory, a renamed extension, a walk that silently returns `[]` on a
 *   permissions error) is green and proves nothing. The test therefore asserts a floor on
 *   the number of files scanned *and* runs the detector against positive controls, so a
 *   detector that has stopped detecting is red rather than quiet.
 * - **Skipping generated trees by name.** `apps/mobile/ios` and `apps/mobile/android` are
 *   `expo prebuild` output and are full of vendored JavaScript. They are skipped **by
 *   path**, never by the directory names `ios`/`android`, which are ordinary words a real
 *   source directory may one day use.
 */

export interface ExecAsyncCall {
  /** Byte offset of the `execAsync` token in the source. */
  readonly index: number;
  /** 1-based line number. */
  readonly line: number;
  /** The argument text as written, between the parentheses. */
  readonly argument: string;
  /** Why it is a violation, for a failure message somebody has to act on. */
  readonly reason: string;
}

/** `execAsync`, `db.execAsync`, `await handle.execAsync` — the token, however reached. */
const EXEC_ASYNC = /\bexecAsync\s*\(/g;

/**
 * A single string literal with no substitution: `'PRAGMA foo'`, `"..."`, or a template
 * literal whose body contains no `${`. Anything else — an identifier, a concatenation, a
 * template with a hole — is a violation, including the cases that *look* safe, because
 * "this variable is always a constant" is a claim no grep can check and every injection
 * starts as one.
 */
function classifyArgument(argument: string): string | null {
  const trimmed = argument.trim();
  if (trimmed.length === 0) return 'empty argument';
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return `non-literal argument (${trimmed.slice(0, 40)})`;
  }
  if (quote === '`' && trimmed.includes('${')) {
    return 'template literal with an interpolated hole';
  }
  let closed = -1;
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) {
      closed = i;
      break;
    }
  }
  if (closed === -1) return 'unterminated string literal';
  const rest = trimmed.slice(closed + 1).trim();
  if (rest.length === 0) return null;
  if (rest.startsWith('+')) return `string concatenation (${rest.slice(0, 40)})`;
  return `expression around a literal (${rest.slice(0, 40)})`;
}

/** Scan forward from the `(` to its match, ignoring parens inside strings and comments. */
function argumentAt(source: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

export function execAsyncCallsIn(source: string): ExecAsyncCall[] {
  const calls: ExecAsyncCall[] = [];
  EXEC_ASYNC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXEC_ASYNC.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    const argument = argumentAt(source, open);
    const line = source.slice(0, match.index).split('\n').length;
    if (argument === null) {
      calls.push({ index: match.index, line, argument: '', reason: 'unbalanced parentheses' });
      continue;
    }
    const reason = classifyArgument(argument);
    calls.push({ index: match.index, line, argument, reason: reason ?? '' });
  }
  return calls;
}

export function execAsyncViolationsIn(source: string): ExecAsyncCall[] {
  return execAsyncCallsIn(source).filter((call) => call.reason !== '');
}

/** Extensions the gate reads. A `.ts` rule that skips `.mjs` is a rule with a hole. */
export const EXEC_GATE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

/** Directory NAMES the walk never enters, wherever they appear. */
export const EXEC_GATE_SKIP_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.expo',
  'artifacts',
] as const;

/**
 * Repo-relative PATHS the walk never enters: the two generated native trees (INV-PLAT-02).
 * By path, never by the names `ios`/`android` — see the header.
 */
export const EXEC_GATE_SKIP_PATHS: readonly string[] = [
  'apps/mobile/ios',
  'apps/mobile/android',
] as const;

/**
 * Repo-relative paths that legitimately contain the token: this detector and its test,
 * whose positive controls are strings shaped exactly like violations.
 */
export const EXEC_GATE_SELF_PATHS: readonly string[] = [
  'packages/core/src/security/exec-gate.ts',
  'packages/core/src/security/exec-gate.test.ts',
] as const;

/** The floor on files scanned. A scan that finds nothing passes for free. */
export const EXEC_GATE_MIN_FILES = 25;
