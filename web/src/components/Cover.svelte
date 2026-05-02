<script lang="ts">
  import { initials } from '$lib/initials';

  interface Props {
    title: string;
    coverUrl?: string | null;
    size?: 'normal' | 'tiny';
  }

  let { title, coverUrl, size = 'normal' }: Props = $props();

  const className = $derived(size === 'tiny' ? 'tiny-cover' : 'cover');
</script>

{#if coverUrl}
  {#if size === 'tiny'}
    <img class="tiny-cover" src={coverUrl} alt="" loading="lazy" />
  {:else}
    <div class="cover">
      <img src={coverUrl} alt="" loading="lazy" />
    </div>
  {/if}
{:else if size === 'tiny'}
  <span class="tiny-cover fallback">{initials(title)}</span>
{:else}
  <div class="cover fallback">{initials(title)}</div>
{/if}

<style>
  /* Inherits global .cover, .tiny-cover, .fallback styles. */
</style>
