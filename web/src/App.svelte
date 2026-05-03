<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '$lib/state.svelte';
  import { router } from '$lib/router.svelte';
  import { applyTheme, watchSystemTheme } from '$lib/theme';
  import { refreshMe } from '$lib/me';
  import { navigate } from '$lib/router.svelte';
  import UtilityBar from './components/UtilityBar.svelte';
  import Icon from './components/Icon.svelte';
  import ToastNotice from './components/ToastNotice.svelte';
  import SettingsModal from './components/SettingsModal.svelte';
  import ReportModal from './components/ReportModal.svelte';
  import ListPickerModal from './components/ListPickerModal.svelte';
  import AvatarCropModal from './components/AvatarCropModal.svelte';
  import Login from './routes/Login.svelte';
  import Home from './routes/Home.svelte';
  import ListPage from './routes/ListPage.svelte';
  import AlbumPage from './routes/AlbumPage.svelte';
  import ExplorePage from './routes/ExplorePage.svelte';
  import ProfilePage from './routes/ProfilePage.svelte';
  import ProfileAlbumPage from './routes/ProfileAlbumPage.svelte';
  import InvitePage from './routes/InvitePage.svelte';
  import SharePage from './routes/SharePage.svelte';
  import HistoryPage from './routes/HistoryPage.svelte';
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
  <button class="report-fab" type="button" onclick={() => (appState.reportOpen = true)}>
    <Icon name="flag" />
    <span>Report bug</span>
  </button>
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
    {#if router.current.albumId !== null}
      <AlbumPage />
    {:else}
      <ListPage />
    {/if}
  {:else if router.current.type === 'share'}
    {#if router.current.albumId !== null}
      <AlbumPage />
    {:else}
      <SharePage />
    {/if}
  {:else if router.current.type === 'invite'}
    <InvitePage />
  {:else if router.current.type === 'history'}
    <HistoryPage />
  {:else if router.current.type === 'profile'}
    {#if router.current.albumKey}
      <ProfileAlbumPage />
    {:else}
      <ProfilePage />
    {/if}
  {:else if router.current.type === 'explore'}
    <ExplorePage />
  {/if}
  {#if appState.settingsOpen}
    <SettingsModal onClose={() => (appState.settingsOpen = false)} />
  {/if}
  {#if appState.reportOpen}
    <ReportModal onClose={() => (appState.reportOpen = false)} />
  {/if}
  {#if appState.listPicker}
    <ListPickerModal onClose={() => (appState.listPicker = null)} />
  {/if}
  {#if appState.avatarCrop}
    <AvatarCropModal onClose={() => (appState.avatarCrop = null)} />
  {/if}
</div>
