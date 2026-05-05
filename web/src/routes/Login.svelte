<script lang="ts">
  import { appState, buildGuestImport, clearGuest } from '$lib/state.svelte';
  import { navigate } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import { refreshMe } from '$lib/me';
  import type { AuthResponse, MusicPlatform } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';
  import Icon from '../components/Icon.svelte';

  const platformOptions: Array<[MusicPlatform, string]> = [
    ['spotify', 'Spotify'],
    ['youtube_music', 'YouTube Music'],
    ['apple_music', 'Apple Music'],
    ['tidal', 'TIDAL'],
    ['soundcloud', 'SoundCloud'],
    ['bandcamp', 'Bandcamp'],
    ['deezer', 'Deezer'],
    ['na', 'N/A']
  ];

  let submitting = $state<boolean>(false);
  let formError = $state<string>('');
  const isRegister = $derived(appState.authMode === 'register');
  const guestCount = $derived(appState.guest.albums.length);

  function safeNextPath(): string {
    const next = new URLSearchParams(window.location.search).get('next') || '';
    if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/api/')) return '';
    return next;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    formError = '';
    submitting = true;

    const form = event.currentTarget as HTMLFormElement;
    const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    const guestImport = buildGuestImport();

    try {
      if (isRegister) {
        await api.post<AuthResponse>('/api/auth/register', {
          username: data.username,
          email: data.email,
          password: data.password,
          musicPlatform: appState.selectedPlatform,
          guestImport
        });
      } else {
        await api.post<AuthResponse>('/api/auth/login', {
          identifier: data.identifier,
          password: data.password,
          guestImport
        });
      }
      clearGuest();
      await refreshMe();
      const next = safeNextPath();
      if (next) {
        navigate(next);
      } else {
        const personal = appState.lists.find((list) => list.kind === 'personal') ?? appState.lists[0];
        navigate(personal ? `/list/${personal.id}` : '/');
      }
    } catch (err) {
      formError = getErrorMessage(err);
    } finally {
      submitting = false;
    }
  }

  function setMode(mode: 'login' | 'register'): void {
    appState.authMode = mode;
    formError = '';
  }
</script>

<main class="auth-page">
  <IconButton icon="arrow-left" label="Back" className="text-button back-link" onclick={() => navigate('/')} />
  <section class="auth-card">
    <h1>{isRegister ? 'Create account' : 'Sign in'}</h1>
    <div class="segmented">
      <button class:active={!isRegister} type="button" onclick={() => setMode('login')}>Sign in</button>
      <button class:active={isRegister} type="button" onclick={() => setMode('register')}>Create</button>
    </div>
    <form class="form-stack" onsubmit={submit}>
      {#if isRegister}
        <label>
          <span>Username</span>
          <input name="username" autocomplete="username" required minlength="3" maxlength="30" />
        </label>
        <label>
          <span>Email</span>
          <input name="email" type="email" autocomplete="email" required />
        </label>
        <div>
          <span class="label">Music platform</span>
          <div class="platform-grid">
            {#each platformOptions as [value, label] (value)}
              <button
                type="button"
                class:active={appState.selectedPlatform === value}
                onclick={() => (appState.selectedPlatform = value)}
              >
                {label}
              </button>
            {/each}
          </div>
        </div>
      {:else}
        <label>
          <span>Username or email</span>
          <input name="identifier" autocomplete="username" required />
        </label>
      {/if}
      <label>
        <span>Password</span>
        <input
          name="password"
          type="password"
          autocomplete={isRegister ? 'new-password' : 'current-password'}
          required
          minlength="8"
        />
      </label>
      {#if guestCount}
        <div class="soft-line">{guestCount} guest albums will transfer.</div>
      {/if}
      {#if formError}
        <div class="error-line">{formError}</div>
      {/if}
      <button class="primary icon-text-button" type="submit" disabled={submitting}>
        <Icon name={isRegister ? 'user-plus' : 'log-in'} />
        <span class="button-label">{submitting ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}</span>
      </button>
    </form>
  </section>
</main>

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
  }
</style>
