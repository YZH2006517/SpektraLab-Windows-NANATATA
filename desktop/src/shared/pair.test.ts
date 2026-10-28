import { describe, expect, it } from 'vitest';
import { decodePair, effectiveSpacing, encodePair, isPairPath, newHole, newPairName, openPairRequest, pairLabel } from './pair';

// A pair file as the Mac writes it (HalfFramePair.swift, sorted keys), with
// fields this port does not model.
const MAC = {
  folder: '/Users/me/Roll 12',
  left: {
    autoExposure: true,
    decode: { lensCorrection: false, temperature: 5200, tint: 0, whiteBalance: 'asShot' },
    exposureEV: 0.5,
    path: '/Users/me/Roll 12/A.NEF',
    placement: { quarterTurns: 1, scale: 1.4, x: 0.2, y: -0.1 },
    printScope: 'film',
  },
  onStrip: true,
  right: { exposureEV: 0, path: '/Users/me/Roll 12/B.NEF', placement: { quarterTurns: 0, scale: 1, x: 0, y: 0 } },
  schemaVersion: 1,
  spacingMM: 1.6,
  turned: false,
};

describe('half-frame pairs (HalfFramePair.swift)', () => {
  it('reads the Mac file and writes back what it does not model', () => {
    const p = decodePair(MAC)!;
    expect(p.left!.placement).toEqual({ scale: 1.4, x: 0.2, y: -0.1, quarterTurns: 1 });
    expect(p.left!.exposureEV).toBe(0.5);
    const back = encodePair(p) as typeof MAC;
    expect(back.left.decode).toEqual(MAC.left.decode);
    expect(back.left.printScope).toBe('film');
    expect(decodePair(back)).toEqual(p);
  });

  it('a hole may be empty, and a file without a folder is not a pair', () => {
    expect(decodePair({ ...MAC, right: undefined })!.right).toBeNull();
    expect(decodePair({ left: MAC.left })).toBeNull();
  });

  it('sends the host the composition, with the camera\'s gap on the strip', () => {
    const p = decodePair(MAC)!;
    expect(effectiveSpacing(p)).toBe(1);
    expect(effectiveSpacing({ ...p, onStrip: false })).toBe(1.6);
    expect(effectiveSpacing({ ...p, onStrip: false, spacingMM: 9 })).toBe(2);
    const r = openPairRequest(p);
    expect(r.holes[0]).toEqual({ path: MAC.left.path, exposure_ev: 0.5, placement: { scale: 1.4, x: 0.2, y: -0.1, quarter_turns: 1 } });
    expect(r.spacing_mm).toBe(1);
  });

  it('names pairs per folder without colliding, and labels them by their frames', () => {
    const a = newPairName('/x', []);
    expect(isPairPath(a)).toBe(true);
    expect(newPairName('/x', [a])).not.toBe(a);
    expect(newPairName('/y', [])).not.toBe(a);
    expect(/^[A-Za-z0-9._-]+$/.test(a)).toBe(true);
    expect(pairLabel({ ...decodePair(MAC)!, right: null })).toBe('A + —');
    expect(newHole('/a/b.jpg').placement.scale).toBe(1);
  });
});
