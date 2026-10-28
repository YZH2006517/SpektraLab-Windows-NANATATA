// session.ts — the one session (the Mac's `Model/Session.swift`, reduced to
// what this port carries): the library, the open frame and its edits, the
// engine session behind it, undo, the clipboard and the view.
//
// Three kinds of edit, three costs (ARCHITECTURE.md §7.1):
//   params      → a `set_params` delta and a render (reprint if print-only)
//   adjustments → Layer 2 in the canvas shader, no host call
//   geometry    → applied when the canvas samples, no host call -- except
//                 while the frame is cut before the engine (a film edge, or
//                 the date under a crop: `cutsFrame`), when the crop is part
//                 of the negative and a geometry edit is a render
//                 (Session+FilmEdge.swift).
//
// Pixels do not live in this store: `frames.ts` holds them, and the store
// carries a version number the canvas watches.

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { useMemo } from 'react';
import type { HelloResult, HostState, FileMetadata, Tier } from '@shared/protocol';
import {
  type EngineCut,
  type FeatureGate,
  type FilmParams,
  type FilmSide,
  ALL_FEATURES,
  FILM_FRAME_CUSTOM,
  cutsFrame,
  delta as paramsDelta,
  featureGate,
  filmEdgeOn,
  gateRatio,
  filmFormatMM,
  filmFrameNamed,
  fullDelta,
  jsonEqual,
  clamp,
} from '@shared/params';
import { type Adjustments, ADJUSTMENTS_DEFAULT } from '@shared/adjustments';
import { captureDay, formatDate, resolvedFilmEdge } from '@shared/filmEdge';
import { type HalfFramePair, type PairSide, PAIR_AREA, decodePair, encodePair, isPairPath, newHole, newPairName, openPairRequest, pairLabel } from '@shared/pair';
import { type Geometry, GEOMETRY_DEFAULT, constrained, outputSize } from '@shared/geometry';
import { type DecodeSettings, type Sidecar, decodeSidecar, encodeSidecar, newSidecar } from '@shared/sidecar';
import { decodeWire, isRawPath, modeOf } from '@shared/whiteBalance';
import { type ClipboardGroup, type SettingsClip, CLIPBOARD_GROUPS, applyClip, clipChanges } from '@shared/clipboard';
import { EMPTY_CATALOG, type StockCatalog, loadCatalog } from '@shared/stocks';
import { HostCallError, host } from '../host/client';
import { type FileEntry, baseName, dirName, platform } from '../platform';
import { settingsStore } from './settings';
import { frameImages, makeThumbFromPrint } from './frames';
import { thumbs } from './thumbs';
import { tz } from '../i18n';

export type Tool = 'select' | 'hand' | 'crop';

export interface ViewState {
  /** Fit the output to the canvas; when false, `zoom` is native px → device px. */
  fit: boolean;
  zoom: number;
  /** Pan: the output point (0…1) at the canvas centre. */
  cx: number;
  cy: number;
}

export interface UndoEntry {
  params: FilmParams;
  adjustments: Adjustments;
  geometry: Geometry;
  decode: DecodeSettings;
}

export interface SessionState {
  // host
  hostState: HostState;
  hello: HelloResult | null;
  gate: FeatureGate;
  unsupported: string[];
  catalog: StockCatalog;
  // library
  folder: string | null;
  frames: FileEntry[];
  selection: string | null;
  picked: string[];
  savedGeometry: Record<string, Geometry>;
  thumbVersion: number;
  // the open frame
  sidecar: Sidecar;
  engineSession: string | null;
  nativeSize: { width: number; height: number } | null;
  metadata: FileMetadata | null;
  /** The open frame's kind as the host decoded it (`raw`, `tiff`, …); null until it lands. */
  frameKind: string | null;
  /** The open frame when it is a half-frame pair, and its second frame's metadata. */
  pair: HalfFramePair | null;
  pairMetadataB: FileMetadata | null;
  /** A decode-setting change (white balance) is being re-decoded. */
  redecoding: boolean;
  imageVersion: number;
  badge: Tier | null;
  developing: boolean;
  status: string;
  lastError: string | null;
  // view
  tool: Tool;
  view: ViewState;
  fitZoom: number;
  /** The canvas in device px (the navigator draws the visible part from it). */
  canvasPx: { width: number; height: number };
  showingOriginal: boolean;
  comparing: boolean;
  comparePosition: number;
  // edits
  undo: UndoEntry[];
  redo: UndoEntry[];
  clipboard: SettingsClip | null;
  clipboardGroups: ClipboardGroup[];
  // pages
  exportOpen: boolean;
  settingsOpen: boolean;
  aboutOpen: boolean;
  batchExporting: boolean;
}

const INITIAL: SessionState = {
  hostState: { phase: 'starting' },
  hello: null,
  gate: ALL_FEATURES,
  unsupported: [],
  catalog: EMPTY_CATALOG,
  folder: null,
  frames: [],
  selection: null,
  picked: [],
  savedGeometry: {},
  thumbVersion: 0,
  sidecar: newSidecar(),
  engineSession: null,
  nativeSize: null,
  metadata: null,
  frameKind: null,
  pair: null,
  pairMetadataB: null,
  redecoding: false,
  imageVersion: 0,
  badge: null,
  developing: false,
  status: '',
  lastError: null,
  tool: 'select',
  fitZoom: 1,
  canvasPx: { width: 1, height: 1 },
  view: { fit: true, zoom: 1, cx: 0.5, cy: 0.5 },
  showingOriginal: false,
  comparing: false,
  comparePosition: 0.5,
  undo: [],
  redo: [],
  clipboard: null,
  clipboardGroups: [...CLIPBOARD_GROUPS],
  exportOpen: false,
  settingsOpen: false,
  aboutOpen: false,
  batchExporting: false,
};

