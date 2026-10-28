// The store's edit doors, against a stand-in host and platform: what makes an
// undo step and what does not.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('../host/client', () => {
  class HostCallError extends Error {
    code = 'internal';
  }
  const h = {
    setParams: vi.fn(async () => {
      calls.push('set_params');
      return {};
    }),
    render: vi.fn(async (_sid: string, tier: string) => {
      calls.push(`render:${tier}`);
      return { width: 4, height: 4, data: new Uint8Array(64), colorSpace: 'sRGB', tier, reprinted: false, ms: 1 };
    }),
    redecode: vi.fn(async (_sid: string, decode: object) => {
      calls.push('redecode:' + JSON.stringify(decode));
      return { session: 's1', width: 6000, height: 4000, kind: 'raw', metadata: { orientation: 1 }, params: {} };
    }),
  };
  return { HostCallError, host: () => h };
});
vi.mock('../platform', () => ({
  platform: () => ({ log: () => {}, sidecarSave: async () => '' }),
  baseName: (p: string) => p.split(/[\\/]/).pop() ?? p,
  dirName: (p: string) => p,
}));

import { recomputeFilmFormat, sessionStore, setDecode, setGeometry, setParams, undo } from './session';
import type { HelloResult } from '@shared/protocol';
import { settingsStore } from './settings';
import { newSidecar } from '@shared/sidecar';

// Undo steps coalesce within 500 ms; each case starts well past the last one.
let clock = 0;
beforeEach(() => {
  clock += 10_000;
  vi.spyOn(performance, 'now').mockReturnValue(clock);
  calls.length = 0;
  sessionStore.setState({
    selection: '/x/a.cr2',
    engineSession: 's1',
    nativeSize: { width: 6000, height: 4000 },
    sidecar: newSidecar(),
    undo: [],
    redo: [],
    batchExporting: false,
  });
  settingsStore.getState().set('recalculateEffectsAfterCrop', true);
});

describe('the derived film format', () => {
  it('is written without an undo step', () => {
    const before = sessionStore.getState().sidecar.params.filmFormatMM;
    sessionStore.setState({ sidecar: { ...newSidecar(), params: { ...newSidecar().params, filmFormatMM: before + 7 } } });
    recomputeFilmFormat();
    const s = sessionStore.getState();
    expect(s.sidecar.params.filmFormatMM).toBeCloseTo(before, 3);
    expect(s.undo).toHaveLength(0);
  });

  it('rides along with the crop that moved it: one undo step, and undo restores both', async () => {
    const mm0 = sessionStore.getState().sidecar.params.filmFormatMM;
    setGeometry((g) => ({ ...g, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }));
    const s = sessionStore.getState();
    expect(s.undo).toHaveLength(1);
    expect(s.sidecar.params.filmFormatMM).not.toBeCloseTo(mm0, 3);
    undo();
    const u = sessionStore.getState();
    expect(u.sidecar.geometry.crop.width).toBe(1);
    expect(u.sidecar.params.filmFormatMM).toBeCloseTo(mm0, 3);
    await vi.waitFor(() => expect(calls).toContain('render:live'));
  });

  it('a real edit still makes an undo step', () => {
    setParams((p) => ({ ...p, exposureCompensationEV: 1 }));
    expect(sessionStore.getState().undo).toHaveLength(1);
  });
});

describe('white balance at decode (R2)', () => {
  const hello = { methods: ['open', 'redecode', 'render'] } as unknown as HelloResult;

  it('a decode edit is one undo step and re-decodes the session, then renders', async () => {
    sessionStore.setState({ hello, frameKind: 'raw' });
    setDecode((d) => ({ ...d, whiteBalance: 'Custom', temperature: 3200, tint: 0 }));
    expect(sessionStore.getState().undo).toHaveLength(1);
    await vi.waitFor(() => expect(calls).toContain('redecode:{"white_balance":{"mode":"custom","temperature_k":3200,"tint":0}}'));
    await vi.waitFor(() => expect(calls.indexOf('render:live')).toBeGreaterThan(calls.findIndex((c) => c.startsWith('redecode'))));
    calls.length = 0;
    undo();
    expect(sessionStore.getState().sidecar.decode.whiteBalance).toBe('As Shot');
    await vi.waitFor(() => expect(calls).toContain('redecode:{"white_balance":{"mode":"as_shot"}}'));
  });

  it('a raster frame is not re-decoded', async () => {
    sessionStore.setState({ hello, frameKind: 'tiff', selection: '/x/a.tif' });
    setDecode((d) => ({ ...d, whiteBalance: 'Custom', temperature: 3200 }));
    await vi.waitFor(() => expect(calls).toContain('render:live'));
    expect(calls.some((c) => c.startsWith('redecode'))).toBe(false);
  });
});

