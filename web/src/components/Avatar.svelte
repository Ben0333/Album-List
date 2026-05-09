<script lang="ts">
  import { initials } from '$lib/initials';
  import { followInternalLink } from '$lib/router.svelte';

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

  const profilePath = $derived(`/u/${encodeURIComponent(member.username)}`);
</script>

{#if clickable && member.username}
  <a class={klass} style:background={bg} title={member.username} href={profilePath} onclick={(event) => followInternalLink(event, profilePath)}>
    {#if member.avatarUrl}
      <img src={member.avatarUrl} alt="" />
    {:else}
      {initials(member.username).slice(0, 2)}
    {/if}
  </a>
{:else}
  <span class={klass} style:background={bg} title={member.username}>
    {#if member.avatarUrl}
      <img src={member.avatarUrl} alt="" />
    {:else}
      {initials(member.username).slice(0, 2)}
    {/if}
  </span>
{/if}
