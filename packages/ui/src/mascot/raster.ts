/**
 * A tiny, dependency-free rasteriser for the *subset* of SVG the Freelingo art is
 * authored in, plus a PNG encoder.
 *
 * Why this exists rather than a library or `rsvg-convert`:
 *
 * The mascot's hard requirement (deep/08 §10) is that "every illustration must be
 * readable at 64 px (widget) and 240 px (ceremony) from the same source". The only way
 * to hold that is a test that renders the real source at 64 px and measures it, and that
 * test has to run on a Linux CI box with nothing installed. A native rasteriser would be
 * a system dependency in `ci.yml`; a rendering library would be a dependency change, and
 * dependency lists belong to the phase's deps task. So the renderer is 400 lines of
 * arithmetic here, and `raster.test.ts` checks it against shapes whose exact coverage is
 * known in closed form.
 *
 * This is a *test and build* tool. It is not exported from `@freelingo/ui` and nothing in
 * the app renders through it — the app draws poses in Skia behind `MascotRenderer`
 * (deep/08 §10, D12).
 *
 * The supported subset, which is also the authoring contract for everything in `art/`:
 *
 * - `<svg viewBox="0 0 w h">` — required; width/height attributes are ignored.
 * - `<g>` with `fill`, `stroke`, `stroke-width`, `stroke-linecap`, `transform`.
 * - `<path d>`, `<circle>`, `<ellipse>`, `<rect>` (with `rx`), `<line>`, `<polygon>`,
 *   `<polyline>`.
 * - `transform`: `translate`, `rotate` (with or without a centre), `scale`, `matrix`.
 * - Path commands `M m L l H h V v C c S s Q q T t Z z`. **No arcs**: `A` is rejected
 *   loudly rather than skipped, because a silently dropped arc is a silently wrong test.
 * - Fills are solid `#rgb`/`#rrggbb` or `none`. No gradients — the extraction measured
 *   zero gradients in the product UI (deep/08 §10) and the renderer enforces it.
 *
 * Anything outside the subset throws. A pose that cannot be rendered here is a pose the
 * legibility floor cannot measure, which is the failure this file exists to prevent.
 */

import { deflateSync } from 'node:zlib';

// --- geometry ------------------------------------------------------------------------

/** Row-major affine transform: `[a, b, c, d, e, f]` as in SVG's `matrix()`. */
export type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** A closed ring of device-space points, flat as `[x0, y0, x1, y1, …]`. */
type Ring = number[];

// --- colour --------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

export function parseColour(value: string): Rgb | null {
  const text = value.trim().toLowerCase();
  if (text === 'none' || text === 'transparent' || text === '') return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (!hex) {
    throw new Error(
      `unsupported colour ${JSON.stringify(value)}: art/ is authored in solid #rgb or ` +
        '#rrggbb only (deep/08 §10: zero gradients, solid fills)',
    );
  }
  const digits = hex[1] as string;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((c) => c + c)
          .join('')
      : digits;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// --- a bitmap ------------------------------------------------------------------------

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGBA8, length `width * height * 4`, straight (non-premultiplied) alpha. */
  readonly pixels: Uint8ClampedArray;
}

