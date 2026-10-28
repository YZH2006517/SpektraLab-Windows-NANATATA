// Boot against a host whose "ready" lands while the window is still asking for
// its state: the race that left the window waiting for the engine forever.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Cb = (s: unknown) => void;
const hostMock = {
  listener: null as Cb | null,
  answer: { phase: 'starting' } as unknown,
  onAsk: null as (() => void) | null,
};
const HELLO = { protocol: 1, backend: { available: true }, capabilities: { backend: { unsupported_features: [] } }, methods: [] };

vi.mock('../host/client', () => {
  class HostCallError extends Error {
    code = 'internal';
  }
  const h = {
    subscribeState: vi.fn(async (cb: Cb) => {
      hostMock.listener = cb;
      return () => {};
    }),
    state: vi.fn(async () => {
      const a = hostMock.answer;
      hostMock.onAsk?.();
      return a;
    }),
  };
  return { HostCallError, host: () => h };
});
vi.mock('../platform', () => ({
  platform: () => ({
    log: () => {},
    onOpenPaths: () => () => {},
    onDrop: () => () => {},
    takeLaunchPaths: async () => [],
    setTitle: async () => {},
  }),
  baseName: (p: string) => p,
  dirName: (p: string) => p,
}));
vi.mock('@shared/stocks', async (orig) => ({ ...(await orig<object>()), loadCatalog: async () => ({ stocks: [] }) }));

import { boot, sessionStore } from './session';

vi.stubGlobal('window', { addEventListener: () => {} });

describe('boot', () => {
  beforeEach(() => {
    hostMock.listener = null;
    hostMock.onAsk = null;
    sessionStore.setState({ hostState: { phase: 'starting' } as never });
  });

  it('keeps a "ready" heard while asking, over the older answer', async () => {
    hostMock.answer = { phase: 'starting' };
    // The host turns ready after it answered "starting" but before the
    // answer reached the window.
    hostMock.onAsk = () => hostMock.listener?.({ phase: 'ready', hello: HELLO });
    await boot();
    expect(sessionStore.getState().hostState.phase).toBe('ready');
  });

  it('asks again while starting, so a lost event cannot leave it waiting', async () => {
    vi.useFakeTimers();
    hostMock.answer = { phase: 'starting' };
    await boot();
    expect(sessionStore.getState().hostState.phase).toBe('starting');
    hostMock.answer = { phase: 'ready', hello: HELLO };
    await vi.advanceTimersByTimeAsync(2100);
    expect(sessionStore.getState().hostState.phase).toBe('ready');
    vi.useRealTimers();
  });
});
