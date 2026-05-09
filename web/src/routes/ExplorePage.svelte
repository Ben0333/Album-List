<script lang="ts">
  import { router, navigate, followInternalLink } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import { addGuestAlbum } from '$lib/guest';
  import { appState } from '$lib/state.svelte';
  import type {
    ExploreAlbum,
    ExploreDetailPayload,
    ExploreIndexPayload,
    ExploreList,
    ExploreListSummary,
    PopularList
  } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';
  import Cover from '../components/Cover.svelte';
  import RatingRow from '../components/RatingRow.svelte';
  import Placeholder from './Placeholder.svelte';

  let indexData = $state<ExploreIndexPayload | null>(null);
  let detailData = $state<ExploreList | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');
  let shuffleBusy = $state<boolean>(false);
  let albumBusy = $state<boolean>(false);
  let albumError = $state<string>('');
  const failedExploreCoverUrls = new Set<string>();

  $effect(() => {
    const route = router.current;
    if (route.type !== 'explore') return;
    const slug = route.slug;
    let cancelled = false;
    loading = true;
    loadError = '';
    albumError = '';
    indexData = null;
    detailData = null;
    const promise = slug
      ? api.get<ExploreDetailPayload>(`/api/explore/${encodeURIComponent(slug)}`).then((data) => {
          if (!cancelled) {
            detailData = data.list;
            void warmMissingExploreCovers(data.list.slug, () => cancelled);
          }
        })
      : api.get<ExploreIndexPayload>('/api/explore').then((data) => {
          if (!cancelled) indexData = data;
        });
    promise
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

  const slug = $derived(router.current.type === 'explore' ? router.current.slug : null);
  const albumIndex = $derived(router.current.type === 'explore' ? router.current.albumIndex : null);
  const currentAlbum = $derived<ExploreAlbum | null>(detailData && albumIndex !== null ? detailData.albums[albumIndex] ?? null : null);

  $effect(() => {
    if (router.current.type !== 'explore' || router.current.albumIndex === null || !currentAlbum?.albumKey) return;
    navigate(`/album/${encodeURIComponent(currentAlbum.albumKey)}`, { replace: true });
  });

  function albumSubtitle(album: ExploreAlbum): string {
    const artist = album.artist || 'Unknown artist';
    return album.releaseYear ? `${artist} - ${album.releaseYear}` : artist;
  }

  async function warmMissingExploreCovers(listSlug: string, isCancelled: () => boolean): Promise<void> {
    let offset = 0;
    const limit = 24;
    while (!isCancelled()) {
      const list = detailData;
      if (!list || list.slug !== listSlug) return;
      const nextMissing = list.albums.findIndex((album, index) => index >= offset && !album.coverUrl);
      if (nextMissing === -1) return;
      try {
        const data = await api.post<{
          covers: Array<{ index: number; coverUrl: string | null }>;
          nextOffset: number;
          total: number;
        }>(`/api/explore/${encodeURIComponent(listSlug)}/covers/warm`, {
          offset: nextMissing,
          limit
        });
        if (isCancelled()) return;
        const current = detailData;
        if (!current || current.slug !== listSlug) return;
        const coverMap = new Map(data.covers.map((item) => [item.index, item.coverUrl]));
        detailData = {
          ...current,
          albums: current.albums.map((album, index) => {
            const coverUrl = coverMap.get(index);
            return coverUrl ? { ...album, coverUrl } : album;
          })
        };
        offset = data.nextOffset;
        if (offset >= data.total) return;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      } catch {
        return;
      }
    }
  }

  async function refreshExploreCover(index: number, brokenUrl: string): Promise<void> {
    const list = detailData;
    if (!list || failedExploreCoverUrls.has(`${list.slug}:${index}:${brokenUrl}`)) return;
    failedExploreCoverUrls.add(`${list.slug}:${index}:${brokenUrl}`);
    try {
      const data = await api.post<{ index: number; coverUrl: string | null }>(
        `/api/explore/${encodeURIComponent(list.slug)}/covers/${index}/refresh`
      );
      if (!data.coverUrl || data.coverUrl === brokenUrl || !detailData || detailData.slug !== list.slug) return;
      detailData = {
        ...detailData,
        albums: detailData.albums.map((album, albumIndex) =>
          albumIndex === data.index ? { ...album, coverUrl: data.coverUrl } : album
        )
      };
    } catch {
      // Keep the initials fallback if automatic repair cannot find a replacement.
    }
  }

  function albumStatus(album: ExploreAlbum): string {
    if (album.currentUserCompleted) return 'Listened';
    if (album.currentUserRatingCount) return `Your rating ${album.currentUserRatingAverage}/10`;
    return '';
  }

  function addToGuest(album: ExploreAlbum): void {
    addGuestAlbum({
      title: album.title,
      artist: album.artist,
      coverUrl: album.coverUrl,
      tracks: []
    });
    appState.notice = `Added “${album.title}” to your guest list.`;
  }

  function openListPicker(album: ExploreAlbum): void {
    appState.listPicker = {
      title: album.title,
      artist: album.artist,
      coverUrl: album.coverUrl
    };
  }

  function listSummary(list: PopularList): string {
    const parts = [`${list.albumCount} albums`, `${list.memberCount} member${list.memberCount === 1 ? '' : 's'}`];
    if (list.listenCount) parts.push(`${list.listenCount} listens`);
    return parts.join(' • ');
  }
  function popularListPath(list: PopularList): string {
    return list.shareToken ? `/share/${encodeURIComponent(list.shareToken)}` : `/list/${list.id}`;
  }

  function albumPath(album: ExploreAlbum, index: number): string {
    return album.albumKey
      ? `/album/${encodeURIComponent(album.albumKey)}`
      : detailData
        ? `/explore/${encodeURIComponent(detailData.slug)}/album/${index}`
        : '/explore';
  }

  async function shuffleExplore(currentSlug?: string): Promise<void> {
    if (shuffleBusy) return;
    shuffleBusy = true;
    try {
      if (currentSlug && detailData?.slug === currentSlug && detailData.albums.length) {
        const nextIndex = Math.floor(Math.random() * detailData.albums.length);
        const nextAlbum = detailData.albums[nextIndex];
        if (nextAlbum?.albumKey) navigate(`/album/${encodeURIComponent(nextAlbum.albumKey)}`);
        else navigate(`/explore/${encodeURIComponent(currentSlug)}/album/${nextIndex}`);
        return;
      }
    } catch (err) {
      appState.error = getErrorMessage(err);
    } finally {
      shuffleBusy = false;
    }
  }

  async function rateExploreAlbum(rating: number): Promise<void> {
    const list = detailData;
    const index = albumIndex;
    const album = currentAlbum;
    if (!list || index === null || !album || !appState.user || albumBusy) return;
    albumBusy = true;
    albumError = '';
    try {
      const data = await api.put<{ ok: boolean; album: ExploreAlbum }>(
        `/api/explore/${encodeURIComponent(list.slug)}/albums/${index}/rating`,
        { rating, coverUrl: album.coverUrl }
      );
      const albums = list.albums.map((item, itemIndex) => (itemIndex === index ? data.album : item));
      detailData = { ...list, albums };
    } catch (err) {
      albumError = getErrorMessage(err);
    } finally {
      albumBusy = false;
    }
  }
</script>

{#if loading && !indexData && !detailData}
  <Placeholder title="Loading..." />
{:else if loadError}
  <Placeholder title="Could not load explore" note={loadError} />
{:else if currentAlbum && detailData}
  {@const album = currentAlbum}
  <main class="page-shell detail-shell">
    <IconButton
      icon="arrow-left"
      label="Back"
      className="text-button back-link"
      onclick={() => navigate(`/explore/${encodeURIComponent(detailData!.slug)}`)}
    />
    <section class="album-hero">
      <Cover
        title={album.title}
        coverUrl={album.coverUrl}
        onfail={(url) => {
          if (albumIndex !== null) void refreshExploreCover(albumIndex, url);
        }}
      />
      <div>
        <h1>{album.title}</h1>
        <p>{albumSubtitle(album)}</p>
        <div class="button-row left">
          {#if appState.user}
            <IconButton icon="plus" label="Add to library" className="pill" onclick={() => openListPicker(album)} />
          {:else}
            <IconButton icon="plus" label="Add to guest list" className="pill" onclick={() => addToGuest(album)} />
          {/if}
          {#if albumStatus(album)}
            <span class="pill done">{albumStatus(album)}</span>
          {/if}
        </div>
      </div>
    </section>
    {#if appState.user}
      <div class="album-rating-panel">
        <div class="track-row album-rating-row">
          <div>
            <strong>Your rating</strong>
            <span>{albumStatus(album) || 'No rating yet'}</span>
            {#if albumError}<span class="error-line">{albumError}</span>{/if}
          </div>
          <RatingRow current={album.currentUserAlbumRating?.rating ?? null} disabled={albumBusy} onpick={rateExploreAlbum} />
        </div>
      </div>
    {:else}
      <div class="empty-minimal small">Log in to rate this album.</div>
    {/if}
  </main>
{:else if detailData}
  <main class="page-shell explore-shell">
    <IconButton icon="arrow-left" label="Explore" className="text-button back-link" onclick={() => navigate('/explore')} />
    <section class="explore-hero">
      <h1>{detailData.name}</h1>
      <p>{detailData.description}</p>
      <div class="button-row tight">
        <IconButton
          icon="dice"
          label="Shuffle"
          className="pill"
          disabled={shuffleBusy}
          onclick={() => shuffleExplore(detailData!.slug)}
        />
      </div>
    </section>
    <section class="album-stack">
      {#each detailData.albums as album, index (`${detailData.slug}:${index}:${album.title}`)}
        {@const status = albumStatus(album)}
        <article class="album-item">
          <div class="album-line">
            <div class="rank-number">{index + 1}</div>
            <Cover title={album.title} coverUrl={album.coverUrl} onfail={(url) => refreshExploreCover(index, url)} />
            <a
              class="album-title"
              href={albumPath(album, index)}
              onclick={(event) => followInternalLink(event, albumPath(album, index))}
            >
              <strong>{album.title}</strong>
              <span>{albumSubtitle(album)}</span>
            </a>
            {#if status}
              <span class="pill done">{status}</span>
            {/if}
            {#if appState.user}
              <IconButton icon="plus" label="Add" className="pill" onclick={() => openListPicker(album)} />
            {:else}
              <IconButton icon="plus" label="Add" className="pill" onclick={() => addToGuest(album)} />
            {/if}
          </div>
        </article>
      {/each}
    </section>
  </main>
{:else if indexData}
  <main class="page-shell explore-shell">
    <IconButton icon="arrow-left" label="Back" className="text-button back-link" onclick={() => navigate('/')} />
    <h1>Explore</h1>
    <section class="explore-grid">
      {#each indexData.lists as list (list.slug)}
        <a
          class="explore-card"
          href={`/explore/${encodeURIComponent(list.slug)}`}
          onclick={(event) => followInternalLink(event, `/explore/${encodeURIComponent(list.slug)}`)}
        >
          <strong>{list.name}</strong>
          <span>{list.description}</span>
          <small>{list.albumCount} albums</small>
        </a>
      {/each}
    </section>
    {#if indexData.popularLists.length}
      <section class="profile-section">
        <h2>Popular shared lists</h2>
        <div class="album-stack">
          {#each indexData.popularLists as list (list.id)}
            <article class="album-item">
              <div class="album-line">
                <a
                  class="album-title"
                  href={popularListPath(list)}
                  onclick={(event) => followInternalLink(event, popularListPath(list))}
                >
                  <strong>{list.name}</strong>
                  <span>by {list.ownerUsername} - {listSummary(list)}</span>
                </a>
              </div>
            </article>
          {/each}
        </div>
      </section>
    {/if}
  </main>
{/if}

<style>
  .error-line {
    color: var(--danger);
  }
</style>
