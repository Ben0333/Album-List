# Developer Handoff

## Product Shape

This app is for album lists first. Song-only lists may exist later, but do not build that now unless requested. Keep album URLs/routes generic enough that a future `songs.` subdomain or parallel song mode could reuse the same account/session/list patterns.

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
- Collaborative members can leave shared lists; owners can remove non-owner members. Non-owners should only see a remove/leave control for themselves.
- Ratings and shared listening state are logged-in features.
- Track ratings are 0-10 and roll up to album averages when the user opts in.
- Ratings should be reusable across lists so users do not have to re-review the same album/tracks.
- Listened/completed state should be treated as reusable per user/album, not only per list row.
- Recommendations are currently a local algorithm, not LLM-based: use high ratings to find similar users and suggest unrated/unlisted albums, with explore-list fallback when rating data is thin.
- Rating every track on a listed album must auto-complete that album for the current user.
- Rated/completed album activity must persist independently of list rows.
- Include dark mode, light mode, and a late-90s easter egg theme.
- Accent color derives from `users.music_platform` unless `users.accent_color` is set.

## Architecture

- `src/server.js`: Express app, auth/session helpers, REST routes, list/rating/history logic.
- `src/explore-data.js`: static curated explore-list data. The `1001-all-editions` list mirrors `https://1001albumsgenerator.com/albums` as of April 28, 2026 and currently contains 1,088 albums across editions plus Spotify album IDs for cover hydration.
- `src/db.js`: SQLite connection, schema, normalization helpers, transaction helper.
- `src/config.js`: environment config.
- `public/index.html`: app root.
- `public/app.js`: vanilla JS client/router/state/rendering.
- `public/styles.css`: responsive UI and themes.
- `data/albums.sqlite`: local database, ignored by git.
- `Start Albums App.bat` / `Stop Albums App.bat`: Windows one-click local server controls that use `.server.pid`.

There is no frontend build pipeline. Keep it that way unless there is a clear reason to add one.

## Security and Deployment Notes

- Production startup validation lives in `src/config.js`. With `NODE_ENV=production`, the app requires a public `https://` `APP_ORIGIN`, `COOKIE_SECURE=true`, and an explicit persistent `DATABASE_PATH`.
- Session cookies are HTTP-only, same-site `lax`, and secure when `COOKIE_SECURE=true`.
- Mutating `/api` requests are same-origin protected with `Origin` and Fetch Metadata checks. Keep new write endpoints under `/api` so this middleware applies.
- `helmet` sets security headers and CSP. Current CSP allows same-origin scripts/connections/styles, inline styles for the existing vanilla UI, and images from `self`, `data:`, and `https:`.
- Rate limits are process-local maps. This is acceptable for one beta Node process; use a shared limiter before running multiple instances.
- User search intentionally supports partial username search, but email matching is exact-only to reduce email enumeration.
- Do not expose `password_hash`, session token hashes, invite tokens, history tokens, or non-manager share tokens in API responses.
- Avatar uploads are constrained data URLs and album cover URLs are normalized to HTTPS before storage/output.

## Database Notes

Node's built-in `node:sqlite` is used to avoid native npm SQLite packages. This matters on Windows because native packages may require Visual Studio C++ build tools.

Important tables:

- `users`: account, theme, history sharing, avatar color.
- `users.avatar_data_url`: small uploaded profile image stored as a data URL.
- `users.music_platform`: preferred external music service; `na` maps to YouTube Music links.
- `users.accent_color`: optional custom hex accent override; empty means derive from music platform.
- `sessions`: persistent HTTP-only cookie sessions.
- `lists`: personal/collab lists, visibility, share/invite tokens, rating display flag.
- `list_members`: owner/editor/viewer roles.
- `list_invites`: pending/accepted/declined account-targeted invites.
- `list_albums`: album entries on a specific list.
- `album_tracks`: tracks loaded from the selected album metadata result.
- `album_completions`: who listened to which album entry. `user_album_activity.completed_at` is also used to carry listened state across lists for the same user/album.
- `list_album_removal_votes`: collaborative removal voting.
- `list_messages`: collaborative list chat.
- `track_ratings`: reusable user ratings by normalized `album_key` and `track_key`.
- `album_average_opt_in`: user-level opt-in/out for aggregate album averages.
- `user_album_activity`: profile/history activity that survives list entry deletion.
- `explore_album_covers`: persistent on-demand cache for explore cover URLs.

Do not store plaintext passwords. Do not move sessions to localStorage.

## API Conventions

All API endpoints are same-origin JSON under `/api`.

