// filmEdge.ts — what the session fills in on the frame's behalf for RFC-032's
// film edge and RFC-031's date back (the Mac's `Session.resolvedFilmEdge`,
// Session+FilmEdge.swift): the stock's own edge print, the gate's f-number,
// the date and the shooting data from EXIF, and the camera the date back is
// on. A pure function of the frame, its metadata and its stock, so resolving
// twice is resolving once.

import type { FileMetadata } from './protocol';
import { type FilmParams, FILM_EDGE_GATE_MM, filmEdgeOn, type FeatureGate, ALL_FEATURES } from './params';

/** The film a format runs on (half frame and XPan are cameras for 135 film). */
export function gaugeOf(format: string): '135' | '120' {
  return format === '135' || format === '135_half' || format === '135_xpan' ? '135' : '120';
}

/**
 * The stock's own edge print, as measured on the owner's strips (the Mac's
 * `edgeText(for:gauge:)`); a stock with no reference prints its name.
 */
const OWN_EDGE_TEXT: Record<string, [string, string]> = {
  kodak_gold_200: ['KODAK GB 200-7', 'KODAK 200'],
  kodak_portra_800: ['KODAK PORTRA 800-3', 'KODAK PORTRA 800'],
  kodak_portra_800_push1: ['KODAK PORTRA 800-3', 'KODAK PORTRA 800'],
  kodak_portra_800_push2: ['KODAK PORTRA 800-3', 'KODAK PORTRA 800'],
  kodak_ultramax_400: ['KODAK GC 400', 'KODAK GC 400'],
  kodak_ektachrome_100: ['KODAK E100', 'KODAK E100'],
  fujifilm_c200: ['FUJI 200', 'FUJI 200'],
  fujifilm_xtra_400: ['S-400', 'FUJI S-400'],
  fujifilm_pro_400h: ['PRO400H', 'FUJI PRO400H'],
  fujifilm_provia_100f: ['FUJI RDPIII', 'FUJI RDPIII'],
  fujifilm_velvia_100: ['RVP100', 'FUJI RVP100'],
  kodak_vision3_50d: ['EASTMAN 5203', 'EASTMAN 5203'],
  kodak_vision3_250d: ['EASTMAN 5207', 'EASTMAN 5207'],
  kodak_vision3_200t: ['EASTMAN 5213', 'EASTMAN 5213'],
  kodak_vision3_500t: ['EASTMAN 5219', 'EASTMAN 5219'],
  cinestill_800t: ['CINESTILL 800T', 'CINESTILL 800T'],
  kodak_tri_x_400: ['KODAK 400TX', 'KODAK 400TX'],
  kodak_tmax_100: ['KODAK 100TMX', 'KODAK 100TMX'],
  fujifilm_neopan_acros_100_ii: ['FUJI 100 ACROS II', 'FUJI 100 ACROS II'],
  ilford_hp5_plus_400: ['ILFORD HP5 PLUS', 'ILFORD HP5 PLUS'],
};

export function edgeTextFor(stockId: string, stockName: string | undefined, gauge: '135' | '120'): string {
  const own = OWN_EDGE_TEXT[stockId];
  if (own) return gauge === '120' ? own[1] : own[0];
  if (!stockName) return '';
  const open = stockName.indexOf('(');
  return (open >= 0 ? stockName.slice(0, open) : stockName).trim().toUpperCase();
}

/** EXIF's `yyyy:MM:dd HH:mm:ss` (or ISO's `yyyy-MM-dd…`) as a day, or null. */
export function captureDay(datetime: string | undefined): { year: number; month: number; day: number } | null {
  if (!datetime) return null;
  const parts = datetime.slice(0, 10).split(/[:-]/).map((v) => Number.parseInt(v, 10));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
  const [year, month, day] = parts as [number, number, number];
  if (year <= 1800 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** The date as the `lcd` and `dots` faces print it (`DateBackSettings.format`). */
export function formatDate(year: number, month: number, day: number, order: string): string {
  const yy = `'${String(((year % 100) + 100) % 100).padStart(2, '0')}`;
  return order === 'us' ? `${month} ${day} ${yy}` : `${yy} ${month} ${day}`;
}

/** One decimal without a trailing `.0`: `1.8`, `2`, `11`. */
function trimmed(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** The longest line Nikon's between-frames imprint holds (RFC-033 §5). */
export const DATA_LINE_MAX = 22;

/**
 * The `data` face's line, after the F6: shutter, aperture, focal length.
 * Fields drop from the right until it fits; a field the file does not carry
 * is left out, never invented. The host's metadata has no exposure program
 * or bias, so those two of the Mac's five fields are not printed here.
 */
export function dataTextFrom(m: FileMetadata | null | undefined): string {
  if (!m) return '';
  const fields: string[] = [];
  if (m.shutter_s && m.shutter_s > 0) fields.push(m.shutter_s >= 1 ? `${trimmed(m.shutter_s)}s` : `1/${Math.round(1 / m.shutter_s)}`);
  if (m.aperture && m.aperture > 0) fields.push(`F${trimmed(m.aperture)}`);
  if (m.focal_mm && m.focal_mm > 0) fields.push(`${Math.round(m.focal_mm)}mm`);
  while (fields.join(' ').length > DATA_LINE_MAX) fields.pop();
  return fields.join(' ');
}

/** The camera a date back sits on, from Film Format's sides (`dateBackCamera(longMM:shortMM:)`). */
export function dateBackCameraFor(longMM: number, shortMM: number): string | null {
  for (const f of ['135', '135_half', '120_645']) {
    const [l, s] = FILM_EDGE_GATE_MM[f]!;
    if (Math.abs(l - longMM) <= 1 && Math.abs(s - shortMM) <= 1) return f;
  }
  return null;
}

/**
 * Everything the session fills in on the frame's behalf. `aspect` is the
 * photograph's long side over its short one.
 */
export function resolvedFilmEdge(
  p: FilmParams,
  meta: FileMetadata | null | undefined,
  stockName: string | undefined,
  aspect: number,
  gate: FeatureGate = ALL_FEATURES,
): FilmParams {
  const fe = p.filmEdge;
  const d = p.dateBack;
  const day = captureDay(meta?.datetime_original);
  const data = dataTextFrom(meta);
  const camera = filmEdgeOn(p, gate) ? fe.format : (dateBackCameraFor(p.filmFormatMM, p.filmFormatMM / Math.max(aspect, 1)) ?? '135');
  return {
    ...p,
    filmEdge: {
      ...fe,
      edgeText: edgeTextFor(p.filmStock, stockName, gaugeOf(fe.format)),
      fNumber: meta?.aperture && meta.aperture > 0 ? meta.aperture : 0,
    },
    dateBack: {
      ...d,
      text: d.face === 'data' ? data : day ? formatDate(day.year, day.month, day.day, d.order) : '',
      dataText: data,
      camera,
    },
  };
}
