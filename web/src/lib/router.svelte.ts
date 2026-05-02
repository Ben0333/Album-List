type RouteState = {
  path: string;
  search: URLSearchParams;
};

function read(): RouteState {
  return {
    path: window.location.pathname,
    search: new URLSearchParams(window.location.search)
  };
}

export const route = $state<RouteState>(read());

window.addEventListener('popstate', () => {
  Object.assign(route, read());
});

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  if (options.replace) {
    window.history.replaceState(null, '', to);
  } else {
    window.history.pushState(null, '', to);
  }
  Object.assign(route, read());
}

export function interceptLinks(root: HTMLElement = document.body): void {
  root.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('#')) return;
    if (anchor.target && anchor.target !== '_self') return;
    event.preventDefault();
    navigate(href);
  });
}
