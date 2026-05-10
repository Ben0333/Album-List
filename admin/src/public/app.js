const root = document.querySelector('#app');
let csrfToken = sessionStorage.getItem('albumsAdminCsrf') || '';
let currentUsers = { q: '', status: 'all', limit: 25, offset: 0 };
let currentReports = { q: '', status: '', priority: '', limit: 25, offset: 0 };
let editingReportId = null;
let currentRoute = normalizeAdminPath(window.location.pathname);
let pollTimer = null;
let pollBusy = false;
let routingBound = false;

const reportStatuses = [
  ['open', 'Open'],
  ['in_progress', 'In progress'],
  ['fixed', 'Fixed'],
  ['wont_fix', "Won't fix"]
];
const reportPriorities = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['critical', 'Critical']
];
const adminPages = [
  { path: '/admin/', label: 'Overview', title: 'Overview' },
  { path: '/admin/users', label: 'Users', title: 'Users' },
  { path: '/admin/bugs', label: 'Bugs', title: 'Bugs to Fix' },
  { path: '/admin/explore', label: 'Explore', title: 'Explore Playlists' }
];
const pollIntervalMs = 10_000;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function optionList(options, selected) {
  return options.map(([value, label]) => {
    const option = el('option', { value, text: label });
    if (value === selected) option.selected = true;
    return option;
  });
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function showNotice(message, danger = false) {
  const target = document.querySelector('#admin-notice');
  if (!target) return window.alert(message);
  target.className = danger ? 'error' : 'notice';
  target.textContent = message;
  target.hidden = false;
}

function normalizeAdminPath(pathname) {
  const path = String(pathname || '/admin/').replace(/\/+$/, '') || '/admin';
  if (path === '/admin' || path === '/admin/index.html') return '/admin/';
  if (path === '/admin/bug') return '/admin/bugs';
  if (adminPages.some((page) => page.path === path)) return path;
  return '/admin/';
}

function activePage() {
  return adminPages.find((page) => page.path === currentRoute) || adminPages[0];
}

function bindRouting() {
  if (routingBound) return;
  routingBound = true;
  window.addEventListener('popstate', () => {
    currentRoute = normalizeAdminPath(window.location.pathname);
    renderPage();
  });
}

function navigateAdmin(path) {
  const next = normalizeAdminPath(path);
  if (next === currentRoute) return;
  currentRoute = next;
  history.pushState({}, '', next);
  renderPage();
}

function navLink(page) {
  return el(
    'a',
    {
      href: page.path,
      className: page.path === currentRoute ? 'active' : '',
      onclick: (event) => {
        event.preventDefault();
        navigateAdmin(page.path);
      }
    },
    page.label
  );
}

function setPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    refreshActivePage({ silent: true }).catch(() => {});
  }, pollIntervalMs);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  pollBusy = false;
}

function userIsEditingWithin(target) {
  const active = document.activeElement;
  if (!target || !active || !target.contains(active)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
}

function updateNav() {
  const nav = document.querySelector('#admin-nav');
  if (!nav) return;
  clear(nav);
  for (const page of adminPages) nav.append(navLink(page));
}

function updateLiveStatus(data) {
  const target = document.querySelector('#admin-live-status');
  if (!target || !data) return;
  const activeVisitors = data.activeVisitors?.total ?? data.counts?.activeVisitors ?? 0;
  const maintenance = Boolean(data.maintenance?.enabled);
  target.className = maintenance ? 'live-status danger-card' : 'live-status';
  target.textContent = `${activeVisitors} active - ${maintenance ? 'Maintenance on' : 'Public site open'}`;
}

async function loadLiveStatus() {
  const data = await api('/admin/api/summary');
  updateLiveStatus(data);
  return data;
}

async function refreshActivePage({ silent = false, force = false } = {}) {
  if (pollBusy && !force) return;
  pollBusy = true;
  try {
    if (currentRoute === '/admin/') {
      await loadSummary({ silent });
    } else if (currentRoute === '/admin/users') {
      await Promise.all([loadLiveStatus(), loadUsers({ silent })]);
    } else if (currentRoute === '/admin/bugs') {
      await Promise.all([loadLiveStatus(), loadReports({ silent })]);
    } else if (currentRoute === '/admin/explore') {
      await Promise.all([loadLiveStatus(), loadExplorePlaylists({ silent })]);
    }
  } finally {
    pollBusy = false;
  }
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) {
    headers.set('x-admin-csrf', csrfToken);
  }
  let response;
  try {
    response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: 'include'
    });
  } catch (error) {
    throw new Error(`Could not reach the admin service. Check that you are on the private admin origin and that the admin server is running. ${error.message}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Request failed with ${response.status}`);
  }
  return payload;
}

