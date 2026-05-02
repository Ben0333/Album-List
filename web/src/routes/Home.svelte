<script lang="ts">
  import { appState } from '$lib/state.svelte';
  import { navigate } from '$lib/router.svelte';
  import GuestPage from './GuestPage.svelte';
  import Placeholder from './Placeholder.svelte';

  $effect(() => {
    if (!appState.user) return;
    const personal = appState.lists.find((list) => list.kind === 'personal') ?? appState.lists[0];
    if (personal) navigate(`/list/${personal.id}`, { replace: true });
  });
</script>

{#if appState.user}
  <Placeholder title="Loading…" note="Redirecting to your list." />
{:else}
  <GuestPage />
{/if}
