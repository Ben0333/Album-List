import { hasSavedScrollForRoute, restoreScrollForCurrentRoute, saveCurrentScroll } from './scroll';

export type Route =
  | { type: 'home' }
  | { type: 'login' }
  | { type: 'album'; albumKey: string }
  | { type: 'list'; id: number; albumId: number | null }
  | { type: 'share'; token: string; albumId: number | null }
  | { type: 'invite'; token: string }
  | { type: 'history'; token: string; albumKey: string | null }
  | { type: 'profile'; username: string; albumKey: string | null }
  | { type: 'explore'; slug: string | null; albumIndex: number | null };

function parseRoute(): Route {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'login') return { type: 'login' };
  if (parts[0] === 'album' && parts[1]) return { type: 'album', albumKey: decodeURIComponent(parts[1]) };
  if (parts[0] === 'explore') {
    return {
      type: 'explore',
      slug: parts[1] ?? null,
      albumIndex: parts[2] === 'album' && parts[3] ? Number(parts[3]) : null
    };
  }
  if (parts[0] === 'list' && parts[1]) {
    return {
      type: 'list',
      id: Number(parts[1]),
      albumId: parts[2] === 'album' && parts[3] ? Number(parts[3]) : null
    };
  }
  if (parts[0] === 'share' && parts[1]) {
    return {
      type: 'share',
      token: parts[1],
      albumId: parts[2] === 'album' && parts[3] ? Number(parts[3]) : null
    };
  }
  if (parts[0] === 'invite' && parts[1]) return { type: 'invite', token: parts[1] };
  if (parts[0] === 'history' && parts[1]) {
    return {
      type: 'history',
      token: parts[1],
      albumKey: parts[2] === 'album' && parts[3] ? decodeURIComponent(parts[3]) : null
    };
  }
  if (parts[0] === 'u' && parts[1]) {
    return {
      type: 'profile',
      username: decodeURIComponent(parts[1]),
      albumKey: parts[2] === 'album' && parts[3] ? decodeURIComponent(parts[3]) : null
    };
  }
  return { type: 'home' };
}

let _route = $state<Route>(parseRoute());

export const router = {
  get current(): Route {
    return _route;
  }
};

window.addEventListener('popstate', () => {
  _route = parseRoute();
  restoreScrollForCurrentRoute({ fallbackToTop: true });
});

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  const from = window.location.pathname + window.location.search;
  saveCurrentScroll();
  const hasSavedTargetScroll = hasSavedScrollForRoute(to);
  if (options.replace) {
    const state = window.history.state as { from?: string } | null;
    window.history.replaceState(state?.from ? { from: state.from } : {}, '', to);
  } else {
    window.history.pushState({ from }, '', to);
  }
  _route = parseRoute();
  restoreScrollForCurrentRoute({ fallbackToTop: !hasSavedTargetScroll });
}

export function followInternalLink(event: MouseEvent, to: string, options: { replace?: boolean } = {}): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(to, options);
}
