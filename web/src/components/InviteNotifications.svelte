<script lang="ts">
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import { refreshMe } from '$lib/me';
  import type { InviteSummary, ListSummary } from '$lib/types';
  import IconButton from './IconButton.svelte';

  let busy = $state<boolean>(false);
  let panelError = $state<string>('');

  async function accept(invite: InviteSummary): Promise<void> {
    if (busy) return;
    busy = true;
    panelError = '';
    try {
      const data = await api.post<{ ok: boolean; lists: ListSummary[]; invites: InviteSummary[] }>(
        `/api/invitations/${invite.id}/accept`
      );
      appState.lists = data.lists;
      appState.invites = data.invites;
      await refreshMe();
      appState.notice = `Joined "${invite.list.name}".`;
    } catch (err) {
      panelError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function decline(invite: InviteSummary): Promise<void> {
    if (busy) return;
    busy = true;
    panelError = '';
    try {
      const data = await api.post<{ ok: boolean; invites: InviteSummary[] }>(
        `/api/invitations/${invite.id}/decline`
      );
      appState.invites = data.invites;
    } catch (err) {
      panelError = getErrorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

{#if appState.invites.length}
  <div>
    <span class="label">Invites</span>
    {#if panelError}<div class="error-line">{panelError}</div>{/if}
    <div class="invite-list">
      {#each appState.invites as invite (invite.id)}
        <div class="user-line">
          <strong>{invite.list.name}</strong>
          <span>by {invite.inviter.username} ({invite.role})</span>
          <IconButton
            icon="check"
            label="Accept"
            className="pill primary"
            disabled={busy}
            onclick={() => accept(invite)}
          />
          <IconButton
            icon="x"
            label="Decline"
            className="pill"
            disabled={busy}
            onclick={() => decline(invite)}
          />
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
  }
  .invite-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
</style>
