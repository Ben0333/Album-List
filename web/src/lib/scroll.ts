interface StoredScrollPosition {
  x: number;
  y: number;
  updatedAt: number;
}

const STORAGE_KEY = 'albums_scroll_positions_v1';
const HISTORY_SCROLL_KEY = '__albumsScroll';
const MAX_POSITIONS = 120;
const RESTORE_TIMEOUT_MS = 3000;

let positions: Record<string, StoredScrollPosition> | null = null;
let saveTimer: number | null = null;
let restoreFrame: number | null = null;
let restoreRun = 0;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function currentKey(): string {
  return `${window.location.pathname}${window.location.search}` || '/';
}

function loadPositions(): Record<string, StoredScrollPosition> {
  if (positions) return positions;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || '{}');
    positions = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    positions = {};
  }
  if (!positions) positions = {};
  return positions;
}

function persistPositions(): void {
  if (!positions) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Storage can be unavailable in private browsing modes.
  }
}

function prunePositions(): void {
  const loaded = loadPositions();
  const entries = Object.entries(loaded);
  if (entries.length <= MAX_POSITIONS) return;
  entries
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, entries.length - MAX_POSITIONS)
    .forEach(([key]) => {
      delete loaded[key];
    });
}

function isStoredPosition(value: unknown): value is StoredScrollPosition {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<StoredScrollPosition>;
  return Number.isFinite(maybe.x) && Number.isFinite(maybe.y);
}

function historyPosition(): StoredScrollPosition | null {
  const state = window.history.state as Record<string, unknown> | null;
  const value = state?.[HISTORY_SCROLL_KEY];
  return isStoredPosition(value) ? value : null;
}

function savedPositionForCurrentRoute(): StoredScrollPosition | null {
  return historyPosition() ?? loadPositions()[currentKey()] ?? null;
}

export function hasSavedScrollForRoute(path: string): boolean {
  if (!isBrowser()) return false;
  return Boolean(loadPositions()[path]);
}

export function saveCurrentScroll(): void {
  if (!isBrowser()) return;
  const position = {
    x: Math.max(0, Math.round(window.scrollX)),
    y: Math.max(0, Math.round(window.scrollY)),
    updatedAt: Date.now()
  };
  const loaded = loadPositions();
  loaded[currentKey()] = position;
  prunePositions();
  persistPositions();

  const state = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
  try {
    window.history.replaceState({ ...state, [HISTORY_SCROLL_KEY]: position }, '');
  } catch {
    // Ignore state write failures; sessionStorage still carries the fallback.
  }
}

function queueSave(): void {
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveCurrentScroll();
  }, 75);
}

function cancelRestore(): void {
  restoreRun += 1;
  if (restoreFrame !== null) {
    window.cancelAnimationFrame(restoreFrame);
    restoreFrame = null;
  }
}

function restorePosition(position: StoredScrollPosition): void {
  cancelRestore();
  const run = restoreRun;
  const startedAt = performance.now();
  const targetX = Math.max(0, position.x);
  const targetY = Math.max(0, position.y);

  const attempt = () => {
    if (run !== restoreRun) return;
    window.scrollTo(targetX, targetY);
    const maxY = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    ) - window.innerHeight;
    const clampedTargetY = Math.min(targetY, Math.max(0, maxY));
    const reached = Math.abs(window.scrollY - clampedTargetY) <= 2;
    const contentCanReachTarget = targetY <= Math.max(0, maxY);

    if ((reached && contentCanReachTarget) || performance.now() - startedAt > RESTORE_TIMEOUT_MS) {
      restoreFrame = null;
      return;
    }

    restoreFrame = window.requestAnimationFrame(attempt);
  };

  restoreFrame = window.requestAnimationFrame(attempt);
}

export function restoreScrollForCurrentRoute(options: { fallbackToTop?: boolean } = {}): void {
  if (!isBrowser()) return;
  const saved = savedPositionForCurrentRoute();
  if (saved) {
    restorePosition(saved);
    return;
  }
  if (options.fallbackToTop) {
    restorePosition({ x: 0, y: 0, updatedAt: Date.now() });
  }
}

export function setupScrollRestoration(): () => void {
  if (!isBrowser()) return () => {};
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }

  restoreScrollForCurrentRoute();

  window.addEventListener('scroll', queueSave, { passive: true });
  window.addEventListener('beforeunload', saveCurrentScroll);
  window.addEventListener('pagehide', saveCurrentScroll);
  document.addEventListener('visibilitychange', saveCurrentScroll);

  return () => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    cancelRestore();
    window.removeEventListener('scroll', queueSave);
    window.removeEventListener('beforeunload', saveCurrentScroll);
    window.removeEventListener('pagehide', saveCurrentScroll);
    document.removeEventListener('visibilitychange', saveCurrentScroll);
  };
}