function fileNameFromDisposition(header, fallback) {
  const encoded = String(header || '').match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return fallback;
    }
  }
  return String(header || '').match(/filename="?([^"]+)"?/i)?.[1] || fallback;
}

async function downloadDatabaseBackup(button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Backing up...';
  try {
    const headers = new Headers({ Accept: 'application/vnd.sqlite3, application/json' });
    if (csrfToken) headers.set('x-admin-csrf', csrfToken);
    let response;
    try {
      response = await fetch('/admin/api/database/backup', {
        method: 'POST',
        headers,
        credentials: 'include'
      });
    } catch (error) {
      throw new Error(
        `Backup download could not reach /admin/api/database/backup. Use the private admin URL and make sure the admin service is running. Browser error: ${error.message}`
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error?.message || `Backup failed with HTTP ${response.status}.`);
    }

    const blob = await response.blob();
    if (!blob.size) throw new Error('Backup returned an empty file.');
    const fileName = fileNameFromDisposition(response.headers.get('content-disposition'), `albums-${new Date().toISOString()}.sqlite`);
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showNotice(`Downloaded ${fileName}.`);
  } catch (error) {
    showNotice(error.message, true);
    window.alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function renderLogin(message = '') {
  stopPolling();
  clear(root);
  root.className = 'login-shell';
  const form = el('form', { className: 'login-card stack' }, [
    el('div', {}, [el('h1', { text: 'Turntable Admin' }), el('p', { text: 'Private control plane' })]),
    message ? el('div', { className: 'error', text: message }) : null,
    el('label', {}, ['Username', el('input', { name: 'username', autocomplete: 'username', required: true, value: 'admin' })]),
    el('label', {}, ['Password', el('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })]),
    el('button', { type: 'submit', text: 'Sign in' })
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    const data = new FormData(form);
    try {
      const result = await api('/admin/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') })
      });
      csrfToken = result.csrfToken || '';
      sessionStorage.setItem('albumsAdminCsrf', csrfToken);
      renderConsole();
    } catch (error) {
      renderLogin(error.message);
    } finally {
      button.disabled = false;
    }
  });

  root.append(form);
}

function renderConsole() {
  clear(root);
  root.className = 'shell';
  root.append(
    el('header', { className: 'topbar' }, [
      el('div', {}, [
        el('h1', { text: 'Turntable Admin' }),
        el('div', { className: 'muted', text: 'Private backend controls' }),
        el('div', { id: 'admin-live-status', className: 'live-status', text: 'Loading live status...' })
      ]),
      el('div', { className: 'topbar-actions' }, [
        el('button', { className: 'secondary', text: 'Download DB backup', onclick: (event) => downloadDatabaseBackup(event.currentTarget) }),
        el('button', {
          className: 'secondary',
          text: 'Sign out',
          onclick: async () => {
            await api('/admin/api/logout', { method: 'POST' }).catch(() => {});
            csrfToken = '';
            sessionStorage.removeItem('albumsAdminCsrf');
            stopPolling();
            renderLogin();
          }
        })
      ])
    ]),
    el('nav', { id: 'admin-nav', className: 'admin-nav' }),
    el('div', { id: 'admin-notice', hidden: true }),
    el('main', { id: 'admin-page', className: 'admin-stack' })
  );
  bindRouting();
  if (window.location.pathname !== currentRoute) history.replaceState({}, '', currentRoute);
  setPolling();
  renderPage();
}

function renderPage() {
  currentRoute = normalizeAdminPath(window.location.pathname);
  if (window.location.pathname !== currentRoute) history.replaceState({}, '', currentRoute);
  updateNav();
  const page = document.querySelector('#admin-page');
  if (!page) return;
  clear(page);
  const pageInfo = activePage();
  page.append(el('div', { className: 'page-title' }, [el('h2', { text: pageInfo.title }), el('span', { text: 'Auto-updates every 10 seconds' })]));
  if (currentRoute === '/admin/') {
    page.append(overviewPanel());
  } else if (currentRoute === '/admin/users') {
    page.append(usersPanel());
  } else if (currentRoute === '/admin/bugs') {
    page.append(reportsPanel());
  } else if (currentRoute === '/admin/explore') {
    page.append(explorePanel());
  }
  refreshActivePage({ force: true }).catch((error) => showNotice(error.message, true));
}

function overviewPanel() {
  return el('section', { id: 'summary', className: 'grid summary-grid' });
}

function usersPanel() {
  const q = el('input', { placeholder: 'Search username, email, or id', value: currentUsers.q });
  const status = el('select', {}, [
    el('option', { value: 'all', text: 'All users' }),
    el('option', { value: 'active', text: 'Active' }),
    el('option', { value: 'disabled', text: 'Disabled' })
  ]);
  status.value = currentUsers.status;
  const apply = () => {
    currentUsers = { ...currentUsers, q: q.value, status: status.value, offset: 0 };
    loadUsers();
  };
  q.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') apply();
  });
  status.addEventListener('change', apply);

  return el('section', { className: 'panel' }, [
    el('div', { className: 'panel-header' }, [el('h2', { text: 'Users' }), el('button', { className: 'secondary', text: 'Refresh', onclick: loadUsers })]),
    el('div', { className: 'panel-body stack' }, [
      el('div', { className: 'filters' }, [q, status, el('button', { type: 'button', text: 'Search', onclick: apply })]),
      el('div', { id: 'users-result', className: 'table-wrap' })
    ])
  ]);
}