export const sessionStore = createStore<SessionState>(() => INITIAL);
export const useSession = <T>(sel: (s: SessionState) => T): T => useStore(sessionStore, sel);
const get = () => sessionStore.getState();
const set = (p: Partial<SessionState>) => sessionStore.setState(p);

// ------------------------------------------------------------ the scheduler
//
// "Sent vs wanted" (`RenderScheduler.swift`): one render in flight; edits
// made while it runs only move what is wanted, and the loop catches up with
// the newest state when it lands. The original-resolution render starts
// 400 ms after the last edit and is dropped if anything moved meanwhile.

let sentParams: FilmParams | null = null;
/** The engine cut that went with `sentParams`. */
let sentCut: EngineCut | null = null;
let wantedGen = 0;
let inFlight = false;
let fullTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastUndoAt = 0;
let openGen = 0;
const FULL_DELAY_MS = 400;

function noteError(op: string, e: unknown) {
  const msg = e instanceof HostCallError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);
  platform().log('error', `${op}: ${msg}`);
  set({ lastError: `${op}: ${msg}`, status: tz(`${op} failed: ${msg}`, `${op} 失败：${msg}`) });
}

function previewEdge() {
  return settingsStore.getState().previewLongEdge;
}

function wireParams(p: FilmParams, cut: EngineCut | null) {
  return { ...fullDelta(p, get().gate, cut), preview_long_edge: previewEdge() };
}

/**
 * The params as the engine is sent them: the user's, with what the session
 * fills in on the frame's behalf -- the stock's edge print, the gate's
 * f-number, the date and the shooting data from EXIF (`resolvedFilmEdge`).
 * The sidecar keeps the user's own; these are derived every time.
 */
export function resolvedParams(s: SessionState = get()): FilmParams {
  const n = s.nativeSize;
  const aspect = n ? Math.max(n.width, n.height) / Math.max(1, Math.min(n.width, n.height)) : 1.5;
  const p = s.sidecar.params;
  if (!s.pair) return resolvedFilmEdge(p, s.metadata, s.catalog.stock(p.filmStock)?.name, aspect, s.gate);
  // A pair is 135_half exposed twice on one strip, each frame with its own
  // date (Session.resolved on the Mac); the piece is already the gate's shape.
  const half = { ...p, filmEdge: { ...p.filmEdge, format: '135_half' } };
  const r = resolvedFilmEdge(half, s.metadata, s.catalog.stock(p.filmStock)?.name, aspect, s.gate);
  const dayB = captureDay(s.pairMetadataB?.datetime_original);
  return {
    ...r,
    filmEdge: { ...r.filmEdge, pair: filmEdgeOn(r, s.gate) },
    dateBack: {
      ...r.dateBack,
      camera: '135_half',
      textB: r.dateBack.face === 'data' ? '' : dayB ? formatDate(dayB.year, dayB.month, dayB.day, r.dateBack.order) : '',
    },
  };
}

/**
 * The crop the engine's frame is cut with, or null for the whole decode. While
 * the crop tool is open the picture is framed over the uncut print (the Mac's
 * README: the guide over the undeveloped picture), and leaving the tool
 * develops the new framing.
 */
export function engineCut(s: SessionState = get()): Geometry | null {
  // A pair's picture is the whole piece, already the gate's shape.
  if (s.pair) return null;
  return s.tool !== 'crop' && cutsFrame(s.sidecar.params, s.gate, s.sidecar.geometry) ? s.sidecar.geometry : null;
}

/**
 * The geometry the canvas, the navigator, the filmstrip and an export apply
 * to the print: none while the engine has cut it (the film canvas already is
 * the framing).
 */
export function canvasGeometry(s: SessionState = get()): Geometry {
  return engineCut(s) ? GEOMETRY_DEFAULT : s.sidecar.geometry;
}

/**
 * Before a params change lands (`Session.filmEdgeWillChange`): turning the
 * film edge on takes the crop into the gate's shape and holds it there, off
 * gives the user's own crop back, and a new format reshapes the framing.
 */
let heldCrop: Geometry | null = null;
function filmEdgeWillChange(from: FilmParams, to: FilmParams, g: Geometry): Geometry {
  // A pair has no crop to hold: the film edge only re-lays its gap.
  if (get().pair) return g;
  const gate = get().gate;
  const was = filmEdgeOn(from, gate);
  const now = filmEdgeOn(to, gate);
  const size = get().nativeSize;
  const framed = (format: string) => {
    if (!size) return g;
    const landscape = g.crop.width * size.width >= g.crop.height * size.height;
    return constrained({ ...g, lockedRatio: gateRatio(format, landscape) }, size);
  };
  if (!was && now) {
    heldCrop = g;
    return framed(to.filmEdge.format);
  }
  if (was && !now) {
    const back = heldCrop ?? { ...g, lockedRatio: null };
    heldCrop = null;
    return back;
  }
  if (now && to.filmEdge.format !== from.filmEdge.format) return framed(to.filmEdge.format);
  return g;
}

/**
 * The size `canvasGeometry` is relative to: the decode's, or while the engine
 * has cut the frame, the film canvas's -- the print as it landed, so 100 % is
 * the preview's pixels until the full render lands and the frame's own after.
 */
export function canvasSource(s: SessionState = get()): { width: number; height: number } | null {
  if (engineCut(s) && frameImages.print) return { width: frameImages.print.width, height: frameImages.print.height };
  return s.nativeSize;
}

/** `canvasGeometry` for a component (a stable reference: the sidecar's, or the default). */
export function useCanvasGeometry(): Geometry {
  return useSession((s) => canvasGeometry(s));
}

