<script lang="ts">
  import { router, navigate } from '$lib/router.svelte';
  import { api, ApiError } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import { refreshMe } from '$lib/me';
  import type { ListPayload } from '$lib/types';
  import IconButton from '../components/IconButton.svelte';

  let busy = $state<boolean>(false);
  let pageError = $state<string>('');

  async function join(): Promise<void> {
    if (busy) return;
    if (router.current.type !== 'invite') return;
    busy = true;
    pageError = '';
    try {
      const data = await api.post<ListPayload>(`/api/invites/${encodeURIComponent(router.current.token)}/join`);
      await refreshMe();
      appState.notice = `Joined "${data.list.name}".`;
      navigate(`/list/${data.list.id}`);
    } catch (err) {
      pageError = err instanceof ApiError ? err.message : (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="page-shell">
  <h1>Shared albums</h1>
  <div class="empty-minimal">
    {#if appState.user}
      <IconButton icon="check" label="Join list" className="primary" disabled={busy} onclick={join} />
    {:else}
      <IconButton icon="log-in" label="Sign in to join" className="primary" onclick={() => navigate('/login')} />
    {/if}
    {#if pageError}
      <div class="error-line">{pageError}</div>
    {/if}
  </div>
</main>

<style>
  .error-line {
    color: var(--danger);
    margin-top: 0.5rem;
  }
</style>
