<script lang="ts">
  import { appState } from '$lib/state.svelte';
  import { addGuestAlbum, toggleGuestCompleted, removeGuestAlbum } from '$lib/guest';
  import type { GuestAlbum } from '$lib/types';
  import AlbumSearch from '../components/AlbumSearch.svelte';
  import type { AlbumDetail } from '../components/AlbumSearch.svelte';
  import Cover from '../components/Cover.svelte';
  import IconButton from '../components/IconButton.svelte';

  let highlightedId = $state<string | null>(null);

  async function add(album: AlbumDetail): Promise<void> {
    const exists = appState.guest.albums.find(
      (a) => a.title.toLowerCase() === album.title.toLowerCase() && (a.artist || '').toLowerCase() === (album.artist || '').toLowerCase()
    );
    if (exists) {
      appState.notice = 'Already on your guest list.';
      return;
    }
    addGuestAlbum({
      title: album.title,
      artist: album.artist,
      coverUrl: album.coverUrl,
      tracks: album.tracks
    });
  }

  function shuffle(): void {
    const candidates = appState.guest.albums.filter((a) => !a.completed);
    const pool = candidates.length ? candidates : appState.guest.albums;
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!pick) return;
    highlightedId = pick.id;
    queueMicrotask(() => {
      const node = document.querySelector(`[data-album-id="${pick.id}"]`);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function rowSubtitle(album: GuestAlbum): string {
    const artist = album.artist || 'Unknown artist';
    return album.completed ? `${artist} - listened` : artist;
  }
</script>

<main class="page-shell">
  <h1>Turntable</h1>
  <p class="brand-line">Your album queue, listening diary, and shared record shelf.</p>
  <AlbumSearch onPick={add} />
  {#if appState.guest.albums.length}
    <div class="action-row">
      <IconButton icon="dice" label="Shuffle" onclick={shuffle} />
    </div>
  {/if}
  <section class="album-stack">
    {#if appState.guest.albums.length}
      {#each appState.guest.albums as album (album.id)}
        <article class="album-item" class:highlight={highlightedId === album.id} data-album-id={album.id}>
          <div class="album-line">
            <Cover title={album.title} coverUrl={album.coverUrl} />
            <button class="album-title" onclick={() => toggleGuestCompleted(album.id)}>
              <strong>{album.title}</strong>
              <span>{rowSubtitle(album)}</span>
            </button>
            <IconButton
              icon="trash"
              label="Remove"
              className="icon-button danger"
              onclick={() => removeGuestAlbum(album.id)}
            />
          </div>
        </article>
      {/each}
    {:else}
      <div class="empty-minimal">No albums yet.</div>
    {/if}
  </section>
</main>

<style>
  .brand-line {
    color: var(--muted);
    margin: -8px 0 14px;
    max-width: 620px;
  }
</style>
