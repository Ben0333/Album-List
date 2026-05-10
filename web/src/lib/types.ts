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
  inviter: { username: string; avatarColor?: string | null; avatarUrl?: string | null };
  role: 'editor' | 'viewer';
  createdAt: string;
}

export interface MePayload {
  user: User | null;
  lists: ListSummary[];
  invites: InviteSummary[];
}

export interface GuestAlbum {
  id: string;
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

export interface Member {
  userId: number;
  username: string;
  role: 'owner' | 'editor' | 'viewer';
  avatarColor: string | null;
  avatarUrl: string | null;
}

export interface AlbumCompletion {
  userId: number;
  completedAt: string;
}

export interface TrackRating {
  rating: number;
  includeInAverage: boolean;
  updatedAt: string;
}

export interface AlbumTrack {
  id: number;
  title: string;
  discNumber: number;
  position: number;
  trackKey: string;
  userRating: TrackRating | null;
  aggregate: { average: number | null; count: number } | null;
  sharedAggregate: { average: number | null; count: number } | null;
}

export interface AlbumHydrationStatus {
  metadataStatus: 'missing' | 'queued' | 'hydrating' | 'complete' | 'failed' | 'stale';
  coverStatus: 'missing' | 'queued' | 'hydrating' | 'complete' | 'failed' | 'stale';
  trackStatus: 'missing' | 'queued' | 'hydrating' | 'complete' | 'failed' | 'stale';
  metadataUpdatedAt?: string | null;
  coverUpdatedAt?: string | null;
  tracksUpdatedAt?: string | null;
  lastError?: string;
}

export interface AlbumLibraryRef {
  listId: number;
  albumId: number;
  average: number | null;
  ratingCount: number;
}

export interface ListAlbum {
  id: number;
  albumKey: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  externalUrl: string | null;
  notes: string;
  sortOrder: number;
  createdBy: number | null;
  creatorUsername: string | null;
  createdAt: string;
  updatedAt: string;
  tracks: AlbumTrack[];
  hydrationStatus?: AlbumHydrationStatus;
  hydrationPending?: boolean;
  completions: AlbumCompletion[];
  pendingMembers: Member[];
  currentUserCompleted: boolean;
  currentUserFullyRated: boolean;
  currentUserAverageOptIn: boolean;
  currentUserAlbumRating: TrackRating | null;
  currentUserAggregate: { average: number | null; count: number } | null;
  currentUserRemovalVoted: boolean;
  removalVoteCount: number;
  removalVoteThreshold: number;
  currentUserLibrary: AlbumLibraryRef | null;
  aggregate: { average: number | null; count: number } | null;
  sharedAggregate: { average: number | null; count: number } | null;
  ratingsByUser: Array<{
    userId: number;
    username: string;
    avatarColor: string | null;
    avatarUrl: string | null;
    trackKey: string;
    trackTitle: string;
    rating: number;
    includeInAverage: boolean;
    updatedAt: string;
  }>;
}

export interface AlbumDetail {
  albumKey: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  externalUrl: string | null;
  tracks: AlbumTrack[];
  hydrationStatus?: AlbumHydrationStatus;
  hydrationPending?: boolean;
  currentUserCompleted: boolean;
  currentUserFullyRated: boolean;
  currentUserAverageOptIn: boolean;
  currentUserAlbumRating: TrackRating | null;
  currentUserAggregate: { average: number | null; count: number } | null;
  currentUserLibrary: AlbumLibraryRef | null;
  aggregate: { average: number | null; count: number } | null;
}

export interface AlbumDetailPayload {
  album: AlbumDetail;
}

export interface ListSummaryFull {
  id: number;
  ownerUserId: number;
  kind: 'personal' | 'collab';
  name: string;
  description: string;
  visibility: 'private' | 'unlisted' | 'public';
  shareToken: string;
  inviteToken: string;
  showRatings: boolean;
  createdAt: string;
  updatedAt: string;
  ownerUsername?: string;
  albumCount?: number;
  memberCount?: number;
}

export interface ChatMessage {
  id: number;
  userId: number;
  username: string;
  avatarColor: string | null;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
}

export interface ListPermissions {
  canEdit: boolean;
  canManage: boolean;
  canRate: boolean;
  isMember: boolean;
}

export interface ListPayload {
  revision: string;
  list: ListSummaryFull;
  permissions: ListPermissions;
  members: Member[];
  albums: ListAlbum[];
  messages: ChatMessage[];
}

export interface NotModifiedPayload {
  notModified: true;
  revision: string;
}

export interface ExploreListSummary {
  slug: string;
  name: string;
  description: string;
  sourceUrl?: string;
  albumCount: number;
}

export interface ExploreAlbum {
  albumKey?: string;
  title: string;
  artist: string;
  releaseYear: number | null;
  coverUrl: string | null;
  spotifyAlbumId?: string | null;
  currentUserCompleted?: boolean;
  currentUserAlbumRating?: TrackRating | null;
  currentUserRatingAverage?: number | null;
  currentUserRatingCount?: number;
}

export interface ExploreList extends ExploreListSummary {
  albums: ExploreAlbum[];
}

export interface PopularList {
  id: number;
  name: string;
  description: string;
  ownerUsername: string;
  albumCount: number;
  memberCount: number;
  listenCount: number;
  visibility: 'public' | 'unlisted' | 'private';
  shareToken: string;
}

export interface ExploreIndexPayload {
  lists: ExploreListSummary[];
  popularLists: PopularList[];
}

export interface ExploreDetailPayload {
  list: ExploreList;
}

export interface ProfileListSummary {
  id: number;
  name: string;
  description: string;
  visibility: 'private' | 'unlisted' | 'public';
  albumCount: number;
  memberCount: number;
}

export interface ProfileAlbum {
  albumKey: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  completedAt: string | null;
  ratedAt: string | null;
  fullyListened: boolean;
  average: number | null;
  ratingCount: number;
  ratings: Array<{
    trackKey: string;
    trackTitle: string;
    rating: number;
    includeInAverage: boolean;
    updatedAt: string;
  }>;
  inCommon: boolean;
}

export interface ProfilePayload {
  user: User;
  lists: ProfileListSummary[];
  ratedAlbums: ProfileAlbum[];
}

export interface HistoryCompletion {
  completedAt: string;
  albumKey: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  listName: string;
  aggregate: { average: number | null; count: number } | null;
  myRatings: Array<{
    trackKey: string;
    trackTitle: string;
    rating: number;
    includeInAverage: boolean;
    updatedAt: string;
  }>;
}

export interface HistoryPayload {
  user: User;
  completions: HistoryCompletion[];
}
