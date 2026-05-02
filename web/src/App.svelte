<script lang="ts">
  import { route, navigate } from '$lib/router.svelte';
  import { api } from '$lib/api';

  let health = $state<string>('…');

  $effect(() => {
    api.get<{ ok: boolean; database: string }>('/api/health')
      .then((data) => (health = data.ok ? `ok (db ${data.database})` : 'not ok'))
      .catch((err: unknown) => (health = `error: ${(err as Error).message}`));
  });
</script>

<main>
  <h1>Albums to Listen To</h1>
  <p>Svelte scaffold is up. Frontend port pending.</p>
  <p>Current path: <code>{route.path}</code></p>
  <p>Server health: <code>{health}</code></p>
  <p>
    <button onclick={() => navigate('/explore')}>navigate /explore</button>
    <button onclick={() => navigate('/')}>navigate /</button>
  </p>
</main>

<style>
  main {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 40rem;
    margin: 4rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 {
    margin-bottom: 0.5rem;
  }
  button {
    font: inherit;
    padding: 0.4rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid currentColor;
    background: transparent;
    cursor: pointer;
  }
  button + button {
    margin-left: 0.5rem;
  }
</style>
