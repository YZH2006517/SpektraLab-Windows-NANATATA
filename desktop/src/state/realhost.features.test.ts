// Against the real engine host, when one is staged: every stock in the
// catalogue and every date-back configuration, with the params this interface
// sends (`fullDelta` after `monochromeResolved` and `resolvedFilmEdge`, the
// engine cut held at the gate as `session.ts` holds it). These are the
// failures a person met in the installed app (a stock with no profile in the
// build, a date back the engine refused) -- every one must open and render.
//
//   SPEKTRALAB_HOST_DIR=../build/host-win-x64 npx vitest run realhost.features
//
// Skipped (and says so) without the variable.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, encodeFrame } from '@shared/framing';
import { ALL_FEATURES, FILM_PARAMS_DEFAULT, type FilmParams, type WireValue, fullDelta, gateRatio, filmEdgeOn, cutsFrame } from '@shared/params';
import { GEOMETRY_DEFAULT, constrained } from '@shared/geometry';
import { resolvedFilmEdge } from '@shared/filmEdge';
import { StockCatalog, type Stock, monochromeResolved } from '@shared/stocks';

const dir = process.env.SPEKTRALAB_HOST_DIR;
const exe = dir ? join(dir, process.platform === 'win32' ? 'spektralab-host.exe' : 'spektralab-host') : '';
const enabled = !!dir && existsSync(exe);

function hostConn() {
  const p = spawn(exe, ['--resources', join(dir!, 'engine')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const dec = new FrameDecoder();
  const waiting = new Map<number, (h: Record<string, unknown>) => void>();
  p.stdout!.on('data', (c: Buffer) => {
    for (const f of dec.push(new Uint8Array(c))) {
      const h = f.header as Record<string, unknown>;
      if (typeof h.id === 'number') waiting.get(h.id)?.(h);
    }
  });
  let id = 1;
  return {
    call(method: string, params: Record<string, unknown>) {
      const i = id++;
      return new Promise<Record<string, unknown>>((res) => {
        waiting.set(i, res);
        p.stdin!.write(encodeFrame({ id: i, method, params }));
      });
    },
    close: () => p.stdin!.end(),
  };
}

function png(path: string, w: number, h: number) {
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push((255 * x) / (w - 1), (255 * y) / (h - 1), 110);
  }
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const v of b) {
      c ^= v;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const td = Buffer.concat([Buffer.from(t), d]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  writeFileSync(
    path,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]),
  );
}

const META = { datetime_original: '2026:10:28 09:30:00', aperture: 2.8, shutter_s: 1 / 125, focal_mm: 35 };

/** What session.ts sends: the user's params resolved, with the engine cut as `engineCut` holds it. */
function sent(p: FilmParams, catalog: StockCatalog, size: { width: number; height: number }, user = GEOMETRY_DEFAULT): Record<string, WireValue> {
  let g = user;
  if (filmEdgeOn(p, ALL_FEATURES)) {
    const landscape = size.width >= size.height;
    g = constrained({ ...g, lockedRatio: gateRatio(p.filmEdge.format, landscape) }, size);
  }
  const resolved = resolvedFilmEdge(monochromeResolved(p, catalog), META, catalog.stock(p.filmStock)?.name, Math.max(size.width, size.height) / Math.min(size.width, size.height));
  const cut = cutsFrame(resolved, ALL_FEATURES, g) ? g : null;
  return { ...fullDelta(resolved, ALL_FEATURES, cut), preview_long_edge: 800 };
}

