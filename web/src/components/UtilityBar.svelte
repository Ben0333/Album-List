<script lang="ts">
  import { appState, persistTheme } from '$lib/state.svelte';
  import { applyTheme, nextTheme, themeIconName } from '$lib/theme';
  import { router, navigate } from '$lib/router.svelte';
  import { api } from '$lib/api';
  import IconButton from './IconButton.svelte';
  import Avatar from './Avatar.svelte';

  const onExploreClick = () => navigate(router.current.type === 'explore' ? '/' : '/explore');

  function goHome(): void {
    const personal = appState.lists.find((list) => list.kind === 'personal') ?? appState.lists[0];
    navigate(personal ? `/list/${personal.id}` : '/');
  }

  function isHomeActive(): boolean {
    const personal = appState.lists.find((list) => list.kind === 'personal') ?? appState.lists[0];
    return router.current.type === 'home' || (router.current.type === 'list' && personal?.id === router.current.id);
  }

  async function cycleTheme(): Promise<void> {
    const next = nextTheme(appState.themePreference);
    appState.themePreference = next;
    persistTheme(next);
    applyTheme(next);
    if (appState.user) {
      try {
        const data = await api.patch<{ user: typeof appState.user }>('/api/me', { themePreference: next });
        appState.user = data.user;
      } catch {
        // Silent: theme still applied locally.
      }
    }
  }
</script>

<div class="home-corner">
  <IconButton icon="home" label="Home" active={isHomeActive()} onclick={goHome} />
</div>

<div class="utility-bar">
  <IconButton
    icon={themeIconName(appState.themePreference)}
    label="Theme"
    className="icon-button"
    onclick={cycleTheme}
  />
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
