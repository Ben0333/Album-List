const GUEST_KEY = 'albums_guest_v2';
const OLD_GUEST_KEY = 'albums_guest_v1';
const THEME_KEY = 'albums_theme_preference_v1';
const CHAT_OPEN_KEY = 'albums_chat_open_v1';
const CHAT_READ_KEY = 'albums_chat_read_v1';
const LIVE_SYNC_MS = 1800;

const app = document.querySelector('#app');
const mediaDark = window.matchMedia('(prefers-color-scheme: dark)');
let searchTimer = null;
let searchNonce = 0;
let liveTimer = null;
let liveInFlight = false;
let cropDrag = null;
let exploreCoverObserver = null;
const coverRefreshAttempted = new Set();
const coverRefreshInFlight = new Set();

const state = {
  user: null,
  lists: [],
  invites: [],
  payload: null,
  history: null,
  profile: null,
  explore: null,
  route: { type: 'home' },
  guest: loadGuest(),
  authMode: 'login',
  selectedPlatform: 'na',
  listTab: 'albums',
  albumQuery: '',
  suggestions: [],
  selectedAlbum: null,
  searching: false,
  shareOpen: false,
  userSearchQuery: '',
  userResults: [],
  userSearching: false,
  shareRole: 'editor',
  settingsOpen: false,
  avatarCrop: null,
  listPicker: null,
  exploreCoverLoading: false,
  exploreCoverRequested: new Set(),
  chatOpen: localStorage.getItem(CHAT_OPEN_KEY) !== 'closed',
  chatReadIds: loadChatReadIds(),
  chatUnread: {},
  chatDraft: '',
  peopleOpen: false,
  highlightAlbumId: null,
  notice: '',
  error: '',
  themePreference: localStorage.getItem(THEME_KEY) || 'system'
};

const platformOptions = [
  ['spotify', 'Spotify'],
  ['youtube_music', 'YouTube Music'],
  ['apple_music', 'Apple Music'],
  ['tidal', 'TIDAL'],
  ['soundcloud', 'SoundCloud'],
  ['bandcamp', 'Bandcamp'],
  ['deezer', 'Deezer'],
  ['na', 'N/A']
];

app.onclick = (event) => {
  if (event.target.classList?.contains('modal-backdrop')) {
    if (state.avatarCrop) state.avatarCrop = null;
    else if (state.listPicker) state.listPicker = null;
    else state.settingsOpen = false;
    render();
    return;
  }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  handleAction(target, event).catch(showError);
};

app.addEventListener(
  'error',
  (event) => {
    if (!(event.target instanceof HTMLImageElement) || event.target.dataset.coverImg !== '1') return;
    handleCoverImageError(event.target).catch(() => {});
  },
  true
);

app.onchange = (event) => {
  const target = event.target.closest('[data-change]');
  if (!target) return;
  handleChange(target).catch(showError);
};

app.oninput = (event) => {
  const target = event.target.closest('[data-input]');
  if (!target) return;
  handleInput(target).catch(showError);
};

app.onpointerdown = (event) => {
  const frame = event.target.closest('[data-crop-frame]');
  if (!frame || !state.avatarCrop) return;
  event.preventDefault();
  cropDrag = {
    pointerId: event.pointerId,
    frame,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startCropX: Number(state.avatarCrop.x || 0),
    startCropY: Number(state.avatarCrop.y || 0)
  };
  frame.setPointerCapture?.(event.pointerId);
  frame.classList.add('dragging');
};

app.onpointermove = (event) => {
  if (!cropDrag || !state.avatarCrop || event.pointerId !== cropDrag.pointerId) return;
  event.preventDefault();
  const rect = cropDrag.frame.getBoundingClientRect();
  const zoom = Math.max(1, Number(state.avatarCrop.zoom || 1));
  const scale = 200 / Math.max(1, Math.min(rect.width, rect.height)) / zoom;
  setCropPan(cropDrag.startCropX + (event.clientX - cropDrag.startClientX) * scale, cropDrag.startCropY + (event.clientY - cropDrag.startClientY) * scale);
};

app.onpointerup = (event) => finishCropDrag(event);
app.onpointercancel = (event) => finishCropDrag(event);

app.onsubmit = (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  handleForm(form).catch(showError);
};

window.addEventListener('popstate', () => {
  loadRoute().catch(showError);
});

mediaDark.addEventListener('change', () => applyTheme(state.themePreference));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncCurrentPayload().catch(() => {});
});

boot().catch(showError);

async function boot() {
  applyTheme(state.themePreference);
  applyAccent(null);
  await refreshMe();
  await loadRoute();
}

async function refreshMe() {
  const data = await api('/api/me');
  state.user = data.user;
  state.lists = data.lists || [];
  state.invites = data.invites || [];
  if (state.user) {
    state.themePreference = state.user.themePreference || 'system';
    localStorage.setItem(THEME_KEY, state.themePreference);
    applyTheme(state.themePreference);
    applyAccent(state.user.accentColor);
  } else {
    applyAccent(null);
  }
}

async function loadRoute() {
  state.route = parseRoute();
  state.payload = null;
  state.history = null;
  state.profile = null;
  state.explore = null;
  state.exploreCoverRequested = new Set();
  state.error = '';
  state.notice = '';
  state.albumQuery = '';
  state.suggestions = [];
  state.selectedAlbum = null;
  state.shareOpen = false;
  state.userSearchQuery = '';
  state.userResults = [];
  state.userSearching = false;
  state.settingsOpen = false;
  state.avatarCrop = null;
  state.listPicker = null;
  state.peopleOpen = false;
  state.highlightAlbumId = null;
  state.chatDraft = '';
  configureLiveSync();

  if (state.route.type === 'login') {
    render();
    return;
  }

  if (state.route.type === 'list') {
    state.payload = await api(`/api/lists/${state.route.id}`);
  } else if (state.route.type === 'share') {
    state.payload = await api(`/api/share/${encodeURIComponent(state.route.token)}`);
  } else if (state.route.type === 'history') {
    state.history = await api(`/api/history/${encodeURIComponent(state.route.token)}`);
  } else if (state.route.type === 'profile') {
    state.profile = await api(`/api/users/${encodeURIComponent(state.route.username)}`);
  } else if (state.route.type === 'explore') {
    if (state.route.slug) {
      state.explore = await api(`/api/explore/${encodeURIComponent(state.route.slug)}`);
    } else {
      state.explore = await api('/api/explore');
    }
  } else if (state.route.type === 'invite') {
    render();
    return;
  } else if (state.user) {
    const personal = state.lists.find((list) => list.kind === 'personal') || state.lists[0];
    if (personal) {
      navigate(`/list/${personal.id}`, true);
      return;
    }
  }

  ensureChatBaseline(state.payload);
  if (state.chatOpen) markChatRead(state.payload);
  render();
  configureLiveSync();
}

function parseRoute() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'login') return { type: 'login' };
  if (parts[0] === 'explore') {
    return {
      type: 'explore',
      slug: parts[1] || null,
      albumIndex: parts[2] === 'album' ? Number(parts[3]) : null
    };
  }
  if (parts[0] === 'list' && parts[1]) {
    return { type: 'list', id: Number(parts[1]), albumId: parts[2] === 'album' ? Number(parts[3]) : null };
  }
  if (parts[0] === 'share' && parts[1]) {
    return { type: 'share', token: parts[1], albumId: parts[2] === 'album' ? Number(parts[3]) : null };
  }
  if (parts[0] === 'invite' && parts[1]) return { type: 'invite', token: parts[1] };
  if (parts[0] === 'history' && parts[1]) {
    return {
      type: 'history',
      token: parts[1],
      albumKey: parts[2] === 'album' ? decodeURIComponent(parts[3] || '') : null
    };
  }
  if (parts[0] === 'u' && parts[1]) {
    return {
      type: 'profile',
      username: decodeURIComponent(parts[1]),
      albumKey: parts[2] === 'album' ? decodeURIComponent(parts[3] || '') : null
    };
  }
  return { type: 'home' };
}

function navigate(path, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  loadRoute().catch(showError);
}

