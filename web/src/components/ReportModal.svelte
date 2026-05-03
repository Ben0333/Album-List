<script lang="ts">
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();
  let body = $state<string>('');
  let website = $state<string>('');
  let saving = $state<boolean>(false);
  let reportError = $state<string>('');
  const openedAt = Date.now();

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const text = body.trim();
    if (text.length < 10) {
      reportError = 'Tell us a little more about the bug.';
      return;
    }
    saving = true;
    reportError = '';
    try {
      await api.post('/api/reports', {
        body: text,
        path: `${window.location.pathname}${window.location.search}`,
        openedAt,
        website
      });
      appState.notice = 'Bug report sent.';
      onClose();
    } catch (err) {
      reportError = getErrorMessage(err);
    } finally {
      saving = false;
    }
  }

  function backdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }
</script>

<div class="modal-backdrop" onclick={backdropClick} role="presentation">
  <div class="settings-modal report-modal" role="dialog" aria-modal="true" aria-labelledby="report-title">
    <div class="modal-head">
      <strong id="report-title">Report a bug</strong>
      <IconButton icon="x" label="Close" className="icon-button" onclick={onClose} />
    </div>
    <form class="report-form" onsubmit={submit}>
      <label>
        <span class="label">What broke?</span>
        <textarea
          bind:value={body}
          minlength="10"
          maxlength="2000"
          rows="7"
          placeholder="What happened, what you clicked, and what you expected..."
          required
        ></textarea>
      </label>
      <label class="report-honeypot" aria-hidden="true">
        <span>Website</span>
        <input bind:value={website} tabindex="-1" autocomplete="off" />
      </label>
      {#if reportError}<div class="error-line">{reportError}</div>{/if}
      <div class="button-row left tight">
        <IconButton
          icon="flag"
          label={saving ? 'Sending...' : 'Send report'}
          className="primary report-submit"
          type="submit"
          disabled={saving || body.trim().length < 10}
        />
      </div>
    </form>
  </div>
</div>

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
  }
</style>