function reportsPanel() {
  return el('section', { className: 'panel' }, [
    el('div', { className: 'panel-header' }, [el('h2', { text: 'Bugs to Fix' }), el('button', { className: 'secondary', text: 'Refresh', onclick: loadReports })]),
    el('div', { className: 'panel-body stack' }, [reportEditor(), reportFilters(), el('div', { id: 'reports-result', className: 'card-list' })])
  ]);
}

function reportEditor(report = null) {
  const form = el('form', { id: 'report-form', className: 'editor-grid' }, [
    el('label', {}, ['Title', el('input', { name: 'title', required: true, maxlength: 160, value: report?.title || '' })]),
    el('label', {}, ['Status', el('select', { name: 'status' }, optionList(reportStatuses, report?.status || 'open'))]),
    el('label', {}, ['Priority', el('select', { name: 'priority' }, optionList(reportPriorities, report?.priority || 'medium'))]),
    el('label', { className: 'wide' }, ['Details', el('textarea', { name: 'description', required: true, text: report?.description || '' })]),
    el('label', { className: 'wide' }, ['Notes', el('textarea', { name: 'notes', text: report?.notes || '' })]),
    el('label', {}, ['Page/source', el('input', { name: 'pagePath', value: report?.pagePath || '' })]),
    el('label', {}, ['Browser/source info', el('input', { name: 'browser', value: report?.browser || '' })]),
    el('div', { className: 'actions wide' }, [
      el('button', { type: 'submit', text: editingReportId ? 'Save bug report' : 'Create bug report' }),
      el('button', { type: 'button', className: 'secondary', text: 'Clear', onclick: clearReportForm })
    ])
  ]);
  form.addEventListener('submit', saveReportFromForm);
  return form;
}

function reportFilters() {
  const q = el('input', { placeholder: 'Search bug title, details, or id', value: currentReports.q });
  const status = el('select', {}, [el('option', { value: '', text: 'All statuses' }), ...optionList(reportStatuses, currentReports.status)]);
  const priority = el('select', {}, [el('option', { value: '', text: 'All priorities' }), ...optionList(reportPriorities, currentReports.priority)]);
  const apply = () => {
    currentReports = { ...currentReports, q: q.value, status: status.value, priority: priority.value, offset: 0 };
    loadReports();
  };
  q.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') apply();
  });
  status.addEventListener('change', apply);
  priority.addEventListener('change', apply);
  return el('div', { className: 'filters' }, [q, status, priority, el('button', { type: 'button', text: 'Search', onclick: apply })]);
}

