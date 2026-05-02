<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from '$lib/icons';

  interface Props {
    icon: IconName;
    label: string;
    title?: string;
    className?: string;
    badge?: string | number | null;
    active?: boolean;
    type?: 'button' | 'submit';
    disabled?: boolean;
    onclick?: (event: MouseEvent) => void;
    children?: Snippet;
  }

  let {
    icon,
    label,
    title,
    className = 'text-button',
    badge = null,
    active = false,
    type = 'button',
    disabled = false,
    onclick,
    children
  }: Props = $props();
</script>

<button
  class="{className} icon-text-button{active ? ' active' : ''}"
  {type}
  {disabled}
  title={title ?? label}
  {onclick}
>
  <Icon name={icon} />
  <span class="button-label">{label}</span>
  {#if badge !== null && badge !== undefined && badge !== '' && badge !== 0}
    <span class="button-badge">{badge}</span>
  {/if}
  {@render children?.()}
</button>
