<script lang="ts">
  import { api, ApiError } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import Cover from './Cover.svelte';
  import IconButton from './IconButton.svelte';
  import Icon from './Icon.svelte';

  interface ListLink {
    listId: number;
    name: string;
    kind: 'personal' | 'collab';
    role: 'owner' | 'editor' | 'viewer';
    albumId: number | null;
  }

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();
  let lists = $state<ListLink[]>([]);
  let loading = $state<boolean>(true);
  let busyListId = $state<number | null>(null);
  let modalError = $state<string>('');
  let lastKey = '';

  $effect(() => {
    const target = appState.listPicker;
    if (!target) return;
    const key = `${target.title}|${target.artist}`;
    if (key === lastKey) return;
    lastKey = key;
    let cancelled = false;
    loading = true;
    modalError = '';
    const params = new URLSearchParams({ title: target.title, artist: target.artist });
    api
      .get<{ items: ListLink[] }>(`/api/me/album-lists?${params.toString()}`)
      .then((data) => {
        if (!cancelled) lists = data.items;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        modalError = err instanceof ApiError ? err.message : (err as Error).message;
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  async function toggle(list: ListLink): Promise<void> {
    const target = appState.listPicker;
    if (!target || busyListId !== null) return;
    busyListId = list.listId;
    modalError = '';
    try {
      if (list.albumId) {
        const result = await api.delete<{ removed: boolean; voteCount: number; threshold: number; albumId: number }>(
          `/api/lists/${list.listId}/albums/by-key`,
          { title: target.title, artist: target.artist }
        );
        if (result.removed) {
          lists = lists.map((item) => (item.listId === list.listId ? { ...item, albumId: null } : item));
          appState.notice = `Removed from "${list.name}".`;
        } else {
          appState.notice = `Voted to remove (${result.voteCount}/${result.threshold}).`;
        }
      } else {
        const result = await api.post<{ albumId: number; copied: boolean }>(`/api/lists/${list.listId}/albums/copy`, {
          title: target.title,
          artist: target.artist,
          coverUrl: target.coverUrl
        });
        lists = lists.map((item) => (item.listId === list.listId ? { ...item, albumId: result.albumId } : item));
        appState.notice = result.copied ? `Added to "${list.name}".` : `Already in "${list.name}".`;
      }
    } catch (err) {
      modalError = err instanceof ApiError ? err.message : (err as Error).message;
    } finally {
      busyListId = null;
    }
  }

  function backdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }
</script>

{#if appState.listPicker}
  {@const target = appState.listPicker}
  <div class="modal-backdrop" onclick={backdropClick} role="presentation">
    <section class="settings-modal list-picker-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <strong>Save to lists</strong>
        <IconButton icon="x" label="Close" className="icon-button" onclick={onClose} />
      </div>
      <div class="album-line picker-album">
        <Cover title={target.title} coverUrl={target.coverUrl} />
        <div class="album-title static">
          <strong>{target.title}</strong>
          <span>{target.artist || 'Unknown artist'}</span>
        </div>
      </div>
      {#if modalError}<div class="error-line">{modalError}</div>{/if}
      <div class="picker-list">
        {#if loading}
          <div class="empty-minimal small">Loading…</div>
        {:else if !lists.length}
          <div class="empty-minimal small">No editable lists yet.</div>
        {:else}
          {#each lists as list (list.listId)}
            <button
              type="button"
              class="picker-line"
              class:added={list.albumId !== null}
              disabled={busyListId !== null}
              onclick={() => toggle(list)}
            >
              <span>{list.name}</span>
              <Icon name={list.albumId !== null ? 'check' : 'plus'} />
            </button>
          {/each}
        {/if}
      </div>
      <div class="button-row left">
        <IconButton icon="check" label="Done" className="primary" onclick={onClose} />
      </div>
    </section>
  </div>
{/if}

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
    padding: 0 0.5rem;
  }
</style>