/** `canvasSource` for a component, as one object per size. */
export function useCanvasSource(): { width: number; height: number } | null {
  const w = useSession((s) => canvasSource(s)?.width ?? 0);
  const h = useSession((s) => canvasSource(s)?.height ?? 0);
  return useMemo(() => (w && h ? { width: w, height: h } : null), [w, h]);
}

/** The other orientation of the gate, without turning the picture (the Mac's Framing row). */
export function flipFilmEdgeGate() {
  const s = get();
  const size = s.nativeSize;
  if (!filmEdgeOn(s.sidecar.params, s.gate) || !size) return;
  const g = s.sidecar.geometry;
  const landscape = (g.lockedRatio ?? 1) >= 1;
  setGeometry(() => constrained({ ...g, lockedRatio: gateRatio(s.sidecar.params.filmEdge.format, !landscape) }, size));
}

/**
 * As Shot keeps the camera's pair in the sidecar too, once a decode reported
 * it (the Mac does the same when the decode lands). Derived: no undo step.
 */
function noteAsShot() {
  const s = get();
  const shot = s.metadata?.as_shot;
  const d = s.sidecar.decode;
  if (!shot || modeOf(d) !== 'As Shot') return;
  if (d.temperature === shot.temperature_k && d.tint === shot.tint) return;
  set({ sidecar: { ...s.sidecar, decode: { ...d, temperature: shot.temperature_k, tint: shot.tint } } });
  scheduleSave();
}

export async function requestPrint(): Promise<void> {
  wantedGen++;
  if (fullTimer) clearTimeout(fullTimer);
  if (inFlight) return;
  const sid = get().engineSession;
  if (!sid) return;
  inFlight = true;
  try {
    for (;;) {
      const gen = wantedGen;
      const s = get();
      if (s.engineSession !== sid) return;
      const want = resolvedParams(s);
      const cut = engineCut(s);
      const d = sentParams
        ? paramsDelta(want, sentParams, s.gate, cut, sentCut)
        : { delta: wireParams(want, cut), layers: new Set(['shoot']) };
      if (Object.keys(d.delta).length) {
        await host().setParams(sid, d.delta);
        sentParams = want;
        sentCut = cut;
      }
      const reprint = d.layers.size === 1 && d.layers.has('print');
      const r = await host().render(sid, 'live', { reprint });
      if (get().engineSession !== sid) return;
      frameImages.print = r;
      set({ imageVersion: get().imageVersion + 1, badge: 'preview', status: '' });
      if (gen === wantedGen) break;
    }
  } catch (e) {
    noteError(tz('Render', '渲染'), e);
  } finally {
    inFlight = false;
  }
  scheduleFull();
}

function scheduleFull() {
  if (fullTimer) clearTimeout(fullTimer);
  // An export run renders the frame itself, at the file's own resolution.
  if (get().batchExporting) return;
  const gen = wantedGen;
  fullTimer = setTimeout(() => void renderFull(gen), FULL_DELAY_MS);
}

async function renderFull(gen: number) {
  const s = get();
  const sid = s.engineSession;
  if (!sid || inFlight || gen !== wantedGen) return;
  const native = s.nativeSize;
  // A frame no larger than the preview edge is already at its own size.
  if (native && Math.max(native.width, native.height) <= previewEdge()) {
    set({ badge: 'full' });
    await refreshThumb();
    return;
  }
  inFlight = true;
  try {
    const t0 = performance.now();
    const r = await host().render(sid, 'full');
    // Dropped when the generation, selection or session moved (ARCHITECTURE §7.3).
    if (gen !== wantedGen || get().engineSession !== sid) return;
    frameImages.print = r;
    platform().log('info', `session: full render ${r.width}x${r.height} landed in ${Math.round(performance.now() - t0)} ms`);
    set({ imageVersion: get().imageVersion + 1, badge: 'full' });
    await refreshThumb();
  } catch (e) {
    noteError(tz('Full render', '全尺寸渲染'), e);
  } finally {
    inFlight = false;
    if (gen !== wantedGen) void requestPrint();
  }
}

async function refreshThumb() {
  const s = get();
  if (!s.selection || !frameImages.print) return;
  const url = await makeThumbFromPrint(frameImages.print);
  if (url && get().selection === s.selection) {
    thumbs.setPrint(s.selection, url);
    set({ thumbVersion: get().thumbVersion + 1 });
  }
}

// -------------------------------------------------------------- persistence

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 500);
}

export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  } else return;
  const s = get();
  if (!s.selection) return;
  try {
    await platform().sidecarSave(s.selection, encodeSidecar(s.sidecar));
    set({ savedGeometry: { ...get().savedGeometry, [s.selection]: s.sidecar.geometry } });
  } catch (e) {
    noteError(tz('Saving settings', '保存设置'), e);
  }
}

function pushUndo() {
  const now = performance.now();
  if (now - lastUndoAt < 500) return;
  lastUndoAt = now;
  const sc = get().sidecar;
  const undo = [...get().undo, { params: sc.params, adjustments: sc.adjustments, geometry: sc.geometry, decode: sc.decode }].slice(-60);
  set({ undo, redo: [] });
}

/** The single door for a Layer 1 edit. */
export function setParams(fn: (p: FilmParams) => FilmParams) {
  const s = get();
  if (s.batchExporting) return;
  const next = fn(s.sidecar.params);
  if (jsonEqual(next, s.sidecar.params)) return;
  pushUndo();
  const geometry = filmEdgeWillChange(s.sidecar.params, next, s.sidecar.geometry);
  set({
    sidecar: { ...get().sidecar, params: next, geometry, state: get().sidecar.state === 'processed' ? 'stale' : get().sidecar.state },
    savedGeometry: s.selection && geometry !== s.sidecar.geometry ? { ...s.savedGeometry, [s.selection]: geometry } : s.savedGeometry,
  });
  scheduleSave();
  // A pair's gap is the camera's on the strip and the user's off it: the
  // piece is composed again (`HalfFramePair.effectiveSpacingMM`).
  if (get().pair && filmEdgeOn(s.sidecar.params, s.gate) !== filmEdgeOn(next, s.gate)) {
    setPair((p) => ({ ...p, onStrip: filmEdgeOn(next, get().gate) }));
    return;
  }
  void requestPrint();
}

