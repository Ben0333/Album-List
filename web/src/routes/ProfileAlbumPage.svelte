<script lang="ts">
  import { router, navigate } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import type { ProfileAlbum, ProfilePayload } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';
  import Cover from '../components/Cover.svelte';
  import RatingRow from '../components/RatingRow.svelte';
  import Placeholder from './Placeholder.svelte';

  let profile = $state<ProfilePayload | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');
  let busy = $state<boolean>(false);
  let pageError = $state<string>('');

  $effect(() => {
    const route = router.current;
    if (route.type !== 'profile' || !route.albumKey) return;
    const username = route.username;
    let cancelled = false;
    loading = true;
    loadError = '';
    profile = null;
    api
      .get<ProfilePayload>(`/api/users/${encodeURIComponent(username)}`)
      .then((data) => {
        if (!cancelled) profile = data;
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

  const albumKey = $derived(router.current.type === 'profile' ? router.current.albumKey : null);
  const album: ProfileAlbum | null = $derived.by(() => {
    if (!profile || !albumKey) return null;
    return profile.ratedAlbums.find((item) => item.albumKey === albumKey) ?? null;
  });
  const ownProfile = $derived(Boolean(appState.user && profile?.user.id === appState.user.id));

  function back(): void {
    const route = router.current;
    if (route.type !== 'profile') return;
    navigate(`/u/${encodeURIComponent(route.username)}`);
  }

  async function updateRating(trackKey: string, rating: number): Promise<void> {
    if (!album || !ownProfile || busy) return;
    busy = true;
    pageError = '';
    try {
      const data = await api.put<ProfilePayload>(
        `/api/me/albums/${encodeURIComponent(album.albumKey)}/ratings/${encodeURIComponent(trackKey)}`,
        { rating }
      );
      profile = data;
    } catch (err) {
      pageError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

{#if loading && !profile}
  <Placeholder title="Loading…" />
{:else if loadError}
  <Placeholder title="Could not load profile" note={loadError} />
{:else if !album}
  <main class="page-shell detail-shell">
    <IconButton icon="arrow-left" label="Back" className="text-button back-link" onclick={back} />
    <div class="empty-minimal">Album not found.</div>
  </main>
{:else if profile}
  {@const a = album}
  {@const averageLabel = a.average === null ? 'No average' : `${a.average}/10`}
  <main class="page-shell detail-shell">
    <IconButton icon="arrow-left" label="Back" className="text-button back-link" onclick={back} />
    <section class="album-hero">
      <Cover title={a.title} coverUrl={a.coverUrl} />
      <div>
        <h1>{a.title}</h1>
        <p>{a.artist || 'Unknown artist'}</p>
        <div class="button-row left">
          <span class="pill">{averageLabel}</span>
          {#if a.inCommon}<span class="pill done">In common</span>{/if}
          {#if a.fullyListened}
            <span class="pill done">Listened</span>
          {:else}
            <span class="pill">Not finished</span>
          {/if}
          {#if appState.user && !ownProfile}
            <IconButton
              icon="plus"
              label="Add to library"
              className="pill"
              onclick={() => {
                appState.listPicker = { title: a.title, artist: a.artist, coverUrl: a.coverUrl };
              }}
            />
          {/if}
        </div>
      </div>
    </section>
    <section class="readonly-ratings">
      <h2>{ownProfile ? 'Your ratings' : `${profile.user.username}'s ratings`}</h2>
      {#if pageError}<div class="error-line">{pageError}</div>{/if}
      {#if a.ratings.length}
        <div class="track-list">
          {#each a.ratings as rating (rating.trackKey)}
            <div class="track-row" class:readonly-rating-row={!ownProfile}>
              <div>
                <strong>{rating.trackTitle || 'Album rating'}</strong>
                {#if !rating.includeInAverage}<span>(excluded)</span>{/if}
              </div>
              {#if ownProfile}
                <RatingRow
                  current={rating.rating}
                  disabled={busy}
                  onpick={(value) => updateRating(rating.trackKey, value)}
                />
              {:else}
                <span class="pill">{rating.rating}/10</span>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty-minimal small">No ratings recorded.</div>
      {/if}
    </section>
  </main>
{/if}

<style>
  .error-line {
    color: var(--danger);
    margin-bottom: 0.5rem;
  }
</style>