function blankBitmap(width: number, height: number): Bitmap {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

/**
 * Composite one solid colour into `bitmap` through a per-pixel coverage mask.
 *
 * Source-over on straight alpha. The art is opaque and drawn back to front, so this is
 * only ever blending an edge pixel against what is already there.
 */
function composite(bitmap: Bitmap, coverage: Float64Array, [r, g, b]: Rgb): void {
  const { pixels } = bitmap;
  for (let i = 0; i < coverage.length; i += 1) {
    const a = Math.min(1, Math.max(0, coverage[i] as number));
    if (a <= 0) continue;
    const o = i * 4;
    const da = (pixels[o + 3] as number) / 255;
    const outA = a + da * (1 - a);
    if (outA <= 0) continue;
    for (let c = 0; c < 3; c += 1) {
      const src = c === 0 ? r : c === 1 ? g : b;
      const dst = pixels[o + c] as number;
      pixels[o + c] = (src * a + dst * da * (1 - a)) / outA;
    }
    pixels[o + 3] = outA * 255;
  }
}

// --- scanline fill -------------------------------------------------------------------

const SUBSAMPLES = 8;
/** Vertical supersampling. Horizontal coverage is exact (span/pixel overlap), so 8 rows
 * per pixel is already finer than the 1/255 an 8-bit channel can record. */

/**
 * Non-zero-winding fill of a set of rings into a coverage mask.
 *
 * Every ring the renderer produces (including stroke stamps) is emitted with the same
 * orientation, so non-zero winding is a union and two overlapping stamps never punch a
 * hole in each other.
 */
function rasteriseRings(rings: readonly Ring[], width: number, height: number): Float64Array {
  const coverage = new Float64Array(width * height);
  if (rings.length === 0) return coverage;

  type Edge = { x0: number; y0: number; x1: number; y1: number; dir: number };
  const edges: Edge[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      const ax = ring[i * 2] as number;
      const ay = ring[i * 2 + 1] as number;
      const bx = ring[j * 2] as number;
      const by = ring[j * 2 + 1] as number;
      if (ay === by) continue;
      edges.push(
        ay < by
          ? { x0: ax, y0: ay, x1: bx, y1: by, dir: 1 }
          : { x0: bx, y0: by, x1: ax, y1: ay, dir: -1 },
      );
      minY = Math.min(minY, ay, by);
      maxY = Math.max(maxY, ay, by);
    }
  }
  if (edges.length === 0) return coverage;

  const firstRow = Math.max(0, Math.floor(minY));
  const lastRow = Math.min(height - 1, Math.ceil(maxY));
  const weight = 1 / SUBSAMPLES;
  const crossings: { x: number; dir: number }[] = [];

  for (let py = firstRow; py <= lastRow; py += 1) {
    const rowBase = py * width;
    for (let s = 0; s < SUBSAMPLES; s += 1) {
      const y = py + (s + 0.5) / SUBSAMPLES;
      crossings.length = 0;
      for (const e of edges) {
        if (y < e.y0 || y >= e.y1) continue;
        crossings.push({ x: e.x0 + ((y - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), dir: e.dir });
      }
      if (crossings.length < 2) continue;
      crossings.sort((p, q) => p.x - q.x);
      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i += 1) {
        winding += (crossings[i] as { dir: number }).dir;
        if (winding === 0) continue;
        const xa = Math.max(0, (crossings[i] as { x: number }).x);
        const xb = Math.min(width, (crossings[i + 1] as { x: number }).x);
        if (xb <= xa) continue;
        const pxA = Math.floor(xa);
        const pxB = Math.min(width - 1, Math.floor(xb - 1e-9));
        if (pxA === pxB) {
          coverage[rowBase + pxA] = (coverage[rowBase + pxA] as number) + (xb - xa) * weight;
          continue;
        }
        coverage[rowBase + pxA] = (coverage[rowBase + pxA] as number) + (pxA + 1 - xa) * weight;
        for (let px = pxA + 1; px < pxB; px += 1) {
          coverage[rowBase + px] = (coverage[rowBase + px] as number) + weight;
        }
        coverage[rowBase + pxB] = (coverage[rowBase + pxB] as number) + (xb - pxB) * weight;
      }
    }
  }
  return coverage;
}

// --- path parsing --------------------------------------------------------------------

const BEZIER_STEPS_MIN = 6;
const BEZIER_STEPS_MAX = 96;

function bezierSteps(points: readonly number[]): number {
  let length = 0;
  for (let i = 2; i < points.length; i += 2) {
    length += Math.hypot(
      (points[i] as number) - (points[i - 2] as number),
      (points[i + 1] as number) - (points[i - 1] as number),
    );
  }
  return Math.min(BEZIER_STEPS_MAX, Math.max(BEZIER_STEPS_MIN, Math.ceil(length / 1.2)));
}

