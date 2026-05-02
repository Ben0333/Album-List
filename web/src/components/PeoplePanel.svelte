<script lang="ts">
  import { api, ApiError } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import { navigate } from '$lib/router.svelte';
  import { refreshMe } from '$lib/me';
  import type { ListPayload, ListSummary, Member } from '$lib/types';
  import Avatar from './Avatar.svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    payload: ListPayload;
    onPayloadUpdate: (next: ListPayload) => void;
  }

  let { payload, onPayloadUpdate }: Props = $props();
  let busy = $state<boolean>(false);
  let panelError = $state<string>('');

  function completedCount(member: Member): number {
    return payload.albums.filter((album) => album.completions.some((c) => c.userId === member.userId)).length;
  }

  function canRemoveMember(member: Member): boolean {
    if (!appState.user || payload.list.kind !== 'collab') return false;
    if (member.userId === payload.list.ownerUserId) return false;
    if (payload.permissions.canManage) return true;
    return member.userId === appState.user.id;
  }

  async function removeMember(member: Member): Promise<void> {
    if (busy) return;
    busy = true;
    panelError = '';
    try {
      const data = await api.delete<{ ok: boolean; lists: ListSummary[]; list: ListPayload | null }>(
        `/api/lists/${payload.list.id}/members/${member.userId}`
      );
      appState.lists = data.lists;
      if (data.list) {
        onPayloadUpdate(data.list);
        appState.notice = `Removed ${member.username}.`;
      } else {
        appState.notice = 'You left the list.';
        await refreshMe();
        navigate('/');
      }
    } catch (err) {
      panelError = err instanceof ApiError ? err.message : (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="people-panel">
  {#if panelError}<div class="error-line">{panelError}</div>{/if}
  {#each payload.members as member (member.userId)}
    <div class="person-line">
      <Avatar member={member} />
      <strong>{member.username}</strong>
      <span>{completedCount(member)}/{payload.albums.length} listened</span>
      <span>{member.role}</span>
      {#if canRemoveMember(member)}
        <IconButton
          icon="x"
          label={appState.user?.id === member.userId ? 'Leave' : 'Remove'}
          className="icon-button danger"
          disabled={busy}
          onclick={() => removeMember(member)}
        />
      {/if}
    </div>
  {/each}
</section>

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
  }
</style>