describe('the film edge cuts the frame before the engine (Session+FilmEdge.swift)', () => {
  it('holds the crop at the gate while on, and gives the crop back when off', async () => {
    const { canvasGeometry, engineCut } = await import('./session');
    const { gateRatio } = await import('@shared/params');
    setGeometry((g) => ({ ...g, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.8 } }));
    const own = sessionStore.getState().sidecar.geometry;
    setParams((p) => ({ ...p, filmEdge: { ...p.filmEdge, active: true, format: '135' } }));
    const g = sessionStore.getState().sidecar.geometry;
    const ratio = (g.crop.width * 6000) / (g.crop.height * 4000);
    // The crop was portrait, so the gate is upright: 24 x 36.
    expect(ratio).toBeCloseTo(gateRatio('135', false), 6);
    expect(engineCut()).toEqual(g);
    expect(canvasGeometry().crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    setParams((p) => ({ ...p, filmEdge: { ...p.filmEdge, format: '120_6x7' } }));
    const g2 = sessionStore.getState().sidecar.geometry;
    expect((g2.crop.width * 6000) / (g2.crop.height * 4000)).toBeCloseTo(gateRatio('120_6x7', false), 6);
    setParams((p) => ({ ...p, filmEdge: { ...p.filmEdge, active: false } }));
    expect(sessionStore.getState().sidecar.geometry).toEqual(own);
    expect(engineCut()).toBeNull();
  });

  it('frames over the uncut print while the crop tool is open', async () => {
    const { engineCut, canvasGeometry, setTool } = await import('./session');
    setParams((p) => ({ ...p, filmEdge: { ...p.filmEdge, active: true } }));
    setTool('crop');
    expect(engineCut()).toBeNull();
    expect(canvasGeometry()).toEqual(sessionStore.getState().sidecar.geometry);
    setTool('select');
    expect(engineCut()).not.toBeNull();
  });

  it('sends the crop as engine geometry only while the frame is cut', async () => {
    const { fullDelta, cutsFrame, ALL_FEATURES, FILM_PARAMS_DEFAULT } = await import('@shared/params');
    const cut = { crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, angle: 3, quarterTurns: 5, flipH: true, flipV: false };
    const on = fullDelta(FILM_PARAMS_DEFAULT, ALL_FEATURES, cut);
    expect(on.geometry_crop_x).toBe(0.1);
    expect(on.geometry_crop_h).toBe(0.4);
    expect(on.geometry_quarter_turns).toBe(1);
    expect(on.geometry_flip_h).toBe(true);
    const off = fullDelta(FILM_PARAMS_DEFAULT, ALL_FEATURES, null);
    expect(off.geometry_crop_w).toBe(1);
    expect(off.geometry_rotation_deg).toBe(0);
    // The date alone cuts only under a crop, a turn or a flip.
    const dated = { ...FILM_PARAMS_DEFAULT, dateBack: { ...FILM_PARAMS_DEFAULT.dateBack, active: true } };
    expect(cutsFrame(dated, ALL_FEATURES, { ...cut, crop: { x: 0, y: 0, width: 1, height: 1 }, angle: 0, quarterTurns: 0, flipH: false })).toBe(false);
    expect(cutsFrame(dated, ALL_FEATURES, cut)).toBe(true);
    const edged = { ...FILM_PARAMS_DEFAULT, filmEdge: { ...FILM_PARAMS_DEFAULT.filmEdge, active: true } };
    expect(cutsFrame(edged, { ...ALL_FEATURES, overscan: false }, cut)).toBe(false);
  });
});
