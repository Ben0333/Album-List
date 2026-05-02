const app = document.querySelector('#app');
const numberFormat = new Intl.NumberFormat();
let searchTimer = null;

const state = {
  loading: true,
  stats: null,
  site: null,
  tunnel: null,
  accounts: [],
  query: '',
  notice: '',
  error: ''
};

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  handleAction(target).catch(showError);
});

app.addEventListener('input', (event) => {
  const target = event.target.closest('[data-input]');
  if (!target) return;
  if (target.dataset.input === 'account-search') {
    state.query = target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      loadAccounts().catch(showError);
    }, 180);
  }
});

boot().catch(showError);

async function boot() {
  await Promise.all([loadStats(), loadSiteStatus(), loadTunnelStatus(), loadAccounts()]);
  state.loading = false;
  render();
}

async function loadStats() {
  state.stats = await api('/api/stats');
}

async function loadSiteStatus() {
  const data = await api('/api/site/status');
  state.site = data.site;
}

async function loadTunnelStatus() {
  const data = await api('/api/tunnel/status');
  state.tunnel = data.tunnel;
}

async function loadAccounts() {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set('q', state.query.trim());
  const data = await api(`/api/accounts${params.toString() ? `?${params}` : ''}`);
  state.accounts = data.accounts || [];
  render();
}

async function refreshAll(message = '') {
  await Promise.all([loadStats(), loadSiteStatus(), loadTunnelStatus(), loadAccounts()]);
  state.notice = message;
  state.error = '';
  render();
}

function render() {
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div>
          <h1>Albums Admin</h1>
          <div class="muted">Local dashboard on this computer</div>
        </div>
        <button class="primary" data-action="refresh" type="button">Refresh</button>
      </header>
      ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ''}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
      ${state.loading || !state.stats ? '<div class="panel"><div class="empty">Loading.</div></div>' : renderDashboard()}
    </main>
  `;
  const input = app.querySelector('[data-input="account-search"]');
  if (input && document.activeElement !== input) input.value = state.query;
}

function renderDashboard() {
  return `
    ${renderSiteControls()}
    ${renderTunnelControls()}
    ${renderStats()}
    ${renderAccounts()}
    <div class="panel">
      <div class="panel-header"><h2>Recent Activity</h2></div>
      ${renderRecentActivity()}
    </div>
    <div class="panel">
      <div class="panel-header"><h2>Admin Log</h2></div>
      ${renderAdminLog()}
    </div>
  `;
}

function renderSiteControls() {
  const site = state.site || {};
  const running = Boolean(site.running);
  const healthy = Boolean(site.healthy);
  const statusClass = healthy ? 'active' : running ? 'disabled' : 'anonymized';
  const statusText = healthy ? 'Running' : running ? 'Process only' : 'Stopped';
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Main Website</h2>
          <div class="muted">http://localhost:${site.port || 3000}${site.pid ? ` - PID ${site.pid}` : ''}</div>
        </div>
        <span class="status ${statusClass}">${statusText}</span>
      </div>
      <div class="control-row">
        <button data-action="site-start" ${running ? 'disabled' : ''} type="button">Start website</button>
        <button data-action="site-restart" type="button">Restart website</button>
        <button class="danger" data-action="site-stop" ${running ? '' : 'disabled'} type="button">Stop website</button>
      </div>
    </section>
  `;
}