/** A Layer 2 edit: one draw. */
export function setAdjustments(fn: (a: Adjustments) => Adjustments) {
  const s = get();
  const next = fn(s.sidecar.adjustments);
  if (jsonEqual(next, s.sidecar.adjustments)) return;
  pushUndo();
  set({ sidecar: { ...s.sidecar, adjustments: next } });
  scheduleSave();
}

/** A geometry edit: one draw (and the film format, when a crop re-maps it). */
export function setGeometry(fn: (g: Geometry) => Geometry, opts: { coalesce?: boolean } = {}) {
  const s = get();
  const next = fn(s.sidecar.geometry);
  if (jsonEqual(next, s.sidecar.geometry)) return;
  if (!opts.coalesce) pushUndo();
  set({ sidecar: { ...s.sidecar, geometry: next }, savedGeometry: s.selection ? { ...s.savedGeometry, [s.selection]: next } : s.savedGeometry });
  scheduleSave();
  if (settingsStore.getState().recalculateEffectsAfterCrop) recomputeFilmFormat();
  // While the engine cuts the frame the crop is in the negative.
  if (engineCut(get()) || sentCut) void requestPrint();
}

/**
 * A decode edit (camera white balance): the host decodes the file again
 * (`redecode`, R2) and the frame re-renders with the same params. Debounced:
 * a decode is the slow part of an open, so a drag decodes once it settles.
 */
export function setDecode(fn: (d: DecodeSettings) => DecodeSettings) {
  const s = get();
  if (s.batchExporting) return;
  const next = fn(s.sidecar.decode);
  if (jsonEqual(next, s.sidecar.decode)) return;
  pushUndo();
  set({ sidecar: { ...get().sidecar, decode: next, state: get().sidecar.state === 'processed' ? 'stale' : get().sidecar.state } });
  scheduleSave();
  scheduleRedecode();
}

/** Whether this host can re-decode (it lists `redecode` in `hello.methods`). */
export function hostRedecodes(methods: readonly string[] | undefined): boolean {
  return !!methods?.includes('redecode');
}

let decodeTimer: ReturnType<typeof setTimeout> | null = null;
/** The wire decode the engine session was last decoded with. */
let sentDecode: string | null = null;
const REDECODE_DELAY_MS = 350;

function scheduleRedecode() {
  if (decodeTimer) clearTimeout(decodeTimer);
  // Whatever full render was coming would show the old decode.
  if (fullTimer) clearTimeout(fullTimer);
  wantedGen++;
  decodeTimer = setTimeout(() => void redecodeNow(), REDECODE_DELAY_MS);
}

async function redecodeNow() {
  decodeTimer = null;
  const s = get();
  const sid = s.engineSession;
  if (!sid || !s.selection) return;
  const wire = decodeWire(s.sidecar.decode, isRawFrame());
  const key = JSON.stringify(wire);
  if (!wire || key === sentDecode || !hostRedecodes(s.hello?.methods)) {
    void requestPrint();
    return;
  }
  set({ redecoding: true, status: tz('Decoding with the new white balance…', '正在以新的白平衡解码…') });
  try {
    const r = await host().redecode(sid, wire);
    if (get().engineSession !== sid) return;
    sentDecode = key;
    set({ nativeSize: { width: r.width, height: r.height }, metadata: r.metadata ?? get().metadata, status: '' });
    void requestPrint();
  } catch (e) {
    noteError(tz('White balance', '白平衡'), e);
  } finally {
    set({ redecoding: false });
  }
}

function isRawFrame(): boolean {
  const s = get();
  if (s.frameKind) return s.frameKind === 'raw';
  return !!s.selection && isRawPath(s.selection);
}

export function beginGesture() {
  pushUndo();
  lastUndoAt = performance.now();
}

function restore(e: UndoEntry) {
  const s = get();
  const decodeMoved = !jsonEqual(e.decode, s.sidecar.decode);
  set({ sidecar: { ...s.sidecar, params: e.params, adjustments: e.adjustments, geometry: e.geometry, decode: e.decode } });
  scheduleSave();
  if (decodeMoved) scheduleRedecode();
  else void requestPrint();
}

export function undo() {
  const s = get();
  if (s.batchExporting || !s.selection) return;
  const prev = s.undo[s.undo.length - 1];
  if (!prev) return;
  const cur = { params: s.sidecar.params, adjustments: s.sidecar.adjustments, geometry: s.sidecar.geometry, decode: s.sidecar.decode };
  set({ undo: s.undo.slice(0, -1), redo: [...s.redo, cur] });
  lastUndoAt = 0;
  restore(prev);
  set({ status: tz(`Undo — ${get().undo.length} steps left.`, `撤销 — 还剩 ${get().undo.length} 步。`) });
}

export function redo() {
  const s = get();
  if (s.batchExporting || !s.selection) return;
  const next = s.redo[s.redo.length - 1];
  if (!next) return;
  const cur = { params: s.sidecar.params, adjustments: s.sidecar.adjustments, geometry: s.sidecar.geometry, decode: s.sidecar.decode };
  set({ redo: s.redo.slice(0, -1), undo: [...s.undo, cur] });
  lastUndoAt = 0;
  restore(next);
}

// ------------------------------------------------------------ film format

