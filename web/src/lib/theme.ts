import type { ThemePreference } from './types';

const mediaDark = window.matchMedia('(prefers-color-scheme: dark)');

const themeCycle: ThemePreference[] = ['system', 'dark', 'light', 'retro'];

export function applyTheme(preference: ThemePreference): void {
  const resolved = preference === 'system' ? (mediaDark.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
}

export function applyAccent(color: string | null | undefined): void {
  const accent = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? (color as string) : '#1db954';
  document.documentElement.style.setProperty('--blue', accent);
  document.documentElement.style.setProperty('--blue-strong', accent);
}

export function nextTheme(current: ThemePreference): ThemePreference {
  return themeCycle[(themeCycle.indexOf(current) + 1) % themeCycle.length] ?? 'system';
}

export function themeIconName(preference: ThemePreference): 'moon' | 'sun' | 'system' {
  if (preference === 'dark') return 'moon';
  if (preference === 'light') return 'sun';
  if (preference === 'retro') return 'system';
  return mediaDark.matches ? 'moon' : 'sun';
}

export function watchSystemTheme(handler: () => void): () => void {
  mediaDark.addEventListener('change', handler);
  return () => mediaDark.removeEventListener('change', handler);
}
