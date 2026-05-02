<script lang="ts">
  import { router, navigate } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import type { ProfileAlbum, ProfilePayload } from '$lib/types';
  import Avatar from '../components/Avatar.svelte';
  import Cover from '../components/Cover.svelte';
  import Placeholder from './Placeholder.svelte';

  let profile = $state<ProfilePayload | null>(null);
  let loading = $state<boolean>(true);
  let loadError = $state<string>('');
  let query = $state<string>('');

  $effect(() => {
    const route = router.current;
    if (route.type !== 'profile') return;
    const username = route.username;
    let cancelled = false;
    loading = true;
    loadError = '';
    profile = null;
    query = '';
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

  function normalize(value: string): string {
    return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }

  const filtered: ProfileAlbum[] = $derived.by(() => {
    if (!profile) return [];
    const q = normalize(query.trim());
    if (!q) return profile.ratedAlbums;
    return profile.ratedAlbums.filter((album) => {
      const text = normalize([album.title, album.artist].filter(Boolean).join(' '));
      return text.includes(q);
    });
  });

  function albumSubtitle(album: ProfileAlbum): string {
    const average = album.average === null ? 'No average' : `${album.average}/10`;
    const parts = [album.artist || 'Unknown artist', average];
    if (!album.fullyListened) parts.push('not finished');
    if (album.inCommon) parts.push('in common');
    return parts.join(' - ');
  }
</script>

{#if loading && !profile}
  <Placeholder title="Loading…" />
{:else if loadError}
  <Placeholder title="Could not load profile" note={loadError} />
{:else if profile}
  <main class="page-shell profile-shell">
    <section class="profile-hero">
      <Avatar member={profile.user} clickable={false} />
      <div>
        <h1>{profile.user.username}</h1>
        <p>
          {profile.lists.length} public list{profile.lists.length === 1 ? '' : 's'} -
          {profile.ratedAlbums.length} listened or rated album{profile.ratedAlbums.length === 1 ? '' : 's'}
        </p>
      </div>
    </section>

    <section class="profile-section">
      <h2>Public lists</h2>
      <div class="album-stack">
        {#if profile.lists.length}
          {#each profile.lists as list (list.id)}
            <article class="album-item">
              <div class="album-line">
                <button class="album-title" onclick={() => navigate(`/list/${list.id}`)}>
                  <strong>{list.name}</strong>
                  <span>{list.albumCount} album{list.albumCount === 1 ? '' : 's'}</span>
                </button>
              </div>
            </article>
          {/each}
        {:else}
          <div class="empty-minimal">No public lists.</div>
        {/if}
      </div>
    </section>

    <section class="profile-section">
      <h2>Albums</h2>
      {#if profile.ratedAlbums.length}
        <div class="profile-search">
          <label class="search-input">
            <input
              type="text"
              placeholder="Search albums or artists..."
              aria-label={`Search ${profile.user.username}'s albums`}
              bind:value={query}
              autocomplete="off"
            />
          </label>
        </div>
      {/if}
      <div class="album-stack">
        {#if !profile.ratedAlbums.length}
          <div class="empty-minimal">No listened or rated albums yet.</div>
        {:else if !filtered.length}
          <div class="empty-minimal">No albums match "{query.trim()}".</div>
        {:else}
          {#each filtered as album (album.albumKey)}
            <article class="album-item" class:common={album.inCommon}>
              <div class="album-line">
                <Cover title={album.title} coverUrl={album.coverUrl} />
                <button
                  class="album-title"
                  onclick={() =>
                    navigate(`/u/${encodeURIComponent(profile!.user.username)}/album/${encodeURIComponent(album.albumKey)}`)}
                >
                  <strong>{album.title}</strong>
                  <span>{albumSubtitle(album)}</span>
                </button>
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </section>
  </main>
{/if}
