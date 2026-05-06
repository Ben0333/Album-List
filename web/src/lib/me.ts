import { api } from './api';
import { appState, persistRetroThemeUnlocked, persistTheme } from './state.svelte';
import { applyAccent, applyTheme } from './theme';
import type { MePayload } from './types';

export async function refreshMe(): Promise<void> {
  const data = await api.get<MePayload>('/api/me');
  appState.user = data.user;
  appState.lists = data.lists ?? [];
  appState.invites = data.invites ?? [];
  if (appState.user) {
    appState.themePreference = appState.user.themePreference || 'system';
    if (appState.themePreference === 'retro') {
      appState.retroThemeUnlocked = true;
      persistRetroThemeUnlocked(true);
    }
    persistTheme(appState.themePreference);
    applyTheme(appState.themePreference);
    applyAccent(appState.user.accentColor);
  } else {
    applyAccent(null);
  }
}
