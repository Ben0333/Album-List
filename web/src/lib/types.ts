export type ThemePreference = 'system' | 'light' | 'dark' | 'retro';

export type MusicPlatform =
  | 'spotify'
  | 'youtube_music'
  | 'apple_music'
  | 'tidal'
  | 'soundcloud'
  | 'bandcamp'
  | 'deezer'
  | 'na';

export interface User {
  id: number;
  username: string;
  email?: string;
  avatarColor: string;
  avatarUrl: string | null;
  musicPlatform: MusicPlatform;
  accentColor: string | null;
  themePreference: ThemePreference;
  historyToken?: string;
  historyVisibility?: 'private' | 'unlisted';
}

export interface ListSummary {
  id: number;
  kind: 'personal' | 'collab';
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  visibility: 'private' | 'unlisted' | 'public';
  unread?: number;
}

export interface InviteSummary {
  id: number;
  list: { id: number; name: string };
  inviter: { username: string };
  role: 'editor' | 'viewer';
  createdAt: string;
}

export interface MePayload {
  user: User | null;
  lists: ListSummary[];
  invites: InviteSummary[];
}

export interface GuestAlbum {
  title: string;
  artist: string;
  coverUrl: string | null;
  tracks: Array<{ title: string }>;
  completed: boolean;
}

export interface GuestState {
  albums: GuestAlbum[];
}

export interface AuthLoginInput {
  identifier: string;
  password: string;
  guestImport?: { albums: GuestAlbum[] } | null;
}

export interface AuthRegisterInput {
  username: string;
  email: string;
  password: string;
  musicPlatform: MusicPlatform;
  guestImport?: { albums: GuestAlbum[] } | null;
}

export interface AuthResponse {
  user: User;
  lists: ListSummary[];
  imported?: { count: number } | null;
}
