<script lang="ts">
  import { router } from '$lib/router.svelte';
  import { api, ApiError } from '$lib/api';
  import type { ListPayload } from '$lib/types';
  import AlbumRow from '../components/AlbumRow.svelte';
  import Placeholder from './Placeholder.svelte';

  let payload = $state<ListPayload | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');

  $effect(() => {
    const route = router.current;
    if (route.type !== 'share') return;
    const token = route.token;
    let cancelled = false;
    loading = true;
    loadError = '';
    api
      .get<ListPayload>(`/api/share/${encodeURIComponent(token)}`)
      .then((data) => {
        if (!cancelled) payload = data;
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

  const pathPrefix = $derived(() => {
    const route = router.current;
    if (route.type !== 'share') return '';
    return `/share/${encodeURIComponent(route.token)}`;
  });
</script>

{#if loading && !payload}
  <Placeholder title="Loading…" />
{:else if loadError}
  <Placeholder title="Could not load shared list" note={loadError} />
{:else if payload}
  <main>
    <section class="page-shell list-main">
      <div class="title-row">
        <div class="list-title-line">
          <h1>{payload.list.name}</h1>
        </div>
      </div>
      {#if payload.list.description}
        <p class="soft-line">{payload.list.description}</p>
      {/if}
      <section class="album-stack">
        {#if payload.albums.length}
          {#each payload.albums as album (album.id)}
            <AlbumRow
              {album}
              {payload}
              pathPrefix={pathPrefix()}
              onPayloadUpdate={(next) => (payload = next)}
            />
          {/each}
        {:else}
          <div class="empty-minimal">No albums in this list yet.</div>
        {/if}
      </section>
    </section>
  </main>
{/if}
