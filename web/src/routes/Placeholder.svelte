<script lang="ts">
  interface Props {
    title: string;
    note?: string;
  }
  let { title, note }: Props = $props();

  const loadingTitle = $derived(title === 'Loading...');
  const defaultLoadingNote = $derived(note === undefined);
</script>

<main class="page-shell">
  <h1>
    {#if loadingTitle}
      <span class="loading-copy" aria-label="Loading">
        Loading<span class="loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
      </span>
    {:else}
      {title}
    {/if}
  </h1>
  <div class="empty-minimal">
    {#if defaultLoadingNote}
      <span class="loading-copy" aria-label="Loading">
        Loading<span class="loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
      </span>
    {:else}
      {note}
    {/if}
  </div>
</main>

<style>
  .loading-copy {
    display: inline-flex;
    align-items: baseline;
  }

  .loading-dots {
    display: inline-flex;
    width: 0.9em;
  }

  .loading-dots span {
    animation: loading-dot-blink 1.2s ease-in-out infinite;
  }

  .loading-dots span:nth-child(2) {
    animation-delay: 0.18s;
  }

  .loading-dots span:nth-child(3) {
    animation-delay: 0.36s;
  }

  @keyframes loading-dot-blink {
    0%,
    20% {
      opacity: 0.18;
    }

    45%,
    75% {
      opacity: 1;
    }

    100% {
      opacity: 0.18;
    }
  }
</style>
