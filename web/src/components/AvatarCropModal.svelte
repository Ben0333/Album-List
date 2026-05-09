<script lang="ts">
  import { api, getErrorMessage } from '$lib/api';
  import { appState } from '$lib/state.svelte';
  import { composeAvatar } from '$lib/avatar';
  import type { User } from '$lib/types';
  import IconButton from './IconButton.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();
  let saving = $state<boolean>(false);
  let cropError = $state<string>('');

  const crop = $derived(appState.avatarCrop);

  function setZoom(value: number): void {
    if (!appState.avatarCrop) return;
    appState.avatarCrop = { ...appState.avatarCrop, zoom: value };
  }
  function setX(value: number): void {
    if (!appState.avatarCrop) return;
    appState.avatarCrop = { ...appState.avatarCrop, x: value };
  }
  function setY(value: number): void {
    if (!appState.avatarCrop) return;
    appState.avatarCrop = { ...appState.avatarCrop, y: value };
  }

  async function save(): Promise<void> {
    if (!appState.avatarCrop || saving) return;
    saving = true;
    cropError = '';
    try {
      const dataUrl = await composeAvatar(
        appState.avatarCrop.dataUrl,
        appState.avatarCrop.zoom,
        appState.avatarCrop.x,
        appState.avatarCrop.y
      );
      const data = await api.patch<{ user: User }>('/api/me', { avatarDataUrl: dataUrl });
      appState.user = data.user;
      appState.notice = 'Profile photo saved.';
      onClose();
    } catch (err) {
      cropError = getErrorMessage(err);
    } finally {
      saving = false;
    }
  }
</script>

{#if crop}
  <div class="modal-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && onClose()}>
    <section class="settings-modal crop-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <strong>Crop profile photo</strong>
        <IconButton icon="x" label="Close" className="icon-button" onclick={onClose} />
      </div>
      <div class="crop-frame" data-crop-frame>
        <img
          src={crop.dataUrl}
          alt=""
          style="width:{crop.zoom * 100}%; height:{crop.zoom * 100}%; object-position:{50 + crop.x / 2}% {50 + crop.y / 2}%;"
        />
      </div>
      <div class="crop-controls">
        <label>
          <span class="label">Zoom</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.05"
            value={crop.zoom}
            oninput={(event) => setZoom(Number((event.currentTarget as HTMLInputElement).value))}
          />
        </label>
        <label>
          <span class="label">Left / right</span>
          <input
            type="range"
            min="-100"
            max="100"
            step="1"
            value={crop.x}
            oninput={(event) => setX(Number((event.currentTarget as HTMLInputElement).value))}
          />
        </label>
        <label>
          <span class="label">Up / down</span>
          <input
            type="range"
            min="-100"
            max="100"
            step="1"
            value={crop.y}
            oninput={(event) => setY(Number((event.currentTarget as HTMLInputElement).value))}
          />
        </label>
      </div>
      {#if cropError}<div class="error-line">{cropError}</div>{/if}
      <div class="button-row left">
        <IconButton icon="check" label={saving ? 'Saving...' : 'Save photo'} className="primary" disabled={saving} onclick={save} />
        <IconButton icon="x" label="Cancel" onclick={onClose} />
      </div>
    </section>
  </div>
{/if}

<style>
  .error-line {
    color: var(--danger);
    font-size: 0.9em;
    padding: 0 0.5rem;
  }
</style>
