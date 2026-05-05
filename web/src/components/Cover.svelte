<script lang="ts">
  import { initials } from '$lib/initials';

  interface Props {
    title: string;
    coverUrl?: string | null;
    size?: 'normal' | 'tiny';
  }

  let { title, coverUrl, size = 'normal' }: Props = $props();

  const className = $derived(size === 'tiny' ? 'tiny-cover' : 'cover');
  let failedUrl = $state<string | null>(null);
  const usableCoverUrl = $derived(coverUrl && failedUrl !== coverUrl ? coverUrl : '');

  function markFailed(): void {
    failedUrl = coverUrl || null;
  }
</script>

{#if usableCoverUrl}
  {#if size === 'tiny'}
    <img class="tiny-cover" src={usableCoverUrl} alt="" loading="lazy" onerror={markFailed} />
  {:else}
    <div class="cover">
      <img src={usableCoverUrl} alt="" loading="lazy" onerror={markFailed} />
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
