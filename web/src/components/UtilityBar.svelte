<script lang="ts">
  import { appState, persistRetroThemeUnlocked, persistTheme } from '$lib/state.svelte';
  import { applyTheme, nextTheme, themeIconName } from '$lib/theme';
  import { router, navigate } from '$lib/router.svelte';
  import { api } from '$lib/api';
  import IconButton from './IconButton.svelte';
  import Icon from './Icon.svelte';
  import Avatar from './Avatar.svelte';

  const retroHoldMs = 15000;
  const onExploreClick = () => navigate(router.current.type === 'explore' ? '/' : '/explore');
  let retroHoldTimer: number | null = null;
  let retroHoldTriggered = false;

  function goHome(): void {
    const personal = appState.lists.find((list) => list.kind === 'personal') ?? appState.lists[0];
    navigate(personal ? `/list/${personal.id}` : '/');
  }

  function isHomeActive(): boolean {
    const personal = appState.lists.find((list) => list.kind === 'personal') ?? appState.lists[0];
    return router.current.type === 'home' || (router.current.type === 'list' && personal?.id === router.current.id);
  }

  async function cycleTheme(): Promise<void> {
    const next = nextTheme(appState.themePreference, appState.retroThemeUnlocked);
    await setTheme(next);
  }

  async function setTheme(theme: typeof appState.themePreference): Promise<void> {
    appState.themePreference = theme;
    persistTheme(theme);
    applyTheme(theme);
    if (appState.user) {
      try {
        const data = await api.patch<{ user: typeof appState.user }>('/api/me', { themePreference: theme });
        appState.user = data.user;
      } catch {
        // Silent: theme still applied locally.
      }
    }
  }

  function cancelRetroHold(): void {
    if (retroHoldTimer !== null) {
      window.clearTimeout(retroHoldTimer);
      retroHoldTimer = null;
    }
  }

  function beginRetroHold(): void {
    cancelRetroHold();
    retroHoldTriggered = false;
    retroHoldTimer = window.setTimeout(() => {
      retroHoldTimer = null;
      retroHoldTriggered = true;
      appState.retroThemeUnlocked = true;
      persistRetroThemeUnlocked(true);
      void setTheme('retro');
      appState.notice = '90s theme unlocked.';
    }, retroHoldMs);
  }

  function themeClick(): void {
    if (retroHoldTriggered) {
      retroHoldTriggered = false;
      return;
    }
    void cycleTheme();
  }
</script>

<div class="home-corner">
  <IconButton icon="home" label="Home" active={isHomeActive()} onclick={goHome} />
</div>

<div class="utility-bar">
  <button
    class="icon-button icon-text-button"
    title="Theme"
    type="button"
    onclick={themeClick}
    onpointerdown={beginRetroHold}
    onpointerup={cancelRetroHold}
    onpointercancel={cancelRetroHold}
    onpointerleave={cancelRetroHold}
  >
    <Icon name={themeIconName(appState.themePreference)} />
    <span class="button-label">Theme</span>
  </button>
  <IconButton
    icon={router.current.type === 'explore' ? 'list' : 'compass'}
    label={router.current.type === 'explore' ? 'My lists' : 'Explore'}
    onclick={onExploreClick}
  />
  {#if appState.user}
    <button class="profile-button" title="Account" onclick={() => (appState.settingsOpen = true)}>
      <Avatar member={appState.user} clickable={false} />
      {#if appState.invites.length}
        <span class="notify-dot">{appState.invites.length}</span>
      {/if}
    </button>
  {:else}
    <IconButton icon="log-in" label="Sign in" onclick={() => navigate('/login')} />
  {/if}
</div>