/** Flatten a path's `d` into subpaths of device-space points. */
function flattenPath(d: string, m: Matrix): { points: number[]; closed: boolean }[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const subpaths: { points: number[]; closed: boolean }[] = [];
  let current: { points: number[]; closed: boolean } | null = null;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let lastCubicCtrl: [number, number] | null = null;
  let lastQuadCtrl: [number, number] | null = null;
  let i = 0;
  let command = '';

  const push = (x: number, y: number): void => {
    const [dx, dy] = apply(m, x, y);
    (current as { points: number[] }).points.push(dx, dy);
  };
  const open = (x: number, y: number): void => {
    current = { points: [], closed: false };
    subpaths.push(current);
    push(x, y);
    startX = x;
    startY = y;
  };
  const num = (): number => {
    const value = Number.parseFloat(tokens[i] as string);
    i += 1;
    if (!Number.isFinite(value)) throw new Error(`bad number in path data near token ${i}`);
    return value;
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
    const steps = bezierSteps([cx, cy, x1, y1, x2, y2, x, y]);
    for (let s = 1; s <= steps; s += 1) {
      const u = s / steps;
      const v = 1 - u;
      push(
        v * v * v * cx + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x,
        v * v * v * cy + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y,
      );
    }
    lastCubicCtrl = [x2, y2];
    lastQuadCtrl = null;
    cx = x;
    cy = y;
  };
  const quad = (x1: number, y1: number, x: number, y: number): void => {
    const steps = bezierSteps([cx, cy, x1, y1, x, y]);
    for (let s = 1; s <= steps; s += 1) {
      const u = s / steps;
      const v = 1 - u;
      push(v * v * cx + 2 * v * u * x1 + u * u * x, v * v * cy + 2 * v * u * y1 + u * u * y);
    }
    lastQuadCtrl = [x1, y1];
    lastCubicCtrl = null;
    cx = x;
    cy = y;
  };

  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (/[A-Za-z]/.test(token)) {
      command = token;
      i += 1;
      if (command === 'A' || command === 'a') {
        throw new Error('elliptical arcs are outside the authoring subset; use C/Q instead');
      }
      if (command === 'Z' || command === 'z') {
        if (current) (current as { closed: boolean }).closed = true;
        cx = startX;
        cy = startY;
        continue;
      }
    }
    const relative = command === command.toLowerCase();
    const ox = relative ? cx : 0;
    const oy = relative ? cy : 0;
    switch (command.toUpperCase()) {
      case 'M': {
        const x = num() + ox;
        const y = num() + oy;
        open(x, y);
        cx = x;
        cy = y;
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        const x = num() + ox;
        const y = num() + oy;
        push(x, y);
        cx = x;
        cy = y;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case 'H': {
        const x = num() + ox;
        push(x, cy);
        cx = x;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case 'V': {
        const y = num() + oy;
        push(cx, y);
        cy = y;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case 'C':
        cubic(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy);
        break;
      case 'S': {
        const [rx, ry]: [number, number] = lastCubicCtrl ?? [cx, cy];
        cubic(2 * cx - rx, 2 * cy - ry, num() + ox, num() + oy, num() + ox, num() + oy);
        break;
      }
      case 'Q':
        quad(num() + ox, num() + oy, num() + ox, num() + oy);
        break;
      case 'T': {
        const [rx, ry]: [number, number] = lastQuadCtrl ?? [cx, cy];
        quad(2 * cx - rx, 2 * cy - ry, num() + ox, num() + oy);
        break;
      }
      default:
        throw new Error(`unsupported path command ${JSON.stringify(command)}`);
    }
  }
  return subpaths.filter((s) => s.points.length >= 4);
}

// --- primitives ----------------------------------------------------------------------

const CIRCLE_SEGMENTS = 48;

function ellipseRing(cx: number, cy: number, rx: number, ry: number, m: Matrix): Ring {
  const ring: Ring = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i += 1) {
    const a = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    const [x, y] = apply(m, cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    ring.push(x, y);
  }
  return ring;
}

function rectRing(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number,
  m: Matrix,
): Ring {
  const r = Math.min(rx, w / 2);
  const s = Math.min(ry, h / 2);
  if (r <= 0 || s <= 0) {
    return [
      ...apply(m, x, y),
      ...apply(m, x + w, y),
      ...apply(m, x + w, y + h),
      ...apply(m, x, y + h),
    ];
  }
  const ring: Ring = [];
  const corners: [number, number, number][] = [
    [x + w - r, y + s, -Math.PI / 2],
    [x + w - r, y + h - s, 0],
    [x + r, y + h - s, Math.PI / 2],
    [x + r, y + s, Math.PI],
  ];
  for (const [ccx, ccy, from] of corners) {
    const steps = CIRCLE_SEGMENTS / 4;
    for (let i = 0; i <= steps; i += 1) {
      const a = from + (Math.PI / 2) * (i / steps);
      ring.push(...apply(m, ccx + r * Math.cos(a), ccy + s * Math.sin(a)));
    }
  }
  return ring;
}

/** Twice the signed area of a ring; negative means clockwise in screen coordinates. */
function signedArea(ring: Ring): number {
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    sum +=
      (ring[i * 2] as number) * (ring[j * 2 + 1] as number) -
      (ring[j * 2] as number) * (ring[i * 2 + 1] as number);
  }
  return sum;
}

/** Reverse a ring in place so every stamp shares one winding direction. */
function orient(ring: Ring): Ring {
  if (signedArea(ring) >= 0) return ring;
  const out: Ring = [];
  for (let i = ring.length / 2 - 1; i >= 0; i -= 1) {
    out.push(ring[i * 2] as number, ring[i * 2 + 1] as number);
  }
  return out;
}

/**
 * Turn a flattened polyline into fillable rings: one quad per segment plus a disc at each
 * joint. That is `stroke-linejoin: round` / `stroke-linecap: round`, which is the only
 * join the art uses.
 *
 * Every ring is forced to one winding direction before it is returned, and that is not a
 * tidiness measure. A segment quad is built as `[a+n, b+n, b-n, a-n]`, whose orientation
 * follows the direction of `b - a`: a polyline that turns a corner — a check mark, say —
 * emits one quad clockwise and the next anticlockwise, and under non-zero winding the
 * overlap at the joint *cancels to zero* and punches a hole through the stroke. The
 * rendered tick on the completed-node badge came out as a broken scribble until this was
 * added; nothing in the metrics would have caught it, only looking at the PNG did.
 */
function strokeRings(points: readonly number[], closed: boolean, width: number): Ring[] {
  const half = width / 2;
  const rings: Ring[] = [];
  const n = points.length / 2;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % n;
    const ax = points[i * 2] as number;
    const ay = points[i * 2 + 1] as number;
    const bx = points[j * 2] as number;
    const by = points[j * 2 + 1] as number;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    rings.push(orient([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]));
  }
  for (let i = 0; i < n; i += 1) {
    if (!closed && width <= 0) break;
    const ring: Ring = [];
    const px = points[i * 2] as number;
    const py = points[i * 2 + 1] as number;
    for (let k = 0; k < CIRCLE_SEGMENTS / 2; k += 1) {
      const a = (2 * Math.PI * k) / (CIRCLE_SEGMENTS / 2);
      ring.push(px + half * Math.cos(a), py + half * Math.sin(a));
    }
    rings.push(orient(ring));
  }
  return rings;
}

