<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '$lib/state.svelte';
  import { router } from '$lib/router.svelte';
  import { applyTheme, watchSystemTheme } from '$lib/theme';
  import { refreshMe } from '$lib/me';
  import { navigate } from '$lib/router.svelte';
  import UtilityBar from './components/UtilityBar.svelte';
  import ToastNotice from './components/ToastNotice.svelte';
  import SettingsModal from './components/SettingsModal.svelte';
  import Login from './routes/Login.svelte';
  import Home from './routes/Home.svelte';
  import ListPage from './routes/ListPage.svelte';
  import Placeholder from './routes/Placeholder.svelte';

  let booted = $state<boolean>(false);
  let bootError = $state<string>('');

  onMount(() => {
    applyTheme(appState.themePreference);
    const stop = watchSystemTheme(() => applyTheme(appState.themePreference));
    refreshMe()
      .catch((err: Error) => {
        bootError = err.message;
      })
      .finally(() => {
        booted = true;
      });
    return stop;
  });

  // Intercept internal link clicks so SPA navigation works without full reloads.
  function onAppClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('#') || href.startsWith('mailto:')) return;
    if (anchor.target && anchor.target !== '_self') return;
    event.preventDefault();
    navigate(href);
  }
</script>

<div class="app-shell" onclickcapture={onAppClick} role="presentation">
  <UtilityBar />
  {#if appState.notice}
    <ToastNotice message={appState.notice} onDismiss={() => (appState.notice = '')} />
  {/if}
  {#if appState.error}
    <ToastNotice message={appState.error} onDismiss={() => (appState.error = '')} />
  {/if}
  {#if !booted}
    <Placeholder title="Loading…" />
  {:else if bootError}
    <Placeholder title="Connection error" note={bootError} />
  {:else if router.current.type === 'login'}
    <Login />
  {:else if router.current.type === 'home'}
    <Home />
  {:else if router.current.type === 'list'}
    <ListPage />
  {:else if router.current.type === 'share'}
    <Placeholder title="Shared list" note="Shared-list view port pending." />
  {:else if router.current.type === 'invite'}
    <Placeholder title="Invitation" note="Invite acceptance flow port pending." />
  {:else if router.current.type === 'history'}
    <Placeholder title="History" note="History view port pending." />
  {:else if router.current.type === 'profile'}
    <Placeholder title="Profile" note="Profile view port pending." />
  {:else if router.current.type === 'explore'}
    <Placeholder title="Explore" note="Explore view port pending." />
  {/if}
  {#if appState.settingsOpen}
    <SettingsModal onClose={() => (appState.settingsOpen = false)} />
  {/if}
</div>