function explorePanel() {
  const form = el('form', { id: 'explore-form', className: 'editor-grid' }, [
    el('label', { className: 'wide' }, ['Share link', el('input', { name: 'shareLink', required: true, placeholder: 'https://.../share/token' })]),
    el('label', {}, ['Name', el('input', { name: 'name', required: true, maxlength: 120 })]),
    el('label', {}, ['Sort order', el('input', { name: 'sortOrder', type: 'number', value: '0' })]),
    el('label', { className: 'wide' }, ['Description', el('textarea', { name: 'description', required: true })]),
    el('label', { className: 'check-row' }, [el('input', { name: 'visible', type: 'checkbox', checked: true }), 'Visible on Explore']),
    el('div', { className: 'actions wide' }, [el('button', { type: 'submit', text: 'Import Explore playlist' })])
  ]);
  form.addEventListener('submit', saveNewExplorePlaylist);

  return el('section', { className: 'panel' }, [
    el('div', { className: 'panel-header' }, [el('h2', { text: 'Explore Playlists' }), el('button', { className: 'secondary', text: 'Refresh', onclick: loadExplorePlaylists })]),
    el('div', { className: 'panel-body stack' }, [form, el('div', { id: 'explore-result', className: 'card-list' })])
  ]);
}

async function refreshAll() {
  await refreshActivePage({ force: true });
}

async function loadSummary({ silent = false } = {}) {
  const target = document.querySelector('#summary');
  if (!target) return;
  if (!silent) {
    clear(target);
    target.append(el('div', { className: 'muted', text: 'Loading overview...' }));
  }
  try {
    const data = await api('/admin/api/summary');
    updateLiveStatus(data);
    clear(target);
    const stats = [
      ['Users', data.counts.users],
      ['Active now', data.activeVisitors?.total ?? data.counts.activeVisitors],
      ['Disabled', data.counts.disabledUsers],
      ['Sessions', data.counts.activeSessions],
      ['Lists', data.counts.lists],
      ['Albums', data.counts.albums],
      ['Ratings', data.counts.ratings],
      ['Messages', data.counts.messages]
    ];
    for (const [label, value] of stats) target.append(el('div', { className: 'stat' }, [el('b', { text: value }), el('span', { text: label })]));
    target.append(maintenanceCard(data.maintenance));
    target.append(storageCard(data.storage));
    target.append(metadataQueueCard(data.metadataQueue));
    target.append(localCoverCacheCard(data.localCoverCache));
    target.append(activeVisitorsCard(data.activeVisitors));
  } catch (error) {
    clear(target);
    target.append(el('div', { className: 'error', text: error.message }));
  }
}

function metadataQueueCard(metadataQueue) {
  const counts = metadataQueue?.counts || {};
  return el('div', { className: 'stat' }, [
    el('b', { text: counts.queued ?? 0 }),
    el('span', { text: `Metadata jobs: ${counts.running ?? 0} running, ${counts.failed ?? 0} failed, ${counts.done ?? 0} done` }),
    el('small', { text: metadataQueue?.oldestQueued ? `Oldest queued ${formatDate(metadataQueue.oldestQueued)}` : 'No queued metadata jobs' })
  ]);
}

function localCoverCacheCard(localCoverCache) {
  const count = localCoverCache?.count ?? 0;
  const maxImages = localCoverCache?.maxImages ?? 0;
  const bytes = localCoverCache?.byteLabel || '0 B';
  const maxBytes = localCoverCache?.maxBytesLabel || '';
  return el('div', { className: 'stat' }, [
    el('b', { text: count }),
    el('span', { text: `Local covers: ${bytes}${maxBytes ? ` of ${maxBytes}` : ''}` }),
    el('small', {
      text: maxImages
        ? `Retaining up to ${maxImages} images. Newest access ${formatDate(localCoverCache?.newestAccessedAt) || 'n/a'}`
        : 'Local cover cache limits unavailable'
    })
  ]);
}

function maintenanceCard(maintenance) {
  const checked = Boolean(maintenance?.enabled);
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      await api('/admin/api/settings/maintenance', { method: 'PATCH', body: JSON.stringify({ enabled: input.checked }) });
      showNotice(input.checked ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.');
      await loadSummary();
    } catch (error) {
      input.checked = !input.checked;
      showNotice(error.message, true);
    } finally {
      input.disabled = false;
    }
  });
  return el('div', { className: checked ? 'stat control-card danger-card' : 'stat control-card' }, [
    el('b', { text: checked ? 'Closed' : 'Open' }),
    el('span', { text: checked ? 'Maintenance mode: public site closed.' : 'Maintenance mode: public site open.' }),
    el('label', { className: 'toggle-row' }, [input, el('span', { text: 'Close public site' })])
  ]);
}

