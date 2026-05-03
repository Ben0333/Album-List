<script lang="ts">
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import type { ListPayload } from '$lib/types';
  import IconButton from './IconButton.svelte';

  interface Props {
    payload: ListPayload;
    onSaved?: () => void;
  }

  let { payload, onSaved }: Props = $props();
  let name = $state<string>('');
  let description = $state<string>('');
  let visibility = $state<'private' | 'unlisted' | 'public'>('private');
  let showRatings = $state<boolean>(true);
  let busy = $state<boolean>(false);
  let saveError = $state<string>('');
  let lastListId = -1;

  $effect(() => {
    if (payload.list.id !== lastListId) {
      name = payload.list.name;
      description = payload.list.description ?? '';
      visibility = payload.list.visibility;
      showRatings = payload.list.showRatings;
      lastListId = payload.list.id;
    }
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    busy = true;
    saveError = '';
    try {
      const data = await api.patch<ListPayload>(`/api/lists/${payload.list.id}`, {
        name,
        description,
        visibility,
        showRatings
      });
      appState.currentListPayload = data;
      appState.lists = appState.lists.map((list) =>
        list.id === data.list.id
          ? { ...list, name: data.list.name, visibility: data.list.visibility }
          : list
      );
      appState.notice = 'List settings saved.';
      onSaved?.();
    } catch (err) {
      saveError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<form class="owner-settings" onsubmit={save}>
  <label>
    <span class="label">List name</span>
    <input bind:value={name} required maxlength="80" />
  </label>
  <label>
    <span class="label">Description</span>
    <input bind:value={description} maxlength="500" />
  </label>
  <label>
    <span class="label">Visibility</span>
    <select bind:value={visibility}>
      <option value="private">Private</option>
      <option value="unlisted">Unlisted</option>
      <option value="public">Public</option>
    </select>
  </label>
  <label>
    <span class="label">Ratings</span>
    <select bind:value={showRatings}>
      <option value={true}>Visible</option>
      <option value={false}>Hidden</option>
    </select>
  </label>
  {#if saveError}<div class="error-line">{saveError}</div>{/if}
  <div class="button-row">
    <IconButton icon="check" label={busy ? 'Saving…' : 'Save'} className="primary" type="submit" disabled={busy} />
  </div>
</form>

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
  }
</style>
