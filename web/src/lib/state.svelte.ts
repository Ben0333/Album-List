import type { GuestState, InviteSummary, ListSummary, ThemePreference, User } from './types';

const GUEST_KEY = 'albums_guest_v2';
const OLD_GUEST_KEY = 'albums_guest_v1';
const THEME_KEY = 'albums_theme_preference_v1';

function loadGuest(): GuestState {
  for (const key of [GUEST_KEY, OLD_GUEST_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.albums)) return parsed as GuestState;
    } catch {
      // fall through to next candidate
    }
  }
  return { albums: [] };
}

function loadThemePreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'retro' || stored === 'system') return stored;
  return 'system';
}

export interface AppState {
  user: User | null;
  lists: ListSummary[];
  invites: InviteSummary[];
  guest: GuestState;
  themePreference: ThemePreference;
  authMode: 'login' | 'register';
  selectedPlatform: 'spotify' | 'youtube_music' | 'apple_music' | 'tidal' | 'soundcloud' | 'bandcamp' | 'deezer' | 'na';
  notice: string;
  error: string;
  settingsOpen: boolean;
}

export const appState: AppState = $state({
  user: null,
  lists: [],
  invites: [],
  guest: loadGuest(),
  themePreference: loadThemePreference(),
  authMode: 'login',
  selectedPlatform: 'na',
  notice: '',
  error: '',
  settingsOpen: false
});

export function persistTheme(theme: ThemePreference): void {
  localStorage.setItem(THEME_KEY, theme);
}

export function persistGuest(): void {
  localStorage.setItem(GUEST_KEY, JSON.stringify(appState.guest));
}

export function clearGuest(): void {
  appState.guest = { albums: [] };
  localStorage.removeItem(GUEST_KEY);
  localStorage.removeItem(OLD_GUEST_KEY);
}

export function buildGuestImport(): { albums: GuestState['albums'] } | null {
  if (!appState.guest.albums.length) return null;
  return { albums: appState.guest.albums };
}
