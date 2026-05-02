<script lang="ts">
  import { initials } from '$lib/initials';
  import { navigate } from '$lib/router.svelte';

  interface Member {
    username: string;
    avatarUrl?: string | null;
    avatarColor?: string | null;
  }

  interface Props {
    member: Member;
    complete?: boolean;
    clickable?: boolean;
  }

  let { member, complete = true, clickable = true }: Props = $props();

  const klass = $derived(`avatar ${complete ? '' : 'pending'}`);
  const bg = $derived(member.avatarColor || '#2563eb');

  function open(): void {
    navigate(`/u/${encodeURIComponent(member.username)}`);
  }
</script>

{#if clickable && member.username}
  <button class={klass} style:background={bg} title={member.username} onclick={open}>
    {#if member.avatarUrl}
      <img src={member.avatarUrl} alt="" />
    {:else}
      {initials(member.username).slice(0, 2)}
    {/if}
  </button>
{:else}
  <span class={klass} style:background={bg} title={member.username}>
    {#if member.avatarUrl}
      <img src={member.avatarUrl} alt="" />
    {:else}
      {initials(member.username).slice(0, 2)}
    {/if}
  </span>
{/if}