function storageCard(storage) {
  const disk = storage?.disk;
  const percent = disk ? Math.min(100, Math.max(0, Number(disk.percentUsed || 0))) : 0;
  return el('div', { className: 'stat storage-card' }, [
    el('b', { text: disk ? `${disk.percentUsed}%` : storage?.database?.totalLabel || 'Unknown' }),
    el('span', { text: disk ? `${disk.usedLabel} used of ${disk.totalLabel}` : 'Database files only' }),
    el('div', { className: 'usage-bar' }, [el('i', { style: `width:${percent}%` })]),
    el('small', { text: storage?.note || `SQLite files: ${storage?.database?.totalLabel || '0 B'}` })
  ]);
}

function activeVisitorsCard(activeVisitors) {
  return el('div', { className: 'stat' }, [
    el('b', { text: activeVisitors?.total ?? 0 }),
    el('span', { text: `Active visitors in last ${activeVisitors?.windowSeconds || 120}s` }),
    el('small', { text: `${activeVisitors?.loggedInUsers || 0} logged-in users, ${activeVisitors?.anonymous || 0} anonymous sessions` })
  ]);
}

async function loadUsers({ silent = false } = {}) {
  const target = document.querySelector('#users-result');
  if (!target) return;
  if (userIsEditingWithin(target) && silent) return;
  if (!silent) {
    clear(target);
    target.append(el('div', { className: 'muted', text: 'Loading users...' }));
  }
  try {
    const params = new URLSearchParams({ q: currentUsers.q, status: currentUsers.status, limit: String(currentUsers.limit), offset: String(currentUsers.offset) });
    const data = await api(`/admin/api/users?${params}`);
    clear(target);
    const table = el('table');
    table.append(el('thead', {}, [el('tr', {}, [el('th', { text: 'User' }), el('th', { text: 'Status' }), el('th', { text: 'Activity' }), el('th', { text: 'Created' }), el('th', { text: 'Actions' })])]));
    const body = el('tbody');
    for (const user of data.users) body.append(userRow(user));
    table.append(body);
    target.append(table, pager(data, currentUsers, (nextOffset) => {
      currentUsers = { ...currentUsers, offset: nextOffset };
      loadUsers();
    }));
  } catch (error) {
    clear(target);
    target.append(el('div', { className: 'error', text: error.message }));
  }
}

function userRow(user) {
  const status = user.disabledAt ? el('span', { className: 'badge danger', text: 'Disabled' }) : el('span', { className: 'badge', text: 'Active' });
  const action = user.disabledAt
    ? el('button', { className: 'secondary', text: 'Enable', onclick: async () => { await api(`/admin/api/users/${user.id}/enable`, { method: 'POST' }); await refreshAll(); } })
    : el('button', {
        className: 'danger',
        text: 'Disable',
        onclick: async () => {
          const reason = window.prompt('Reason for disabling this account. A reason is required.');
          if (reason === null) return;
          const cleanReason = reason.trim();
          if (!cleanReason) return window.alert('A disable reason is required.');
          if (!window.confirm(`Disable ${user.username}? This blocks login and invalidates active sessions.`)) return;
          await api(`/admin/api/users/${user.id}/disable`, { method: 'POST', body: JSON.stringify({ reason: cleanReason }) });
          await refreshAll();
        }
      });

  return el('tr', {}, [
    el('td', {}, [el('strong', { text: user.username }), el('div', { className: 'muted', text: user.email }), el('div', { className: 'muted', text: `ID ${user.id}` })]),
    el('td', {}, [status, user.disabledReason ? el('div', { className: 'muted', text: user.disabledReason }) : null]),
    el('td', { text: `${user.activeSessionCount} sessions, ${user.listCount} lists, ${user.ratingCount} ratings, ${user.reportCount} bugs` }),
    el('td', { text: formatDate(user.createdAt) }),
    el('td', {}, [el('div', { className: 'row-actions' }, [action])])
  ]);
}

function clearReportForm() {
  editingReportId = null;
  const form = document.querySelector('#report-form');
  if (!form) return;
  const replacement = reportEditor();
  form.replaceWith(replacement);
}

