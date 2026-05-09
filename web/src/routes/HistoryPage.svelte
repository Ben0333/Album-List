<script lang="ts">
  import { router, navigate, followInternalLink } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import type { HistoryCompletion, HistoryPayload } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';
  import Cover from '../components/Cover.svelte';
  import Placeholder from './Placeholder.svelte';

  let history = $state<HistoryPayload | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');

  $effect(() => {
    const route = router.current;
    if (route.type !== 'history') return;
    const token = route.token;
    let cancelled = false;
    loading = true;
    loadError = '';
    history = null;
    api
      .get<HistoryPayload>(`/api/history/${encodeURIComponent(token)}`)
      .then((data) => {
        if (!cancelled) history = data;
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

  const albumKey = $derived(router.current.type === 'history' ? router.current.albumKey : null);
  const focused: HistoryCompletion | null = $derived.by(() => {
    if (!history || !albumKey) return null;
    return history.completions.find((item) => item.albumKey === albumKey) ?? null;
  });

  function back(): void {
    const route = router.current;
    if (route.type !== 'history') return;
    navigate(`/history/${encodeURIComponent(route.token)}`);
  }

  function rowSubtitle(item: HistoryCompletion): string {
    const artist = item.artist || 'Unknown artist';
    const average =
      item.aggregate?.average !== null && item.aggregate?.average !== undefined
        ? `Turntable average ${item.aggregate.average}/10`
        : '';
    return average ? `${artist} - ${average}` : artist;
  }

  function historyAlbumPath(item: HistoryCompletion): string {
    const route = router.current;
    return route.type === 'history'
      ? `/history/${encodeURIComponent(route.token)}/album/${encodeURIComponent(item.albumKey)}`
      : '/';
  }
</script>

{#if loading && !history}
  <Placeholder title="Loading…" />
{:else if loadError}
  <Placeholder title="Could not load history" note={loadError} />
{:else if focused && history}
  {@const item = focused}
  {@const average = item.aggregate?.average !== null && item.aggregate?.average !== undefined ? `Turntable average ${item.aggregate.average}/10` : ''}
  <main class="page-shell detail-shell">
    <IconButton icon="arrow-left" label="Back" className="text-button back-link" onclick={back} />
    <section class="album-hero">
      <Cover title={item.title} coverUrl={item.coverUrl} />
      <div>
        <h1>{item.title}</h1>
        <p>{item.artist || 'Unknown artist'}</p>
        <div class="button-row left">
          {#if average}<span class="pill">{average}</span>{/if}
          <span class="pill done">Listened</span>
        </div>
      </div>
    </section>
    <section class="readonly-ratings">
      <h2>{history.user.username}'s ratings</h2>
      {#if item.myRatings.length}
        <div class="track-list">
          {#each item.myRatings as rating (rating.trackKey)}
            <div class="track-row readonly-rating-row">
              <div>
                <strong>{rating.trackTitle || 'Album rating'}</strong>
                {#if !rating.includeInAverage}<span>(excluded)</span>{/if}
              </div>
              <span class="pill">{rating.rating}/10</span>
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty-minimal small">No ratings recorded.</div>
      {/if}
    </section>
  </main>
{:else if history}
  <main class="page-shell">
    <h1>{history.user.username}'s history</h1>
    <section class="album-stack">
      {#if history.completions.length}
        {#each history.completions as item (item.albumKey)}
          <article class="album-item">
            <div class="album-line">
              <Cover title={item.title} coverUrl={item.coverUrl} />
              <a
                class="album-title"
                href={historyAlbumPath(item)}
                onclick={(event) => followInternalLink(event, historyAlbumPath(item))}
              >
                <strong>{item.title}</strong>
                <span>{rowSubtitle(item)}</span>
              </a>
            </div>
          </article>
        {/each}
      {:else}
        <div class="empty-minimal">No history yet.</div>
      {/if}
    </section>
  </main>
{/if}
