<script lang="ts">
  import { appState, persistTheme } from '$lib/state.svelte';
  import { api, ApiError } from '$lib/api';
  import { applyTheme } from '$lib/theme';
  import { navigate } from '$lib/router.svelte';
  import { refreshMe } from '$lib/me';
  import type { ThemePreference } from '$lib/types';
  import IconButton from './IconButton.svelte';
  import OwnerListSettings from './OwnerListSettings.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();
  let saving = $state<boolean>(false);
  let modalError = $state<string>('');

  const themes: Array<[ThemePreference, string]> = [
    ['system', 'System'],
    ['light', 'Light'],
    ['dark', 'Dark'],
    ['retro', '90s']
  ];

  async function setTheme(theme: ThemePreference): Promise<void> {
    appState.themePreference = theme;
    persistTheme(theme);
    applyTheme(theme);
    if (appState.user) {
      try {
        const data = await api.patch<{ user: typeof appState.user }>('/api/me', { themePreference: theme });
        appState.user = data.user;
      } catch {
        // best-effort
      }
    }
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
      modalError = err instanceof ApiError ? err.message : (err as Error).message;
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
          {#each themes as [value, label] (value)}
            <button
              type="button"
              class:active={appState.themePreference === value}
              onclick={() => setTheme(value)}
            >
              {label}
            </button>
          {/each}
        </div>
      </div>
      {#if appState.user}
        <div>
          <span class="label">Account</span>
          <div class="button-row">
            <IconButton
              icon="user"
              label="Profile"
              onclick={() => {
                onClose();
                navigate(`/u/${encodeURIComponent(appState.user!.username)}`);
              }}
            />
            <IconButton icon="log-out" label="Log out" disabled={saving} onclick={logout} />
          </div>
        </div>
      {/if}
      {#if modalError}
        <div class="error-line">{modalError}</div>
      {/if}
      {#if appState.currentListPayload && appState.currentListPayload.permissions.canManage}
        <div>
          <span class="label">List settings</span>
          <OwnerListSettings payload={appState.currentListPayload} />
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
