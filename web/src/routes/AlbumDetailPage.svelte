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
  {@const yourRatingValue = a.currentUserAggregate?.count ? `${a.currentUserAggregate.average}/10` : ''}
  {@const turntableRatingValue = a.aggregate?.average !== null && a.aggregate?.average !== undefined ? `${a.aggregate.average}/10` : ''}
  {@const turntableAverage = turntableRatingValue ? `Turntable average ${turntableRatingValue}` : ''}
  {@const inLibrary = Boolean(a.currentUserLibrary)}
  <main class="page-shell detail-shell">
    <IconButton icon="arrow-left" label="Back" className="text-button back-link" onclick={back} />
    <section class="album-hero">
      <Cover title={a.title} coverUrl={a.coverUrl} />
      <div>
        <h1>{a.title}</h1>
        <p>{a.artist || 'Unknown artist'}</p>
        <div class="album-meta">
          {#if yourRatingValue || turntableRatingValue || inLibrary}
            <div class="album-rating-summary">
              {#if yourRatingValue}
                <span class="album-rating-chip is-mine">
                  <span>Your rating</span>
                  <strong>{yourRatingValue}</strong>
                </span>
              {/if}
              {#if turntableRatingValue}
                <span class="album-rating-chip">
                  <span>Turntable</span>
                  <strong>{turntableRatingValue}</strong>
                </span>
              {/if}
              {#if inLibrary}
                <span class="album-library-chip">In your list</span>
              {/if}
            </div>
          {/if}
          <div class="button-row left album-action-row">
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
            {#if !inLibrary && appState.user}
              <IconButton icon="plus" label="Add to library" className="pill" onclick={openListPicker} />
            {/if}
          </div>
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

  .album-meta {
    display: grid;
    gap: 10px;
  }

  .album-rating-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .album-rating-chip,
  .album-library-chip {
    min-height: 34px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: color-mix(in srgb, var(--panel) 84%, transparent);
  }

  .album-rating-chip {
    min-width: 112px;
    display: grid;
    gap: 1px;
    padding: 6px 10px;
  }

  .album-rating-chip span {
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 750;
    line-height: 1;
    text-transform: uppercase;
  }

  .album-rating-chip strong {
    color: var(--text);
    font-size: 1rem;
    line-height: 1;
  }

  .album-rating-chip.is-mine {
    border-color: color-mix(in srgb, var(--blue) 62%, var(--line));
    background: color-mix(in srgb, var(--blue) 10%, var(--panel));
  }

  .album-rating-chip.is-mine strong,
  .album-library-chip {
    color: var(--blue-strong);
  }

  .album-library-chip {
    display: inline-grid;
    place-items: center;
    padding: 0 10px;
    font-size: 0.78rem;
    font-weight: 750;
  }

  .album-action-row {
    gap: 8px;
  }
</style>
