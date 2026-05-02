<script lang="ts">
  interface Props {
    title: string;
    note?: string;
  }
  let { title, note }: Props = $props();
</script>

<main class="page-shell">
  <h1>{title}</h1>
  <div class="empty-minimal">
    {note ?? 'This page has not been ported to the Svelte frontend yet.'}
  </div>
  <p class="soft-line">
    Set <code>LEGACY_FRONTEND=1</code> on the server to view the original UI while the port is in progress.
  </p>
</main>
