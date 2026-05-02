<script lang="ts">
  import { ApiError, getErrorMessage } from '$lib/api';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  export interface UserResult {
    id: number;
    username: string;
    avatarColor: string | null;
    avatarUrl: string | null;
  }

  interface Props {
    excludeIds?: ReadonlySet<number>;
    onPick: (user: UserResult) => Promise<void> | void;
  }

  let { excludeIds, onPick }: Props = $props();
  let query = $state<string>('');
  let results = $state<UserResult[]>([]);
  let searching = $state<boolean>(false);
  let open = $state<boolean>(false);
  let pickError = $state<string>('');
  let timer: number | null = null;
  let abort: AbortController | null = null;
  let nonce = 0;

  $effect(() => {
    const value = query.trim();
    if (timer !== null) window.clearTimeout(timer);
    if (abort) abort.abort();
    abort = null;
    if (value.length < 2) {
      results = [];
      searching = false;
      return;
    }
    searching = true;
    open = true;
    const myNonce = ++nonce;
    timer = window.setTimeout(async () => {
      const controller = new AbortController();
      abort = controller;
      try {
        const url = `/api/users?q=${encodeURIComponent(value)}`;
        const res = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
        if (!res.ok) throw new ApiError(res.status, res.statusText, null);
        const data = (await res.json()) as { users: UserResult[] };
        if (myNonce !== nonce) return;
        results = data.users ?? [];
        searching = false;
      } catch (err) {
        if ((err as Error).name === 'AbortError' || myNonce !== nonce) return;
        pickError = (err as Error).message;
        results = [];
        searching = false;
      } finally {
        if (myNonce === nonce) abort = null;
      }
    }, 350);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  });

  async function pickUser(user: UserResult): Promise<void> {
    pickError = '';
    try {
      await onPick(user);
      query = '';
      results = [];
      open = false;
    } catch (err) {
      pickError = getErrorMessage(err);
    }
  }

  function onFocus(): void {
    if (results.length || searching) open = true;
  }

  function onBlur(event: FocusEvent): void {
    const next = event.relatedTarget as HTMLElement | null;
    if (next?.closest('[data-search-popup]')) return;
    window.setTimeout(() => (open = false), 150);
  }
</script>

<div class="search-wrap" data-search-scope="user">
  <label class="search-input">
    <Icon name="user-plus" />
    <input
      type="text"
      placeholder="Search users..."
      aria-label="Search users to invite"
      bind:value={query}
      onfocus={onFocus}
      onblur={onBlur}
      autocomplete="off"
    />
  </label>
  {#if open}
    <div class="user-results" data-search-popup>
      {#if searching}
        <div class="user-line muted">Searching…</div>
      {:else if !query || query.length < 2}
        {#if pickError}<div class="user-line muted">{pickError}</div>{/if}
      {:else if !results.length}
        <div class="user-line muted">No users found.</div>
      {:else}
        {#each results as user (user.id)}
          {@const already = excludeIds?.has(user.id) ?? false}
          <div class="user-line">
            <Avatar member={user} clickable={false} />
            <strong>{user.username}</strong>
            {#if already}
              <span class="pill done">Member</span>
            {:else}
              <button type="button" class="pill" onclick={() => pickUser(user)}>Invite</button>
            {/if}
          </div>
        {/each}
      {/if}
      {#if pickError}<div class="user-line muted">{pickError}</div>{/if}
    </div>
  {/if}
</div>
