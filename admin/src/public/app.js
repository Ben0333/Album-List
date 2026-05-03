const root = document.querySelector('#app');
let csrfToken = sessionStorage.getItem('albumsAdminCsrf') || '';
let currentUsers = { q: '', status: 'all', limit: 25, offset: 0 };
let currentReports = { status: '', limit: 10, offset: 0 };

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

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) {
    headers.set('x-admin-csrf', csrfToken);
  }
  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: 'include'
  });
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
    const headers = new Headers();
    if (csrfToken) headers.set('x-admin-csrf', csrfToken);
    const response = await fetch('/admin/api/database/backup', {
      method: 'POST',
      headers,
      credentials: 'include'
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error?.message || `Backup failed with ${response.status}`);
    }

    const blob = await response.blob();
    const fileName = fileNameFromDisposition(response.headers.get('content-disposition'), `albums-${new Date().toISOString()}.sqlite`);
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function renderLogin(message = '') {
  clear(root);
  root.className = 'login-shell';
  const form = el('form', { className: 'login-card stack' }, [
    el('div', {}, [el('h1', { text: 'Albums Admin' }), el('p', { text: 'Private control plane' })]),
    message ? el('div', { className: 'error', text: message }) : null,
    el('label', {}, [
      'Username',
      el('input', {
        name: 'username',
        autocomplete: 'username',
        required: true,
        value: 'admin'
      })
    ]),
    el('label', {}, [
      'Password',
      el('input', {
        name: 'password',
        type: 'password',
        autocomplete: 'current-password',
        required: true
      })
    ]),
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
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password')
        })
      });
      csrfToken = result.csrfToken || '';
      sessionStorage.setItem('albumsAdminCsrf', csrfToken);
      renderConsole();
      await refreshAll();
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
      el('div', {}, [el('h1', { text: 'Albums Admin' }), el('div', { className: 'muted', text: 'Private backend controls' })]),
      el('div', { className: 'topbar-actions' }, [
        el('button', {
          className: 'secondary',
          text: 'Download DB backup',
          onclick: (event) => downloadDatabaseBackup(event.currentTarget)
        }),
        el('button', {
          className: 'secondary',
          text: 'Sign out',
          onclick: async () => {
            await api('/admin/api/logout', { method: 'POST' }).catch(() => {});
            csrfToken = '';
            sessionStorage.removeItem('albumsAdminCsrf');
            renderLogin();
          }
        })
      ])
    ]),
    el('section', { id: 'summary', className: 'grid summary-grid' }),
    el('section', { className: 'grid content-grid' }, [
      el('div', { className: 'grid' }, [usersPanel()]),
      reportsPanel()
    ])
  );
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
  const status = el('select', {}, [
    el('option', { value: '', text: 'All reports' }),
    el('option', { value: 'open', text: 'Open' }),
    el('option', { value: 'reviewing', text: 'Reviewing' }),
    el('option', { value: 'closed', text: 'Closed' }),
    el('option', { value: 'spam', text: 'Spam' })
  ]);
  status.value = currentReports.status;
  status.addEventListener('change', () => {
    currentReports = { ...currentReports, status: status.value, offset: 0 };
    loadReports();
  });

  return el('section', { className: 'panel' }, [
    el('div', { className: 'panel-header' }, [el('h2', { text: 'Bug Reports' }), el('button', { className: 'secondary', text: 'Refresh', onclick: loadReports })]),
    el('div', { className: 'panel-body stack' }, [status, el('div', { id: 'reports-result' })])
  ]);
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadUsers(), loadReports()]);
}

async function loadSummary() {
  const target = document.querySelector('#summary');
  if (!target) return;
  clear(target);
  try {
    const data = await api('/admin/api/summary');
    const stats = [
      ['Users', data.counts.users],
      ['Disabled', data.counts.disabledUsers],
      ['Sessions', data.counts.activeSessions],
      ['Lists', data.counts.lists],
      ['Albums', data.counts.albums],
      ['Ratings', data.counts.ratings],
      ['Messages', data.counts.messages]
    ];
    for (const reportStatus of data.bugReportsByStatus || []) {
      stats.push([`Reports ${reportStatus.status}`, reportStatus.count]);
    }
    for (const [label, value] of stats) {
      target.append(el('div', { className: 'stat' }, [el('b', { text: value }), el('span', { text: label })]));
    }
    if (data.recentSignups?.length) {
      target.append(
        el('div', { className: 'stat recent-signups' }, [
          el('b', { text: 'Recent Signups' }),
          el(
            'ul',
            {},
            data.recentSignups.map((user) =>
              el('li', {}, [
                el('span', { text: user.username }),
                el('small', { text: formatDate(user.createdAt) }),
                user.disabledAt ? el('em', { text: 'disabled' }) : null
              ])
            )
          )
        ])
      );
    }
  } catch (error) {
    target.append(el('div', { className: 'error', text: error.message }));
  }
}

