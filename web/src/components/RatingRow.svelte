<script lang="ts">
  interface Props {
    current: number | null;
    disabled?: boolean;
    onpick: (rating: number) => void;
  }

  let { current, disabled = false, onpick }: Props = $props();
  const ratings = Array.from({ length: 11 }, (_, i) => i);
</script>

<div class="rating-row">
  {#each ratings as rating (rating)}
    <button
      type="button"
      class:active={current === rating}
      {disabled}
      onclick={() => onpick(rating)}
    >
      {rating}
    </button>
  {/each}
</div>
