<script lang="ts">
  import { iconPath, type IconName } from '$lib/icons';

  interface Props {
    name: IconName;
    title?: string;
  }

  let { name, title }: Props = $props();
</script>

<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
  {#if title}<title>{title}</title>{/if}
  {@html iconPath(name)}
</svg>