async function saveReportFromForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const data = new FormData(form);
  const payload = {
    title: data.get('title'),
    description: data.get('description'),
    status: data.get('status'),
    priority: data.get('priority'),
    notes: data.get('notes'),
    pagePath: data.get('pagePath'),
    browser: data.get('browser')
  };
  try {
    if (editingReportId) await api(`/admin/api/reports/${editingReportId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/admin/api/reports', { method: 'POST', body: JSON.stringify(payload) });
    clearReportForm();
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function loadReports({ silent = false } = {}) {
  const target = document.querySelector('#reports-result');
  if (!target) return;
  if (userIsEditingWithin(target) && silent) return;
  if (!silent) {
    clear(target);
    target.append(el('div', { className: 'muted', text: 'Loading bug reports...' }));
  }
  try {
    const params = new URLSearchParams({
      q: currentReports.q,
      status: currentReports.status,
      priority: currentReports.priority,
      limit: String(currentReports.limit),
      offset: String(currentReports.offset)
    });
    const data = await api(`/admin/api/reports?${params}`);
    clear(target);
    if (!data.reports.length) {
      target.append(el('div', { className: 'muted', text: 'No bug reports found.' }));
      return;
    }
    for (const report of data.reports) target.append(reportItem(report));
    target.append(pager(data, currentReports, (nextOffset) => {
      currentReports = { ...currentReports, offset: nextOffset };
      loadReports();
    }));
  } catch (error) {
    clear(target);
    target.append(el('div', { className: 'error', text: error.message }));
  }
}

function reportItem(report) {
  const status = el('select', {}, optionList(reportStatuses, report.status));
  const priority = el('select', {}, optionList(reportPriorities, report.priority));
  status.addEventListener('change', () => quickReportUpdate(report.id, { status: status.value }));
  priority.addEventListener('change', () => quickReportUpdate(report.id, { priority: priority.value }));

  return el('article', { className: `report-card priority-${report.priority}` }, [
    el('div', { className: 'card-head' }, [
      el('div', {}, [el('strong', { text: `#${report.id} ${report.title}` }), el('small', { text: `${formatDate(report.createdAt)} - updated ${formatDate(report.updatedAt)}` })]),
      el('div', { className: 'actions' }, [status, priority])
    ]),
    el('p', { className: 'report-body', text: report.description }),
    report.notes ? el('div', { className: 'notes', text: report.notes }) : null,
    el('div', { className: 'muted meta-line', text: `${report.username || 'Guest'} ${report.pagePath || ''} ${report.browser || ''}`.trim() }),
    el('div', { className: 'actions' }, [
      el('button', { className: 'secondary', text: 'Edit', onclick: () => editReport(report) }),
      el('button', { className: 'danger', text: 'Delete', onclick: () => deleteReport(report) })
    ])
  ]);
}

