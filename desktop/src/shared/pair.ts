// pair.ts — a half-frame pair (the Mac's Model/HalfFramePair.swift): two
// neighbouring half frames on one piece of 135. The pair is a file
// (`<app data>/Pairs/*.spektrapair`, the Mac's JSON) and that file's path is
// the pair's identity wherever a frame's path is one: the filmstrip, the
// selection, the sidecar. The host composes it (`open_pair`); the look —
// stock, paper, enlarger, Film Edge — is the pair's own sidecar.

export const PAIR_EXTENSION = 'spektrapair';
export const PAIR_AREA = 'Pairs';
export const PAIR_SPACING_RANGE: [number, number] = [0.5, 2];
export const PAIR_SCALE_RANGE: [number, number] = [1, 4];
export const HOLE_MM = { along: 18, across: 24 };

/** Where the picture sits under its hole: `scale` 1 fills it, x/y move it across the slack. */
export interface PairPlacement {
  scale: number;
  x: number;
  y: number;
  quarterTurns: number;
}
export const PLACEMENT_DEFAULT: PairPlacement = { scale: 1, x: 0, y: 0, quarterTurns: 0 };

export interface PairHole {
  path: string;
  placement: PairPlacement;
  /** This hole's exposure on the film, stops, on top of its own meter. */
  exposureEV: number;
  /** Keys the port does not model (decode, geometry, print trims, …), carried through. */
  raw?: Record<string, unknown>;
}

export interface HalfFramePair {
  schemaVersion: number;
  folder: string;
  left: PairHole | null;
  right: PairHole | null;
  spacingMM: number;
  onStrip: boolean;
  turned: boolean;
}

export type PairSide = 'left' | 'right';

export function isPairPath(path: string | null | undefined): boolean {
  return !!path && path.toLowerCase().endsWith('.' + PAIR_EXTENSION);
}

export function newHole(path: string): PairHole {
  return { path, placement: { ...PLACEMENT_DEFAULT }, exposureEV: 0 };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function decodeHole(v: unknown): PairHole | null {
  const o = obj(v);
  if (!o || typeof o.path !== 'string') return null;
  const p = obj(o.placement) ?? {};
  return {
    path: o.path,
    placement: { scale: num(p.scale, 1), x: num(p.x, 0), y: num(p.y, 0), quarterTurns: Math.round(num(p.quarterTurns, 0)) },
    exposureEV: num(o.exposureEV, 0),
    raw: o,
  };
}

export function decodePair(v: unknown): HalfFramePair | null {
  const o = obj(v);
  if (!o || typeof o.folder !== 'string') return null;
  return {
    schemaVersion: num(o.schemaVersion, 1),
    folder: o.folder,
    left: decodeHole(o.left),
    right: decodeHole(o.right),
    spacingMM: num(o.spacingMM, 1),
    onStrip: o.onStrip === true,
    turned: o.turned === true,
  };
}

function encodeHole(h: PairHole | null): Record<string, unknown> | undefined {
  if (!h) return undefined;
  return { ...(h.raw ?? {}), path: h.path, placement: { ...h.placement }, exposureEV: h.exposureEV };
}

export function encodePair(p: HalfFramePair): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schemaVersion: p.schemaVersion,
    folder: p.folder,
    spacingMM: p.spacingMM,
    onStrip: p.onStrip,
    turned: p.turned,
  };
  const l = encodeHole(p.left);
  const r = encodeHole(p.right);
  if (l) out.left = l;
  if (r) out.right = r;
  return out;
}

/** The gap the layout uses: the camera's (1 mm) on a strip, the user's otherwise. */
export function effectiveSpacing(p: HalfFramePair): number {
  return p.onStrip ? 1 : Math.min(Math.max(p.spacingMM, PAIR_SPACING_RANGE[0]), PAIR_SPACING_RANGE[1]);
}

/** The host's `open_pair` request for this pair. */
export function openPairRequest(p: HalfFramePair) {
  const hole = (h: PairHole | null) =>
    h && {
      path: h.path,
      exposure_ev: h.exposureEV,
      placement: { scale: h.placement.scale, x: h.placement.x, y: h.placement.y, quarter_turns: h.placement.quarterTurns },
    };
  return { holes: [hole(p.left), hole(p.right)], spacing_mm: effectiveSpacing(p), turned: p.turned };
}

/** A store name for a new pair of `folder`: `pair-<tag>-<n>.spektrapair`, the first free `n`. */
export function newPairName(folder: string, taken: readonly string[]): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(folder)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  const tag = (h & 0xffffffn).toString(16).padStart(6, '0');
  const names = new Set(taken.map((t) => t.split(/[\\/]/).pop()));
  for (let n = 1; ; n++) {
    const name = `pair-${tag}-${n}.${PAIR_EXTENSION}`;
    if (!names.has(name)) return name;
  }
}

/** A pair's name as the filmstrip shows it: the two frames' names. */
export function pairLabel(p: HalfFramePair): string {
  const base = (h: PairHole | null) => (h ? h.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '') : '—');
  return `${base(p.left)} + ${base(p.right)}`;
}