function aspectOf(): number {
  const n = get().nativeSize;
  if (!n) return 1.5;
  const g = get().sidecar.geometry;
  if (settingsStore.getState().recalculateEffectsAfterCrop) {
    const o = outputSize(g, n);
    return Math.max(o.width, o.height) / Math.min(o.width, o.height);
  }
  return Math.max(n.width, n.height) / Math.max(1, Math.min(n.width, n.height));
}

function cropScale(): number {
  if (!settingsStore.getState().recalculateEffectsAfterCrop) return 1;
  const c = get().sidecar.geometry.crop;
  return 1 / Math.max(Math.max(c.width, c.height), 1e-3);
}

function derived(side: FilmSide, mm: number) {
  return filmFormatMM(side, mm, aspectOf(), cropScale());
}

export function recomputeFilmFormat() {
  const p = get().sidecar.params;
  const mm = derived(p.filmSide, p.sideLengthMM);
  // Derived, not an edit: no undo step (the Mac writes it before the open).
  if (Math.abs(mm - p.filmFormatMM) > 0.001) {
    set({ sidecar: { ...get().sidecar, params: { ...get().sidecar.params, filmFormatMM: mm } } });
    scheduleSave();
    void requestPrint();
  }
}

export function setFilmFrame(id: string) {
  setParams((p) => {
    const f = filmFrameNamed(id);
    const side = id === FILM_FRAME_CUSTOM.id ? p.sideLengthMM : p.filmSide === 'short' ? f.short : f.long;
    return { ...p, filmFrame: f.id, sideLengthMM: side, filmFormatMM: derived(p.filmSide, side) };
  });
}
export function setFilmSide(side: FilmSide) {
  setParams((p) => {
    const mm = p.filmFrame !== FILM_FRAME_CUSTOM.id ? (side === 'short' ? filmFrameNamed(p.filmFrame).short : filmFrameNamed(p.filmFrame).long) : p.sideLengthMM;
    return { ...p, filmSide: side, sideLengthMM: mm, filmFormatMM: derived(side, mm) };
  });
}
export function setSideLengthMM(mm: number) {
  setParams((p) => {
    const v = clamp(mm, 1, 500);
    return { ...p, filmFrame: FILM_FRAME_CUSTOM.id, sideLengthMM: v, filmFormatMM: derived(p.filmSide, v) };
  });
}

// ------------------------------------------------------------------ library

export async function openFolder(dir: string) {
  if (get().batchExporting) return;
  try {
    const files = await platform().listImages(dir);
    await setLibrary(dir, files);
    settingsStore.getState().set('lastFolder', dir);
    if (files[0]) await select(files[0].path);
  } catch (e) {
    noteError(tz('Opening the folder', '打开文件夹'), e);
  }
}

/** One door for dropped, argv and dialog paths (`Session.dropped(files:)`). */
export async function openPaths(paths: string[]) {
  if (get().batchExporting || !paths.length) return;
  try {
    const entries = await platform().expandPaths(paths);
    if (!entries.length) {
      set({ status: tz('Nothing there SpektraLab can open.', '没有 SpektraLab 能打开的文件。') });
      return;
    }
    // One file is "edit this": its folder comes along around it.
    if (entries.length === 1 && paths.length === 1 && paths[0] === entries[0]!.path) {
      const dir = dirName(entries[0]!.path);
      const all = await platform().listImages(dir).catch(() => entries);
      await setLibrary(dir, all.length ? all : entries);
      await select(entries[0]!.path);
      return;
    }
    const known = new Set(get().frames.map((f) => f.path));
    if (entries.every((e) => known.has(e.path))) {
      await select(entries[0]!.path);
      return;
    }
    const folder = paths.length === 1 ? paths[0]! : dirName(entries[0]!.path);
    await setLibrary(folder, entries);
    await select(entries[0]!.path);
  } catch (e) {
    noteError(tz('Opening', '打开'), e);
  }
}

async function setLibrary(folder: string, photos: FileEntry[]) {
  const files = [...photos, ...(await pairEntries(folder).catch(() => []))];
  await flushSave();
  await closeEngineSession();
  thumbs.reset();
  frameImages.print = null;
  frameImages.original = null;
  set({ folder, frames: files, selection: null, picked: [], savedGeometry: {}, thumbVersion: get().thumbVersion + 1, imageVersion: get().imageVersion + 1, badge: null });
  void platform().setTitle(`SpektraLab — ${baseName(folder)}`);
  // The thumbnails' crop masks come from each frame's saved geometry.
  void Promise.all(
    files.map(async (f) => {
      const raw = await platform().sidecarLoad(f.path).catch(() => null);
      return raw ? ([f.path, decodeSidecar(raw).geometry] as const) : null;
    }),
  ).then((rows) => {
    const g: Record<string, Geometry> = {};
    for (const r of rows) if (r) g[r[0]] = r[1];
    set({ savedGeometry: { ...g, ...get().savedGeometry } });
  });
}

// -------------------------------------------------------- half-frame pairs
//
// HalfFramePair.swift: a pair is a file in `<app data>/Pairs`, listed in the
// filmstrip of the folder it belongs to (`Pairs/index.json`), opened through
// the host's `open_pair`. Its look is its own sidecar, as a frame's is.

interface PairIndex {
  pairs: { name: string; folder: string }[];
}

let pairsDir: string | null = null;
async function pairsDirectory(): Promise<string> {
  if (!pairsDir) pairsDir = `${(await platform().appPaths()).appData}/${PAIR_AREA}`;
  return pairsDir;
}
const pairName = (path: string) => path.split(/[\\/]/).pop() ?? path;

async function readIndex(): Promise<PairIndex> {
  const v = (await platform().storeRead(PAIR_AREA, 'index.json').catch(() => null)) as PairIndex | null;
  return v && Array.isArray(v.pairs) ? v : { pairs: [] };
}

