<script lang="ts">
  import type { ListAlbum, ListPayload } from '$lib/types';
  import { navigate } from '$lib/router.svelte';
  import Cover from './Cover.svelte';
  import Completion from './Completion.svelte';

  interface Props {
    album: ListAlbum;
    payload: ListPayload;
    highlighted?: boolean;
    pathPrefix: string;
    onPayloadUpdate: (next: ListPayload) => void;
  }

  let { album, payload, highlighted = false, pathPrefix, onPayloadUpdate }: Props = $props();

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

  function open(): void {
    navigate(`${pathPrefix}/album/${album.id}`);
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
  </div>
</article>
