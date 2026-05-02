import { appState, persistGuest } from './state.svelte';
import type { GuestAlbum } from './types';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `g_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function addGuestAlbum(album: Omit<GuestAlbum, 'id' | 'completed'> & { completed?: boolean }): GuestAlbum {
  const next: GuestAlbum = {
    id: newId(),
    title: album.title,
    artist: album.artist,
    coverUrl: album.coverUrl ?? null,
    tracks: album.tracks ?? [],
    completed: Boolean(album.completed)
  };
  appState.guest = { albums: [...appState.guest.albums, next] };
  persistGuest();
  return next;
}

export function toggleGuestCompleted(id: string): void {
  appState.guest = {
    albums: appState.guest.albums.map((a) => (a.id === id ? { ...a, completed: !a.completed } : a))
  };
  persistGuest();
}

export function removeGuestAlbum(id: string): void {
  appState.guest = { albums: appState.guest.albums.filter((a) => a.id !== id) };
  persistGuest();
}
