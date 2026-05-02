<script lang="ts">
  import { appState } from '$lib/state.svelte';
  import { router, navigate } from '$lib/router.svelte';
  import { api, ApiError } from '$lib/api';
  import type { ListPayload } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';
  import AlbumRow from '../components/AlbumRow.svelte';
  import AlbumSearch from '../components/AlbumSearch.svelte';
  import ListSwitcher from '../components/ListSwitcher.svelte';
  import Placeholder from './Placeholder.svelte';

  let payload = $state<ListPayload | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');
  let highlightAlbumId = $state<number | null>(null);

  $effect(() => {
    const route = router.current;
    if (route.type !== 'list') return;
    const id = route.id;
    let cancelled = false;
    loading = true;
    loadError = '';
    api
      .get<ListPayload>(`/api/lists/${id}`)
      .then((data) => {
        if (cancelled) return;
        payload = data;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        loadError = err instanceof ApiError ? err.message : (err as Error).message;
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

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
</script>

{#if loading && !payload}
  <Placeholder title="Loading…" />
{:else if loadError}
  <Placeholder title="Could not load list" note={loadError} />
{:else if payload}
  <main>
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
      </div>

      <AlbumSearch payload={payload} onPayloadUpdate={(next) => (payload = next)} />

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
    </section>
  </main>
{/if}
