<script lang="ts">
  import IconButton from './IconButton.svelte';

  interface Props {
    message: string;
    onDismiss: () => void;
  }

  let { message, onDismiss }: Props = $props();
</script>

<div class="toast">
  <span>{message}</span>
  <IconButton icon="x" label="Dismiss" className="icon-button" onclick={onDismiss} />
</div>
