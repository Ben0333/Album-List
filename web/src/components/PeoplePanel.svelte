<script lang="ts">
  import { api, getErrorMessage } from '$lib/api';
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

  const completedByMember = $derived.by(() => {
    const counts = new Map<number, number>();
    for (const album of payload.albums) {
      for (const c of album.completions) {
        counts.set(c.userId, (counts.get(c.userId) ?? 0) + 1);
      }
    }
    return counts;
  });

  function canRemoveMember(member: Member): boolean {
    if (!appState.user || payload.list.kind !== 'collab') return false;
    if (member.userId === payload.list.ownerUserId) {
      return member.userId === appState.user.id;
    }
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
      panelError = getErrorMessage(err);
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
      <span>{completedByMember.get(member.userId) ?? 0}/{payload.albums.length} listened</span>
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