function render(options = {}) {
  app.innerHTML = `
    ${renderUtilityBar()}
    ${state.notice ? renderNotice(state.notice) : ''}
    ${state.error ? renderNotice(state.error) : ''}
    ${renderMain()}
    ${state.settingsOpen ? renderSettingsModal(state.payload) : ''}
    ${state.avatarCrop ? renderAvatarCropModal() : ''}
    ${state.listPicker ? renderListPickerModal() : ''}
  `;
  if (options.focusSearch) {
    queueMicrotask(() => {
      const input = app.querySelector('[data-input="album-search"]');
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  if (options.focusUserSearch) {
    queueMicrotask(() => {
      const input = app.querySelector('[data-input="user-search"]');
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  if (options.focusChat) {
    queueMicrotask(() => {
      const input = app.querySelector('[data-input="chat-body"]');
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  if (state.route.type === 'explore' && state.explore?.list) {
    queueMicrotask(() => setupExploreCoverHydration());
  }
}

function renderUtilityBar() {
  const exploreToggle = state.route.type === 'explore'
    ? renderActionButton('go-home', 'list', 'My lists')
    : renderActionButton('go-explore', 'compass', 'Explore');
  return `
    <div class="utility-bar">
      ${renderActionButton('theme-cycle', themeIconName(), 'Theme', { className: 'icon-button' })}
      ${exploreToggle}
      ${
        state.user
          ? `<button class="profile-button" data-action="settings-toggle" title="Account">
              ${renderAvatar(state.user, true, false)}
              ${state.invites.length ? `<span class="notify-dot">${state.invites.length}</span>` : ''}
            </button>`
          : renderActionButton('go-login', 'log-in', 'Sign in')
      }
    </div>
  `;
}

function renderMain() {
  if (state.route.type === 'login') return renderLoginPage();
  if (state.route.type === 'invite') return renderInvitePage();
  if (state.route.type === 'history') return state.route.albumKey ? renderHistoryAlbumPage() : renderHistoryPage();
  if (state.route.type === 'profile') return state.route.albumKey ? renderProfileAlbumPage() : renderProfilePage();
  if (state.route.type === 'explore') return renderExplorePage();
  if (state.payload && state.route.albumId) return renderAlbumPage(state.payload);
  if (state.payload) return renderListPage(state.payload);
  return renderGuestPage();
}

function renderGuestPage() {
  return `
    <main class="page-shell">
      <h1>Albums</h1>
      ${renderAlbumSearch({ guest: true })}
      ${state.guest.albums.length ? `<div class="action-row">${renderActionButton('guest-shuffle', 'dice', 'Shuffle')}</div>` : ''}
      <section class="album-stack">
        ${
          state.guest.albums.length
            ? state.guest.albums.map(renderGuestAlbum).join('')
            : `<div class="empty-minimal">No albums yet.</div>`
        }
      </section>
    </main>
  `;
}

function renderListPage(payload) {
  const content = `
    <section class="page-shell list-main">
      <div class="title-row">
        <div class="list-title-line">
          <h1>${escapeHtml(payload.list.name)}</h1>
          ${payload.permissions.canManage ? renderActionButton('rename-list', 'edit', 'Rename list', { className: 'icon-button title-edit' }) : ''}
        </div>
        ${renderListSelect(payload)}
      </div>
      ${renderListActions(payload)}
      ${state.shareOpen ? renderSharePanel(payload) : ''}
      ${renderAlbumSearch({ guest: false, payload })}
      <section class="album-stack">
        ${
          payload.albums.length
            ? payload.albums.map((album) => renderAlbum(album, payload)).join('')
            : `<div class="empty-minimal">No albums yet.</div>`
        }
      </section>
      ${state.peopleOpen ? renderPeople(payload) : ''}
    </section>
  `;
  if (payload.list.kind === 'collab' && payload.permissions.isMember && state.chatOpen) {
    return `<main class="collab-layout">${content}${renderChatPanel(payload)}</main>`;
  }
  return `
    <main>
      ${content}
    </main>
  `;
}

function renderLoginPage() {
  const isRegister = state.authMode === 'register';
  const guestCount = state.guest.albums.length;
  return `
    <main class="auth-page">
      ${renderActionButton('go-home', 'arrow-left', 'Back', { className: 'text-button back-link' })}
      <section class="auth-card">
        <h1>${isRegister ? 'Create account' : 'Sign in'}</h1>
        <div class="segmented">
          <button class="${!isRegister ? 'active' : ''}" data-action="auth-mode" data-mode="login" type="button">Sign in</button>
          <button class="${isRegister ? 'active' : ''}" data-action="auth-mode" data-mode="register" type="button">Create</button>
        </div>
        <form class="form-stack" data-form="auth">
          ${
            isRegister
              ? `<label><span>Username</span><input name="username" autocomplete="username" required minlength="3" maxlength="30" /></label>
                 <label><span>Email</span><input name="email" type="email" autocomplete="email" required /></label>
                 <div>
                   <span class="label">Music platform</span>
                   <div class="platform-grid">
                     ${platformOptions.map(([value, label]) => platformButton(value, label, state.selectedPlatform)).join('')}
                   </div>
                 </div>`
              : `<label><span>Username or email</span><input name="identifier" autocomplete="username" required /></label>`
          }
          <label>
            <span>Password</span>
            <input name="password" type="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" required minlength="8" />
          </label>
          ${guestCount ? `<div class="soft-line">${guestCount} guest albums will transfer.</div>` : ''}
          <button class="primary icon-text-button" type="submit" title="${isRegister ? 'Create account' : 'Sign in'}">
            ${iconContent(isRegister ? 'user-plus' : 'log-in', isRegister ? 'Create account' : 'Sign in')}
          </button>
        </form>
      </section>
    </main>
  `;
}

function renderInvitePage() {
  return `
    <main class="page-shell">
      <h1>Shared albums</h1>
      <div class="empty-minimal">
        ${
          state.user
            ? renderActionButton('join-invite', 'check', 'Join list', { className: 'primary' })
            : renderActionButton('go-login', 'log-in', 'Sign in to join', { className: 'primary' })
        }
      </div>
    </main>
  `;
}

function renderHistoryPage() {
  if (!state.history) return `<main class="page-shell"><div class="empty-minimal">Loading.</div></main>`;
  return `
    <main class="page-shell">
      <h1>${escapeHtml(state.history.user.username)}'s history</h1>
      <section class="album-stack">
        ${
          state.history.completions.length
            ? state.history.completions.map(renderHistoryItem).join('')
            : '<div class="empty-minimal">No history yet.</div>'
        }
      </section>
    </main>
  `;
}

function renderHistoryAlbumPage() {
  if (!state.history) return `<main class="page-shell"><div class="empty-minimal">Loading.</div></main>`;
  const album = state.history.completions.find((item) => item.albumKey === state.route.albumKey);
  if (!album) {
    return `
      <main class="page-shell detail-shell">
        ${renderActionButton('back-to-history', 'arrow-left', 'Back', { className: 'text-button back-link' })}
        <div class="empty-minimal">Album not found.</div>
      </main>
    `;
  }
  const average = album.aggregate && album.aggregate.average !== null ? `${album.aggregate.average}/10` : 'No average';
  return `
    <main class="page-shell detail-shell">
      ${renderActionButton('back-to-history', 'arrow-left', 'Back', { className: 'text-button back-link' })}
      <section class="album-hero">
        ${renderCover(album)}
        <div>
          <h1>${escapeHtml(album.title)}</h1>
          <p>${escapeHtml(album.artist || 'Unknown artist')}</p>
          <div class="button-row left">
            <span class="pill">${average}</span>
            <span class="pill done">Listened</span>
          </div>
        </div>
      </section>
      ${renderReadOnlyRatings(album.myRatings || [], `${state.history.user.username}'s ratings`)}
    </main>
  `;
}

function renderProfilePage() {
  if (!state.profile) return `<main class="page-shell"><div class="empty-minimal">Loading.</div></main>`;
  return `
    <main class="page-shell profile-shell">
      <section class="profile-hero">
        ${renderAvatar(state.profile.user, true)}
        <div>
          <h1>${escapeHtml(state.profile.user.username)}</h1>
          <p>${state.profile.lists.length} public lists - ${state.profile.ratedAlbums.length} rated albums</p>
        </div>
      </section>
      <section class="profile-section">
        <h2>Public lists</h2>
        <div class="album-stack">
          ${
            state.profile.lists.length
              ? state.profile.lists
                  .map(
                    (list) => `
                      <article class="album-item">
                        <div class="album-line">
                          <button class="album-title" data-action="open-list" data-id="${list.id}">
                            <strong>${escapeHtml(list.name)}</strong>
                            <span>${list.albumCount} albums</span>
                          </button>
                        </div>
                      </article>
                    `
                  )
                  .join('')
              : '<div class="empty-minimal">No public lists.</div>'
          }
        </div>
      </section>
      <section class="profile-section">
        <h2>Rated albums</h2>
        <div class="album-stack">
          ${
            state.profile.ratedAlbums.length
              ? state.profile.ratedAlbums.map(renderProfileAlbum).join('')
              : '<div class="empty-minimal">No rated albums.</div>'
          }
        </div>
      </section>
    </main>
  `;
}

function renderProfileAlbumPage() {
  if (!state.profile) return `<main class="page-shell"><div class="empty-minimal">Loading.</div></main>`;
  const album = state.profile.ratedAlbums.find((item) => item.albumKey === state.route.albumKey);
  if (!album) {
    return `
      <main class="page-shell detail-shell">
        ${renderActionButton('back-to-profile', 'arrow-left', 'Back', { className: 'text-button back-link' })}
        <div class="empty-minimal">Album not found.</div>
      </main>
    `;
  }
  const average = album.average === null ? 'No average' : `${album.average}/10`;
  const ownProfile = isOwnProfile();
  return `
    <main class="page-shell detail-shell">
      ${renderActionButton('back-to-profile', 'arrow-left', 'Back', { className: 'text-button back-link' })}
      <section class="album-hero">
        ${renderCover(album)}
        <div>
          <h1>${escapeHtml(album.title)}</h1>
          <p>${escapeHtml(album.artist || 'Unknown artist')}</p>
          <div class="button-row left">
            <span class="pill">${average}</span>
            ${album.inCommon ? '<span class="pill done">In common</span>' : ''}
            ${album.fullyListened ? '<span class="pill done">Listened</span>' : '<span class="pill">Not finished</span>'}
            ${state.user ? renderActionButton('add-profile-album', 'plus', 'Add to library', {
              className: 'pill',
              attrs: `data-title="${escapeAttr(album.title)}" data-artist="${escapeAttr(album.artist || '')}" data-cover-url="${escapeAttr(album.coverUrl || '')}"`
            }) : ''}
          </div>
        </div>
      </section>
      ${ownProfile ? renderEditableProfileRatings(album) : renderReadOnlyRatings(album.ratings || [], `${state.profile.user.username}'s ratings`)}
    </main>
  `;
}

function isOwnProfile() {
  return Boolean(state.user && state.profile?.user?.id === state.user.id);
}

function renderExplorePage() {
  if (!state.explore) return `<main class="page-shell"><div class="empty-minimal">Loading.</div></main>`;
  if (state.explore.list) {
    if (Number.isInteger(state.route.albumIndex)) return renderExploreAlbumPage();
    return `
      <main class="page-shell explore-shell">
        ${renderActionButton('go-explore', 'arrow-left', 'Explore', { className: 'text-button back-link' })}
        <section class="explore-hero">
          <h1>${escapeHtml(state.explore.list.name)}</h1>
          <p>${escapeHtml(state.explore.list.description)}</p>
        </section>
        <section class="album-stack">
          ${state.explore.list.albums.map(renderExploreAlbumRow).join('')}
        </section>
      </main>
    `;
  }

  const popular = state.explore.popularLists || [];
  return `
    <main class="page-shell explore-shell">
      ${renderActionButton('go-home', 'arrow-left', 'Back', { className: 'text-button back-link' })}
      <h1>Explore</h1>
      <section class="explore-grid">
        ${state.explore.lists
          .map(
            (list) => `
              <button class="explore-card" data-action="open-explore-list" data-slug="${escapeAttr(list.slug)}">
                <strong>${escapeHtml(list.name)}</strong>
                <span>${escapeHtml(list.description)}</span>
                <small>${list.albumCount} albums</small>
              </button>
            `
          )
          .join('')}
      </section>
      ${
        popular.length
          ? `<section class="profile-section">
              <h2>Popular shared lists</h2>
              <div class="album-stack">${popular.map(renderPopularList).join('')}</div>
            </section>`
          : ''
      }
    </main>
  `;
}

function renderExploreAlbumRow(album, index) {
  return `
    <article class="album-item">
      <div class="album-line">
        <div class="rank-number">${index + 1}</div>
        ${renderExploreCover(album, index)}
        <button class="album-title" data-action="open-explore-album" data-index="${index}">
          <strong>${escapeHtml(album.title)}</strong>
          <span>${escapeHtml(album.artist)}${album.releaseYear ? ` - ${album.releaseYear}` : ''}</span>
        </button>
        ${renderExploreAddButton(album, index)}
      </div>
    </article>
  `;
}

function renderExploreAlbumPage() {
  const album = state.explore.list.albums[state.route.albumIndex];
  if (!album) {
    return `
      <main class="page-shell detail-shell">
        ${renderActionButton('back-to-explore-list', 'arrow-left', 'Back', { className: 'text-button back-link' })}
        <div class="empty-minimal">Album not found.</div>
      </main>
    `;
  }
  return `
    <main class="page-shell detail-shell">
      ${renderActionButton('back-to-explore-list', 'arrow-left', 'Back', { className: 'text-button back-link' })}
      <section class="album-hero">
        ${renderExploreCover(album, state.route.albumIndex)}
        <div>
          <h1>${escapeHtml(album.title)}</h1>
          <p>${escapeHtml(album.artist || 'Unknown artist')}${album.releaseYear ? ` - ${album.releaseYear}` : ''}</p>
          <div class="button-row left">
            <a class="pill link-pill" href="${escapeAttr(platformAlbumUrl(album))}" target="_blank" rel="noreferrer">Open</a>
            ${renderExploreAddButton(album, state.route.albumIndex)}
          </div>
        </div>
      </section>
      <div class="empty-minimal small">Add this album to a list to rate tracks.</div>
    </main>
  `;
}

function renderExploreAddButton(album, index) {
  const added = !state.user && guestAlbumIndex(album) !== -1;
  return renderActionButton('add-explore-album', added ? 'check' : 'plus', added ? 'In guest list' : 'Add to library', {
    className: `pill${added ? ' done' : ''}`,
    attrs: `data-index="${escapeAttr(index)}" data-title="${escapeAttr(album.title)}" data-artist="${escapeAttr(album.artist || '')}" data-cover-url="${escapeAttr(album.coverUrl || '')}"`
  });
}

function renderExploreCover(album, index) {
  const attrs = `data-explore-cover="${index}"`;
  if (album.coverUrl) {
    return `<div class="cover" ${attrs}><img src="${escapeAttr(album.coverUrl)}" alt="" loading="lazy" ${coverImageAttrs(album, {
      exploreSlug: state.explore?.list?.slug || '',
      exploreIndex: index
    })} /></div>`;
  }
  return `<div class="cover fallback" ${attrs}>${escapeHtml(initials(album.title))}</div>`;
}

function renderRecommendationAlbum(album) {
  return `
    <article class="album-item">
      <div class="album-line">
        ${renderCover(album)}
        <button class="album-title" data-action="open-recommendation-album" data-title="${escapeAttr(album.title)}" data-artist="${escapeAttr(album.artist || '')}" data-cover-url="${escapeAttr(album.coverUrl || '')}">
          <strong>${escapeHtml(album.title)}</strong>
          <span>${escapeHtml(album.artist || 'Unknown artist')}${album.score ? ` - ${album.score}/10` : ''} - ${escapeHtml(album.reason || '')}</span>
        </button>
        ${renderActionButton('add-recommendation-album', 'plus', 'Add to library', {
          className: 'pill',
          attrs: `data-title="${escapeAttr(album.title)}" data-artist="${escapeAttr(album.artist || '')}" data-cover-url="${escapeAttr(album.coverUrl || '')}"`
        })}
      </div>
    </article>
  `;
}

function renderPopularList(list) {
  return `
    <article class="album-item">
      <div class="album-line">
        <button class="album-title" data-action="open-list" data-id="${list.id}">
          <strong>${escapeHtml(list.name)}</strong>
          <span>${escapeHtml(list.ownerUsername)} - ${list.albumCount} albums - ${list.memberCount} members</span>
        </button>
      </div>
    </article>
  `;
}

function renderProfileAlbum(album) {
  const average = album.average === null ? 'No average' : `${album.average}/10`;
  return `
    <article class="album-item ${album.inCommon ? 'common' : ''}">
      <div class="album-line">
        ${renderCover(album)}
        <button class="album-title" data-action="open-profile-album" data-key="${escapeAttr(album.albumKey)}">
          <strong>${escapeHtml(album.title)}</strong>
          <span>${escapeHtml(album.artist || 'Unknown artist')} - ${average}${album.fullyListened ? '' : ' - not finished'}${album.inCommon ? ' - in common' : ''}</span>
        </button>
      </div>
    </article>
  `;
}

function renderAlbumPage(payload) {
  const album = payload.albums.find((item) => item.id === state.route.albumId);
  if (!album) {
    return `
      <main class="page-shell detail-shell">
        ${renderActionButton('back-to-list', 'arrow-left', 'Back', { className: 'text-button back-link' })}
        <div class="empty-minimal">Album not found.</div>
      </main>
    `;
  }
  const average = album.aggregate && album.aggregate.average !== null ? `${album.aggregate.average}/10` : 'No average';
  const alreadyInMain = Boolean(album.currentUserLibrary);
  const canCopy = Boolean(state.user && payload.list.ownerUserId !== state.user.id && copyTargetList() && !alreadyInMain);
  const libraryLabel = alreadyInMain
    ? album.currentUserLibrary.ratingCount
      ? `Your ${album.currentUserLibrary.average}/10`
      : 'In your list'
    : '';
  return `
    <main class="page-shell detail-shell">
      ${renderActionButton('back-to-list', 'arrow-left', 'Back', { className: 'text-button back-link' })}
      <section class="album-hero">
        ${renderCover(album, { listId: payload.list.id, albumId: album.id, canRefresh: payload.permissions.canEdit })}
        <div>
          <h1>${escapeHtml(album.title)}</h1>
          <p>${escapeHtml(album.artist || 'Unknown artist')}</p>
          <div class="button-row left">
            <span class="pill">${average}</span>
            ${album.externalUrl ? `<a class="pill link-pill" href="${escapeAttr(album.externalUrl)}" target="_blank" rel="noreferrer">Open</a>` : ''}
            ${renderCompletion(album, payload)}
            ${libraryLabel ? `<span class="pill done">${escapeHtml(libraryLabel)}</span>` : ''}
            ${canCopy ? renderActionButton('copy-album', 'plus', 'Add to mine', { className: 'pill', attrs: `data-id="${album.id}"` }) : ''}
            ${payload.permissions.canEdit ? renderActionButton('refresh-album-cover', 'refresh', 'Refresh cover', { className: 'pill', attrs: `data-id="${album.id}"` }) : ''}
          </div>
        </div>
      </section>
      ${renderAlbumDetails(album, payload)}
    </main>
  `;
}

function renderListSelect(payload) {
  if (!state.user || !state.lists.length) return '';
  if (state.lists.length <= 5) {
    return `
      <div class="list-switcher" aria-label="Switch list">
        ${state.lists
          .map(
            (list) => `
              <button class="${list.id === payload.list.id ? 'active' : ''}" data-action="open-list" data-id="${list.id}">
                ${escapeHtml(list.name)}
              </button>
            `
          )
          .join('')}
      </div>
    `;
  }
  return `
    <select class="list-select" data-change="list-select" aria-label="Switch list">
      ${state.lists
        .map((list) => `<option value="${list.id}" ${list.id === payload.list.id ? 'selected' : ''}>${escapeHtml(list.name)}</option>`)
        .join('')}
    </select>
  `;
}

function renderListActions(payload) {
  const canShare = payload.list.visibility !== 'private' || payload.permissions.canManage;
  const unread = chatUnreadCount(payload);
  return `
    <div class="action-row">
      ${payload.albums.length ? renderActionButton('shuffle-album', 'dice', 'Shuffle') : ''}
      ${
        payload.permissions.canManage
          ? renderActionButton('settings-toggle', 'gear', 'Settings', { active: state.settingsOpen })
          : ''
      }
      ${
        state.user
          ? renderActionButton('create-collab', 'plus', 'New shared list')
          : ''
      }
      ${payload.permissions.isMember ? renderActionButton('people-toggle', 'users', 'People', { active: state.peopleOpen }) : ''}
      ${
        canShare
          ? renderActionButton('share-list', 'share', 'Share', { active: state.shareOpen })
          : ''
      }
      ${
        payload.list.kind === 'collab' && payload.permissions.isMember
          ? renderActionButton('chat-toggle', 'message', 'Chat', { active: state.chatOpen, badge: unread })
          : ''
      }
    </div>
  `;
}

function renderSharePanel(payload) {
  const canInvite = payload.permissions.canManage && payload.list.kind === 'collab';
  return `
    <section class="share-panel">
      <div class="share-head">
        <div>
          <strong>Share ${escapeHtml(payload.list.name)}</strong>
          <span>Anyone with the link can view. Members can do more.</span>
        </div>
        ${renderActionButton('copy-share-link', 'copy', 'Copy link', { className: 'primary' })}
      </div>
      ${
        canInvite
          ? `<div class="share-search">
              <input
                data-input="user-search"
                value="${escapeAttr(state.userSearchQuery)}"
                placeholder="Search users..."
                autocomplete="off"
                spellcheck="false"
              />
              <select data-change="share-role">
                <option value="editor" ${state.shareRole === 'editor' ? 'selected' : ''}>Editor</option>
                <option value="viewer" ${state.shareRole === 'viewer' ? 'selected' : ''}>Viewer</option>
              </select>
            </div>
            ${renderUserResults(payload)}`
          : ''
      }
      <div class="member-list">
        ${payload.members.map((member) => renderMemberLine(member, payload)).join('')}
      </div>
    </section>
  `;
}

function renderUserResults(payload) {
  if (state.userSearching) return `<div class="user-results"><div class="user-line muted">Searching.</div></div>`;
  if (!state.userSearchQuery) return '';
  if (!state.userResults.length) return `<div class="user-results"><div class="user-line muted">No users found.</div></div>`;
  const memberIds = new Set(payload.members.map((member) => member.userId));
  return `
    <div class="user-results">
      ${state.userResults
        .map((user) => {
          const alreadyMember = memberIds.has(user.id);
          return `
            <div class="user-line">
              ${renderAvatar(user, true)}
              ${renderProfileName(user)}
              ${
                alreadyMember
                  ? '<span class="pill done">Member</span>'
                  : renderActionButton('invite-user-result', 'send', 'Invite', {
                      className: 'pill',
                      attrs: `data-id="${user.id}" data-username="${escapeAttr(user.username)}"`
                    })
              }
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

function canRemoveMember(payload, member) {
  if (!state.user || payload.list.kind !== 'collab') return false;
  if (member.userId === payload.list.ownerUserId) return false;
  if (payload.permissions.canManage) return true;
  return member.userId === state.user.id;
}

function renderMemberRemoveButton(payload, member) {
  if (!canRemoveMember(payload, member)) return '';
  const isSelf = state.user && member.userId === state.user.id;
  return renderActionButton('remove-member', 'x', isSelf ? 'Leave list' : 'Remove member', {
    className: 'icon-button danger',
    attrs: `data-user-id="${member.userId}" data-self="${isSelf ? '1' : '0'}"`
  });
}

function renderMemberLine(member, payload) {
  return `
    <div class="user-line">
      ${renderAvatar(member, true)}
      ${renderProfileName(member)}
      <span>${escapeHtml(member.role)}</span>
      ${renderMemberRemoveButton(payload, member)}
    </div>
  `;
}

function renderAlbumSearch({ guest, payload }) {
  if (!guest && !payload.permissions.canEdit) return '';
  return `
    <form class="search-wrap" data-form="${guest ? 'guest-album' : 'album'}">
      <div class="search-field">
        <input
          name="album"
          data-input="album-search"
          value="${escapeAttr(state.albumQuery)}"
          placeholder="Add an album..."
          autocomplete="off"
          spellcheck="false"
        />
        ${renderSuggestions()}
      </div>
    </form>
  `;
}

function renderSuggestions() {
  if (state.searching) return `<div class="suggestions"><div class="suggestion-empty">Searching.</div></div>`;
  if (!state.albumQuery || state.albumQuery.length < 2) return '';
  if (!state.suggestions.length) return `<div class="suggestions"><div class="suggestion-empty">No albums found.</div></div>`;
  return `
    <div class="suggestions">
      ${state.suggestions
        .map(
          (album) => `
            <button class="suggestion ${state.selectedAlbum?.providerId === album.providerId ? 'selected' : ''}" type="button" data-action="select-suggestion" data-id="${escapeAttr(album.providerId)}">
              ${renderTinyCover(album)}
              <span>
                <strong>${escapeHtml(album.title)}</strong>
                <small>${escapeHtml(album.artist || 'Unknown artist')}${album.releaseYear ? ` - ${album.releaseYear}` : ''}</small>
              </span>
            </button>
          `
        )
        .join('')}
    </div>
  `;
}

function renderSettingsModal(payload = null) {
  return `
    <div class="modal-backdrop">
      <section class="settings-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <strong>Settings</strong>
          ${renderActionButton('settings-close', 'x', 'Close', { className: 'icon-button' })}
        </div>
        <div class="settings-grid">
          <div>
            <span class="label">Theme</span>
            <div class="segmented">
              ${themeButton('system', 'System')}
              ${themeButton('light', 'Light')}
              ${themeButton('dark', 'Dark')}
              ${themeButton('retro', '90s')}
            </div>
          </div>
          ${
            state.user
              ? `<div>
                  <span class="label">Music platform</span>
                  <div class="platform-grid">
                    ${platformOptions.map(([value, label]) => platformButton(value, label, state.user.musicPlatform || 'na')).join('')}
                  </div>
                </div>
                <div>
                  <span class="label">Accent color</span>
                  <div class="accent-row">
                    <input type="color" value="${escapeAttr(state.user.accentColor || '#1db954')}" data-change="accent-color" />
                    ${renderActionButton('accent-platform', 'refresh', 'Use platform color')}
                  </div>
                </div>
                <div>
                  <span class="label">Account</span>
                  <div class="button-row">
                    <label class="upload-button icon-text-button" title="Profile photo">
                      ${iconContent('image', 'Profile photo')}
                      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-change="avatar-upload" />
                    </label>
                    ${renderActionButton('open-profile', 'user', 'Profile')}
                    ${renderActionButton('logout', 'log-out', 'Log out')}
                    ${renderActionButton('copy', 'copy', 'Copy history', { attrs: `data-copy="${escapeAttr(`${location.origin}/history/${state.user.historyToken}`)}"` })}
                  </div>
                </div>`
              : ''
          }
          ${state.invites.length ? renderInviteNotifications() : ''}
          ${payload && payload.permissions.canManage ? renderOwnerSettings(payload) : ''}
        </div>
      </section>
    </div>
  `;
}

function renderAvatarCropModal() {
  const crop = state.avatarCrop;
  const posX = 50 + Number(crop.x || 0) / 2;
  const posY = 50 + Number(crop.y || 0) / 2;
  return `
    <div class="modal-backdrop">
      <section class="settings-modal crop-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <strong>Crop profile photo</strong>
          ${renderActionButton('avatar-crop-cancel', 'x', 'Close', { className: 'icon-button' })}
        </div>
        <div class="crop-frame" data-crop-frame>
          <img
            src="${escapeAttr(crop.dataUrl)}"
            alt=""
            style="width:${Number(crop.zoom || 1) * 100}%; height:${Number(crop.zoom || 1) * 100}%; object-position:${posX}% ${posY}%;"
          />
        </div>
        <div class="crop-controls">
          <label>
            <span class="label">Zoom</span>
            <input type="range" min="1" max="3" step="0.05" value="${escapeAttr(crop.zoom)}" data-input="avatar-crop-zoom" />
          </label>
          <label>
            <span class="label">Left / right</span>
            <input type="range" min="-100" max="100" step="1" value="${escapeAttr(crop.x)}" data-input="avatar-crop-x" />
          </label>
          <label>
            <span class="label">Up / down</span>
            <input type="range" min="-100" max="100" step="1" value="${escapeAttr(crop.y)}" data-input="avatar-crop-y" />
          </label>
        </div>
        <div class="button-row left">
          ${renderActionButton('avatar-crop-save', 'check', 'Save photo', { className: 'primary' })}
          ${renderActionButton('avatar-crop-cancel', 'x', 'Cancel')}
        </div>
      </section>
    </div>
  `;
}

function renderListPickerModal() {
  const picker = state.listPicker;
  const lists = editableListOptions();
  return `
    <div class="modal-backdrop">
      <section class="settings-modal list-picker-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <strong>Save to lists</strong>
          ${renderActionButton('list-picker-close', 'x', 'Close', { className: 'icon-button' })}
        </div>
        <div class="album-line picker-album">
          ${renderCover(picker.album)}
          <div class="album-title static">
            <strong>${escapeHtml(picker.album.title)}</strong>
            <span>${escapeHtml(picker.album.artist || 'Unknown artist')}</span>
          </div>
        </div>
        <div class="picker-list">
          ${
            lists.length
              ? lists
                  .map((list) => {
                    const added = picker.addedListIds.has(String(list.id));
                    return `
                      <button class="picker-line ${added ? 'added' : ''}" data-action="list-picker-toggle" data-id="${escapeAttr(list.id)}">
                        <span>${escapeHtml(list.name)}</span>
                        ${added ? iconSvg('check') : iconSvg('plus')}
                      </button>
                    `;
                  })
                  .join('')
              : '<div class="empty-minimal small">No editable lists yet.</div>'
          }
        </div>
        <div class="button-row left">
          ${renderActionButton('list-picker-close', 'check', 'Done', { className: 'primary' })}
        </div>
      </section>
    </div>
  `;
}

function platformButton(value, label, selected) {
  return `<button class="${selected === value ? 'active' : ''}" data-action="platform-set" data-platform="${value}" type="button">${label}</button>`;
}

function renderActionButton(action, iconName, label, options = {}) {
  const active = options.active ? ' active' : '';
  const className = `${options.className || 'text-button'} icon-text-button${active}`;
  const attrs = options.attrs ? ` ${options.attrs}` : '';
  const badge = options.badge ? `<span class="button-badge">${escapeHtml(options.badge)}</span>` : '';
  return `<button class="${className}" type="button" data-action="${escapeAttr(action)}" title="${escapeAttr(label)}"${attrs}>${iconContent(iconName, label)}${badge}</button>`;
}

function iconContent(iconName, label) {
  return `${iconSvg(iconName)}<span class="button-label">${escapeHtml(label)}</span>`;
}

function iconSvg(name) {
  const icons = {
    'arrow-left': '<path d="M15 6l-6 6 6 6"/><path d="M9 12h11"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15 9-2 6-6 2 2-6 6-2z"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    gear: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    headphones: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="2"/><rect x="17" y="14" width="4" height="6" rx="2"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m21 16-5-5L5 19"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    'log-in': '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5"/>',
    send: '<path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    'user-plus': '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
    users: '<path d="M16 21a6 6 0 0 0-12 0"/><circle cx="10" cy="8" r="4"/><path d="M22 21a5 5 0 0 0-4-4.9"/><path d="M16 4.1a4 4 0 0 1 0 7.8"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>'
  };
  return `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.system}</svg>`;
}

function renderChatPanel(payload) {
  return `
    <aside class="chat-panel">
      <div class="chat-head">
        <strong>Chat</strong>
        <div>
          <span>${payload.members.length} people</span>
          ${renderActionButton('chat-toggle', 'x', 'Close chat', { className: 'icon-button' })}
        </div>
      </div>
      <div class="chat-messages">
        ${
          payload.messages.length
            ? payload.messages.map(renderChatMessage).join('')
            : '<div class="empty-chat">No messages yet.</div>'
        }
      </div>
      <form class="chat-form" data-form="chat">
        <input name="body" data-input="chat-body" value="${escapeAttr(state.chatDraft)}" placeholder="Message..." autocomplete="off" maxlength="800" />
        <button class="primary icon-text-button" type="submit" title="Send">${iconContent('send', 'Send')}</button>
      </form>
    </aside>
  `;
}

function renderChatMessage(message) {
  return `
    <div class="chat-message">
      ${renderAvatar(message, true)}
      <div>
        <div class="chat-meta">
          ${renderProfileName(message)}
          <time>${escapeHtml(formatTime(message.createdAt))}</time>
        </div>
        <p>${escapeHtml(message.body)}</p>
      </div>
    </div>
  `;
}

function renderInviteNotifications() {
  return `
    <div class="invite-list">
      <span class="label">Invites</span>
      ${state.invites
        .map(
          (invite) => `
            <div class="invite-line">
              <span>${renderProfileName({ username: invite.inviterUsername })} invited you to ${escapeHtml(invite.listName)}</span>
              <div class="button-row tight">
                ${renderActionButton('accept-invite', 'check', 'Accept', { attrs: `data-id="${invite.id}"` })}
                ${renderActionButton('decline-invite', 'x', 'Decline', { attrs: `data-id="${invite.id}"` })}
              </div>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderOwnerSettings(payload) {
  return `
    <form class="owner-settings" data-form="list-settings">
      <label>
        <span class="label">List name</span>
        <input name="name" value="${escapeAttr(payload.list.name)}" required maxlength="80" />
      </label>
      <label>
        <span class="label">Visibility</span>
        <select name="visibility">
          <option value="private" ${payload.list.visibility === 'private' ? 'selected' : ''}>Private</option>
          <option value="unlisted" ${payload.list.visibility === 'unlisted' ? 'selected' : ''}>Unlisted</option>
          <option value="public" ${payload.list.visibility === 'public' ? 'selected' : ''}>Public</option>
        </select>
      </label>
      <label>
        <span class="label">Ratings</span>
        <select name="showRatings">
          <option value="1" ${payload.list.showRatings ? 'selected' : ''}>Visible</option>
          <option value="0" ${!payload.list.showRatings ? 'selected' : ''}>Hidden</option>
        </select>
      </label>
      <div class="button-row">
        <button class="primary icon-text-button" type="submit" title="Save">${iconContent('check', 'Save')}</button>
      </div>
    </form>
  `;
}

function themeButton(value, label) {
  return `<button class="${state.themePreference === value ? 'active' : ''}" data-action="theme-set" data-theme="${value}">${label}</button>`;
}

function renderAlbum(album, payload) {
  const average = album.aggregate && album.aggregate.average !== null ? `${album.aggregate.average}/10` : '';
  const alreadyInMain = Boolean(album.currentUserLibrary);
  const canCopy = Boolean(state.user && payload.list.ownerUserId !== state.user.id && copyTargetList() && !alreadyInMain);
  const libraryLabel = alreadyInMain
    ? album.currentUserLibrary.ratingCount
      ? `Your ${album.currentUserLibrary.average}/10`
      : 'In your list'
    : '';
  const canVoteRemove = payload.list.kind === 'collab' && payload.permissions.isMember;
  const removeLabel =
    payload.list.kind === 'collab'
      ? album.currentUserRemovalVoted
        ? `Voted ${album.removalVoteCount}/${album.removalVoteThreshold}`
        : `Remove ${album.removalVoteCount}/${album.removalVoteThreshold}`
      : 'x';
  return `
    <article class="album-item ${state.highlightAlbumId === album.id ? 'highlight' : ''}" data-album-id="${album.id}">
      <div class="album-line">
        ${renderCover(album, { listId: payload.list.id, albumId: album.id, canRefresh: payload.permissions.canEdit })}
        <button class="album-title" data-action="open-album-page" data-id="${album.id}">
          <strong>${escapeHtml(album.title)}</strong>
          <span>${escapeHtml(album.artist || 'Unknown artist')}${average ? ` - ${average}` : ''}</span>
        </button>
        ${renderCompletion(album, payload)}
        ${libraryLabel ? `<span class="pill done">${escapeHtml(libraryLabel)}</span>` : ''}
        ${canCopy ? renderActionButton('copy-album', 'plus', 'Add', { className: 'pill', attrs: `data-id="${album.id}"` }) : ''}
        ${
          payload.permissions.canEdit || canVoteRemove
            ? renderActionButton('delete-album', 'trash', removeLabel, {
                className: payload.list.kind === 'collab' ? 'pill danger' : 'icon-button danger',
                attrs: `data-id="${album.id}"`,
                badge: payload.list.kind === 'collab' ? `${album.removalVoteCount}/${album.removalVoteThreshold}` : ''
              })
            : ''
        }
      </div>
    </article>
  `;
}

function renderGuestAlbum(album) {
  return `
    <article class="album-item ${state.highlightAlbumId === album.id ? 'highlight' : ''}" data-album-id="${escapeAttr(album.id)}">
      <div class="album-line">
        ${renderCover(album)}
        <button class="album-title" data-action="guest-toggle" data-id="${album.id}">
          <strong>${escapeHtml(album.title)}</strong>
          <span>${escapeHtml(album.artist || 'Unknown artist')}${album.completed ? ' - listened' : ''}</span>
        </button>
        ${renderActionButton('guest-delete', 'trash', 'Remove', { className: 'icon-button danger', attrs: `data-id="${album.id}"` })}
      </div>
    </article>
  `;
}

function renderHistoryItem(item) {
  const average = item.aggregate && item.aggregate.average !== null ? ` - ${item.aggregate.average}/10` : '';
  return `
    <article class="album-item">
      <div class="album-line">
        ${renderCover(item)}
        <button class="album-title" data-action="open-history-album" data-key="${escapeAttr(item.albumKey)}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.artist || 'Unknown artist')}${average}</span>
        </button>
      </div>
    </article>
  `;
}

function renderReadOnlyRatings(ratings, title) {
  if (!ratings.length) {
    return `<div class="empty-minimal small">No ratings recorded.</div>`;
  }
  return `
    <section class="readonly-ratings">
      <h2>${escapeHtml(title)}</h2>
      <div class="track-list">
        ${ratings
          .map(
            (rating) => `
              <div class="track-row readonly-rating-row">
                <div>
                  <strong>${escapeHtml(rating.trackTitle || 'Album rating')}</strong>
                  <span>${rating.includeInAverage ? 'Included in average' : 'Hidden from average'}</span>
                </div>
                <span class="rating-pill">${rating.rating}/10</span>
              </div>
            `
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderEditableProfileRatings(album) {
  const ratings = album.ratings || [];
  if (!ratings.length) {
    return `<div class="empty-minimal small">No ratings recorded.</div>`;
  }
  return `
    <section class="readonly-ratings editable-profile-ratings">
      <h2>Your ratings</h2>
      <div class="track-list">
        ${ratings
          .map(
            (rating) => `
              <div class="track-row readonly-rating-row">
                <div>
                  <strong>${escapeHtml(rating.trackTitle || 'Album rating')}</strong>
                  <span>${rating.includeInAverage ? 'Included in average' : 'Hidden from average'}</span>
                </div>
                <div class="rating-row">
                  ${Array.from({ length: 11 }, (_, value) => {
                    const active = rating.rating === value;
                    return `<button class="${active ? 'active' : ''}" data-action="rate-profile-track" data-album-key="${escapeAttr(album.albumKey)}" data-track-key="${escapeAttr(rating.trackKey)}" data-track-title="${escapeAttr(rating.trackTitle || 'Album rating')}" data-rating="${value}">${value}</button>`;
                  }).join('')}
                </div>
              </div>
            `
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderAlbumDetails(album, payload) {
  const averageToggle =
    payload.permissions.canRate && payload.list.showRatings
      ? renderActionButton('average-opt', album.currentUserAverageOptIn ? 'check' : 'x', `Averages ${album.currentUserAverageOptIn ? 'on' : 'off'}`, {
          className: 'pill',
          attrs: `data-album-id="${album.id}"`
        })
      : '';
  return `
    <div class="album-details">
      ${
        album.tracks.length
          ? `${averageToggle ? `<div class="album-detail-controls">${averageToggle}</div>` : ''}<div class="track-list">${album.tracks.map((track) => renderTrack(track, album, payload)).join('')}</div>`
          : renderAlbumRatingFallback(album, payload, averageToggle)
      }
    </div>
  `;
}

function renderAlbumRatingFallback(album, payload, averageToggle = '') {
  if (!payload.permissions.canRate) {
    return `<div class="empty-minimal small">Track list unavailable.</div>`;
  }
  const average = album.aggregate && album.aggregate.average !== null ? `${album.aggregate.average}/10` : 'No average';
  return `
    <div class="album-rating-panel">
      <div class="track-row album-rating-row">
        <div>
          <strong>Album rating</strong>
          <span>Track list unavailable - ${average}</span>
        </div>
        <div class="rating-row">
          ${Array.from({ length: 11 }, (_, rating) => {
            const active = album.currentUserAlbumRating?.rating === rating;
            return `<button class="${active ? 'active' : ''}" data-action="rate-album" data-album-id="${album.id}" data-rating="${rating}">${rating}</button>`;
          }).join('')}
        </div>
      </div>
      ${averageToggle ? `<div class="album-detail-controls">${averageToggle}</div>` : ''}
    </div>
  `;
}

function renderTrack(track, album, payload) {
  const average = track.aggregate && track.aggregate.average !== null ? `${track.aggregate.average}/10` : '';
  return `
    <div class="track-row">
      <div>
        <strong>${escapeHtml(track.position)}. ${escapeHtml(track.title)}</strong>
        ${average ? `<span>${average}</span>` : ''}
      </div>
      ${
        payload.permissions.canRate
          ? `<div class="rating-row">
              ${Array.from({ length: 11 }, (_, rating) => {
                const active = track.userRating?.rating === rating;
                return `<button class="${active ? 'active' : ''}" data-action="rate" data-album-id="${album.id}" data-track-id="${track.id}" data-rating="${rating}">${rating}</button>`;
              }).join('')}
            </div>`
          : ''
      }
    </div>
  `;
}

function renderCompletion(album, payload) {
  const canMark = Boolean(state.user && payload.permissions.isMember);
  const completedIds = new Set(album.completions.map((completion) => completion.userId));
  const visibleMembers = payload.members.length > 4 ? album.pendingMembers : payload.members;
  return `
    <div class="completion">
      ${visibleMembers.map((member) => renderAvatar(member, completedIds.has(member.userId))).join('')}
      ${
        canMark
          ? renderActionButton('complete', 'headphones', album.currentUserCompleted ? 'Listened' : 'Listen', {
              className: `pill ${album.currentUserCompleted ? 'done' : ''}`,
              attrs: `data-id="${album.id}"`
            })
          : ''
      }
    </div>
  `;
}

function renderPeople(payload) {
  return `
    <section class="people-panel">
      ${payload.members
        .map((member) => {
          const completed = payload.albums.filter((album) => album.completions.some((item) => item.userId === member.userId)).length;
          return `
            <div class="person-line">
              ${renderAvatar(member, true)}
              ${renderProfileName(member)}
              <span>${completed}/${payload.albums.length} listened</span>
              <span>${escapeHtml(member.role)}</span>
              ${renderMemberRemoveButton(payload, member)}
            </div>
          `;
        })
        .join('')}
    </section>
  `;
}

function coverImageAttrs(album, context = {}) {
  const attrs = [
    'data-cover-img="1"',
    `data-cover-title="${escapeAttr(album.title || '')}"`,
    `data-cover-artist="${escapeAttr(album.artist || '')}"`
  ];
  if (context.listId && context.albumId && context.canRefresh) {
    attrs.push(`data-cover-list-id="${escapeAttr(context.listId)}"`);
    attrs.push(`data-cover-album-id="${escapeAttr(context.albumId)}"`);
  }
  if (context.exploreSlug && Number.isInteger(Number(context.exploreIndex))) {
    attrs.push(`data-cover-explore-slug="${escapeAttr(context.exploreSlug)}"`);
    attrs.push(`data-cover-explore-index="${escapeAttr(context.exploreIndex)}"`);
  }
  return attrs.join(' ');
}

function renderCover(album, context = {}) {
  if (album.coverUrl) {
    return `<div class="cover"><img src="${escapeAttr(album.coverUrl)}" alt="" loading="lazy" ${coverImageAttrs(album, context)} /></div>`;
  }
  return `<div class="cover fallback">${escapeHtml(initials(album.title))}</div>`;
}

function albumPath(albumId) {
  if (state.route.type === 'share') return `/share/${state.route.token}/album/${albumId}`;
  return `/list/${state.payload.list.id}/album/${albumId}`;
}

function copyTargetList() {
  if (!state.user) return null;
  const currentListId = state.payload?.list?.id;
  const editable = state.lists.filter((list) => ['owner', 'editor'].includes(list.role) && list.id !== currentListId);
  return editable.find((list) => list.kind === 'personal') || editable[0] || null;
}

function defaultEditableList() {
  if (!state.user) return null;
  const editable = state.lists.filter((list) => ['owner', 'editor'].includes(list.role));
  return editable.find((list) => list.kind === 'personal') || editable[0] || null;
}

function editableListOptions() {
  if (!state.user) return [{ id: 'guest', name: 'Guest list' }];
  return state.lists.filter((list) => ['owner', 'editor'].includes(list.role));
}

function normalizeAlbumText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function clientAlbumKey(title, artist) {
  return `${normalizeAlbumText(artist) || 'unknown'}::${normalizeAlbumText(title)}`;
}

function guestAlbumIndex(album) {
  const key = clientAlbumKey(album.title, album.artist);
  return state.guest.albums.findIndex((item) => clientAlbumKey(item.title, item.artist) === key);
}

function addAlbumToGuestList(album) {
  const guestAlbum = {
    title: album.title || '',
    artist: album.artist || '',
    coverUrl: album.coverUrl || '',
    tracks: album.tracks || []
  };
  if (!guestAlbum.title) throw new Error('Album title is required.');
  if (guestAlbumIndex(guestAlbum) !== -1) {
    state.notice = 'Already in guest list.';
    return false;
  }
  state.guest.albums.unshift({ ...guestAlbum, id: randomId(), completed: false });
  saveGuest();
  state.notice = 'Added to guest list.';
  return true;
}

async function openListPicker(album) {
  const pickerAlbum = {
    title: album.title || '',
    artist: album.artist || '',
    coverUrl: album.coverUrl || '',
    tracks: album.tracks || []
  };
  const addedListIds = new Set();
  if (!state.user) {
    if (guestAlbumIndex(pickerAlbum) !== -1) addedListIds.add('guest');
  } else {
    try {
      const params = new URLSearchParams({ title: pickerAlbum.title, artist: pickerAlbum.artist });
      const data = await api(`/api/me/album-lists?${params.toString()}`);
      for (const item of data.items || []) {
        if (item.albumId) addedListIds.add(String(item.listId));
      }
    } catch {
      // The picker can still add albums if membership lookup fails.
    }
  }
  state.listPicker = {
    album: pickerAlbum,
    addedListIds
  };
}

async function ensurePickerAlbumDetails() {
  if (!state.listPicker) throw new Error('No album selected.');
  const album = state.listPicker.album;
  if (album.tracks?.length) return album;
  const query = `${album.title || ''} ${album.artist || ''}`.trim();
  if (!query) return album;
  try {
    const search = await api(`/api/albums/search?q=${encodeURIComponent(query)}`);
    const result = (search.results || [])[0];
    if (!result) return album;
    const details = await api(`/api/albums/lookup/${encodeURIComponent(result.providerId)}`);
    state.listPicker.album = {
      title: details.album.title || album.title,
      artist: details.album.artist || album.artist,
      coverUrl: details.album.coverUrl || album.coverUrl || '',
      tracks: details.album.tracks || []
    };
  } catch {
    // Adding the typed album is still better than blocking the picker.
  }
  return state.listPicker.album;
}

async function togglePickerAlbumForList(listId) {
  if (!state.listPicker) return;
  if (state.listPicker.addedListIds.has(String(listId))) {
    await removePickerAlbumFromList(listId);
    return;
  }
  const album = await ensurePickerAlbumDetails();
  if (listId === 'guest') {
    if (!addAlbumToGuestList(album)) {
      state.listPicker.addedListIds.add('guest');
      return render();
    }
    state.listPicker.addedListIds.add('guest');
    return render();
  }

  const targetList = editableListOptions().find((list) => String(list.id) === String(listId));
  if (!targetList) throw new Error('You do not have edit access to that list.');
  const result = await api(`/api/lists/${targetList.id}/albums/copy`, {
    method: 'POST',
    body: album
  });
  state.listPicker.addedListIds.add(String(targetList.id));
  state.notice = result.copied ? `Added to ${targetList.name}.` : `Already in ${targetList.name}.`;
  await refreshMe();
  if (state.payload?.list?.id === targetList.id) setCurrentPayload(payloadFromResponse(result));
  return render();
}

async function removePickerAlbumFromList(listId) {
  if (!state.listPicker) return;
  const album = state.listPicker.album;
  if (listId === 'guest') {
    const index = guestAlbumIndex(album);
    if (index !== -1) state.guest.albums.splice(index, 1);
    state.listPicker.addedListIds.delete('guest');
    saveGuest();
    state.notice = 'Removed from guest list.';
    return render();
  }

  const targetList = editableListOptions().find((list) => String(list.id) === String(listId));
  if (!targetList) throw new Error('You do not have edit access to that list.');
  const result = await api(`/api/lists/${targetList.id}/albums/by-key`, {
    method: 'DELETE',
    body: { title: album.title, artist: album.artist }
  });
  if (result.removed || !result.albumId) {
    state.listPicker.addedListIds.delete(String(targetList.id));
    state.notice = `Removed from ${targetList.name}.`;
  } else if (result.voteCount) {
    state.listPicker.addedListIds.add(String(targetList.id));
    state.notice = `Removal vote recorded (${result.voteCount}/${result.threshold}).`;
  } else {
    state.listPicker.addedListIds.delete(String(targetList.id));
    state.notice = `Not in ${targetList.name}.`;
  }
  await refreshMe();
  if (state.payload?.list?.id === targetList.id) setCurrentPayload(payloadFromResponse(result));
  return render();
}

function exploreAlbumFromTarget(target) {
  const index = Number(target.dataset.index);
  const album = Number.isInteger(index) ? state.explore?.list?.albums?.[index] : null;
  return {
    title: album?.title || target.dataset.title || '',
    artist: album?.artist || target.dataset.artist || '',
    coverUrl: album?.coverUrl || target.dataset.coverUrl || '',
    tracks: album?.tracks || []
  };
}

function setCurrentPayload(payload) {
  if (!payload) return;
  state.payload = payload;
  ensureChatBaseline(payload);
  if (state.chatOpen) markChatRead(payload);
  else updateChatUnread(payload);
  if (state.route.albumId && !payload.albums.some((album) => album.id === state.route.albumId)) {
    if (state.route.type === 'share') history.replaceState(null, '', `/share/${state.route.token}`);
    else history.replaceState(null, '', `/list/${payload.list.id}`);
    state.route = parseRoute();
  }
}

function payloadFromResponse(data) {
  if (!data) return null;
  if (data.permissions && data.albums) return data;
  if (data.list?.permissions && data.list?.albums) return data.list;
  return null;
}

function latestMessageId(payload) {
  if (!payload?.messages?.length) return 0;
  return Math.max(...payload.messages.map((message) => Number(message.id) || 0));
}

function loadChatReadIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_READ_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveChatReadIds() {
  localStorage.setItem(CHAT_READ_KEY, JSON.stringify(state.chatReadIds));
}

function ensureChatBaseline(payload) {
  if (!payload?.list || payload.list.kind !== 'collab') return;
  const key = String(payload.list.id);
  if (state.chatReadIds[key] !== undefined) return;
  state.chatReadIds[key] = latestMessageId(payload);
  state.chatUnread[key] = 0;
  saveChatReadIds();
}

function markChatRead(payload) {
  if (!payload?.list || payload.list.kind !== 'collab') return;
  const key = String(payload.list.id);
  state.chatReadIds[key] = latestMessageId(payload);
  state.chatUnread[key] = 0;
  saveChatReadIds();
}

function updateChatUnread(payload) {
  if (!payload?.list || payload.list.kind !== 'collab') return;
  const key = String(payload.list.id);
  const lastRead = Number(state.chatReadIds[key] || 0);
  state.chatUnread[key] = payload.messages.filter((message) => Number(message.id) > lastRead).length;
}

function chatUnreadCount(payload) {
  if (!payload?.list) return 0;
  return Number(state.chatUnread[String(payload.list.id)] || 0);
}

function renderTinyCover(album) {
  if (album.coverUrl) return `<img class="tiny-cover" src="${escapeAttr(album.coverUrl)}" alt="" loading="lazy" ${coverImageAttrs(album)} />`;
  return `<span class="tiny-cover fallback">${escapeHtml(initials(album.title))}</span>`;
}

function renderAvatar(member, complete, clickable = true) {
  const content = member.avatarUrl
    ? `<img src="${escapeAttr(member.avatarUrl)}" alt="" />`
    : escapeHtml(initials(member.username).slice(0, 2));
  const attrs = `class="avatar ${complete ? '' : 'pending'}" style="background:${escapeAttr(member.avatarColor || '#2563eb')}" title="${escapeAttr(member.username)}"`;
  if (!clickable || !member.username) return `<span ${attrs}>${content}</span>`;
  return `<button ${attrs} data-action="open-user-profile" data-username="${escapeAttr(member.username)}">${content}</button>`;
}

function renderProfileName(user) {
  return `<button class="profile-link" data-action="open-user-profile" data-username="${escapeAttr(user.username)}">${escapeHtml(user.username)}</button>`;
}

function renderNotice(message) {
  return `<div class="toast"><span>${escapeHtml(message)}</span>${renderActionButton('dismiss-notice', 'x', 'Dismiss', { className: 'icon-button' })}</div>`;
}

async function handleInput(target) {
  if (target.dataset.input === 'chat-body') {
    state.chatDraft = target.value;
    return;
  }

  if (target.dataset.input?.startsWith('avatar-crop-')) {
    if (!state.avatarCrop) return;
    const key = target.dataset.input.replace('avatar-crop-', '');
    if (key === 'zoom') state.avatarCrop.zoom = Number(target.value);
    if (key === 'x') state.avatarCrop.x = Number(target.value);
    if (key === 'y') state.avatarCrop.y = Number(target.value);
    updateCropPreview();
    return;
  }

  if (target.dataset.input === 'user-search') {
    state.userSearchQuery = target.value;
    window.clearTimeout(searchTimer);
    if (state.userSearchQuery.trim().length < 1) {
      state.userResults = [];
      state.userSearching = false;
      render({ focusUserSearch: true });
      return;
    }
    const nonce = ++searchNonce;
    state.userSearching = true;
    searchTimer = window.setTimeout(async () => {
      try {
        const data = await api(`/api/users?q=${encodeURIComponent(state.userSearchQuery.trim())}`);
        if (nonce !== searchNonce) return;
        state.userResults = data.users || [];
        state.userSearching = false;
        render({ focusUserSearch: true });
      } catch (error) {
        if (nonce !== searchNonce) return;
        state.userResults = [];
        state.userSearching = false;
        showError(error);
      }
    }, 200);
    return;
  }

  if (target.dataset.input !== 'album-search') return;
  state.albumQuery = target.value;
  state.selectedAlbum = null;
  window.clearTimeout(searchTimer);
  if (state.albumQuery.trim().length < 2) {
    state.suggestions = [];
    state.searching = false;
    render({ focusSearch: true });
    return;
  }
  const nonce = ++searchNonce;
  state.searching = true;
  searchTimer = window.setTimeout(async () => {
    try {
      const data = await api(`/api/albums/search?q=${encodeURIComponent(state.albumQuery.trim())}`);
      if (nonce !== searchNonce) return;
      state.suggestions = data.results || [];
      state.searching = false;
      render({ focusSearch: true });
    } catch (error) {
      if (nonce !== searchNonce) return;
      state.suggestions = [];
      state.searching = false;
      showError(error);
    }
  }, 450);
}

async function handleAction(target) {
  const action = target.dataset.action;
  if (action === 'go-home') return navigate('/');
  if (action === 'go-login') return navigate('/login');
  if (action === 'go-explore') return navigate('/explore');
  if (action === 'open-list') return navigate(`/list/${target.dataset.id}`);
  if (action === 'open-explore-list') return navigate(`/explore/${encodeURIComponent(target.dataset.slug)}`);
  if (action === 'open-explore-album') return navigate(`/explore/${encodeURIComponent(state.route.slug)}/album/${target.dataset.index}`);
  if (action === 'back-to-explore-list') return navigate(`/explore/${encodeURIComponent(state.route.slug)}`);
  if (action === 'open-profile-album') return navigate(`/u/${encodeURIComponent(state.route.username)}/album/${encodeURIComponent(target.dataset.key)}`);
  if (action === 'back-to-profile') return navigate(`/u/${encodeURIComponent(state.route.username)}`);
  if (action === 'open-history-album') return navigate(`/history/${encodeURIComponent(state.route.token)}/album/${encodeURIComponent(target.dataset.key)}`);
  if (action === 'back-to-history') return navigate(`/history/${encodeURIComponent(state.route.token)}`);
  if (action === 'open-profile') return navigate(`/u/${encodeURIComponent(state.user.username)}`);
  if (action === 'open-user-profile') return navigate(`/u/${encodeURIComponent(target.dataset.username)}`);
  if (action === 'dismiss-notice') {
    state.notice = '';
    state.error = '';
    return render();
  }
  if (action === 'theme-cycle') return setTheme(nextTheme());
  if (action === 'theme-set') return setTheme(target.dataset.theme);
  if (action === 'platform-set') {
    const platform = target.dataset.platform || 'na';
    if (!state.user || state.route.type === 'login') {
      state.selectedPlatform = platform;
      return render();
    }
    const data = await api('/api/me', { method: 'PATCH', body: { musicPlatform: platform } });
    state.user = data.user;
    applyAccent(state.user.accentColor);
    state.notice = 'Music platform saved.';
    return render();
  }
  if (action === 'accent-platform') {
    const data = await api('/api/me', { method: 'PATCH', body: { accentColor: null } });
    state.user = data.user;
    applyAccent(state.user.accentColor);
    state.notice = 'Using platform color.';
    return render();
  }
  if (action === 'settings-toggle') {
    state.settingsOpen = !state.settingsOpen;
    return render();
  }
  if (action === 'settings-close') {
    state.settingsOpen = false;
    return render();
  }
  if (action === 'avatar-crop-cancel') {
    state.avatarCrop = null;
    return render();
  }
  if (action === 'avatar-crop-save') {
    if (!state.avatarCrop) return;
    const avatarDataUrl = await cropAvatarToDataUrl(state.avatarCrop);
    const data = await api('/api/me', { method: 'PATCH', body: { avatarDataUrl } });
    state.user = data.user;
    state.avatarCrop = null;
    state.notice = 'Profile photo updated.';
    return reloadCurrent();
  }
  if (action === 'people-toggle') {
    state.peopleOpen = !state.peopleOpen;
    return render();
  }
  if (action === 'chat-toggle') {
    state.chatOpen = !state.chatOpen;
    localStorage.setItem(CHAT_OPEN_KEY, state.chatOpen ? 'open' : 'closed');
    if (state.chatOpen) markChatRead(state.payload);
    return render();
  }
  if (action === 'auth-mode') {
    state.authMode = target.dataset.mode;
    return render();
  }
  if (action === 'logout') {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.lists = [];
    applyAccent(null);
    navigate('/');
    return;
  }
  if (action === 'copy') {
    await copyText(target.dataset.copy);
    state.notice = 'Copied.';
    return render();
  }
  if (action === 'share-list') {
    state.shareOpen = !state.shareOpen;
    return render();
  }
  if (action === 'copy-share-link') {
    if (state.payload.permissions.canManage && state.payload.list.visibility === 'private') {
      state.payload = await api(`/api/lists/${state.payload.list.id}/share/publish`, { method: 'POST' });
      await refreshMe();
    }
    const sharePath = state.payload.list.shareToken ? `/share/${state.payload.list.shareToken}` : `/list/${state.payload.list.id}`;
    await copyText(`${location.origin}${sharePath}`);
    state.notice = 'Share link copied.';
    return render();
  }
  if (action === 'rename-list') {
    const name = window.prompt('List name', state.payload.list.name);
    if (name === null) return;
    const cleanName = name.trim();
    if (!cleanName) throw new Error('List name is required.');
    const response = await api(`/api/lists/${state.payload.list.id}`, {
      method: 'PATCH',
      body: { name: cleanName }
    });
    setCurrentPayload(payloadFromResponse(response));
    await refreshMe();
    state.notice = 'List renamed.';
    return render();
  }
  if (action === 'invite-user-result') {
    await api(`/api/lists/${state.payload.list.id}/invites`, {
      method: 'POST',
      body: {
        identifier: target.dataset.username,
        role: state.shareRole
      }
    });
    state.notice = `Invite sent to ${target.dataset.username}.`;
    state.userSearchQuery = '';
    state.userResults = [];
    return render();
  }
  if (action === 'remove-member') {
    const isSelf = target.dataset.self === '1';
    const data = await api(`/api/lists/${state.payload.list.id}/members/${target.dataset.userId}`, { method: 'DELETE' });
    if (isSelf) {
      await refreshMe();
      state.notice = 'Left shared list.';
      const personal = state.lists.find((list) => list.kind === 'personal') || state.lists[0];
      navigate(personal ? `/list/${personal.id}` : '/');
      return;
    }
    setCurrentPayload(payloadFromResponse(data));
    state.lists = data.lists || state.lists;
    state.notice = 'Member removed.';
    return render();
  }
  if (action === 'select-suggestion') {
    await autoAddAlbum(target.dataset.id);
    return;
  }
  if (action === 'create-collab') {
    const name = window.prompt('Name the shared list', 'Shared Albums');
    if (!name) return;
    const data = await api('/api/lists', { method: 'POST', body: { kind: 'collab', name } });
    await refreshMe();
    navigate(`/list/${data.list.list.id}`);
    return;
  }
  if (action === 'shuffle-album') {
    const candidates = state.payload.albums.filter((album) => !album.currentUserCompleted);
    const pool = candidates.length ? candidates : state.payload.albums;
    if (!pool.length) return;
    const album = pool[Math.floor(Math.random() * pool.length)];
    state.highlightAlbumId = album.id;
    render();
    return scrollAlbumIntoView(album.id);
  }
  if (action === 'guest-shuffle') {
    const candidates = state.guest.albums.filter((album) => !album.completed);
    const pool = candidates.length ? candidates : state.guest.albums;
    if (!pool.length) return;
    const album = pool[Math.floor(Math.random() * pool.length)];
    state.highlightAlbumId = album.id;
    render();
    return scrollAlbumIntoView(album.id);
  }
  if (action === 'add-explore-album') {
    const album = exploreAlbumFromTarget(target);
    if (!state.user) {
      state.listPicker = null;
      addAlbumToGuestList(album);
      return render();
    }
    await openListPicker(album);
    return render();
  }
  if (action === 'add-recommendation-album') {
    await openListPicker({
      title: target.dataset.title,
      artist: target.dataset.artist,
      coverUrl: target.dataset.coverUrl || '',
      tracks: []
    });
    return render();
  }
  if (action === 'add-profile-album') {
    await openListPicker({
      title: target.dataset.title,
      artist: target.dataset.artist,
      coverUrl: target.dataset.coverUrl || '',
      tracks: []
    });
    return render();
  }
  if (action === 'open-recommendation-album') {
    await openListPicker({
      title: target.dataset.title,
      artist: target.dataset.artist,
      coverUrl: target.dataset.coverUrl || '',
      tracks: []
    });
    return render();
  }
  if (action === 'open-album-page') {
    return navigate(albumPath(Number(target.dataset.id)));
  }
  if (action === 'back-to-list') {
    if (state.route.type === 'share') return navigate(`/share/${state.route.token}`);
    return navigate(`/list/${state.payload.list.id}`);
  }
  if (action === 'complete') {
    const album = state.payload.albums.find((item) => item.id === Number(target.dataset.id));
    const data = await api(`/api/lists/${state.payload.list.id}/albums/${album.id}/complete`, {
      method: 'POST',
      body: { completed: !album.currentUserCompleted }
    });
    setCurrentPayload(payloadFromResponse(data));
    return render();
  }
  if (action === 'average-opt') {
    const album = state.payload.albums.find((item) => item.id === Number(target.dataset.albumId));
    const data = await api(`/api/lists/${state.payload.list.id}/albums/${album.id}/rating-preferences`, {
      method: 'PATCH',
      body: { includeInAverage: !album.currentUserAverageOptIn }
    });
    setCurrentPayload(payloadFromResponse(data));
    return render();
  }
  if (action === 'rate-profile-track') {
    state.profile = await api(
      `/api/me/albums/${encodeURIComponent(target.dataset.albumKey)}/ratings/${encodeURIComponent(target.dataset.trackKey)}`,
      {
        method: 'PUT',
        body: {
          rating: Number(target.dataset.rating),
          trackTitle: target.dataset.trackTitle || 'Album rating'
        }
      }
    );
    return render();
  }
  if (action === 'rate') {
    const data = await api(`/api/lists/${state.payload.list.id}/albums/${target.dataset.albumId}/tracks/${target.dataset.trackId}/rating`, {
      method: 'PUT',
      body: { rating: Number(target.dataset.rating) }
    });
    setCurrentPayload(payloadFromResponse(data));
    return render();
  }
  if (action === 'rate-album') {
    const data = await api(`/api/lists/${state.payload.list.id}/albums/${target.dataset.albumId}/rating`, {
      method: 'PUT',
      body: { rating: Number(target.dataset.rating) }
    });
    setCurrentPayload(payloadFromResponse(data));
    return render();
  }
  if (action === 'delete-album') {
    const data = await api(`/api/lists/${state.payload.list.id}/albums/${target.dataset.id}`, { method: 'DELETE' });
    setCurrentPayload(payloadFromResponse(data));
    if (state.payload?.list.kind === 'collab' && !data.removed) {
      state.notice = `Removal vote recorded (${data.voteCount}/${data.threshold}).`;
    }
    return render();
  }
  if (action === 'copy-album') {
    const album = state.payload.albums.find((item) => item.id === Number(target.dataset.id));
    await openListPicker({
      title: album.title,
      artist: album.artist,
      coverUrl: album.coverUrl,
      tracks: album.tracks.map((track) => ({ title: track.title, position: track.position }))
    });
    return render();
  }
  if (action === 'refresh-album-cover') {
    const data = await api(`/api/lists/${state.payload.list.id}/albums/${target.dataset.id}/cover/refresh`, {
      method: 'POST',
      body: { force: true }
    });
    setCurrentPayload(payloadFromResponse(data));
    state.notice = data.coverUrl ? 'Cover refreshed.' : 'Cover unavailable.';
    return render();
  }
  if (action === 'list-picker-close') {
    state.listPicker = null;
    return render();
  }
  if (action === 'list-picker-toggle') {
    await togglePickerAlbumForList(target.dataset.id);
    return;
  }
  if (action === 'guest-toggle') {
    const album = state.guest.albums.find((item) => item.id === target.dataset.id);
    if (album) album.completed = !album.completed;
    saveGuest();
    return render();
  }
  if (action === 'guest-delete') {
    state.guest.albums = state.guest.albums.filter((item) => item.id !== target.dataset.id);
    saveGuest();
    return render();
  }
  if (action === 'join-invite') {
    const data = await api(`/api/invites/${encodeURIComponent(state.route.token)}/join`, { method: 'POST' });
    await refreshMe();
    navigate(`/list/${data.list.id}`);
    return;
  }
  if (action === 'accept-invite') {
    const data = await api(`/api/invitations/${target.dataset.id}/accept`, { method: 'POST' });
    state.lists = data.lists || state.lists;
    state.invites = data.invites || [];
    state.notice = 'Invite accepted.';
    return render();
  }
  if (action === 'decline-invite') {
    const data = await api(`/api/invitations/${target.dataset.id}/decline`, { method: 'POST' });
    state.invites = data.invites || [];
    state.notice = 'Invite declined.';
    return render();
  }
}

async function handleChange(target) {
  if (target.dataset.change === 'list-select') {
    navigate(`/list/${target.value}`);
    return;
  }
  if (target.dataset.change === 'share-role') {
    state.shareRole = target.value === 'viewer' ? 'viewer' : 'editor';
    return render();
  }
  if (target.dataset.change === 'avatar-upload') {
    const file = target.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    if (!dataUrl.startsWith('data:image/')) throw new Error('Choose an image file.');
    state.avatarCrop = { dataUrl, zoom: 1, x: 0, y: 0 };
    target.value = '';
    return render();
  }
  if (target.dataset.change === 'accent-color') {
    const data = await api('/api/me', { method: 'PATCH', body: { accentColor: target.value } });
    state.user = data.user;
    applyAccent(state.user.accentColor);
    state.notice = 'Accent color saved.';
    return render();
  }
}

async function handleForm(form) {
  const formType = form.dataset.form;
  const data = Object.fromEntries(new FormData(form).entries());

  if (formType === 'auth') {
    const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body =
      state.authMode === 'register'
        ? {
            username: data.username,
            email: data.email,
            password: data.password,
            musicPlatform: state.selectedPlatform,
            guestImport: buildGuestImport()
          }
        : {
            identifier: data.identifier,
            password: data.password,
            guestImport: buildGuestImport()
          };
    await api(endpoint, { method: 'POST', body });
    clearGuest();
    await refreshMe();
    const personal = state.lists.find((list) => list.kind === 'personal') || state.lists[0];
    navigate(personal ? `/list/${personal.id}` : '/');
    return;
  }

  if (formType === 'guest-album' || formType === 'album') {
    const album = state.selectedAlbum || state.suggestions[0];
    if (!album) throw new Error('Pick an album from the dropdown first.');
    await autoAddAlbum(album.providerId);
    return;
  }

  if (formType === 'list-settings') {
    const response = await api(`/api/lists/${state.payload.list.id}`, {
      method: 'PATCH',
      body: {
        name: data.name,
        visibility: data.visibility,
        showRatings: data.showRatings === '1'
      }
    });
    state.notice = 'Saved.';
    state.settingsOpen = false;
    setCurrentPayload(payloadFromResponse(response));
    return render();
  }

  if (formType === 'invite-user') {
    await api(`/api/lists/${state.payload.list.id}/invites`, {
      method: 'POST',
      body: {
        identifier: data.identifier,
        role: data.role
      }
    });
    state.notice = 'Invite sent.';
    form.reset();
    return render();
  }

  if (formType === 'chat') {
    const body = String(data.body || '').trim();
    if (!body) return;
    const response = await api(`/api/lists/${state.payload.list.id}/messages`, {
      method: 'POST',
      body: { body }
    });
    setCurrentPayload(payloadFromResponse(response));
    state.chatDraft = '';
    markChatRead(state.payload);
    form.reset();
    return render({ focusChat: true });
  }
}

async function selectedAlbumDetails() {
  return albumDetailsFromProvider((state.selectedAlbum || state.suggestions[0])?.providerId);
}

async function albumDetailsFromProvider(providerId) {
  const album = state.suggestions.find((item) => item.providerId === providerId) || state.selectedAlbum;
  if (!album) throw new Error('Pick an album from the dropdown first.');
  const data = await api(`/api/albums/lookup/${encodeURIComponent(providerId)}`);
  return {
    title: data.album.title,
    artist: data.album.artist,
    coverUrl: data.album.coverUrl,
    tracks: data.album.tracks || []
  };
}

async function autoAddAlbum(providerId) {
  const album = await albumDetailsFromProvider(providerId);
  if (state.route.type === 'home') {
    addAlbumToGuestList(album);
  } else if (state.payload?.permissions?.canEdit) {
    const data = await api(`/api/lists/${state.payload.list.id}/albums`, {
      method: 'POST',
      body: album
    });
    if (data.copied === false) state.notice = 'Already in this list.';
    setCurrentPayload(payloadFromResponse(data));
  } else {
    throw new Error('You do not have edit access to this list.');
  }
  state.albumQuery = '';
  state.suggestions = [];
  state.selectedAlbum = null;
  render({ focusSearch: true });
}

function scrollAlbumIntoView(albumId) {
  queueMicrotask(() => {
    const escapedId = window.CSS?.escape ? CSS.escape(String(albumId)) : String(albumId).replaceAll('"', '\\"');
    const item = app.querySelector(`[data-album-id="${escapedId}"]`);
    if (!item) return;
    item.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function platformAlbumUrl(album) {
  const query = encodeURIComponent(`${album.title || ''} ${album.artist || ''}`.trim());
  const platform = state.user?.musicPlatform || 'na';
  if (platform === 'spotify') return `https://open.spotify.com/search/${query}`;
  if (platform === 'apple_music') return `https://music.apple.com/us/search?term=${query}`;
  if (platform === 'tidal') return `https://listen.tidal.com/search?q=${query}`;
  if (platform === 'soundcloud') return `https://soundcloud.com/search/albums?q=${query}`;
  if (platform === 'bandcamp') return `https://bandcamp.com/search?q=${query}&item_type=a`;
  if (platform === 'deezer') return `https://www.deezer.com/search/${query}/album`;
  return `https://music.youtube.com/search?q=${query}`;
}

function setupExploreCoverHydration() {
  if (exploreCoverObserver) {
    exploreCoverObserver.disconnect();
    exploreCoverObserver = null;
  }
  const list = state.explore?.list;
  if (!list?.slug) return;
  const fallbackCovers = Array.from(app.querySelectorAll('[data-explore-cover].fallback'));
  if (!fallbackCovers.length) return;
  if (!('IntersectionObserver' in window)) {
    hydrateExploreCovers(0).catch(() => {});
    return;
  }
  exploreCoverObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number(entry.target.dataset.exploreCover || 0);
        const offset = Math.floor(index / 12) * 12;
        hydrateExploreCovers(offset).catch(() => {});
        exploreCoverObserver?.unobserve(entry.target);
      }
    },
    { rootMargin: '480px 0px' }
  );
  for (const cover of fallbackCovers) exploreCoverObserver.observe(cover);
}

async function hydrateExploreCovers(offset = 0) {
  const list = state.explore?.list;
  if (!list?.slug || state.exploreCoverRequested.has(offset)) return;
  const slice = list.albums.slice(offset, offset + 12);
  if (!slice.some((album) => !album.coverUrl)) return;
  state.exploreCoverRequested.add(offset);
  const data = await api(`/api/explore/${encodeURIComponent(list.slug)}/covers?offset=${offset}&limit=12`);
  for (const cover of data.covers || []) {
    if (state.route.type !== 'explore' || state.route.slug !== list.slug) return;
    const album = list.albums[cover.index];
    if (!album) continue;
    album.coverUrl = cover.coverUrl || album.coverUrl || '';
    updateExploreCoverNode(cover.index, album);
  }
}

function updateExploreCoverNode(index, album) {
  if (!album.coverUrl) return;
  const node = app.querySelector(`[data-explore-cover="${index}"]`);
  if (!node) return;
  const list = state.explore?.list;
  node.classList.remove('fallback');
  node.innerHTML = `<img src="${escapeAttr(album.coverUrl)}" alt="" loading="lazy" ${coverImageAttrs(album, {
    exploreSlug: list?.slug || '',
    exploreIndex: index
  })} />`;
  const button = Array.from(app.querySelectorAll('[data-action="add-explore-album"]')).find(
    (item) => item.dataset.title === album.title && item.dataset.artist === album.artist
  );
  if (button) button.dataset.coverUrl = album.coverUrl;
}

function coverRefreshKey(image) {
  if (image.dataset.coverListId && image.dataset.coverAlbumId) {
    return `list:${image.dataset.coverListId}:${image.dataset.coverAlbumId}`;
  }
  if (image.dataset.coverExploreSlug && image.dataset.coverExploreIndex) {
    return `explore:${image.dataset.coverExploreSlug}:${image.dataset.coverExploreIndex}`;
  }
  return '';
}

function replaceBrokenCover(image) {
  const title = image.dataset.coverTitle || '';
  const fallback = escapeHtml(initials(title));
  if (image.classList.contains('tiny-cover')) {
    image.outerHTML = `<span class="tiny-cover fallback">${fallback}</span>`;
    return;
  }
  const cover = image.closest('.cover');
  if (!cover) return;
  cover.classList.add('fallback');
  cover.textContent = initials(title);
}

async function handleCoverImageError(image) {
  if (image.dataset.coverHandled === '1') return;
  image.dataset.coverHandled = '1';
  const key = coverRefreshKey(image);
  const brokenUrl = image.currentSrc || image.src || '';
  replaceBrokenCover(image);
  if (!key || coverRefreshAttempted.has(key) || coverRefreshInFlight.has(key)) return;
  coverRefreshAttempted.add(key);
  coverRefreshInFlight.add(key);
  try {
    if (image.dataset.coverListId && image.dataset.coverAlbumId) {
      const data = await api(`/api/lists/${image.dataset.coverListId}/albums/${image.dataset.coverAlbumId}/cover/refresh`, {
        method: 'POST',
        body: { force: true, brokenUrl }
      });
      const payload = payloadFromResponse(data);
      if (payload && state.payload?.list?.id === payload.list.id) {
        setCurrentPayload(payload);
        render();
      }
      return;
    }
    if (image.dataset.coverExploreSlug && image.dataset.coverExploreIndex) {
      const index = Number(image.dataset.coverExploreIndex);
      const data = await api(
        `/api/explore/${encodeURIComponent(image.dataset.coverExploreSlug)}/covers/${encodeURIComponent(index)}/refresh`,
        { method: 'POST', body: { brokenUrl } }
      );
      const album = state.explore?.list?.albums?.[index];
      if (album && data.coverUrl) {
        album.coverUrl = data.coverUrl;
        updateExploreCoverNode(index, album);
      }
    }
  } finally {
    coverRefreshInFlight.delete(key);
  }
}

async function reloadCurrent() {
  await refreshMe();
  await loadRoute();
}

function configureLiveSync() {
  if (liveTimer) {
    window.clearInterval(liveTimer);
    liveTimer = null;
  }
  if (!shouldLiveSync()) return;
  liveTimer = window.setInterval(() => {
    syncCurrentPayload().catch(() => {});
  }, LIVE_SYNC_MS);
}

function shouldLiveSync() {
  return Boolean(
    state.payload?.list?.kind === 'collab' &&
      state.payload.permissions?.isMember &&
      (state.route.type === 'list' || state.route.type === 'share')
  );
}

async function syncCurrentPayload() {
  if (liveInFlight || !shouldLiveSync() || document.hidden || state.settingsOpen || state.avatarCrop) return;
  liveInFlight = true;
  const routeSnapshot = { ...state.route };
  const activeInput = document.activeElement?.dataset?.input || '';
  try {
    const data =
      routeSnapshot.type === 'share'
        ? await api(`/api/share/${encodeURIComponent(routeSnapshot.token)}`)
        : await api(`/api/lists/${state.payload.list.id}`);
    if (routeSnapshot.type !== state.route.type) return;
    if (routeSnapshot.type === 'list' && routeSnapshot.id !== state.route.id) return;
    if (routeSnapshot.type === 'share' && routeSnapshot.token !== state.route.token) return;
    if (JSON.stringify(data) === JSON.stringify(state.payload)) return;
    setCurrentPayload(data);
    render({
      focusSearch: activeInput === 'album-search',
      focusUserSearch: activeInput === 'user-search',
      focusChat: activeInput === 'chat-body'
    });
  } finally {
    liveInFlight = false;
  }
}

async function setTheme(theme) {
  state.themePreference = theme;
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  if (state.user) {
    const data = await api('/api/me', { method: 'PATCH', body: { themePreference: theme } });
    state.user = data.user;
  }
  render();
}

function nextTheme() {
  const cycle = ['system', 'dark', 'light', 'retro'];
  return cycle[(cycle.indexOf(state.themePreference) + 1) % cycle.length];
}

function themeIconName() {
  if (state.themePreference === 'dark') return 'moon';
  if (state.themePreference === 'light') return 'sun';
  if (state.themePreference === 'retro') return 'system';
  return mediaDark.matches ? 'moon' : 'sun';
}

function applyTheme(preference) {
  const resolved = preference === 'system' ? (mediaDark.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
}

function applyAccent(color) {
  const accent = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : '#1db954';
  document.documentElement.style.setProperty('--blue', accent);
  document.documentElement.style.setProperty('--blue-strong', accent);
}

function buildGuestImport() {
  if (!state.guest.albums.length) return null;
  return {
    albums: state.guest.albums.map((album) => ({
      title: album.title,
      artist: album.artist,
      coverUrl: album.coverUrl,
      tracks: album.tracks || [],
      completed: Boolean(album.completed)
    }))
  };
}

function loadGuest() {
  for (const key of [GUEST_KEY, OLD_GUEST_KEY]) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed && Array.isArray(parsed.albums)) return parsed;
    } catch {
      // Use a fresh guest list.
    }
  }
  return { albums: [] };
}

function saveGuest() {
  localStorage.setItem(GUEST_KEY, JSON.stringify(state.guest));
}

function clearGuest() {
  state.guest = { albums: [] };
  localStorage.removeItem(GUEST_KEY);
  localStorage.removeItem(OLD_GUEST_KEY);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Request failed.');
  return data;
}

function showError(error) {
  state.error = error.message || 'Something went wrong.';
  render();
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement('textarea');
  input.value = value;
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load that image.'));
    image.src = src;
  });
}

function updateCropPreview() {
  if (!state.avatarCrop) return;
  const image = app.querySelector('.crop-frame img');
  if (!image) return;
  const zoom = Number(state.avatarCrop.zoom || 1);
  image.style.width = `${zoom * 100}%`;
  image.style.height = `${zoom * 100}%`;
  image.style.objectPosition = `${50 + Number(state.avatarCrop.x || 0) / 2}% ${50 + Number(state.avatarCrop.y || 0) / 2}%`;
}

function updateCropControls() {
  const xInput = app.querySelector('[data-input="avatar-crop-x"]');
  const yInput = app.querySelector('[data-input="avatar-crop-y"]');
  if (xInput) xInput.value = String(state.avatarCrop?.x || 0);
  if (yInput) yInput.value = String(state.avatarCrop?.y || 0);
}

function setCropPan(x, y) {
  if (!state.avatarCrop) return;
  state.avatarCrop.x = clampNumber(x, -100, 100);
  state.avatarCrop.y = clampNumber(y, -100, 100);
  updateCropPreview();
  updateCropControls();
}

function finishCropDrag(event) {
  if (!cropDrag || event.pointerId !== cropDrag.pointerId) return;
  cropDrag.frame.releasePointerCapture?.(event.pointerId);
  cropDrag.frame.classList.remove('dragging');
  cropDrag = null;
}

async function cropAvatarToDataUrl(crop) {
  const image = await loadImage(crop.dataUrl);
  const canvas = document.createElement('canvas');
  const outputSize = 512;
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare that image.');

  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const zoom = Math.min(3, Math.max(1, Number(crop.zoom || 1)));
  const cropSize = Math.min(naturalWidth, naturalHeight) / zoom;
  const panX = Math.min(100, Math.max(-100, Number(crop.x || 0))) / 100;
  const panY = Math.min(100, Math.max(-100, Number(crop.y || 0))) / 100;
  const centerX = naturalWidth / 2 + ((naturalWidth - cropSize) / 2) * panX;
  const centerY = naturalHeight / 2 + ((naturalHeight - cropSize) / 2) * panY;
  const sourceX = Math.min(Math.max(0, centerX - cropSize / 2), naturalWidth - cropSize);
  const sourceY = Math.min(Math.max(0, centerY - cropSize / 2), naturalHeight - cropSize);

  context.fillStyle = '#111111';
  context.fillRect(0, 0, outputSize, outputSize);
  context.drawImage(image, sourceX, sourceY, cropSize, cropSize, 0, 0, outputSize, outputSize);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  if (dataUrl.length > 700_000) throw new Error('That image is still too large. Try zooming in more.');
  return dataUrl;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function formatTime(value) {
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

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function initials(value) {
  const words = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'AL';
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
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
