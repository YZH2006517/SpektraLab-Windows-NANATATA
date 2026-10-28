import { describe, expect, it } from 'vitest';
import { captureDay, dataTextFrom, dateBackCameraFor, edgeTextFor, formatDate, gaugeOf, resolvedFilmEdge } from './filmEdge';
import { FILM_PARAMS_DEFAULT, gateRatio } from './params';

describe('film edge resolution (Session+FilmEdge.swift)', () => {
  it('prints a stock its own edge text per gauge, else its name', () => {
    expect(edgeTextFor('kodak_gold_200', 'Kodak Gold 200', '135')).toBe('KODAK GB 200-7');
    expect(edgeTextFor('kodak_gold_200', 'Kodak Gold 200', '120')).toBe('KODAK 200');
    expect(edgeTextFor('kodak_portra_400', 'Kodak Portra 400 (v2)', '135')).toBe('KODAK PORTRA 400');
    expect(edgeTextFor('unknown', undefined, '135')).toBe('');
    expect(gaugeOf('135_xpan')).toBe('135');
    expect(gaugeOf('120_6x7')).toBe('120');
  });

  it('formats the date as the faces print it', () => {
    expect(formatDate(1998, 10, 28, 'japan')).toBe("'98 10 28");
    expect(formatDate(2005, 3, 7, 'us')).toBe("3 7 '05");
    expect(captureDay('2024:06:01 12:00:00')).toEqual({ year: 2024, month: 6, day: 1 });
    expect(captureDay('2024-06-01T12:00:00')).toEqual({ year: 2024, month: 6, day: 1 });
    expect(captureDay('0000:00:00 00:00:00')).toBeNull();
    expect(captureDay(undefined)).toBeNull();
  });

  it('builds the data line from what the file carries, and never past 22 characters', () => {
    expect(dataTextFrom({ shutter_s: 1 / 250, aperture: 5.6, focal_mm: 24 })).toBe('1/250 F5.6 24mm');
    expect(dataTextFrom({ shutter_s: 2, aperture: 8 })).toBe('2s F8');
    expect(dataTextFrom({})).toBe('');
    expect(dataTextFrom({ shutter_s: 1 / 8000, aperture: 22, focal_mm: 1200 }).length).toBeLessThanOrEqual(22);
  });

  it('finds the date back camera from Film Format', () => {
    expect(dateBackCameraFor(36, 24)).toBe('135');
    expect(dateBackCameraFor(56, 41.5)).toBe('120_645');
    expect(dateBackCameraFor(69.5, 56)).toBeNull();
  });

  it('resolves everything at once, and is idempotent', () => {
    const p = { ...FILM_PARAMS_DEFAULT, filmStock: 'kodak_gold_200', dateBack: { ...FILM_PARAMS_DEFAULT.dateBack, active: true } };
    const meta = { datetime_original: '1998:10:28 10:00:00', aperture: 2.8, shutter_s: 1 / 125 };
    const r = resolvedFilmEdge(p, meta, 'Kodak Gold 200', 1.5);
    expect(r.filmEdge.edgeText).toBe('KODAK GB 200-7');
    expect(r.filmEdge.fNumber).toBe(2.8);
    expect(r.dateBack.text).toBe("'98 10 28");
    expect(r.dateBack.dataText).toBe('1/125 F2.8');
    expect(resolvedFilmEdge(r, meta, 'Kodak Gold 200', 1.5)).toEqual(r);
  });

  it('gives the gate its orientation', () => {
    expect(gateRatio('135', true)).toBeCloseTo(1.5);
    expect(gateRatio('135', false)).toBeCloseTo(2 / 3);
    expect(gateRatio('120_6x7', true)).toBeCloseTo(69.5 / 56);
  });
});