async function loadPair(path: string): Promise<HalfFramePair | null> {
  return decodePair(await platform().storeRead(PAIR_AREA, pairName(path)).catch(() => null));
}

/** The pairs of `folder`, as filmstrip entries. */
async function pairEntries(folder: string): Promise<FileEntry[]> {
  const dir = await pairsDirectory().catch(() => null);
  if (!dir) return [];
  const out: FileEntry[] = [];
  for (const e of (await readIndex()).pairs) {
    if (e.folder !== folder) continue;
    const pair = await loadPair(`${dir}/${e.name}`);
    if (pair) out.push({ path: `${dir}/${e.name}`, name: pairLabel(pair), size: 0, mtime_ms: 0 });
  }
  return out;
}

/**
 * ⌘J on the Mac: the picked photos (one or two, frames not pairs) become a new
 * pair after the last of them, open on the canvas with Film Edge on Half.
 */
export async function makePair(): Promise<void> {
  const s = get();
  if (s.batchExporting || !s.folder) return;
  const photos = s.picked.filter((p) => !isPairPath(p)).slice(0, 2);
  if (!photos.length) {
    set({ status: tz('Pick one or two photos to make a half-frame pair.', '请选择一张或两张照片来组成半格配对。') });
    return;
  }
  const dir = await pairsDirectory();
  const index = await readIndex();
  const name = newPairName(s.folder, index.pairs.map((p) => p.name));
  const pair: HalfFramePair = {
    schemaVersion: 1,
    folder: s.folder,
    left: newHole(photos[0]!),
    right: photos[1] ? newHole(photos[1]) : null,
    spacingMM: 1,
    onStrip: false,
    turned: false,
  };
  await platform().storeWrite(PAIR_AREA, name, encodePair(pair));
  await platform().storeWrite(PAIR_AREA, 'index.json', { pairs: [...index.pairs, { name, folder: s.folder }] });
  const path = `${dir}/${name}`;
  // The pair's look starts as the first frame's, on half frames.
  const first = await platform().sidecarLoad(photos[0]!).catch(() => null);
  const look = first ? decodeSidecar(first) : newSidecar();
  const sidecar = { ...newSidecar(), params: { ...look.params, filmEdge: { ...look.params.filmEdge, format: '135_half' } } };
  await platform().sidecarSave(path, encodeSidecar(sidecar));
  const entry: FileEntry = { path, name: pairLabel(pair), size: 0, mtime_ms: 0 };
  const frames = [...get().frames];
  const after = Math.max(...photos.map((p) => frames.findIndex((f) => f.path === p)));
  frames.splice(after + 1, 0, entry);
  set({ frames, picked: [path] });
  await select(path);
}

let pairTimer: ReturnType<typeof setTimeout> | null = null;
/** An edit of the open pair's piece: saved, and the piece composed again. */
export function setPair(fn: (p: HalfFramePair) => HalfFramePair) {
  const s = get();
  if (!s.pair || !s.selection || s.batchExporting) return;
  const next = fn(s.pair);
  if (jsonEqual(next, s.pair)) return;
  set({ pair: next });
  const path = s.selection;
  if (pairTimer) clearTimeout(pairTimer);
  pairTimer = setTimeout(() => {
    pairTimer = null;
    void (async () => {
      await platform().storeWrite(PAIR_AREA, pairName(path), encodePair(get().pair ?? next));
      const label = pairLabel(get().pair ?? next);
      set({ frames: get().frames.map((f) => (f.path === path ? { ...f, name: label } : f)) });
      if (get().selection !== path) return;
      await closeEngineSession();
      void develop(path, ++openGen);
    })();
  }, 300);
}

export function swapPairHoles() {
  setPair((p) => ({ ...p, left: p.right, right: p.left }));
}

export function setPairHole(side: PairSide, path: string | null) {
  setPair((p) => ({ ...p, [side]: path ? (p[side]?.path === path ? p[side] : newHole(path)) : null }));
}

async function closeEngineSession() {
  const sid = get().engineSession;
  set({ engineSession: null });
  sentParams = null;
  sentDecode = null;
  wantedGen++;
  if (fullTimer) clearTimeout(fullTimer);
  if (decodeTimer) clearTimeout(decodeTimer);
  decodeTimer = null;
  if (sid) await host().close(sid).catch(() => {});
}

/** A plain click: picks exactly this frame and opens it (`Session.click`). */
export function click(path: string, additive = false) {
  const s = get();
  if (s.batchExporting) return;
  if (!additive) {
    set({ picked: [path] });
    void select(path);
    return;
  }
  togglePick(path);
}

export function togglePick(path: string) {
  const s = get();
  if (s.batchExporting) return;
  if (!s.picked.includes(path)) set({ picked: [...s.picked, path] });
  else if (path !== s.selection) set({ picked: s.picked.filter((p) => p !== path) });
}

export function selectAllFrames() {
  const s = get();
  if (s.batchExporting || !s.frames.length) return;
  set({ picked: s.frames.map((f) => f.path) });
  if (!s.selection) void select(s.frames[0]!.path);
}

export function selectRelative(delta: number) {
  const s = get();
  if (s.batchExporting || !s.selection) return;
  const i = s.frames.findIndex((f) => f.path === s.selection);
  const j = clamp(i + delta, 0, s.frames.length - 1);
  if (i >= 0 && j !== i) click(s.frames[j]!.path);
}

/**
 * Put a frame on the canvas. **Not guarded by `batchExporting`**: it is the
 * export run's own door (AGENTS.md trap 34). Everything a person does goes
 * through `click`/`openPaths`, which are.
 */
