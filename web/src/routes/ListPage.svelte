<script lang="ts">
  import { appState, persistChatOpen } from '$lib/state.svelte';
  import { router, navigate } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import type { ListAlbum, ListPayload, NotModifiedPayload } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';
  import AlbumRow from '../components/AlbumRow.svelte';
  import AlbumSearch from '../components/AlbumSearch.svelte';
  import type { AlbumDetail } from '../components/AlbumSearch.svelte';
  import ListSwitcher from '../components/ListSwitcher.svelte';
  import SharePanel from '../components/SharePanel.svelte';
  import PeoplePanel from '../components/PeoplePanel.svelte';
  import ChatPanel from '../components/ChatPanel.svelte';
  import Placeholder from './Placeholder.svelte';

  const POLL_INTERVAL_MS = 5000;

  let payload = $state<ListPayload | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');
  let highlightAlbumId = $state<number | null>(null);
  let shareOpen = $state<boolean>(false);
  let peopleOpen = $state<boolean>(false);

  $effect(() => {
    const route = router.current;
    if (route.type !== 'list') return;
    const id = route.id;
    let cancelled = false;
    loading = true;
    loadError = '';
    shareOpen = false;
    peopleOpen = false;
    api
      .get<ListPayload>(`/api/lists/${id}`)
      .then((data) => {
        if (cancelled) return;
        payload = data;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        loadError = getErrorMessage(err);
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
      appState.currentListPayload = null;
    };
  });

  $effect(() => {
    if (payload) appState.currentListPayload = payload;
  });

  $effect(() => {
    if (!payload || payload.list.kind !== 'collab' || !payload.permissions.isMember) return;
    let cancelled = false;
    let timer: number | null = null;

    async function tick(): Promise<void> {
      if (cancelled || !payload) return;
      try {
        const data = await api.get<ListPayload | NotModifiedPayload>(
          `/api/lists/${payload.list.id}?revision=${encodeURIComponent(payload.revision)}`
        );
        if (cancelled) return;
        if ('notModified' in data) return;
        payload = data;
      } catch {
        // ignore transient errors
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  });

  const chatUnread = $derived.by(() => {
    if (!payload || payload.list.kind !== 'collab') return 0;
    const lastRead = appState.chatReadIds[String(payload.list.id)] ?? 0;
    return payload.messages.filter((m) => Number(m.id) > lastRead).length;
  });

  function toggleChat(): void {
    appState.chatOpen = !appState.chatOpen;
    persistChatOpen(appState.chatOpen);
  }

  async function newCollabList(): Promise<void> {
    const name = window.prompt('Name for the shared list?');
    if (!name?.trim()) return;
    try {
      const data = await api.post<{ list: ListPayload }>('/api/lists', { kind: 'collab', name: name.trim() });
      appState.notice = `Created "${data.list.list.name}".`;
      navigate(`/list/${data.list.list.id}`);
    } catch (err) {
      appState.error = getErrorMessage(err);
    }
  }

  function shuffle(): void {
    if (!payload) return;
    const candidates = payload.albums.filter((album) => !album.currentUserCompleted);
    const pool = candidates.length ? candidates : payload.albums;
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!pick) return;
    highlightAlbumId = pick.id;
    queueMicrotask(() => {
      const node = document.querySelector(`[data-album-id="${pick.id}"]`);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  const pathPrefix = $derived(payload ? `/list/${payload.list.id}` : '');
  const canShare = $derived(
    payload ? payload.list.visibility !== 'private' || payload.permissions.canManage : false
  );

  async function addAlbum(album: AlbumDetail): Promise<void> {
    if (!payload) return;
    const result = await api.post<{ albumId: number; copied?: boolean; album?: ListAlbum }>(
      `/api/lists/${payload.list.id}/albums`,
      album
    );
    if (result.copied === false) appState.notice = 'Already in this list.';
    if (result.album) {
      const albums = payload.albums.some((a) => a.id === result.album!.id)
        ? payload.albums.map((a) => (a.id === result.album!.id ? result.album! : a))
        : [...payload.albums, result.album];
      payload = { ...payload, albums };
    }
  }
</script>

{#if loading && !payload}
  <Placeholder title="Loading…" />
{:else if loadError}
  <Placeholder title="Could not load list" note={loadError} />
{:else if payload}
  {@const showChat = payload.list.kind === 'collab' && payload.permissions.isMember && appState.chatOpen}
  <main class:collab-layout={showChat}>
    <section class="page-shell list-main">
      <div class="title-row">
        <div class="list-title-line">
          <h1>{payload.list.name}</h1>
        </div>
        <ListSwitcher activeListId={payload.list.id} />
      </div>

      <div class="action-row">
        {#if payload.albums.length}
          <IconButton icon="dice" label="Shuffle" onclick={shuffle} />
        {/if}
        {#if payload.permissions.canManage}
          <IconButton
            icon="gear"
            label="Settings"
            active={appState.settingsOpen}
            onclick={() => (appState.settingsOpen = !appState.settingsOpen)}
          />
        {/if}
        {#if appState.user}
          <IconButton icon="plus" label="New shared list" onclick={newCollabList} />
        {/if}
        {#if payload.permissions.isMember && payload.list.kind === 'collab'}
          <IconButton
            icon="users"
            label="People"
            active={peopleOpen}
            onclick={() => (peopleOpen = !peopleOpen)}
          />
        {/if}
        {#if canShare}
          <IconButton
            icon="share"
            label="Share"
            active={shareOpen}
            onclick={() => (shareOpen = !shareOpen)}
          />
        {/if}
        {#if payload.list.kind === 'collab' && payload.permissions.isMember}
          <IconButton
            icon="message"
            label="Chat"
            active={appState.chatOpen}
            badge={chatUnread > 0 ? chatUnread : null}
            onclick={toggleChat}
          />
        {/if}
      </div>

      {#if shareOpen}
        <SharePanel payload={payload} onPayloadUpdate={(next) => (payload = next)} />
      {/if}

      <AlbumSearch enabled={payload.permissions.canEdit} onPick={addAlbum} />

      <section class="album-stack">
        {#if payload.albums.length}
          {#each payload.albums as album (album.id)}
            <AlbumRow
              {album}
              payload={payload}
              highlighted={highlightAlbumId === album.id}
              {pathPrefix}
              onPayloadUpdate={(next) => (payload = next)}
            />
          {/each}
        {:else}
          <div class="empty-minimal">No albums yet.</div>
        {/if}
      </section>

      {#if peopleOpen}
        <PeoplePanel payload={payload} onPayloadUpdate={(next) => (payload = next)} />
      {/if}
    </section>
    {#if showChat}
      <ChatPanel payload={payload} onPayloadUpdate={(next) => (payload = next)} />
    {/if}
  </main>
{/if}
