<script lang="ts">
  import type { ListAlbum, ListPayload } from '$lib/types';
  import { navigate } from '$lib/router.svelte';
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import Cover from './Cover.svelte';
  import Completion from './Completion.svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    album: ListAlbum;
    payload: ListPayload;
    highlighted?: boolean;
    pathPrefix: string;
    onPayloadUpdate: (next: ListPayload) => void;
  }

  let { album, payload, highlighted = false, pathPrefix, onPayloadUpdate }: Props = $props();
  let busy = $state<boolean>(false);

  const subtitle: string = $derived.by(() => {
    const artist = album.artist || 'Unknown artist';
    const average =
      album.aggregate?.average !== null && album.aggregate?.average !== undefined
        ? `${album.aggregate.average}/10`
        : '';
    return average ? `${artist} - ${average}` : artist;
  });

  const libraryLabel: string = $derived.by(() => {
    if (!album.currentUserLibrary) return '';
    return album.currentUserLibrary.ratingCount
      ? `Your ${album.currentUserLibrary.average}/10`
      : 'In your list';
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

  function open(): void {
    navigate(`${pathPrefix}/album/${album.id}`);
  }

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

</script>

<article class="album-item" class:highlight={highlighted} data-album-id={album.id}>
  <div class="album-line">
    <Cover title={album.title} coverUrl={album.coverUrl} />
    <button class="album-title" onclick={open}>
      <strong>{album.title}</strong>
      <span>{subtitle}</span>
    </button>
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