export async function select(path: string): Promise<void> {
  if (path === get().selection && get().engineSession) return;
  const gen = ++openGen;
  await flushSave();
  await closeEngineSession();
  frameImages.print = null;
  frameImages.original = null;
  const raw = await platform().sidecarLoad(path).catch(() => null);
  if (gen !== openGen) return;
  const sidecar = raw ? decodeSidecar(raw) : newSidecar();
  heldCrop = null;
  set({
    pair: null,
    pairMetadataB: null,
    selection: path,
    picked: get().picked.includes(path) ? get().picked : [path],
    sidecar,
    nativeSize: null,
    metadata: null,
    frameKind: null,
    badge: null,
    undo: [],
    redo: [],
    imageVersion: get().imageVersion + 1,
    view: { fit: true, zoom: 1, cx: 0.5, cy: 0.5 },
    showingOriginal: false,
    status: tz(`Opening ${baseName(path)}…`, `正在打开 ${baseName(path)}…`),
  });
  void loadOriginal(path, gen);
  await develop(path, gen);
}

async function loadOriginal(path: string, gen: number) {
  try {
    const img = await host().thumbnail(path, 2048);
    if (gen !== openGen) return;
    frameImages.original = img;
    set({ imageVersion: get().imageVersion + 1 });
  } catch {
    /* no original to compare against; the print still shows */
  }
}

async function develop(path: string, gen: number) {
  if (get().hostState.phase !== 'ready') {
    set({ status: tz('Waiting for the engine…', '正在等待引擎…') });
    return;
  }
  set({ developing: true });
  try {
    const t0 = performance.now();
    const params = resolvedParams(get());
    const decode = decodeWire(get().sidecar.decode, isRawPath(path));
    const cut = engineCut(get());
    let r;
    if (isPairPath(path)) {
      const pair = await loadPair(path);
      if (!pair) throw new Error(tz('The pair file cannot be read.', '无法读取配对文件。'));
      set({ pair });
      const sent = resolvedParams(get());
      r = await host().openPair(openPairRequest({ ...pair, onStrip: filmEdgeOn(sent, get().gate) }), wireParams(sent, null));
      set({ pairMetadataB: r.metadata_b ?? null });
    } else try {
      r = await host().open(path, wireParams(params, cut), decode);
    } catch (e) {
      // A host without R2 refuses the decode key: open with the camera's own.
      if (!(decode && e instanceof HostCallError && e.code === 'unsupported')) throw e;
      r = await host().open(path, wireParams(params, cut));
    }
    if (gen !== openGen) {
      void host().close(r.session).catch(() => {});
      return;
    }
    sentParams = params;
    sentCut = cut;
    sentDecode = JSON.stringify(decode);
    set({ engineSession: r.session, nativeSize: { width: r.width, height: r.height }, metadata: r.metadata, frameKind: r.kind ?? (isRawPath(path) ? 'raw' : null) });
    noteAsShot();
    platform().log(
      'info',
      `session: open path (ms): decode ${r.timings_ms?.decode ?? '?'} · open ${r.timings_ms?.open ?? '?'} · TOTAL ${Math.round(performance.now() - t0)} · core=${get().hello?.capabilities?.backend?.render_core ?? '?'}`,
    );
    recomputeFilmFormat();
    // `recomputeFilmFormat` may have queued a render already.
    if (!inFlight) await requestPrint();
    const sc = get().sidecar;
    if (sc.state === 'unprocessed') {
      set({ sidecar: { ...sc, state: 'processed' } });
      scheduleSave();
    }
  } catch (e) {
    noteError(tz(`Opening ${baseName(path)}`, `打开 ${baseName(path)}`), e);
  } finally {
    if (gen === openGen) set({ developing: false });
  }
}

/** Process: auto-exposure and the enlarger's filter pack for this paper. */
export async function solveNow() {
  const s = get();
  if (!s.engineSession || s.developing) return;
  set({ developing: true, status: tz('Solving…', '正在配光…') });
  try {
    await host().solve(s.engineSession, 'both');
    // The pack is the engine's now; the user's shifts return to neutral.
    sentParams = null;
    setParams((p) => ({ ...p, yFilterShift: 0, mFilterShift: 0 }));
    void requestPrint();
    set({ status: tz('Solved.', '配光完成。') });
  } catch (e) {
    noteError(tz('Process', '配光'), e);
  } finally {
    set({ developing: false });
  }
}

export function resetParams() {
  setParams((p) => ({
    ...p,
    exposureCompensationEV: 0,
    autoExposure: true,
    autoExposureMethod: 'balanced',
    printBrightnessStops: 0,
    yFilterShift: 0,
    mFilterShift: 0,
    preflashExposure: 0,
  }));
}
export function resetAdjustments() {
  setAdjustments(() => ({ ...ADJUSTMENTS_DEFAULT }));
}
export function resetCrop() {
  setGeometry(() => GEOMETRY_DEFAULT);
}

// ---------------------------------------------------------------- clipboard

export function copySettings() {
  const s = get();
  if (!s.selection || !s.clipboardGroups.length) return;
  set({
    clipboard: { groups: s.clipboardGroups, settings: s.sidecar, sourceName: baseName(s.selection) },
    status: tz(`Copied ${s.clipboardGroups.length} groups from ${baseName(s.selection)}.`, `已从 ${baseName(s.selection)} 拷贝 ${s.clipboardGroups.length} 组设置。`),
  });
}

async function pasteOffline(clip: SettingsClip, path: string): Promise<boolean> {
  const raw = await platform().sidecarLoad(path).catch(() => null);
  const target = raw ? decodeSidecar(raw) : newSidecar();
  if (!clipChanges(clip, target)) return false;
  const next = applyClip(clip, target);
  await platform().sidecarSave(path, encodeSidecar({ ...next, state: next.state === 'processed' ? 'stale' : next.state }));
  return true;
}