async function loadUsers() {
  const target = document.querySelector('#users-result');
  if (!target) return;
  clear(target);
  target.append(el('div', { className: 'muted', text: 'Loading users...' }));
  try {
    const params = new URLSearchParams({
      q: currentUsers.q,
      status: currentUsers.status,
      limit: String(currentUsers.limit),
      offset: String(currentUsers.offset)
    });
    const data = await api(`/admin/api/users?${params}`);
    clear(target);
    const table = el('table');
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'User' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Activity' }),
          el('th', { text: 'Created' }),
          el('th', { text: 'Actions' })
        ])
      ])
    );
    const body = el('tbody');
    for (const user of data.users) {
      body.append(userRow(user));
    }
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
  const status = user.disabledAt
    ? el('span', { className: 'badge danger', text: 'Disabled' })
    : el('span', { className: 'badge', text: 'Active' });
  const action = user.disabledAt
    ? el('button', {
        className: 'secondary',
        text: 'Enable',
        onclick: async () => {
          await api(`/admin/api/users/${user.id}/enable`, { method: 'POST' });
          await refreshAll();
        }
      })
    : el('button', {
        className: 'danger',
        text: 'Disable',
        onclick: async () => {
          const reason = window.prompt('Reason for disabling this account. A reason is required.');
          if (reason === null) return;
          const cleanReason = reason.trim();
          if (!cleanReason) {
            window.alert('A disable reason is required.');
            return;
          }
          const confirmed = window.confirm(
            `Disable ${user.username}? This blocks login, invalidates active sessions, and does not delete any user data.`
          );
          if (!confirmed) return;
          await api(`/admin/api/users/${user.id}/disable`, {
            method: 'POST',
            body: JSON.stringify({ reason: cleanReason })
          });
          await refreshAll();
        }
      });

  return el('tr', {}, [
    el('td', {}, [
      el('strong', { text: user.username }),
      el('div', { className: 'muted', text: user.email }),
      el('div', { className: 'muted', text: `ID ${user.id}` })
    ]),
    el('td', {}, [status, user.disabledReason ? el('div', { className: 'muted', text: user.disabledReason }) : null]),
    el('td', { text: `${user.activeSessionCount} sessions, ${user.listCount} lists, ${user.ratingCount} ratings` }),
    el('td', { text: formatDate(user.createdAt) }),
    el('td', {}, [el('div', { className: 'row-actions' }, [action])])
  ]);
}

async function loadReports() {
  const target = document.querySelector('#reports-result');
  if (!target) return;
  clear(target);
  target.append(el('div', { className: 'muted', text: 'Loading reports...' }));
  try {
    const params = new URLSearchParams({
      status: currentReports.status,
      limit: String(currentReports.limit),
      offset: String(currentReports.offset)
    });
    const data = await api(`/admin/api/reports?${params}`);
    clear(target);
    if (!data.reports.length) {
      target.append(el('div', { className: 'muted', text: 'No reports found.' }));
      return;
    }
    for (const report of data.reports) {
      target.append(reportItem(report));
    }
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
  const status = el('select', {}, [
    el('option', { value: 'open', text: 'Open' }),
    el('option', { value: 'reviewing', text: 'Reviewing' }),
    el('option', { value: 'closed', text: 'Closed' }),
    el('option', { value: 'spam', text: 'Spam' })
  ]);
  status.value = report.status;
  status.addEventListener('change', async () => {
    await api(`/admin/api/reports/${report.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: status.value })
    });
    await loadReports();
  });

  return el('article', { className: 'report' }, [
    el('div', { className: 'actions' }, [
      el('span', { className: 'badge', text: report.status }),
      el('span', { className: 'muted', text: formatDate(report.createdAt) })
    ]),
    el('p', { className: 'report-body', text: report.body }),
    el('div', { className: 'muted', text: `${report.username || 'Guest'} ${report.path || ''}`.trim() }),
    el('div', { className: 'report-status' }, [status])
  ]);
}

function pager(data, state, onPage) {
  const previous = Math.max(0, state.offset - state.limit);
  const next = state.offset + state.limit;
  return el('div', { className: 'actions pager' }, [
    el('button', {
      className: 'secondary',
      text: 'Previous',
      disabled: state.offset <= 0,
      onclick: () => onPage(previous)
    }),
    el('button', {
      className: 'secondary',
      text: 'Next',
      disabled: next >= data.total,
      onclick: () => onPage(next)
    }),
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
