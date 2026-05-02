<script lang="ts">
  import { appState } from '$lib/state.svelte';
  import { navigate } from '$lib/router.svelte';

  interface Props {
    activeListId: number;
  }

  let { activeListId }: Props = $props();

  function pickList(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    navigate(`/list/${select.value}`);
  }
</script>

{#if appState.user && appState.lists.length}
  {#if appState.lists.length <= 5}
    <div class="list-switcher" aria-label="Switch list">
      {#each appState.lists as list (list.id)}
        <button class:active={list.id === activeListId} onclick={() => navigate(`/list/${list.id}`)}>
          {list.name}
        </button>
      {/each}
    </div>
  {:else}
    <select class="list-select" aria-label="Switch list" onchange={pickList} value={String(activeListId)}>
      {#each appState.lists as list (list.id)}
        <option value={list.id}>{list.name}</option>
      {/each}
    </select>
  {/if}
{/if}
