<script lang="ts">
  interface Props {
    title: string;
    note?: string;
  }
  let { title, note }: Props = $props();
</script>

<main class="page-shell">
  <h1>{title}</h1>
  <div class="empty-minimal">{note ?? 'Loading...'}</div>
</main>
