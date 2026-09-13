/** S138–S140. A route describes a landing surface, never a session mutation.
 * Identifier bound is a transport policy adopted 2026-09-13, not an ID format. */
export const WIDGET_ROUTE_POLICY = {
  maximumIdentifierCodeUnits: 1024,
  maximumUrlCodeUnits: 8192,
} as const;
export type WidgetRoute =
  | { readonly surface: 'open' }
  | { readonly surface: 'resume' | 'practice'; readonly courseId: string }
  | { readonly surface: 'path'; readonly courseId: string; readonly nodeId: string | null };

export function validWidgetIdentifier(v: unknown): v is string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > WIDGET_ROUTE_POLICY.maximumIdentifierCodeUnits ||
    Array.from(v).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    return false;
  try {
    encodeURIComponent(v);
    return true;
  } catch {
    return false;
  }
}

/** Reject duplicate fields and hidden URL components; never consult active-course state. */
export function parseWidgetRoute(raw: string): WidgetRoute | null {
  if (raw.length > WIDGET_ROUTE_POLICY.maximumUrlCodeUnits || /%(?![\da-f]{2})/iu.test(raw))
    return null;
  try {
    const url = new URL(raw);
    // URLSearchParams repairs invalid UTF-8; a route must reject, not rename, its ID.
    decodeURIComponent(url.search.replace(/\+/gu, ' '));
    if (
      url.protocol !== 'freelingo:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname ||
      url.hash
    )
      return null;
    const surface = url.hostname;
    const entries = [...url.searchParams];
    if (surface === 'open') return entries.length === 0 ? { surface } : null;
    if (!['path', 'resume', 'practice'].includes(surface)) return null;
    const allowed = surface === 'path' ? ['course', 'node'] : ['course'];
    if (
      entries.some(([key]) => !allowed.includes(key)) ||
      new Set(entries.map(([key]) => key)).size !== entries.length
    )
      return null;
    const courseId = url.searchParams.get('course');
    if (!validWidgetIdentifier(courseId)) return null;
    if (surface === 'path') {
      const nodeId = url.searchParams.get('node');
      return nodeId === null || validWidgetIdentifier(nodeId)
        ? { surface, courseId, nodeId }
        : null;
    }
    return { surface: surface as 'resume' | 'practice', courseId };
  } catch {
    return null;
  }
}
