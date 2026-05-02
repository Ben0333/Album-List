<script lang="ts">
  import { api, getErrorMessage } from '$lib/api';
  import { appState, persistChatOpen, persistChatReadIds } from '$lib/state.svelte';
  import type { ListPayload } from '$lib/types';
  import IconButton from './IconButton.svelte';
  import Avatar from './Avatar.svelte';

  interface Props {
    payload: ListPayload;
    onPayloadUpdate: (next: ListPayload) => void;
  }

  let { payload, onPayloadUpdate }: Props = $props();
  let draft = $state<string>('');
  let sending = $state<boolean>(false);
  let chatError = $state<string>('');

  const listKey = $derived(String(payload.list.id));
  const lastReadId = $derived(appState.chatReadIds[listKey] ?? 0);

  function latestMessageId(): number {
    if (!payload.messages.length) return 0;
    return Math.max(...payload.messages.map((m) => Number(m.id) || 0));
  }

  $effect(() => {
    const id = latestMessageId();
    if (appState.chatReadIds[listKey] === id) return;
    appState.chatReadIds[listKey] = id;
    persistChatReadIds();
  });

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body || sending) return;
    sending = true;
    chatError = '';
    try {
      const data = await api.post<ListPayload>(`/api/lists/${payload.list.id}/messages`, { body });
      onPayloadUpdate(data);
      draft = '';
    } catch (err) {
      chatError = getErrorMessage(err);
    } finally {
      sending = false;
    }
  }

  function close(): void {
    appState.chatOpen = false;
    persistChatOpen(false);
  }

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return iso;
    }
  }
</script>

<aside class="chat-panel">
  <div class="chat-head">
    <strong>Chat</strong>
    <div>
      <IconButton icon="x" label="Close" className="icon-button" onclick={close} />
    </div>
  </div>
  <div class="chat-body">
    {#if !payload.messages.length}
      <div class="empty-minimal small">No messages yet.</div>
    {:else}
      {#each payload.messages as message (message.id)}
        <div class="chat-message" class:unread={Number(message.id) > lastReadId}>
          <Avatar member={message} />
          <div>
            <strong>{message.username}</strong>
            <small>{formatTime(message.createdAt)}</small>
            <p>{message.body}</p>
          </div>
        </div>
      {/each}
    {/if}
  </div>
  {#if chatError}<div class="error-line">{chatError}</div>{/if}
  <form
    class="chat-form"
    onsubmit={(event) => {
      event.preventDefault();
      send();
    }}
  >
    <textarea
      bind:value={draft}
      placeholder="Type a message..."
      maxlength="800"
      rows="2"
      onkeydown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      }}
    ></textarea>
    <IconButton icon="send" label="Send" className="primary" disabled={sending || !draft.trim()} type="submit" />
  </form>
</aside>

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
    padding: 0 0.5rem;
  }
  .unread {
    border-left: 2px solid var(--blue);
    padding-left: 0.5rem;
  }
</style>
