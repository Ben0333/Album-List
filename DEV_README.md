# Developer Handoff

## Product Shape

This app is for album lists first. Song-only lists may exist later, but do not
build that now unless requested. Keep album URLs/routes generic enough that a
future `songs.` subdomain or parallel song mode could reuse the same
account/session/list patterns.

Core rules:

- Guests can create a practical local album list.
- Guest albums must transfer after signup/login.
- Accounts use username, email, and password, without email verification.
- Every account has one personal list.
- Every account can create unlimited collaborative lists.
- A user can be invited to unlimited collaborative lists.
- Collaborative behavior should feel like a modern document tool: owner/editor/viewer roles, account-targeted invites, share links, and private/unlisted/public visibility.
- Invites are notification-style records. Do not make invite links the primary joining flow.
- Collaborative lists have closeable right-side chat with unread counts and timestamps.
- Collaborative pages use short polling for live album, rating, listened, removal-vote, and chat updates. Keep this simple unless a real websocket/SSE need appears.
- Collaborative album removal requires votes from at least one quarter of members.
- Collaborative members can leave shared lists; owners can remove non-owner members.
- Ratings and shared listening state are logged-in features.
- Track ratings are 0-10 and roll up to album averages when the user opts in; individual track ratings can also be excluded from averages.
- Ratings are reusable across lists by normalized `album_key` and `track_key`.
- Listened/completed state is reusable per user/album, not only per list row.
- Recommendations use a local rating-based algorithm. Endpoint exists; not currently surfaced in the UI.
- Rating every track on a listed album auto-completes that album for the current user.
- Rated/completed album activity persists independently of list rows.
- Themes: light, dark, and a late-90s easter egg theme.
- Accent color derives from `users.music_platform` unless `users.accent_color` is set.

## Architecture

```
server/                      Express JSON API
  src/server.js              public Express app: auth/session, REST routes, list/rating/history logic
  src/explore-data.js        static curated explore-list data
web/                         Svelte 5 + Vite + TypeScript SPA
  src/App.svelte             route dispatcher
  src/main.ts                mount entry, imports global styles.css
  src/styles.css             global theme + layout (ported from the original vanilla UI)
  src/lib/                   shared modules: api client, router, state, theme, types, etc.
  src/components/            reusable UI (Avatar, AlbumRow, ChatPanel, SettingsModal, ...)
  src/routes/                page components (Login, ListPage, AlbumPage, ExplorePage, ...)
shared/                      @albums/shared workspace
  src/db.js                  SQLite connection, schema, normalization helpers, transactions
  src/config.js              environment config + production safety checks
data/albums.sqlite           local DB, gitignored
```

The server serves `web/dist/` as static assets in production, with a `*` SPA
fallback so client-side routes (`/list/:id`, `/u/:username`, etc.) refresh
correctly. Vite handles hashed asset filenames; the Express static middleware
sets `immutable` cache headers on `assets/*` and `no-cache` on `index.html`.

In dev, run `npm run dev` to start both Vite (port 5173) and the API server
(port 3000). Vite proxies `/api` and `/u` to the API server.

## Security and Deployment Notes

- Production startup validation lives in `shared/src/config.js`. With
  `NODE_ENV=production`, the app requires a public `https://` `APP_ORIGIN`,
  `COOKIE_SECURE=true`, and an explicit persistent `DATABASE_PATH`.
- Session cookies are HTTP-only, same-site `lax`, and secure when
  `COOKIE_SECURE=true`.
- Mutating `/api` requests are same-origin protected with `Origin` and Fetch
  Metadata checks. Keep new write endpoints under `/api` so this middleware
  applies.
- `helmet` sets security headers and CSP. Current CSP allows same-origin
  scripts/connections, inline styles (Vite emits some), and images from
  `self`, `data:`, and `https:`.
- Rate limits are process-local maps. Acceptable for one Node process; use a
  shared limiter before running multiple instances.
- User search supports partial username search; email matching is exact-only
  to reduce email enumeration.
- Do not expose `password_hash`, session token hashes, invite tokens, history
  tokens, or non-manager share tokens in API responses.
- Avatar uploads are constrained data URLs; album cover URLs are normalized
  to HTTPS before storage/output.

## Database Notes

Node's built-in `node:sqlite` is used to avoid native npm SQLite packages.

Important tables:

