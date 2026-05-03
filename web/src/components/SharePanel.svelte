<script lang="ts">
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import { navigate } from '$lib/router.svelte';
  import { copyText } from '$lib/clipboard';
  import { refreshMe } from '$lib/me';
  import type { ListPayload, ListSummary, Member } from '$lib/types';
  import IconButton from './IconButton.svelte';
  import Avatar from './Avatar.svelte';
  import UserSearch from './UserSearch.svelte';

  interface Props {
    payload: ListPayload;
    onPayloadUpdate: (next: ListPayload) => void;
  }

  let { payload, onPayloadUpdate }: Props = $props();
  let role = $state<'editor' | 'viewer'>('editor');
  let busy = $state<boolean>(false);
  let panelError = $state<string>('');

  const canInvite = $derived(payload.permissions.canManage && payload.list.kind === 'collab');
  const memberIds = $derived<ReadonlySet<number>>(new Set(payload.members.map((m) => m.userId)));
  const shareUrl = $derived(`${window.location.origin}/share/${payload.list.shareToken}`);

  async function copyShareLink(): Promise<void> {
    panelError = '';
    if (payload.list.visibility === 'private' && payload.permissions.canManage) {
      try {
        const data = await api.post<ListPayload>(`/api/lists/${payload.list.id}/share/publish`);
        onPayloadUpdate(data);
      } catch (err) {
        panelError = getErrorMessage(err);
        return;
      }
    }
    const ok = await copyText(shareUrl);
    if (ok) appState.notice = 'Share link copied.';
    else panelError = 'Could not copy link. Highlight and copy manually.';
  }

  async function inviteUser(user: { id: number; username: string }): Promise<void> {
    if (busy) return;
    busy = true;
    panelError = '';
    try {
      await api.post(`/api/lists/${payload.list.id}/invites`, { identifier: user.username, role });
      appState.notice = `Invite sent to ${user.username}.`;
    } catch (err) {
      panelError = getErrorMessage(err);
    } finally {
      busy = false;
    }
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

  function canRemoveMember(member: Member): boolean {
    if (!appState.user || payload.list.kind !== 'collab') return false;
    if (member.userId === payload.list.ownerUserId) {
      return member.userId === appState.user.id;
    }
    if (payload.permissions.canManage) return true;
    return member.userId === appState.user.id;
  }
</script>

<section class="share-panel">
  <div class="share-head">
    <div>
      <strong>Share {payload.list.name}</strong>
      <span>Anyone with the link can view. Members can do more.</span>
    </div>
    <IconButton icon="copy" label="Copy link" className="primary" onclick={copyShareLink} />
  </div>
  {#if panelError}<div class="error-line">{panelError}</div>{/if}
  {#if canInvite}
    <div class="share-search">
      <UserSearch excludeIds={memberIds} onPick={inviteUser} />
      <select bind:value={role}>
        <option value="editor">Editor</option>
        <option value="viewer">Viewer</option>
      </select>
    </div>
  {/if}
  <div class="member-list">
    {#each payload.members as member (member.userId)}
      <div class="user-line">
        <Avatar member={member} />
        <strong>{member.username}</strong>
        <span>{member.role}</span>
        {#if canRemoveMember(member)}
          <IconButton
            icon="x"
            label={appState.user?.id === member.userId ? 'Leave list' : 'Remove member'}
            className="icon-button danger"
            disabled={busy}
            onclick={() => removeMember(member)}
          />
        {/if}
      </div>
    {/each}
  </div>
</section>

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
    margin: 0.5rem 0;
  }
</style>
