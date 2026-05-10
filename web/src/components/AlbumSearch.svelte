<script lang="ts">
  import { ApiError, getErrorMessage } from '$lib/api';
  import Cover from './Cover.svelte';
  import Icon from './Icon.svelte';

  export interface Suggestion {
    providerId: string;
    title: string;
    artist: string;
    releaseYear: number | null;
    coverUrl: string | null;
  }

  export interface AlbumDetail {
    providerId?: string;
    title: string;
    artist: string;
    coverUrl: string | null;
    tracks: Array<{ title: string }>;
  }

  interface Props {
    enabled?: boolean;
    onPick: (album: AlbumDetail, suggestion: Suggestion) => Promise<void> | void;
  }

  let { enabled = true, onPick }: Props = $props();
  let query = $state<string>('');
  let suggestions = $state<Suggestion[]>([]);
  let searching = $state<boolean>(false);
  let open = $state<boolean>(false);
  let adding = $state<boolean>(false);
  let lastError = $state<string>('');
  let timer: number | null = null;
  let abort: AbortController | null = null;
  let nonce = 0;

  $effect(() => {
    const value = query.trim();
    if (timer !== null) window.clearTimeout(timer);
    if (abort) abort.abort();
    abort = null;
    if (value.length < 2) {
      suggestions = [];
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
        const url = `/api/albums/search?q=${encodeURIComponent(value)}`;
        const res = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
        if (!res.ok) throw new ApiError(res.status, res.statusText, null);
        const data = (await res.json()) as { results: Suggestion[] };
        if (myNonce !== nonce) return;
        suggestions = data.results ?? [];
        searching = false;
      } catch (err) {
        if ((err as Error).name === 'AbortError' || myNonce !== nonce) return;
        lastError = (err as Error).message;
        suggestions = [];
        searching = false;
      } finally {
        if (myNonce === nonce) abort = null;
      }
    }, 450);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  });

  async function pickSuggestion(suggestion: Suggestion): Promise<void> {
    if (adding) return;
    adding = true;
    lastError = '';
    try {
      await onPick(
        {
          providerId: suggestion.providerId,
          title: suggestion.title,
          artist: suggestion.artist,
          coverUrl: suggestion.coverUrl,
          tracks: []
        },
        suggestion
      );
      query = '';
      suggestions = [];
      open = false;
    } catch (err) {
      lastError = getErrorMessage(err);
    } finally {
      adding = false;
    }
  }

  function onFocus(): void {
    if (suggestions.length || searching) open = true;
  }

  function onBlur(event: FocusEvent): void {
    const next = event.relatedTarget as HTMLElement | null;
    if (next?.closest('[data-search-popup]')) return;
    window.setTimeout(() => (open = false), 150);
  }

  function clearQuery(): void {
    query = '';
    suggestions = [];
    open = false;
  }

  function suggestionKey(suggestion: Suggestion, index: number): string {
    return `${suggestion.providerId || 'album'}:${index}`;
  }
</script>

{#if enabled}
  <div class="search-wrap" data-search-scope="album">
    <label class="search-input">
      <Icon name="plus" />
      <input
        type="text"
        placeholder="Add an album..."
        aria-label="Search albums to add"
        bind:value={query}
        onfocus={onFocus}
        onblur={onBlur}
        autocomplete="off"
      />
      {#if query}
        <button type="button" class="icon-button" title="Clear album search" onclick={clearQuery}>
          <Icon name="x" />
        </button>
      {/if}
    </label>
    {#if open}
      <div class="suggestions" data-search-popup>
        {#if searching}
          <div class="suggestion-empty">Searching...</div>
        {:else if !query || query.length < 2}
          {#if lastError}<div class="suggestion-empty">{lastError}</div>{/if}
        {:else if !suggestions.length}
          <div class="suggestion-empty">No albums found.</div>
        {:else}
          {#each suggestions as suggestion, index (suggestionKey(suggestion, index))}
            <button
              type="button"
              class="suggestion"
              disabled={adding}
              onclick={() => pickSuggestion(suggestion)}
            >
              <Cover title={suggestion.title} coverUrl={suggestion.coverUrl} size="tiny" />
              <span>
                <strong>{suggestion.title}</strong>
                <small>
                  {suggestion.artist || 'Unknown artist'}{suggestion.releaseYear ? ` - ${suggestion.releaseYear}` : ''}
                </small>
              </span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}
