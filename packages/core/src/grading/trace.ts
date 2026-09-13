import { TRACE_POLICY } from './trace-config.js';
export interface TracePoint {
  readonly x: number;
  readonly y: number;
}
export interface TraceStroke {
  readonly points: readonly TracePoint[];
}
/** stroke_paths_json v1. Paths are explicit, ordered source-derived polylines in viewBox units. */
export interface TraceDefinition {
  readonly version: 1;
  readonly source: string;
  readonly viewBox: { readonly width: number; readonly height: number };
  readonly strokes: readonly TraceStroke[];
}
export interface TraceAttempt {
  readonly id: string;
  readonly points: readonly TracePoint[];
}
export interface TraceRuntime {
  readonly attempts: readonly TraceAttempt[];
  readonly accepted: number;
  readonly rejections: number;
  readonly complete: boolean;
}
export const TRACE_RUNTIME_KEY = 'traceRuntime';
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function tracePoints(value: unknown, minimum: 1 | 2 = 2): value is readonly TracePoint[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= TRACE_POLICY.maximumInputPoints &&
    value.every(
      (p: unknown) =>
        object(p) &&
        typeof p['x'] === 'number' &&
        typeof p['y'] === 'number' &&
        Number.isFinite(p['x']) &&
        Number.isFinite(p['y']),
    )
  );
}
const distance = (a: TracePoint, b: TracePoint) => Math.hypot(a.x - b.x, a.y - b.y);
function length(points: readonly TracePoint[]): number {
  return points.slice(1).reduce((sum, p, i) => sum + distance(p, points[i]!), 0);
}
export function validTraceDefinition(value: unknown): value is TraceDefinition {
  if (
    !object(value) ||
    value['version'] !== 1 ||
    typeof value['source'] !== 'string' ||
    value['source'].trim() === '' ||
    !object(value['viewBox'])
  )
    return false;
  const box = value['viewBox'];
  if (
    typeof box['width'] !== 'number' ||
    typeof box['height'] !== 'number' ||
    !Number.isFinite(box['width']) ||
    !Number.isFinite(box['height']) ||
    box['width'] <= 0 ||
    box['height'] <= 0
  )
    return false;
  const width = box['width'],
    height = box['height'];
  const strokes = value['strokes'];
  return (
    Array.isArray(strokes) &&
    strokes.length > 0 &&
    strokes.length <= TRACE_POLICY.maximumStrokes &&
    strokes.every(
      (s: unknown) =>
        object(s) &&
        tracePoints(s['points']) &&
        s['points'].every((p) => p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height) &&
        length(s['points']) > 0,
    )
  );
}
export function decodeTraceDefinition(
  source: string | null,
  raw: string | null,
): TraceDefinition | null {
  if (source === null || source.trim() === '' || raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value)) return null;
    const result = { ...value, source };
    return validTraceDefinition(result) ? result : null;
  } catch {
    return null;
  }
}
function sample(points: readonly TracePoint[]): readonly TracePoint[] {
  const total = length(points);
  const out: TracePoint[] = [];
  let cursor = 1,
    previous = 0;
  for (let n = 0; n < TRACE_POLICY.samples; n++) {
    const target = (total * n) / (TRACE_POLICY.samples - 1);
    while (
      cursor < points.length - 1 &&
      previous + distance(points[cursor - 1]!, points[cursor]!) < target
    ) {
      previous += distance(points[cursor - 1]!, points[cursor]!);
      cursor++;
    }
    const a = points[cursor - 1]!,
      b = points[cursor]!;
    const segment = distance(a, b);
    const t = segment === 0 ? 0 : Math.max(0, Math.min(1, (target - previous) / segment));
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}
/** Arc-length correspondence compares ordered geometry, so reversing even a closed path fails. */
export function evaluateStroke(
  definition: TraceDefinition,
  index: number,
  input: readonly TracePoint[],
): boolean {
  if (
    !validTraceDefinition(definition) ||
    !Number.isInteger(index) ||
    index < 0 ||
    !tracePoints(input)
  )
    return false;
  const expected = definition.strokes[index]?.points;
  if (expected === undefined) return false;
  const diagonal = Math.hypot(definition.viewBox.width, definition.viewBox.height);
  if (length(input) < diagonal * TRACE_POLICY.minimumLengthDiagonalFraction) return false;
  if (
    distance(input[0]!, expected[0]!) > diagonal * TRACE_POLICY.endpointDiagonalFraction ||
    distance(input.at(-1)!, expected.at(-1)!) > diagonal * TRACE_POLICY.endpointDiagonalFraction
  )
    return false;
  const actual = sample(input),
    target = sample(expected);
  const errors = actual.map((p, i) => distance(p, target[i]!) / diagonal);
  return (
    Math.max(...errors) <= TRACE_POLICY.maximumDiagonalFraction &&
    errors.reduce((sum, e) => sum + e, 0) / errors.length <= TRACE_POLICY.meanDiagonalFraction
  );
}
/** Recompute every acceptance from source geometry; serialized counters are never proof. */
export function traceRuntime(
  definition: TraceDefinition,
  partial: Readonly<Record<string, unknown>>,
): TraceRuntime | null {
  if (!validTraceDefinition(definition)) return null;
  const raw = partial[TRACE_RUNTIME_KEY];
  if (raw === undefined) return { attempts: [], accepted: 0, rejections: 0, complete: false };
  if (!object(raw) || !Array.isArray(raw['attempts'])) return null;
  const attempts: TraceAttempt[] = [];
  const ids = new Set<string>();
  let accepted = 0,
    rejections = 0;
  for (const value of raw['attempts'] as unknown[]) {
    if (
      !object(value) ||
      typeof value['id'] !== 'string' ||
      value['id'] === '' ||
      ids.has(value['id']) ||
      !tracePoints(value['points']) ||
      accepted === definition.strokes.length
    )
      return null;
    const attempt = { id: value['id'], points: value['points'] };
    ids.add(attempt.id);
    attempts.push(attempt);
    if (evaluateStroke(definition, accepted, attempt.points)) accepted++;
    else rejections++;
  }
  return { attempts, accepted, rejections, complete: accepted === definition.strokes.length };
}
export function preserveTraceRuntime(
  current: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result = { ...next };
  delete result[TRACE_RUNTIME_KEY];
  if (current[TRACE_RUNTIME_KEY] !== undefined)
    result[TRACE_RUNTIME_KEY] = current[TRACE_RUNTIME_KEY];
  return result;
}