// --- transform parsing ---------------------------------------------------------------

function parseTransform(value: string): Matrix {
  let m = IDENTITY;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const args = (match[2] as string)
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const name = (match[1] as string).toLowerCase();
    if (name === 'translate') {
      m = multiply(m, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]);
    } else if (name === 'scale') {
      const sx = args[0] ?? 1;
      m = multiply(m, [sx, 0, 0, args[1] ?? sx, 0, 0]);
    } else if (name === 'rotate') {
      const a = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      m = multiply(m, [1, 0, 0, 1, cx, cy]);
      m = multiply(m, [cos, sin, -sin, cos, 0, 0]);
      m = multiply(m, [1, 0, 0, 1, -cx, -cy]);
    } else if (name === 'matrix') {
      m = multiply(m, [
        args[0] ?? 1,
        args[1] ?? 0,
        args[2] ?? 0,
        args[3] ?? 1,
        args[4] ?? 0,
        args[5] ?? 0,
      ]);
    } else {
      throw new Error(`unsupported transform ${JSON.stringify(name)}`);
    }
  }
  return m;
}

// --- the document walk ---------------------------------------------------------------

interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
}

function tokeniseTags(svg: string): Tag[] {
  const withoutComments = svg.replace(/<!--[\s\S]*?-->/g, '');
  const tags: Tag[] = [];
  const re = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutComments)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(match[3] as string)) !== null) {
      attrs[a[1] as string] = a[2] as string;
    }
    tags.push({
      name: (match[2] as string).toLowerCase(),
      attrs,
      selfClosing: match[4] === '/',
      closing: match[1] === '/',
    });
  }
  return tags;
}

