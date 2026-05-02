<script lang="ts">
  import type { ListAlbum, ListPayload } from '$lib/types';
  import { appState } from '$lib/state.svelte';
  import { api } from '$lib/api';
  import Avatar from './Avatar.svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    album: ListAlbum;
    payload: ListPayload;
    onPayloadUpdate: (next: ListPayload) => void;
  }

  let { album, payload, onPayloadUpdate }: Props = $props();
  let busy = $state<boolean>(false);

  const canMark = $derived(Boolean(appState.user && payload.permissions.isMember));
  const completedIds = $derived(new Set(album.completions.map((c) => c.userId)));
  const visibleMembers = $derived(
    payload.members.length > 4 ? album.pendingMembers : payload.members
  );

  async function toggleListened(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const data = await api.post<{ album: ListAlbum }>(
        `/api/lists/${payload.list.id}/albums/${album.id}/complete`,
        { completed: !album.currentUserCompleted }
      );
      const albums = payload.albums.map((a) => (a.id === data.album.id ? data.album : a));
      onPayloadUpdate({ ...payload, albums });
    } finally {
      busy = false;
    }
  }
</script>

<div class="completion">
  {#each visibleMembers as member (member.userId)}
    <Avatar member={member} complete={completedIds.has(member.userId)} />
  {/each}
  {#if canMark}
    <IconButton
      icon="headphones"
      label={album.currentUserCompleted ? 'Listened' : 'Listen'}
      className={`pill ${album.currentUserCompleted ? 'done' : ''}`}
      disabled={busy}
      onclick={toggleListened}
    />
  {/if}
</div>