export async function pasteSettings() {
  const s = get();
  const clip = s.clipboard;
  if (!clip || !s.selection || s.batchExporting) return;
  const targets = s.picked.length ? s.picked : [s.selection];
  let written = 0;
  for (const p of targets) if (p !== s.selection && (await pasteOffline(clip, p))) written++;
  if (targets.includes(s.selection) && clipChanges(clip, get().sidecar)) {
    const next = applyClip(clip, get().sidecar);
    setParams(() => next.params);
    const decodeMoved = !jsonEqual(next.decode, get().sidecar.decode);
    set({ sidecar: { ...get().sidecar, decode: next.decode, placementNeedsFit: next.placementNeedsFit } });
    if (decodeMoved) scheduleRedecode();
    written++;
  }
  set({
    status:
      written === 0
        ? tz('Nothing to paste — the frames already have these settings.', '无需粘贴——这些照片已经是这些设置。')
        : tz(`Pasted ${clip.groups.length} groups onto ${written} frames.`, `已将 ${clip.groups.length} 组设置粘贴到 ${written} 张照片。`),
  });
}

export async function syncSettings() {
  const s = get();
  if (s.batchExporting || !s.selection) return;
  const clip = { groups: s.clipboardGroups, settings: s.sidecar, sourceName: baseName(s.selection) };
  let written = 0;
  for (const p of s.picked) if (p !== s.selection && (await pasteOffline(clip, p))) written++;
  set({ status: tz(`Synced to ${written} frames.`, `已同步到 ${written} 张照片。`) });
}

// --------------------------------------------------------------------- view

export const ZOOM_STEPS = [0.0625, 0.125, 0.25, 0.333, 0.5, 0.667, 1, 2, 3, 4, 8, 16];

export function setView(v: Partial<ViewState>) {
  set({ view: { ...get().view, ...v } });
}
export function zoomToFit() {
  setView({ fit: true, cx: 0.5, cy: 0.5 });
}
export function zoomTo(zoom: number) {
  setView({ fit: false, zoom });
}
/** `fitZoom` is the zoom the fit currently implies (the canvas knows it). */
export function zoomStep(dir: 1 | -1, fitZoom: number) {
  const cur = get().view.fit ? fitZoom : get().view.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur * 1.001) : [...ZOOM_STEPS].reverse().find((z) => z < cur * 0.999);
  if (next) setView({ fit: false, zoom: next });
}
export let currentFitZoom = 1;
export function noteCanvasPx(width: number, height: number) {
  const c = get().canvasPx;
  if (c.width !== width || c.height !== height) set({ canvasPx: { width, height } });
}
export function noteFitZoom(z: number) {
  currentFitZoom = z;
  if (Math.abs(get().fitZoom - z) > 1e-4) set({ fitZoom: z });
}

export function setTool(tool: Tool) {
  const was = engineCut(get());
  set({ tool });
  // Entering the crop tool shows the uncut print to frame; leaving it
  // develops the new framing.
  if (!jsonEqual(was, engineCut(get()))) void requestPrint();
}
export function setOriginal(on: boolean) {
  set({ showingOriginal: on });
}
export function toggleCompare() {
  set({ comparing: !get().comparing });
}
export function setComparePosition(p: number) {
  const v = clamp(p, 0, 1);
  if (v !== get().comparePosition) set({ comparePosition: v });
}

export function setPages(p: Partial<Pick<SessionState, 'exportOpen' | 'settingsOpen' | 'aboutOpen' | 'batchExporting' | 'clipboardGroups'>>) {
  set(p);
}
export function setStatus(status: string) {
  set({ status });
}

// --------------------------------------------------------------------- boot

let lastReadyHello: unknown = null;

function takeHostState(st: HostState) {
  // The host answers but its engine could not start (no Vulkan device): the
  // files still list and thumbnail, nothing develops. Shown as a failure with
  // the host's own words.
  if (st.phase === 'ready' && st.hello.backend?.available === false) {
    set({
      hello: st.hello,
      hostState: { phase: 'failed', reason: st.hello.backend.error || tz('The engine has no GPU device to render on.', '引擎没有可用于渲染的 GPU 设备。'), detail: st.hello.build_info },
    });
    return;
  }
  set({ hostState: st });
  if (st.phase === 'ready') {
    const unsupported = (st.hello.capabilities?.backend?.unsupported_features as string[] | undefined) ?? [];
    set({
      hello: st.hello,
      unsupported,
      gate: featureGate(unsupported, settingsStore.getState().diBlueCompensation),
    });
    // A new host (first start or a restart): re-open the frame from its sidecar.
    if (lastReadyHello !== st.hello) {
      lastReadyHello = st.hello;
      const sel = get().selection;
      if (sel && !get().engineSession) {
        const gen = ++openGen;
        void develop(sel, gen);
      } else if (sel) {
        set({ engineSession: null });
        sentParams = null;
        const gen = ++openGen;
        void develop(sel, gen);
      }
    }
  } else if (st.phase === 'restarting' || st.phase === 'failed') {
    set({ engineSession: null, status: st.phase === 'failed' ? st.reason : tz('Restarting the engine…', '正在重启引擎…') });
    sentParams = null;
  }
}

export async function boot() {
  host().onState(takeHostState);
  void loadCatalog().then((catalog) => set({ catalog }));
  takeHostState(await host().state());
  platform().onOpenPaths((paths) => void openPaths(paths));
  platform().onDrop((paths) => void openPaths(paths));
  const launch = await platform().takeLaunchPaths();
  if (launch.length) await openPaths(launch);
  window.addEventListener('beforeunload', () => void flushSave());
}

/** For tests and the export run. */
export function _internals() {
  return { get, set };
}
