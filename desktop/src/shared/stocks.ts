// stocks.ts — the film and paper catalogue (`Model/StockCatalog.swift`),
// read from the Mac app's `StockCatalog.json` (copied to public/assets).

import type { FilmParams } from './params';

export interface Stock {
  id: string;
  name: string;
  stage: 'filming' | 'printing' | string;
  use: 'still' | 'cine' | string;
  type?: string | null;
  targetPrint?: string | null;
  hasPreviewLUT: boolean;
  pairedFilm?: string | null;
  cover?: string | null;
  formats?: string[] | null;
  /** A black-and-white stock: one silver emulsion, or a silver paper. */
  monochrome?: boolean | null;
}

export class StockCatalog {
  readonly stocks: Stock[];
  constructor(stocks: Stock[]) {
    this.stocks = stocks;
  }
  get films() {
    return this.stocks.filter((s) => s.stage === 'filming');
  }
  get papers() {
    return this.stocks.filter((s) => s.stage === 'printing');
  }
  stock(id: string) {
    return this.stocks.find((s) => s.id === id);
  }
  isPositive(id: string) {
    return this.stock(id)?.type === 'positive';
  }
  isMonochrome(id: string) {
    return this.stock(id)?.monochrome === true;
  }
  /**
   * Whether `paper` can print `film` at all (`StockCatalog.canPrint`): silver
   * film on silver paper, colour on colour. A black-and-white negative on a
   * colour paper prints orange, and the Multigrade profile's three emulsions
   * are a contrast control, not a colour response. An unknown id rules
   * nothing out.
   */
  canPrint(film: string, paper: string) {
    const f = this.stock(film);
    const p = this.stock(paper);
    if (!f || !p) return true;
    return (f.monochrome === true) === (p.monochrome === true);
  }
  /** Still first, then cine, as the Mac picker orders them; then by polarity, black and white last. */
  filmGroups(): { title: 'Positive' | 'Negative' | 'Monochrome'; films: Stock[] }[] {
    const ordered = [...this.films.filter((s) => s.use !== 'cine'), ...this.films.filter((s) => s.use === 'cine')];
    return [
      { title: 'Positive', films: ordered.filter((s) => s.type === 'positive') },
      { title: 'Negative', films: ordered.filter((s) => s.type !== 'positive' && !s.monochrome) },
      { title: 'Monochrome', films: ordered.filter((s) => s.type !== 'positive' && s.monochrome === true) },
    ].filter((g) => g.films.length) as { title: 'Positive' | 'Negative' | 'Monochrome'; films: Stock[] }[];
  }
  paperGroups(): { title: 'Still' | 'Cine'; papers: Stock[] }[] {
    return [
      { title: 'Still', papers: this.papers.filter((s) => s.use !== 'cine') },
      { title: 'Cine', papers: this.papers.filter((s) => s.use === 'cine') },
    ];
  }
  coverURL(id: string): string | null {
    const c = this.stock(id)?.cover;
    return c ? `assets/FilmCovers/${c}` : null;
  }
}

export const EMPTY_CATALOG = new StockCatalog([]);

export async function loadCatalog(): Promise<StockCatalog> {
  try {
    const r = await fetch('assets/StockCatalog.json');
    const j = (await r.json()) as { stocks: Stock[] };
    return new StockCatalog(j.stocks ?? []);
  } catch {
    return EMPTY_CATALOG;
  }
}

/** Multigrade filter 2: (C, M, Y) on the enlarger (Params.swift `multigradeFilter2`). */
export const MULTIGRADE_FILTER_2: [number, number, number] = [0, 0, 68];

/**
 * Black and white (Params.swift): a silver film has one emulsion, so no
 * sub-layer grain; the silver paper has no EDR calibration; and on it the
 * enlarger's pack is sent, since the engine's table has no row for it.
 */
export function monochromeResolved(p: FilmParams, catalog: StockCatalog): FilmParams {
  const film = catalog.isMonochrome(p.filmStock);
  const paper = catalog.isMonochrome(p.printStock);
  if (!film && !paper) return p;
  return {
    ...p,
    effects: film ? { ...p.effects, grainLayered: false } : p.effects,
    extendedDynamicRange: paper ? false : p.extendedDynamicRange,
    neutralPack: film && paper ? MULTIGRADE_FILTER_2 : null,
  };
}
