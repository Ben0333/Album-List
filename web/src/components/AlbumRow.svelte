<script lang="ts">
  import type { ListAlbum, ListPayload } from '$lib/types';
  import { followInternalLink } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import Cover from './Cover.svelte';
  import Completion from './Completion.svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    album: ListAlbum;
    payload: ListPayload;
    highlighted?: boolean;
    openPath?: string | null;
    onPayloadUpdate: (next: ListPayload) => void;
  }

  let { album, payload, highlighted = false, openPath = null, onPayloadUpdate }: Props = $props();
  let busy = $state<boolean>(false);
  let coverRepairing = $state<boolean>(false);
  const failedCoverUrls = new Set<string>();

  const subtitle: string = $derived.by(() => {
    const artist = album.artist || 'Unknown artist';
    const average =
      album.aggregate?.average !== null && album.aggregate?.average !== undefined
        ? `Turntable average ${album.aggregate.average}/10`
        : '';
    return average ? `${artist} - ${average}` : artist;
  });

  const albumPath = $derived(openPath || `/album/${encodeURIComponent(album.albumKey)}`);

  const libraryLabel: string = $derived.by(() => {
    if (album.currentUserFullyRated && album.currentUserAggregate?.count) {
      return `${album.currentUserAggregate.average}/10`;
    }
    return album.currentUserLibrary ? 'In your list' : '';
  });

  const isCollab = $derived(payload.list.kind === 'collab');
  const canVoteRemove = $derived(isCollab && payload.permissions.isMember);
  const canRemove = $derived(payload.permissions.canEdit || canVoteRemove);
  const canCopy = $derived(
    Boolean(
      appState.user &&
        payload.list.ownerUserId !== appState.user.id &&
        !album.currentUserLibrary
    )
  );
  const removeLabel: string = $derived.by(() => {
    if (!isCollab) return 'Remove';
    return album.currentUserRemovalVoted
      ? `Voted ${album.removalVoteCount}/${album.removalVoteThreshold}`
      : `Remove ${album.removalVoteCount}/${album.removalVoteThreshold}`;
  });

  async function removeOrVote(): Promise<void> {
    if (busy || !canRemove) return;
    busy = true;
    try {
      const data = await api.delete<{
        removed: boolean;
        voteCount: number;
        threshold: number;
        albumId: number;
        album?: ListAlbum;
        removedAlbumId?: number | null;
      }>(`/api/lists/${payload.list.id}/albums/${album.id}`);
      if (data.removedAlbumId) {
        const albums = payload.albums.filter((a) => a.id !== data.removedAlbumId);
        onPayloadUpdate({ ...payload, albums });
      } else if (data.album) {
        const albums = payload.albums.map((a) => (a.id === data.album!.id ? data.album! : a));
        onPayloadUpdate({ ...payload, albums });
      }
    } catch (err) {
      appState.error = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function repairBrokenCover(brokenUrl: string): Promise<void> {
    if (!payload.permissions.canEdit || coverRepairing || failedCoverUrls.has(brokenUrl)) return;
    failedCoverUrls.add(brokenUrl);
    coverRepairing = true;
    try {
      const data = await api.post<{ ok: boolean; album: ListAlbum; coverUrl: string }>(
        `/api/lists/${payload.list.id}/albums/${album.id}/cover/refresh`,
        { brokenUrl, force: true }
      );
      const albums = payload.albums.map((item) => (item.id === data.album.id ? data.album : item));
      onPayloadUpdate({ ...payload, albums });
    } catch {
      // Keep the local initials fallback if automatic repair cannot find a replacement.
    } finally {
      coverRepairing = false;
    }
  }

</script>

<article class="album-item" class:highlight={highlighted} data-album-id={album.id}>
  <div class="album-line">
    <Cover title={album.title} coverUrl={album.coverUrl} onfail={repairBrokenCover} />
    <a class="album-title" href={albumPath} onclick={(event) => followInternalLink(event, albumPath)}>
      <strong>{album.title}</strong>
      <span>{subtitle}</span>
    </a>
    <Completion {album} {payload} {onPayloadUpdate} />
    {#if libraryLabel}
      <span class="pill done">{libraryLabel}</span>
    {/if}
    {#if canCopy}
      <IconButton
        icon="plus"
        label="Add"
        className="pill"
        onclick={() => {
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
        }}
      />
    {/if}
    {#if canRemove}
      <IconButton
        icon="trash"
        label={removeLabel}
        className={isCollab ? 'pill danger' : 'icon-button danger'}
        disabled={busy}
        onclick={removeOrVote}
      />
    {/if}
  </div>
</article>