Useful flows:

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/me/album-lists` to check which editable lists already contain an album key
- `PATCH /api/me` for theme/history/profile photo updates
- `GET /api/lists`
- `POST /api/lists` to create a collaborative list
- `GET /api/explore`
- `GET /api/explore/:slug`
- `GET /api/explore/:slug/covers`
- `POST /api/explore/:slug/covers/:index/refresh`
- `GET /api/recommendations`
- `GET /api/lists/:id`
- `PATCH /api/lists/:id`
- `GET /api/share/:token`
- `POST /api/invites/:token/join`
- `POST /api/lists/:id/invites`
- `GET /api/invitations`
- `POST /api/invitations/:id/accept`
- `POST /api/invitations/:id/decline`
- `POST /api/lists/:id/albums`
- `POST /api/lists/:id/albums/copy`
- `POST /api/lists/:id/albums/:albumId/cover/refresh`
- `DELETE /api/lists/:id/albums/by-key`
- `POST /api/lists/:id/messages`
- `PATCH /api/lists/:id/members/:userId`
- `DELETE /api/lists/:id/members/:userId` for owner kick or self-leave
- `PATCH /api/lists/:id/albums/:albumId`
- `PUT /api/lists/:id/albums/:albumId/rating` for album-level fallback ratings when track metadata is unavailable
- `POST /api/lists/:id/albums/:albumId/complete`
- `PUT /api/lists/:id/albums/:albumId/tracks/:trackId/rating`
- `PUT /api/me/albums/:albumKey/ratings/:trackKey` for editing existing ratings from the signed-in user's profile album page
- `GET /api/users/:username`
- `GET /api/history/:token`

## UI Rules

Keep the app screen first. Do not turn this into a marketing landing page.

Maintain:

- responsive mobile and desktop layouts
- clean app-style controls
- minimalist first screen with no heavy header/sidebar
- `/login` as the dedicated auth page
- album add flow as one search input plus dropdown suggestions
- clicking an album search result should add it immediately; do not require a second Add click
- album search must include song-result mapping back to albums
- share panel should follow the Google Docs-style model: link is view-only, explicit members get roles
- settings should open as a modal, not an inline panel
- saving settings should close the modal
- list owners should have a direct rename affordance near the list title, in addition to the settings form
- profile photo upload should go through the square crop modal before saving, with both sliders and pointer-drag panning
- modern action buttons should be minimalist icon buttons using `renderActionButton`; the retro theme should expose text labels and hide icons
- keep list-altering actions live by applying returned payloads; avoid forcing route reloads for add/rate/listened/chat
- after sending chat with Enter, keep focus in the chat input so repeated messages feel continuous
- visible user avatars and names should link to `/u/:username`
- album rows in list, explore, profile, and history contexts should open a detail page instead of being dead static rows
- profile/history album detail routes should show the rated user's track-level ratings when available
- own-profile album detail routes should let the signed-in user edit their existing ratings in place
- profile rated albums should sort fully listened albums above unfinished albums; do not let a half-rated album jump above completed albums just because it has a high average
- keep `/explore` as usable list content, not a marketing page
- keep `1001-all-editions` synced from the public 1001 Albums Generator album page when intentionally refreshing that snapshot
- keep the generated external Explore lists source-tagged; current added sources include Rolling Stone 500 via `thegreatestmusic.org`, Needle Drop 10s, and The Quietus Baker's Dozen sampler.
- explore album covers are hydrated through `/api/explore/:slug/covers`; the frontend uses intersection-triggered batches and the backend persists covers in `explore_album_covers`. Do not reintroduce full-list re-render loops or eager loading of all 1,088 covers on page load.
- broken album covers should render as initials immediately and only refresh through targeted cover-refresh endpoints; do not make list views block on cover validation.
- adding albums from explore/shared views should open the list picker and mark existing destination lists with a checkmark; clicking a checked list removes the album, or records a removal vote for collaborative lists
- exception: guests adding from Explore should not see the list picker; the plus/check button should add directly to the local guest list with duplicate protection
- keep recommendations backend-only until a real recommendations page is intentionally designed; do not re-add a Recommended block to `/explore`
- platform color should change with music platform unless the user has set a custom accent
- no user-facing cover URL, notes, or manual track fields
- if an album has no tracks, keep the album-level 0-10 rating fallback instead of showing a dead "track list unavailable" state
- no nested cards
- album rows as repeated items only
- compact controls on mobile
- readable contrast in all three themes
- no decorative gradients/orbs

## Next Likely Work

- Add additional metadata providers for external links through Spotify, YouTube, or other APIs.
- Current metadata lookup uses cached Apple iTunes Search/Lookup API calls plus MusicBrainz release search through `/api/albums/search` and `/api/albums/lookup/:providerId`.
- MusicBrainz search handles mixed `album artist` and `artist album` queries by generating release/artist field clauses, includes Albums and EPs, and runs through a one-at-a-time request queue to stay within the public API guidance.
- MusicBrainz fallback IDs use `mb:<releaseId>`. Keep lookup support for these provider IDs.
- Add ownership transfer for collaborative lists.
- Add drag-and-drop album ordering.
- Add import/export.
- Add richer profile pages.
- Add a small refresh script if the 1001 snapshot needs routine updates.
- Add password reset once email sending exists.
- Add admin moderation tools before broad public launch.

## Verification Used

The current implementation was smoke-tested with:

- health check
- account registration
- guest album import
- personal list fetch
- album creation
- track rating
- completion toggle
- unlisted share setting
- public share fetch

Run syntax checks with:

```powershell
npm run check
npm run audit
```
