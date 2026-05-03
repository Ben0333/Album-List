<script lang="ts">
  import { router, navigate } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import type { ListAlbum, ListPayload } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';
  import Cover from '../components/Cover.svelte';
  import Completion from '../components/Completion.svelte';
  import RatingRow from '../components/RatingRow.svelte';
  import TrackRow from '../components/TrackRow.svelte';
  import Placeholder from './Placeholder.svelte';

  let payload = $state<ListPayload | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');
  let albumBusy = $state<boolean>(false);
  let albumError = $state<string>('');

  $effect(() => {
    const route = router.current;
    if ((route.type !== 'list' && route.type !== 'share') || route.albumId === null) return;
    const url =
      route.type === 'list'
        ? `/api/lists/${route.id}`
        : `/api/share/${encodeURIComponent(route.token)}`;
    let cancelled = false;
    loading = true;
    loadError = '';
    api
      .get<ListPayload>(url)
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
    };
  });

  const album: ListAlbum | null = $derived.by(() => {
    if (!payload) return null;
    const route = router.current;
    if ((route.type !== 'list' && route.type !== 'share') || route.albumId === null) return null;
    return payload.albums.find((a) => a.id === route.albumId) ?? null;
  });

  function back(): void {
    const route = router.current;
    if (route.type === 'share') {
      navigate(`/share/${encodeURIComponent(route.token)}`);
      return;
    }
    if (payload) navigate(`/list/${payload.list.id}`);
  }

  async function rateAlbum(rating: number): Promise<void> {
    const current = album;
    if (!payload || !current || albumBusy) return;
    albumBusy = true;
    albumError = '';
    try {
      const data = await api.put<{ ok: boolean; album: ListAlbum }>(
        `/api/lists/${payload.list.id}/albums/${current.id}/rating`,
        { rating }
      );
      const albums = payload.albums.map((a) => (a.id === data.album.id ? data.album : a));
      payload = { ...payload, albums };
    } catch (err) {
      albumError = getErrorMessage(err);
    } finally {
      albumBusy = false;
    }
  }

  async function toggleAverageOptIn(): Promise<void> {
    const current = album;
    if (!payload || !current || albumBusy) return;
    albumBusy = true;
    albumError = '';
    try {
      const data = await api.patch<{ ok: boolean; album: ListAlbum }>(
        `/api/lists/${payload.list.id}/albums/${current.id}/rating-preferences`,
        { includeInAverage: !current.currentUserAverageOptIn }
      );
      const albums = payload.albums.map((a) => (a.id === data.album.id ? data.album : a));
      payload = { ...payload, albums };
    } catch (err) {
      albumError = getErrorMessage(err);
    } finally {
      albumBusy = false;
    }
  }
</script>

{#if loading && !payload}
  <Placeholder title="Loading…" />
{:else if loadError}
  <Placeholder title="Could not load list" note={loadError} />
{:else if !album}
  <main class="page-shell detail-shell">
    <IconButton icon="arrow-left" label="Back" className="text-button back-link" onclick={back} />
    <div class="empty-minimal">Album not found.</div>
  </main>
{:else if payload}
  {@const a = album}
  {@const averagePill = a.aggregate?.average !== null && a.aggregate?.average !== undefined ? `${a.aggregate.average}/10` : 'No average'}
  {@const libraryLabel = a.currentUserLibrary
    ? a.currentUserLibrary.ratingCount
      ? `Your ${a.currentUserLibrary.average}/10`
      : 'In your list'
    : ''}
  <main class="page-shell detail-shell">
    <IconButton icon="arrow-left" label="Back" className="text-button back-link" onclick={back} />
    <section class="album-hero">
      <Cover title={a.title} coverUrl={a.coverUrl} />
      <div>
        <h1>{a.title}</h1>
        <p>{a.artist || 'Unknown artist'}</p>
        <div class="button-row left">
          <span class="pill">{averagePill}</span>
          {#if a.externalUrl}
            <a class="pill link-pill" href={a.externalUrl} target="_blank" rel="noreferrer">Open</a>
          {/if}
          <Completion album={a} {payload} onPayloadUpdate={(next) => (payload = next)} />
          {#if libraryLabel}
            <span class="pill done">{libraryLabel}</span>
          {/if}
        </div>
      </div>
    </section>

    <div class="album-details">
      {#if a.tracks.length}
        {#if payload.permissions.canRate && payload.list.showRatings}
          <div class="album-detail-controls">
            <button
              type="button"
              class="pill"
              disabled={albumBusy}
              onclick={toggleAverageOptIn}
            >
              Averages {a.currentUserAverageOptIn ? 'on' : 'off'}
            </button>
          </div>
        {/if}
        <div class="track-list">
          {#each a.tracks as track (track.id)}
            <TrackRow {track} album={a} {payload} onPayloadUpdate={(next) => (payload = next)} />
          {/each}
        </div>
      {:else if payload.permissions.canRate}
        <div class="album-rating-panel">
          <div class="track-row album-rating-row">
            <div>
              <strong>Album rating</strong>
              <span>Track list unavailable - {averagePill}</span>
              {#if albumError}<span class="error-line">{albumError}</span>{/if}
            </div>
            <RatingRow current={a.currentUserAlbumRating?.rating ?? null} disabled={albumBusy} onpick={rateAlbum} />
          </div>
        </div>
      {:else}
        <div class="empty-minimal small">Track list unavailable.</div>
      {/if}
    </div>
  </main>
{/if}

<style>
  .error-line {
    color: var(--danger);
    margin-left: 0.5rem;
  }
</style>