function renderTunnelControls() {
  const tunnel = state.tunnel || {};
  const running = Boolean(tunnel.running);
  const installed = Boolean(tunnel.serviceInstalled);
  const statusClass = running ? 'active' : installed ? 'anonymized' : 'disabled';
  const statusText = running ? 'Open' : installed ? 'Stopped' : 'Missing';
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Cloudflare Tunnel</h2>
          <div class="muted">${escapeHtml(tunnel.serviceName || 'Cloudflared')}${tunnel.serviceStatus ? ` - ${escapeHtml(tunnel.serviceStatus)}` : ''}</div>
        </div>
        <span class="status ${statusClass}">${statusText}</span>
      </div>
      <div class="control-row">
        <button data-action="tunnel-start" ${running ? 'disabled' : ''} type="button">Start tunnel</button>
        <button class="danger" data-action="tunnel-stop" ${running ? '' : 'disabled'} type="button">Stop tunnel</button>
        <button class="danger strong-danger" data-action="lockdown" type="button">Emergency lockdown</button>
      </div>
    </section>
  `;
}

function renderStats() {
  const totals = state.stats.totals || {};
  const items = [
    ['Users', totals.users],
    ['Disabled', totals.disabledUsers],
    ['Anonymized', totals.anonymizedUsers],
    ['Sessions', totals.activeSessions],
    ['Lists', totals.lists],
    ['Saved albums', totals.savedAlbums],
    ['Completions', totals.completions],
    ['Ratings', totals.ratings],
    ['Activity records', totals.activityRecords],
    ['Cached covers', totals.cachedExploreCovers]
  ];
  return `
    <section class="stats-grid">
      ${items.map(([label, value]) => `<div class="stat-card"><strong>${formatNumber(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}
    </section>
  `;
}

function renderAccounts() {
  return `
    <section class="panel">
      <div class="panel-header">
        <h2>Accounts</h2>
        <div class="search-row">
          <input data-input="account-search" value="${escapeAttr(state.query)}" placeholder="Search username, email, or id" />
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Account</th>
              <th>Status</th>
              <th>Data</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              state.accounts.length
                ? state.accounts.map(renderAccountRow).join('')
                : '<tr><td colspan="6" class="muted">No accounts found.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderAccountRow(account) {
  const status = account.anonymizedAt ? 'anonymized' : account.disabledAt ? 'disabled' : 'active';
  const statusText = account.anonymizedAt ? 'Anonymized' : account.disabledAt ? 'Disabled' : 'Active';
  return `
    <tr>
      <td>${account.id}</td>
      <td>
        <strong>${escapeHtml(account.username)}</strong>
        <div class="muted">${escapeHtml(account.email)}</div>
      </td>
      <td>
        <span class="status ${status}">${statusText}</span>
        ${account.disabledReason ? `<div class="muted">${escapeHtml(account.disabledReason)}</div>` : ''}
      </td>
      <td>
        <div>${formatNumber(account.ownedLists)} owned lists, ${formatNumber(account.memberships)} memberships</div>
        <div class="muted">${formatNumber(account.albumsAdded)} albums, ${formatNumber(account.completions)} completions, ${formatNumber(account.ratings)} ratings</div>
      </td>
      <td>${formatDate(account.createdAt)}</td>
      <td>
        <div class="actions">
          <button data-action="disable" data-id="${account.id}" ${account.disabledAt ? 'disabled' : ''} type="button">Disable</button>
          <button data-action="enable" data-id="${account.id}" ${!account.disabledAt || account.anonymizedAt ? 'disabled' : ''} type="button">Enable</button>
          <button class="danger" data-action="anonymize" data-id="${account.id}" ${account.anonymizedAt ? 'disabled' : ''} type="button">Anonymize</button>
        </div>
      </td>
    </tr>
  `;
}

function renderRecentActivity() {
  const signups = state.stats.recentSignups || [];
  const albums = state.stats.recentSavedAlbums || [];
  const activity = state.stats.recentActivity || [];
  const items = [
    ...signups.map((item) => ({
      title: `${item.username} signed up`,
      detail: `User #${item.id}`,
      time: item.created_at
    })),
    ...albums.map((item) => ({
      title: `${item.title}${item.artist ? ` by ${item.artist}` : ''}`,
      detail: item.username ? `Saved by ${item.username}` : 'Saved album',
      time: item.created_at
    })),
    ...activity.map((item) => ({
      title: `${item.title || item.album_key}${item.artist ? ` by ${item.artist}` : ''}`,
      detail: item.username ? `Activity by ${item.username}` : 'Listening activity',
      time: item.updated_at
    }))
  ]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 12);

  if (!items.length) return '<div class="empty">No recent activity.</div>';
  return `<div class="mini-list">${items.map(renderMiniItem).join('')}</div>`;
}