describe.skipIf(!enabled)('the real host, as this interface drives it', () => {
  const catalog = new StockCatalog(
    (JSON.parse(readFileSync(join(__dirname, '../../public/assets/StockCatalog.json'), 'utf8')) as { stocks: Stock[] }).stocks,
  );
  const tmp = mkdtempSync(join(tmpdir(), 'spk-features-'));
  const frames = { '3:2': { path: join(tmp, 'a.png'), width: 600, height: 400 }, '4:3': { path: join(tmp, 'b.png'), width: 640, height: 480 } };
  for (const f of Object.values(frames)) png(f.path, f.width, f.height);

  async function renders(h: ReturnType<typeof hostConn>, frame: (typeof frames)['3:2'], p: FilmParams, user = GEOMETRY_DEFAULT) {
    const open = await h.call('open', { path: frame.path, params: sent(p, catalog, frame, user) });
    if (!open.ok) return JSON.stringify(open.error);
    const sid = (open.result as { session: string }).session;
    const r = await h.call('render', { session: sid, tier: 'live', format: 'rgba8', display: 'srgb' });
    await h.call('close', { session: sid });
    return r.ok ? null : JSON.stringify(r.error);
  }

  it('opens and renders every film in the catalogue, on the paper choosing it leads to', async () => {
    const h = hostConn();
    const failures: string[] = [];
    try {
      for (const film of catalog.films) {
        // Session.selectFilmStock: the declared paper, and never across silver and colour.
        let printStock = film.targetPrint && catalog.stock(film.targetPrint) ? film.targetPrint : FILM_PARAMS_DEFAULT.printStock;
        if (!catalog.canPrint(film.id, printStock)) printStock = catalog.papers.find((p) => catalog.canPrint(film.id, p.id))!.id;
        const p = { ...FILM_PARAMS_DEFAULT, filmStock: film.id, printStock, scanFilm: catalog.isPositive(film.id) };
        const why = await renders(h, frames['3:2'], p);
        if (why) failures.push(`${film.id} on ${printStock}: ${why}`);
      }
      for (const paper of catalog.papers) {
        const film = catalog.films.find((f) => f.type !== 'positive' && catalog.canPrint(f.id, paper.id));
        if (!film) continue;
        const why = await renders(h, frames['3:2'], { ...FILM_PARAMS_DEFAULT, filmStock: film.id, printStock: paper.id });
        if (why) failures.push(`paper ${paper.id} (with ${film.id}): ${why}`);
      }
    } finally {
      h.close();
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it('renders the date back in every face, place and camera, with and without the film edge', async () => {
    const h = hostConn();
    const failures: string[] = [];
    try {
      for (const [shape, frame] of Object.entries(frames))
        for (const edge of [false, true])
          for (const face of ['lcd', 'dots', 'data'])
            for (const placement of ['frame', 'rebate'])
              for (const withData of [false, true])
              for (const cropped of [false, true]) {
                const p: FilmParams = {
                  ...FILM_PARAMS_DEFAULT,
                  filmEdge: { ...FILM_PARAMS_DEFAULT.filmEdge, active: edge, format: '135' },
                  dateBack: { ...FILM_PARAMS_DEFAULT.dateBack, active: true, face, placement, withData },
                };
                const user = cropped
                  ? { ...GEOMETRY_DEFAULT, crop: { x: 0.08, y: 0.1, width: 0.7, height: 0.75 }, angle: 4, quarterTurns: 1 }
                  : GEOMETRY_DEFAULT;
                const why = await renders(h, frame, p, user);
                if (why) failures.push(`${shape} edge=${edge} ${face} ${placement} data=${withData} crop=${cropped}: ${why}`);
              }
    } finally {
      h.close();
    }
    expect(failures).toEqual([]);
  }, 600_000);
  it('walks every date-back and film-edge state in one session, by deltas, as the app edits', async () => {
    const h = hostConn();
    const failures: string[] = [];
    try {
      for (const [shape, frame] of Object.entries(frames)) {
        let prev = sent(FILM_PARAMS_DEFAULT, catalog, frame);
        const open = await h.call('open', { path: frame.path, params: prev });
        expect(open.ok, JSON.stringify(open.error)).toBe(true);
        const sid = (open.result as { session: string }).session;
        const steps: [string, FilmParams][] = [];
        let p: FilmParams = FILM_PARAMS_DEFAULT;
        const step = (label: string, next: FilmParams) => {
          p = next;
          steps.push([label, next]);
        };
        for (const edge of [false, true, false])
          for (const face of ['lcd', 'dots', 'data', 'lcd'])
            for (const placement of ['frame', 'rebate', 'frame']) {
              step(`edge=${edge} ${face} ${placement}`, {
                ...p,
                filmEdge: { ...p.filmEdge, active: edge },
                dateBack: { ...p.dateBack, active: true, face, placement },
              });
            }
        step('date off', { ...p, dateBack: { ...p.dateBack, active: false } });
        step('120 6x7 edge', { ...p, filmEdge: { ...p.filmEdge, active: true, format: '120_6x7' } });
        step('date on 6x7', { ...p, dateBack: { ...p.dateBack, active: true, face: 'lcd' } });
        step('HP5', { ...p, filmStock: 'ilford_hp5_plus_400', printStock: 'ilford_multigrade_iv_rc' });
        step('CineStill', { ...p, filmStock: 'cinestill_800t', printStock: 'kodak_2383' });
        step('edge off', { ...p, filmEdge: { ...p.filmEdge, active: false } });
        step('all off', { ...p, dateBack: { ...p.dateBack, active: false } });
        for (const [label, next] of steps) {
          const want = sent(next, catalog, frame);
          const d: Record<string, WireValue> = {};
          for (const [k, v] of Object.entries(want)) if (prev[k] !== v) d[k] = v;
          const r = await h.call('set_params', { session: sid, delta: d });
          if (!r.ok) {
            failures.push(`${shape} ${label}: set_params ${JSON.stringify(r.error)}`);
            continue;
          }
          prev = want;
          const img = await h.call('render', { session: sid, tier: 'live', format: 'rgba8', display: 'srgb' });
          if (!img.ok) failures.push(`${shape} ${label}: render ${JSON.stringify(img.error)}`);
        }
        await h.call('close', { session: sid });
      }
    } finally {
      h.close();
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
