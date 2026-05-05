<script lang="ts">
  import { router, navigate } from '$lib/router.svelte';
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
  import Placeholder from './Placeholder.svelte';

  let indexData = $state<ExploreIndexPayload | null>(null);
  let detailData = $state<ExploreList | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');
  let shuffleBusy = $state<boolean>(false);

  $effect(() => {
    const route = router.current;
    if (route.type !== 'explore') return;
    const slug = route.slug;
    let cancelled = false;
    loading = true;
    loadError = '';
    indexData = null;
    detailData = null;
    const promise = slug
      ? api.get<ExploreDetailPayload>(`/api/explore/${encodeURIComponent(slug)}`).then((data) => {
          if (!cancelled) detailData = data.list;
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

  function albumSubtitle(album: ExploreAlbum): string {
    const artist = album.artist || 'Unknown artist';
    return album.releaseYear ? `${artist} - ${album.releaseYear}` : artist;
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
  function openPopularList(list: PopularList): void {
    if (list.shareToken) {
      navigate(`/share/${encodeURIComponent(list.shareToken)}`);
      return;
    }
    navigate(`/list/${list.id}`);
  }

  async function shuffleExplore(currentSlug?: string): Promise<void> {
    if (shuffleBusy) return;
    shuffleBusy = true;
    try {
      if (currentSlug && detailData?.slug === currentSlug && detailData.albums.length) {
        const nextIndex = Math.floor(Math.random() * detailData.albums.length);
        navigate(`/explore/${encodeURIComponent(currentSlug)}/album/${nextIndex}`);
        return;
      }
    } catch (err) {
      appState.error = getErrorMessage(err);
    } finally {
      shuffleBusy = false;
    }
  }
</script>

{#if loading && !indexData && !detailData}
  <Placeholder title="Loading…" />
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
      <Cover title={album.title} coverUrl={album.coverUrl} />
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
    <div class="empty-minimal small">Add this album to a list to rate tracks.</div>
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
            <Cover title={album.title} coverUrl={album.coverUrl} />
            <button
              class="album-title"
              onclick={() => navigate(`/explore/${encodeURIComponent(detailData!.slug)}/album/${index}`)}
            >
              <strong>{album.title}</strong>
              <span>{albumSubtitle(album)}</span>
            </button>
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
        <button class="explore-card" onclick={() => navigate(`/explore/${encodeURIComponent(list.slug)}`)}>
          <strong>{list.name}</strong>
          <span>{list.description}</span>
          <small>{list.albumCount} albums</small>
        </button>
      {/each}
    </section>
    {#if indexData.popularLists.length}
      <section class="profile-section">
        <h2>Popular shared lists</h2>
        <div class="album-stack">
          {#each indexData.popularLists as list (list.id)}
            <article class="album-item">
              <div class="album-line">
                <button class="album-title" onclick={() => openPopularList(list)}>
                  <strong>{list.name}</strong>
                  <span>by {list.ownerUsername} - {listSummary(list)}</span>
                </button>
              </div>
            </article>
          {/each}
        </div>
      </section>
    {/if}
  </main>
{/if}
