<script lang="ts">
  import { router, navigate } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import type { AlbumDetail, AlbumDetailPayload, AlbumTrack } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';
  import Cover from '../components/Cover.svelte';
  import RatingRow from '../components/RatingRow.svelte';
  import Placeholder from './Placeholder.svelte';

  let album = $state<AlbumDetail | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');
  let busy = $state<boolean>(false);
  let pageError = $state<string>('');

  $effect(() => {
    const route = router.current;
    if (route.type !== 'album') return;
    const albumKey = route.albumKey;
    let cancelled = false;
    loading = true;
    loadError = '';
    pageError = '';
    album = null;
    api
      .get<AlbumDetailPayload>(`/api/albums/by-key/${encodeURIComponent(albumKey)}`)
      .then((data) => {
        if (!cancelled) album = data.album;
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

  const canRate = $derived(Boolean(appState.user));

  function back(): void {
    const state = window.history.state as { from?: string } | null;
    if (state?.from) {
      window.history.back();
      return;
    }
    navigate('/');
  }

  function setAlbum(next: { album: AlbumDetail }): void {
    album = next.album;
  }

  function openListPicker(): void {
    if (!album) return;
    appState.listPicker = {
      title: album.title,
      artist: album.artist,
      coverUrl: album.coverUrl,
      tracks: album.tracks.map((track) => ({
        title: track.title,
        trackKey: track.trackKey,
        discNumber: track.discNumber,
        position: track.position
      }))
    };
  }

  async function toggleListened(): Promise<void> {
    if (!album || !canRate || busy) return;
    busy = true;
    pageError = '';
    try {
      const data = await api.post<{ ok: boolean; album: AlbumDetail }>(
        `/api/albums/by-key/${encodeURIComponent(album.albumKey)}/complete`,
        { completed: !album.currentUserCompleted }
      );
      setAlbum(data);
    } catch (err) {
      pageError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function toggleAlbumAverage(): Promise<void> {
    if (!album || !canRate || busy) return;
    busy = true;
    pageError = '';
    try {
      const data = await api.patch<{ ok: boolean; album: AlbumDetail }>(
        `/api/albums/by-key/${encodeURIComponent(album.albumKey)}/rating-preferences`,
        { includeInAverage: !album.currentUserAverageOptIn }
      );
      setAlbum(data);
    } catch (err) {
      pageError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function rateAlbum(rating: number): Promise<void> {
    if (!album || !canRate || busy) return;
    busy = true;
    pageError = '';
    try {
      const data = await api.put<{ ok: boolean; album: AlbumDetail }>(
        `/api/albums/by-key/${encodeURIComponent(album.albumKey)}/rating`,
        { rating }
      );
      setAlbum(data);
    } catch (err) {
      pageError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function rateTrack(track: AlbumTrack, rating: number): Promise<void> {
    if (!album || !canRate || busy) return;
    busy = true;
    pageError = '';
    try {
      const data = await api.put<{ ok: boolean; album: AlbumDetail }>(
        `/api/albums/by-key/${encodeURIComponent(album.albumKey)}/tracks/${encodeURIComponent(track.trackKey)}/rating`,
        { rating }
      );
      setAlbum(data);
    } catch (err) {
      pageError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function toggleTrackAverage(track: AlbumTrack): Promise<void> {
    if (!album || !canRate || !track.userRating || busy) return;
    busy = true;
    pageError = '';
    try {
      const data = await api.patch<{ ok: boolean; album: AlbumDetail }>(
        `/api/albums/by-key/${encodeURIComponent(album.albumKey)}/tracks/${encodeURIComponent(track.trackKey)}/rating-preferences`,
        { includeInAverage: !track.userRating.includeInAverage }
      );
      setAlbum(data);
    } catch (err) {
      pageError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  function trackAverage(track: AlbumTrack): string {
    return track.aggregate?.average !== null && track.aggregate?.average !== undefined
      ? `Turntable average ${track.aggregate.average}/10`
      : '';
  }
</script>

{#if loading && !album}
  <Placeholder title="Loadingâ€¦" />
{:else if loadError}
  <Placeholder title="Could not load album" note={loadError} />
{:else if album}
  {@const a = album}
  {@const yourRating = a.currentUserAggregate?.count ? `Your rating ${a.currentUserAggregate.average}/10` : ''}
  {@const turntableAverage = a.aggregate?.average !== null && a.aggregate?.average !== undefined ? `Turntable average ${a.aggregate.average}/10` : ''}
  {@const libraryLabel = a.currentUserLibrary
    ? a.currentUserLibrary.ratingCount
      ? `In your list - ${a.currentUserLibrary.average}/10`
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
          {#if yourRating}<span class="pill done">{yourRating}</span>{/if}
          {#if turntableAverage}<span class="pill">{turntableAverage}</span>{/if}
          {#if a.externalUrl}
            <a class="pill link-pill" href={a.externalUrl} target="_blank" rel="noreferrer">Open</a>
          {/if}
          {#if canRate}
            <IconButton
              icon="headphones"
              label={a.currentUserCompleted ? 'Listened' : 'Listen'}
              className={`pill ${a.currentUserCompleted ? 'done' : ''}`}
              disabled={busy}
              onclick={toggleListened}
            />
          {/if}
          {#if libraryLabel}
            <span class="pill done">{libraryLabel}</span>
          {:else if appState.user}
            <IconButton icon="plus" label="Add to library" className="pill" onclick={openListPicker} />
          {/if}
        </div>
      </div>
    </section>

    <div class="album-details">
      {#if pageError}<div class="error-line">{pageError}</div>{/if}
      {#if a.tracks.length}
        {#if canRate}
          <div class="album-detail-controls">
            <button type="button" class="pill" disabled={busy} onclick={toggleAlbumAverage}>
              Averages {a.currentUserAverageOptIn ? 'on' : 'off'}
            </button>
          </div>
        {/if}
        <div class="track-list">
          {#each a.tracks as track (track.trackKey)}
            {@const average = trackAverage(track)}
            {@const included = !track.userRating || track.userRating.includeInAverage}
            <div class="track-row">
              <div class="track-head">
                <div>
                  <strong>{track.position}. {track.title}</strong>
                  {#if average}<span>{average}</span>{/if}
                  {#if track.userRating && !track.userRating.includeInAverage}<span>Excluded from your average</span>{/if}
                </div>
                {#if canRate}
                  <IconButton
                    icon={included ? 'eye' : 'eye-off'}
                    label={track.userRating ? (included ? 'Exclude from average' : 'Include in average') : 'Rate first'}
                    className={`icon-button track-average-toggle ${included ? '' : 'excluded'}`}
                    disabled={!track.userRating || busy}
                    onclick={() => toggleTrackAverage(track)}
                  />
                {/if}
              </div>
              {#if canRate}
                <RatingRow current={track.userRating?.rating ?? null} disabled={busy} onpick={(value) => rateTrack(track, value)} />
              {/if}
            </div>
          {/each}
        </div>
      {:else if canRate}
        <div class="album-rating-panel">
          <div class="track-row album-rating-row">
            <div>
              <strong>Album rating</strong>
              <span>Track list unavailable.</span>
              {#if turntableAverage}<span>{turntableAverage}</span>{/if}
            </div>
            <RatingRow current={a.currentUserAlbumRating?.rating ?? null} disabled={busy} onpick={rateAlbum} />
          </div>
        </div>
      {:else}
        <div class="empty-minimal small">Log in to rate this album.</div>
      {/if}
    </div>
  </main>
{/if}

<style>
  .error-line {
    color: var(--danger);
  }
</style>
