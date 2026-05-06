<script lang="ts">
  import { appState, persistTheme } from '$lib/state.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import { applyAccent, applyTheme } from '$lib/theme';
  import { navigate } from '$lib/router.svelte';
  import { refreshMe } from '$lib/me';
  import { copyText } from '$lib/clipboard';
  import { readImageAsDataUrl } from '$lib/avatar';
  import type { MusicPlatform, ThemePreference, User } from '$lib/types';
  import IconButton from './IconButton.svelte';
  import Icon from './Icon.svelte';
  import OwnerListSettings from './OwnerListSettings.svelte';
  import InviteNotifications from './InviteNotifications.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();
  let saving = $state<boolean>(false);
  let modalError = $state<string>('');

  const visibleThemes: Array<[ThemePreference, string]> = $derived([
    ['system', 'System'],
    ['light', 'Light'],
    ['dark', 'Dark'],
    ...(appState.retroThemeUnlocked ? ([['retro', '90s']] as Array<[ThemePreference, string]>) : [])
  ]);

  const platforms: Array<[MusicPlatform, string]> = [
    ['spotify', 'Spotify'],
    ['youtube_music', 'YouTube Music'],
    ['apple_music', 'Apple Music'],
    ['tidal', 'TIDAL'],
    ['soundcloud', 'SoundCloud'],
    ['bandcamp', 'Bandcamp'],
    ['deezer', 'Deezer'],
    ['na', 'N/A']
  ];

  async function setTheme(theme: ThemePreference): Promise<void> {
    appState.themePreference = theme;
    persistTheme(theme);
    applyTheme(theme);
    if (appState.user) {
      try {
        const data = await api.patch<{ user: User }>('/api/me', { themePreference: theme });
        appState.user = data.user;
      } catch {
        // best-effort
      }
    }
  }

  async function setPlatform(platform: MusicPlatform): Promise<void> {
    if (!appState.user) return;
    modalError = '';
    try {
      const data = await api.patch<{ user: User }>('/api/me', { musicPlatform: platform });
      appState.user = data.user;
      applyAccent(data.user.accentColor);
      appState.notice = 'Music platform saved.';
    } catch (err) {
      modalError = getErrorMessage(err);
    }
  }

  async function setAccent(color: string): Promise<void> {
    if (!appState.user) return;
    modalError = '';
    try {
      const data = await api.patch<{ user: User }>('/api/me', { accentColor: color });
      appState.user = data.user;
      applyAccent(data.user.accentColor);
    } catch (err) {
      modalError = getErrorMessage(err);
    }
  }

  async function resetAccent(): Promise<void> {
    if (!appState.user) return;
    modalError = '';
    try {
      const data = await api.patch<{ user: User }>('/api/me', { accentColor: null });
      appState.user = data.user;
      applyAccent(data.user.accentColor);
      appState.notice = 'Using platform color.';
    } catch (err) {
      modalError = getErrorMessage(err);
    }
  }

  async function onAvatarFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const dataUrl = await readImageAsDataUrl(file);
      appState.avatarCrop = { dataUrl, zoom: 1, x: 0, y: 0 };
    } catch (err) {
      modalError = (err as Error).message;
    }
  }

  async function copyHistoryLink(): Promise<void> {
    if (!appState.user?.historyToken) return;
    const url = `${window.location.origin}/history/${appState.user.historyToken}`;
    const ok = await copyText(url);
    appState.notice = ok ? 'History link copied.' : 'Could not copy history link.';
  }

  async function logout(): Promise<void> {
    if (saving) return;
    saving = true;
    modalError = '';
    try {
      await api.post('/api/auth/logout');
      await refreshMe();
      onClose();
      navigate('/login');
    } catch (err) {
      modalError = getErrorMessage(err);
    } finally {
      saving = false;
    }
  }

  function backdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }
</script>

<div class="modal-backdrop" onclick={backdropClick} role="presentation">
  <section class="settings-modal" role="dialog" aria-modal="true">
    <div class="modal-head">
      <strong>Settings</strong>
      <IconButton icon="x" label="Close" className="icon-button" onclick={onClose} />
    </div>
    <div class="settings-grid">
      <div>
        <span class="label">Theme</span>
        <div class="segmented">
          {#each visibleThemes as [value, label] (value)}
            <button type="button" class:active={appState.themePreference === value} onclick={() => setTheme(value)}>
              {label}
            </button>
          {/each}
        </div>
      </div>

      {#if appState.user}
        <div>
          <span class="label">Music platform</span>
          <div class="platform-grid">
            {#each platforms as [value, label] (value)}
              <button
                type="button"
                class:active={appState.user.musicPlatform === value}
                onclick={() => setPlatform(value)}
              >
                {label}
              </button>
            {/each}
          </div>
        </div>

        <div>
          <span class="label">Accent color</span>
          <div class="accent-row">
            <input
              type="color"
              value={appState.user.accentColor || '#1db954'}
              onchange={(event) => setAccent((event.currentTarget as HTMLInputElement).value)}
            />
            <IconButton icon="refresh" label="Use platform color" onclick={resetAccent} />
          </div>
        </div>

        <div>
          <span class="label">Account</span>
          <div class="button-row">
            <label class="upload-button icon-text-button" title="Profile photo">
              <Icon name="image" />
              <span class="button-label">Profile photo</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={onAvatarFile} />
            </label>
            <IconButton
              icon="user"
              label="Profile"
              onclick={() => {
                onClose();
                navigate(`/u/${encodeURIComponent(appState.user!.username)}`);
              }}
            />
            <IconButton icon="log-out" label="Log out" disabled={saving} onclick={logout} />
            {#if appState.user.historyToken}
              <IconButton icon="copy" label="Copy history" onclick={copyHistoryLink} />
            {/if}
          </div>
        </div>
      {/if}

      {#if modalError}<div class="error-line">{modalError}</div>{/if}
      <InviteNotifications />

      {#if appState.currentListPayload && appState.currentListPayload.permissions.canManage}
        <div>
          <span class="label">List settings</span>
          <OwnerListSettings payload={appState.currentListPayload} onSaved={onClose} />
        </div>
      {/if}
    </div>
  </section>
</div>

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
  }
</style>
