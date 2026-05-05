<script lang="ts">
  import type { AlbumTrack, ListAlbum, ListPayload } from '$lib/types';
  import { api, getErrorMessage } from '$lib/api';
  import RatingRow from './RatingRow.svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    track: AlbumTrack;
    album: ListAlbum;
    payload: ListPayload;
    onPayloadUpdate: (next: ListPayload) => void;
  }

  let { track, album, payload, onPayloadUpdate }: Props = $props();
  let busy = $state<boolean>(false);
  let rowError = $state<string>('');

  const average = $derived(
    track.aggregate?.average !== null && track.aggregate?.average !== undefined
      ? `Turntable average ${track.aggregate.average}/10`
      : ''
  );
  const sharedAverage = $derived(
    track.sharedAggregate?.average !== null && track.sharedAggregate?.average !== undefined
      ? `Shared list average ${track.sharedAggregate.average}/10`
      : ''
  );
  const excluded = $derived(Boolean(track.userRating && !track.userRating.includeInAverage));
  const hasRating = $derived(Boolean(track.userRating));
  const included = $derived(!track.userRating || track.userRating.includeInAverage);

  async function rate(rating: number): Promise<void> {
    if (busy) return;
    busy = true;
    rowError = '';
    try {
      const data = await api.put<{ ok: boolean; album: ListAlbum }>(
        `/api/lists/${payload.list.id}/albums/${album.id}/tracks/${track.id}/rating`,
        { rating }
      );
      const albums = payload.albums.map((a) => (a.id === data.album.id ? data.album : a));
      onPayloadUpdate({ ...payload, albums });
    } catch (err) {
      rowError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function toggleAverage(): Promise<void> {
    if (busy || !hasRating) return;
    busy = true;
    rowError = '';
    try {
      const data = await api.patch<{ ok: boolean; album: ListAlbum }>(
        `/api/lists/${payload.list.id}/albums/${album.id}/tracks/${track.id}/rating-preferences`,
        { includeInAverage: !included }
      );
      const albums = payload.albums.map((a) => (a.id === data.album.id ? data.album : a));
      onPayloadUpdate({ ...payload, albums });
    } catch (err) {
      rowError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="track-row">
  <div class="track-head">
    <div>
      <strong>{track.position}. {track.title}</strong>
      {#if sharedAverage}<span>{sharedAverage}</span>{/if}
      {#if average}<span>{average}</span>{/if}
      {#if excluded}<span>Excluded from your average</span>{/if}
      {#if rowError}<span class="error-line">{rowError}</span>{/if}
    </div>
    {#if payload.permissions.canRate}
      <IconButton
        icon={included ? 'eye' : 'eye-off'}
        label={hasRating ? (included ? 'Exclude from average' : 'Include in average') : 'Rate first'}
        className={`icon-button track-average-toggle ${included ? '' : 'excluded'}`}
        disabled={!hasRating || busy}
        onclick={toggleAverage}
      />
    {/if}
  </div>
  {#if payload.permissions.canRate}
    <RatingRow current={track.userRating?.rating ?? null} disabled={busy} onpick={rate} />
  {/if}
</div>

<style>
  .error-line {
    color: var(--danger);
    margin-left: 0.5rem;
  }
</style>