function attrNumber(attrs: Record<string, string>, key: string, fallback = 0): number {
  const raw = attrs[key];
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

export interface RenderResult extends Bitmap {
  /** Every distinct solid fill/stroke colour the document actually painted, in document
   * order of first use. This is the palette the legibility floor measures against. */
  readonly palette: readonly string[];
  readonly viewBox: readonly [number, number, number, number];
}

/**
 * Render an SVG string on a transparent ground, scaled so its longest viewBox side is
 * `size` device pixels. Square sources (the mascot, cast and node art) therefore render
 * `size × size`; a 3:4 story cover renders `0.75·size × size`.
 */
export function renderSvg(svg: string, size: number): RenderResult {
  const tags = tokeniseTags(svg);
  const root = tags.find((t) => t.name === 'svg' && !t.closing);
  if (!root) throw new Error('no <svg> element');
  const viewBoxRaw = root.attrs['viewBox'];
  if (!viewBoxRaw) throw new Error('<svg> has no viewBox; art/ requires one');
  const vb = viewBoxRaw.split(/[\s,]+/).map(Number) as [number, number, number, number];
  const [vx, vy, vw, vh] = vb;
  if (!(vw > 0 && vh > 0)) throw new Error(`viewBox must have positive extent, got ${vw}×${vh}`);

  const scale = size / Math.max(vw, vh);
  const width = Math.round(vw * scale);
  const height = Math.round(vh * scale);
  const base: Matrix = [scale, 0, 0, scale, -vx * scale, -vy * scale];
  const bitmap = blankBitmap(width, height);
  const palette: string[] = [];

  const styleStack: Style[] = [{ fill: '#000000', stroke: 'none', strokeWidth: 1 }];
  const matrixStack: Matrix[] = [base];

  const currentStyle = (): Style => styleStack[styleStack.length - 1] as Style;
  const currentMatrix = (): Matrix => matrixStack[matrixStack.length - 1] as Matrix;

  const inherit = (attrs: Record<string, string>): { style: Style; matrix: Matrix } => {
    const parent = currentStyle();
    return {
      style: {
        fill: attrs['fill'] ?? parent.fill,
        stroke: attrs['stroke'] ?? parent.stroke,
        strokeWidth: attrs['stroke-width']
          ? Number.parseFloat(attrs['stroke-width'])
          : parent.strokeWidth,
      },
      matrix: attrs['transform']
        ? multiply(currentMatrix(), parseTransform(attrs['transform']))
        : currentMatrix(),
    };
  };

  const paint = (rings: readonly Ring[], colour: Rgb): void => {
    composite(bitmap, rasteriseRings(rings, width, height), colour);
    const hex = toHex(colour);
    if (!palette.includes(hex)) palette.push(hex);
  };

  const draw = (tag: Tag): void => {
    const { style, matrix } = inherit(tag.attrs);
    const fill = parseColour(style.fill);
    const stroke = parseColour(style.stroke);
    // Uniform-scale only: the art uses translate/rotate/uniform scale, so one number is
    // the honest device-space stroke width.
    const scaleX = Math.hypot(matrix[0], matrix[1]);
    const strokeWidth = style.strokeWidth * scaleX;

    let fillRings: Ring[] = [];
    let outline: { points: number[]; closed: boolean }[] = [];

    switch (tag.name) {
      case 'path': {
        const subpaths = flattenPath(tag.attrs['d'] ?? '', matrix);
        fillRings = subpaths.map((s) => s.points);
        outline = subpaths;
        break;
      }
      case 'circle': {
        const r = attrNumber(tag.attrs, 'r');
        const ring = ellipseRing(attrNumber(tag.attrs, 'cx'), attrNumber(tag.attrs, 'cy'), r, r, matrix); // prettier-ignore
        fillRings = [ring];
        outline = [{ points: ring, closed: true }];
        break;
      }
      case 'ellipse': {
        const ring = ellipseRing(
          attrNumber(tag.attrs, 'cx'),
          attrNumber(tag.attrs, 'cy'),
          attrNumber(tag.attrs, 'rx'),
          attrNumber(tag.attrs, 'ry'),
          matrix,
        );
        fillRings = [ring];
        outline = [{ points: ring, closed: true }];
        break;
      }
      case 'rect': {
        const rx = attrNumber(tag.attrs, 'rx', 0);
        const ring = rectRing(
          attrNumber(tag.attrs, 'x'),
          attrNumber(tag.attrs, 'y'),
          attrNumber(tag.attrs, 'width'),
          attrNumber(tag.attrs, 'height'),
          rx,
          attrNumber(tag.attrs, 'ry', rx),
          matrix,
        );
        fillRings = [ring];
        outline = [{ points: ring, closed: true }];
        break;
      }
      case 'line': {
        const points = [
          ...apply(matrix, attrNumber(tag.attrs, 'x1'), attrNumber(tag.attrs, 'y1')),
          ...apply(matrix, attrNumber(tag.attrs, 'x2'), attrNumber(tag.attrs, 'y2')),
        ];
        outline = [{ points, closed: false }];
        break;
      }
      case 'polygon':
      case 'polyline': {
        const raw = (tag.attrs['points'] ?? '')
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        const points: number[] = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
          points.push(...apply(matrix, raw[i] as number, raw[i + 1] as number));
        }
        if (tag.name === 'polygon') fillRings = [points];
        outline = [{ points, closed: tag.name === 'polygon' }];
        break;
      }
      default:
        throw new Error(`unsupported element <${tag.name}>`);
    }

    if (fill && fillRings.length > 0) paint(fillRings, fill);
    if (stroke && strokeWidth > 0) {
      const rings = outline.flatMap((s) => strokeRings(s.points, s.closed, strokeWidth));
      if (rings.length > 0) paint(rings, stroke);
    }
  };

  const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polygon', 'polyline']);
  for (const tag of tags) {
    if (tag.name === 'svg' || tag.name === 'title' || tag.name === 'desc') {
      continue;
    }
    if (tag.name === 'g') {
      if (tag.closing) {
        styleStack.pop();
        matrixStack.pop();
      } else {
        const { style, matrix } = inherit(tag.attrs);
        styleStack.push(style);
        matrixStack.push(matrix);
        if (tag.selfClosing) {
          styleStack.pop();
          matrixStack.pop();
        }
      }
      continue;
    }
    if (!SHAPES.has(tag.name)) {
      throw new Error(`unsupported element <${tag.name}> in art source`);
    }
    if (!tag.closing) draw(tag);
  }

  return { ...bitmap, palette, viewBox: vb };
}

// --- PNG -----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = ((CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode a bitmap as an 8-bit RGBA PNG. */
export function encodePng(bitmap: Bitmap): Uint8Array {
  const { width, height, pixels } = bitmap;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