function renderAdminLog() {
  const actions = state.stats.recentActions || [];
  if (!actions.length) return '<div class="empty">No admin actions yet.</div>';
  return `
    <div class="mini-list">
      ${actions
        .map((action) =>
          renderMiniItem({
            title: `${action.action} ${action.previousUsername || `user #${action.userId}`}`,
            detail: action.newUsername && action.newUsername !== action.previousUsername ? `New username: ${action.newUsername}` : action.details,
            time: action.createdAt
          })
        )
        .join('')}
    </div>
  `;
}

function renderMiniItem(item) {
  return `
    <div class="mini-item">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span class="muted">${escapeHtml(item.detail || '')}</span>
      </div>
      <time class="muted">${formatDate(item.time)}</time>
    </div>
  `;
}

async function handleAction(target) {
  const action = target.dataset.action;
  if (action === 'refresh') {
    await refreshAll('Dashboard refreshed.');
    return;
  }

  if (action === 'site-start') {
    const data = await api('/api/site/start', { method: 'POST' });
    state.site = data.site;
    await refreshAll(data.message);
    return;
  }

  if (action === 'site-restart') {
    if (!window.confirm('Restart the public website now?')) return;
    const data = await api('/api/site/restart', { method: 'POST' });
    state.site = data.site;
    await refreshAll(data.message);
    return;
  }

  if (action === 'site-stop') {
    if (!window.confirm('Completely stop the public website now?')) return;
    const data = await api('/api/site/stop', { method: 'POST' });
    state.site = data.site;
    await refreshAll(data.message);
    return;
  }

  if (action === 'tunnel-start') {
    const data = await api('/api/tunnel/start', { method: 'POST' });
    state.tunnel = data.tunnel;
    await refreshAll(data.message);
    return;
  }

  if (action === 'tunnel-stop') {
    if (!window.confirm('Stop the Cloudflare tunnel now?')) return;
    const data = await api('/api/tunnel/stop', { method: 'POST' });
    state.tunnel = data.tunnel;
    await refreshAll(data.message);
    return;
  }

  if (action === 'lockdown') {
    if (!window.confirm('Emergency lockdown will stop the public website and Cloudflare tunnel. Continue?')) return;
    const typed = window.prompt('Type LOCKDOWN to continue');
    if (typed !== 'LOCKDOWN') return;
    const data = await api('/api/lockdown', { method: 'POST' });
    state.site = data.site;
    state.tunnel = data.tunnel;
    await refreshAll(data.message);
    return;
  }

  const account = state.accounts.find((item) => String(item.id) === String(target.dataset.id));
  if (!account) return;

  if (action === 'disable') {
    if (!window.confirm(`Disable ${account.username}? Active sessions will be signed out.`)) return;
    const reason = window.prompt('Reason', 'Disabled by local admin');
    if (reason === null) return;
    const data = await api(`/api/accounts/${account.id}/disable`, { method: 'POST', body: { reason } });
    await refreshAll(data.message);
    return;
  }

  if (action === 'enable') {
    if (!window.confirm(`Enable ${account.username}?`)) return;
    const data = await api(`/api/accounts/${account.id}/enable`, { method: 'POST' });
    await refreshAll(data.message);
    return;
  }

  if (action === 'anonymize') {
    if (!window.confirm(`Anonymize ${account.username}? This keeps their data but frees the username.`)) return;
    const typed = window.prompt('Type ANONYMIZE to continue');
    if (typed !== 'ANONYMIZE') return;
    const data = await api(`/api/accounts/${account.id}/anonymize`, { method: 'POST' });
    await refreshAll(data.message);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Request failed.');
  return data;
}

function showError(error) {
  state.error = error.message || 'Something went wrong.';
  state.notice = '';
  state.loading = false;
  render();
}

function formatNumber(value) {
  return numberFormat.format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