function editReport(report) {
  editingReportId = report.id;
  const form = document.querySelector('#report-form');
  if (form) {
    form.replaceWith(reportEditor(report));
    document.querySelector('#report-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function quickReportUpdate(id, patch) {
  try {
    await api(`/admin/api/reports/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function deleteReport(report) {
  if (!window.confirm(`Delete bug report #${report.id}?`)) return;
  try {
    await api(`/admin/api/reports/${report.id}`, { method: 'DELETE' });
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function saveNewExplorePlaylist(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  const data = new FormData(form);
  try {
    await api('/admin/api/explore-playlists', {
      method: 'POST',
      body: JSON.stringify({
        shareLink: data.get('shareLink'),
        name: data.get('name'),
        description: data.get('description'),
        sortOrder: Number(data.get('sortOrder') || 0),
        visible: Boolean(data.get('visible'))
      })
    });
    form.reset();
    form.querySelector('[name="visible"]').checked = true;
    form.querySelector('[name="sortOrder"]').value = '0';
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function loadExplorePlaylists({ silent = false } = {}) {
  const target = document.querySelector('#explore-result');
  if (!target) return;
  if (userIsEditingWithin(target) && silent) return;
  if (!silent) {
    clear(target);
    target.append(el('div', { className: 'muted', text: 'Loading Explore playlists...' }));
  }
  try {
    const data = await api('/admin/api/explore-playlists');
    clear(target);
    if (!data.playlists.length) {
      target.append(el('div', { className: 'muted', text: 'No database-backed Explore playlists yet.' }));
      return;
    }
    for (const playlist of data.playlists) target.append(explorePlaylistCard(playlist));
  } catch (error) {
    clear(target);
    target.append(el('div', { className: 'error', text: error.message }));
  }
}

function explorePlaylistCard(playlist) {
  const form = el('form', { className: 'playlist-card editor-grid' }, [
    el('div', { className: 'wide card-head' }, [
      el('div', {}, [el('strong', { text: playlist.name }), el('small', { text: `${playlist.albumCount} albums - /explore/${playlist.slug}` })]),
      el('span', { className: playlist.visible ? 'badge' : 'badge danger', text: playlist.visible ? 'Visible' : 'Hidden' })
    ]),
    el('label', {}, ['Name', el('input', { name: 'name', required: true, value: playlist.name })]),
    el('label', {}, ['Sort order', el('input', { name: 'sortOrder', type: 'number', value: playlist.sortOrder })]),
    el('label', { className: 'wide' }, ['Share link', el('input', { name: 'shareLink', required: true, value: playlist.shareLink })]),
    el('label', { className: 'wide' }, ['Description', el('textarea', { name: 'description', text: playlist.description })]),
    el('label', { className: 'check-row' }, [el('input', { name: 'visible', type: 'checkbox', checked: playlist.visible }), 'Visible on Explore']),
    el('div', { className: 'actions wide' }, [
      el('button', { type: 'submit', text: 'Save playlist' }),
      el('button', { type: 'button', className: 'secondary', text: 'Reimport albums', onclick: () => reimportExplorePlaylist(playlist, form) }),
      el('button', { type: 'button', className: 'danger', text: 'Delete', onclick: () => deleteExplorePlaylist(playlist) })
    ]),
    el('div', { className: 'wide album-preview', text: previewAlbums(playlist.albums) })
  ]);
  form.addEventListener('submit', (event) => saveExplorePlaylist(event, playlist.id));
  return form;
}

function previewAlbums(albums = []) {
  if (!albums.length) return 'No albums imported.';
  return albums.slice(0, 8).map((album, index) => `${index + 1}. ${album.title}${album.artist ? ` by ${album.artist}` : ''}`).join(' | ');
}

function playlistPayloadFromForm(form) {
  const data = new FormData(form);
  return {
    name: data.get('name'),
    description: data.get('description'),
    shareLink: data.get('shareLink'),
    sortOrder: Number(data.get('sortOrder') || 0),
    visible: Boolean(data.get('visible'))
  };
}

async function saveExplorePlaylist(event, playlistId) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/admin/api/explore-playlists/${playlistId}`, { method: 'PATCH', body: JSON.stringify(playlistPayloadFromForm(form)) });
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function reimportExplorePlaylist(playlist, form) {
  if (!window.confirm(`Reimport albums for ${playlist.name}? This replaces the imported album rows for this Explore playlist.`)) return;
  try {
    await api(`/admin/api/explore-playlists/${playlist.id}/import`, { method: 'POST', body: JSON.stringify(playlistPayloadFromForm(form)) });
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function deleteExplorePlaylist(playlist) {
  if (!window.confirm(`Delete Explore playlist ${playlist.name}?`)) return;
  try {
    await api(`/admin/api/explore-playlists/${playlist.id}`, { method: 'DELETE' });
    await refreshAll();
  } catch (error) {
    showNotice(error.message, true);
  }
}

function pager(data, state, onPage) {
  const previous = Math.max(0, state.offset - state.limit);
  const next = state.offset + state.limit;
  if (!data.total) return el('div');
  return el('div', { className: 'actions pager' }, [
    el('button', { className: 'secondary', text: 'Previous', disabled: state.offset <= 0, onclick: () => onPage(previous) }),
    el('button', { className: 'secondary', text: 'Next', disabled: next >= data.total, onclick: () => onPage(next) }),
    el('span', { className: 'muted', text: `${state.offset + 1}-${Math.min(next, data.total)} of ${data.total}` })
  ]);
}

async function boot() {
  try {
    const me = await api('/admin/api/me');
    csrfToken = me.csrfToken || csrfToken;
    if (csrfToken) sessionStorage.setItem('albumsAdminCsrf', csrfToken);
    renderConsole();
    await refreshAll();
  } catch {
    renderLogin();
  }
}

boot();