- `users`: account, theme, history sharing, avatar color, disabled/anonymized markers.
- `users.avatar_data_url`: small uploaded profile image stored as a data URL.
- `users.music_platform`: preferred external music service; `na` maps to YouTube Music links.
- `users.accent_color`: optional custom hex accent override; empty derives from music platform.
- `sessions`: persistent HTTP-only cookie sessions.
- `lists`: personal/collab lists, visibility, share/invite tokens, rating display flag.
- `list_members`: owner/editor/viewer roles.
- `list_invites`: pending/accepted/declined account-targeted invites.
- `list_albums`: album entries on a specific list.
- `album_tracks`: tracks loaded from the selected album metadata result.
- `album_completions`: who listened to which album entry.
- `user_album_activity`: profile/history activity that survives list entry deletion.
- `list_album_removal_votes`: collaborative removal voting.
- `list_messages`: collaborative list chat.
- `bug_reports`: guest/account report text with spam-control metadata.
- `track_ratings`: reusable user ratings by normalized `album_key` and `track_key`.
- `album_average_opt_in`: user-level opt-in/out for aggregate album averages.
- `explore_album_covers`: persistent on-demand cache for explore cover URLs.

Do not store plaintext passwords. Do not move sessions to localStorage.

## API Conventions

All API endpoints are same-origin JSON under `/api`. Frontend routes go to
`web/dist/index.html` via the SPA fallback.

Useful flows:

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `PATCH /api/me` (theme, music platform, accent color, profile photo)
- `GET /api/me/album-lists?title=&artist=` — list picker source
- `GET /api/lists`
- `POST /api/lists` (collab only)
- `GET /api/lists/:id` and `GET /api/lists/:id?revision=...` (polling)
- `PATCH /api/lists/:id`
- `GET /api/share/:token`
- `POST /api/invites/:token/join`
- `POST /api/lists/:id/invites`
- `GET /api/invitations`
- `POST /api/invitations/:id/accept` / `decline`
- `POST /api/lists/:id/albums` / `albums/copy`
- `POST /api/lists/:id/albums/:albumId/cover/refresh`
- `DELETE /api/lists/:id/albums/by-key`
- `DELETE /api/lists/:id/albums/:albumId` (also handles collab vote-removal)
- `POST /api/lists/:id/albums/:albumId/complete`
- `PUT /api/lists/:id/albums/:albumId/rating` (album-level fallback)
- `PATCH /api/lists/:id/albums/:albumId/rating-preferences`
- `PUT /api/lists/:id/albums/:albumId/tracks/:trackId/rating`
- `PATCH /api/lists/:id/albums/:albumId/tracks/:trackId/rating-preferences`
- `POST /api/lists/:id/messages`
- `DELETE /api/lists/:id/members/:userId` (kick or self-leave)
- `PUT /api/me/albums/:albumKey/ratings/:trackKey` — own-profile rating edits
- `GET /api/users/:username`
- `GET /api/users?q=` — username/email search
- `POST /api/reports` — guest/account bug reports with rate limiting
- `GET /api/history/:token`
- `GET /api/explore` and `/api/explore/:slug` and `/api/explore/:slug/covers`
- `GET /api/recommendations`

## UI Rules

Keep the app screen first. Do not turn this into a marketing landing page.

Maintain:

- responsive mobile and desktop layouts
- minimalist first screen with no heavy header/sidebar
- `/login` as the dedicated auth page
- album add flow as one search input plus dropdown suggestions
- clicking an album search result adds it immediately; no second confirm click
- album search must include song-result mapping back to albums
- share panel follows the Google Docs-style model: link is view-only, explicit members get roles
- settings opens as a modal, not an inline panel
- list owners get a list-settings panel inside the global settings modal when viewing their own list
- profile photo upload goes through the square crop modal before saving
- modern action buttons are minimalist icon buttons; the retro theme exposes text labels and hides icons
- list-altering actions apply returned payloads instead of forcing route reloads
- after sending chat with Enter, keep focus in the chat input
- visible user avatars and names link to `/u/:username`
- album rows in list/explore/profile/history contexts open a detail page instead of being dead static rows
- own-profile album detail routes let the signed-in user edit their existing ratings in place
- profile rated albums sort fully listened above unfinished
- keep `/explore` as usable list content, not a marketing page
- Discover/Explore album rows should surface current-user listened status when
  the viewer is logged in.
- adding albums from explore/shared views opens the list picker; existing destinations show a checkmark; clicking a checked list removes the album (or votes for collab)
- guests adding from Explore add directly to the local guest list with duplicate protection
- recommendations backend exists but is not surfaced in the UI; do not re-add a Recommended block to `/explore`
- platform color changes with music platform unless the user set a custom accent
- if an album has no tracks, keep the album-level 0-10 rating fallback
- no decorative gradients/orbs

## Verification

```sh
npm install
npm run check        # node --check on server, svelte-check on web
npm run audit
npm run build        # builds web/dist
npm start            # runs server against the built SPA at :3000
```

Smoke-tested flows: health check, account registration, guest album import,
personal list fetch, album creation/removal, track rating, completion toggle,
unlisted share setting, public share fetch, chat send + 5 s polling, list
picker add/remove, invite accept, profile-album rating edit.
