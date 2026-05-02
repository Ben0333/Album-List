# Albums to Listen To

A small album-list web app with guest lists, username/email/password accounts, collaborative lists, share links, listening status, track ratings, album averages, and light/dark/late-90s themes.

## Project Layout

```
server/    Express JSON API + SQLite (Node 22, no build step)
web/       Svelte 5 + Vite SPA frontend (TypeScript)
shared/    Config and DB helpers (@albums/shared)
admin/     Local-only admin dashboard (not part of the Docker image)
data/      SQLite database (gitignored, mounted as a volume in Docker)
```

The repository is an npm workspaces monorepo. The Svelte port is in progress on
`refactor/svelte`; the original vanilla-JS frontend is preserved at
`server/legacy-public/` and is served automatically when `web/dist/` is missing
or `LEGACY_FRONTEND=1` is set.

## Run Locally

```sh
npm install
npm run dev
```

Opens Vite at http://localhost:5173 (SPA in development) and the API at
http://localhost:3000. Vite proxies `/api` to the API server.

To run against the legacy frontend (the original vanilla JS app) on a single port:

```sh
npm run dev:legacy   # serves the legacy UI at http://localhost:3000
```

To produce a single-process production build:

```sh
npm run build
npm start            # serves built SPA + API at http://localhost:3000
```

For the local-only admin dashboard at http://127.0.0.1:3001:

```sh
npm run dev:admin
```

The admin app binds to localhost only, can start/stop the public server, and is
explicitly excluded from the Docker image.

## Run with Docker

```sh
cp .env.example .env   # edit for production
docker compose up --build
```

The compose file mounts `./data` to `/data` inside the container so the SQLite
database persists across rebuilds. The image exposes port 3000 and includes a
healthcheck against `/api/health`.

## Configuration

Copy `.env.example` to `.env` when you want custom settings.

```env
NODE_ENV=development
PORT=3000
ADMIN_PORT=3001
ADMIN_HOST=127.0.0.1
CLOUDFLARED_SERVICE_NAME=Cloudflared
APP_ORIGIN=http://localhost:3000
SESSION_COOKIE_NAME=albums_sid
SESSION_DAYS=30
COOKIE_SECURE=false
DATABASE_PATH=./data/albums.sqlite
TRUST_PROXY=false
```

For production, set `NODE_ENV=production`, `APP_ORIGIN` to the public `https://` origin, `COOKIE_SECURE=true`, an explicit persistent `DATABASE_PATH`, and `TRUST_PROXY=true` when Express is behind a reverse proxy that terminates TLS. The server refuses to start in production if those public-facing settings are unsafe.

## Current Features

- Guests can make a local album list in the browser.
- Guest albums transfer into the personal list during signup or login.
- Accounts use username, email, and password. Email is not verified.
- Passwords are hashed with bcrypt.
- Sessions are stored in SQLite and set with HTTP-only cookies.
- Each account gets one personal list and can create unlimited collaborative lists.
- Users can join unlimited collaborative lists through owner-sent invites.
- Collaborative list members can leave; owners can remove any non-owner member.
- Collaborative list owners can invite accounts by username/email; invitees see in-app notifications and can accept or decline.
- Share opens an access panel: copy link gives view-only access, while searched/invited users can become members.
- Collaborative lists have a closeable member chat panel with unread counts and timestamps.
- Collaborative album removal is vote based; at least one quarter of list members must vote before removal.
- Users can upload a profile photo and crop it square in the app with sliders or direct drag.
- New accounts choose a preferred music platform with buttons; N/A defaults album links to YouTube Music.
- The accent color follows the user's music platform by default and can be overridden in settings.
- Shared/public list views let logged-in users copy an album into their own editable list.
- Guests can add albums from Explore directly into their local guest list without a list-picker popup.
- Album add buttons from shared views and explore open a list picker so the destination list is explicit; checked lists can be clicked again to remove/vote-remove the album.
- If a shared album is already on the viewer's main list, the UI shows their rating/list status instead of another Add button.
- List owners can rename lists and manage visibility, ratings, share links, invites, and member roles.
- Broken album-cover images fall back to initials immediately; editable list albums can automatically repull and verify a fresh cover from the metadata APIs.
- Collaborative lists poll for live album, rating, listened, removal-vote, and chat updates without a manual refresh.
- Explore lists at `/explore` include on-demand cached cover hydration, popular public shared lists, a 1,088-album 1001 Albums Generator snapshot, Rolling Stone 500, Needle Drop 10s, famous band essentials, artist-pick samplers, and other starter lists. The recommendation endpoint exists as backend structure but is not surfaced on Explore yet.
- Shuffle picks an unlistened album when possible, scrolls to it, and highlights it.
- Modern action buttons use minimalist icons; the late-90s theme switches those controls back to text labels.
- Albums are added by clicking a metadata search result. Covers and track lists are filled automatically from the iTunes Search/Lookup API, including song-title searches, with MusicBrainz fallback for missing/stylized albums.
- iTunes album lookup also checks the Japanese storefront for matching native-script track names and keeps rating keys stable when it only changes display titles.
- Logged-in list members can mark albums listened, and that listened state follows the album/user across lists.
- Logged-in list members can rate tracks 0-10.
- Logged-in list members can exclude individual track ratings from album averages.
- If track metadata is unavailable, logged-in list members can rate the album directly 0-10.
- Rating every track on an album automatically marks that album listened.
- Rated/completed album activity is kept for profiles even if the list entry is later removed.
- Track ratings are reused by normalized album/track keys across lists, so a user's rating follows the same album wherever it appears.
- Users can opt their ratings in or out of album averages.
- Users have profile pages at `/u/:username` showing public lists and rated albums, with fully listened albums sorted above unfinished rated albums.
- Rated albums on profile and history pages open detail views showing that user's recorded song or album-level ratings. On your own profile, those ratings are editable.
- Visible usernames and profile photos link to the user's profile.
- A separate local-only admin dashboard can view site statistics, start/restart/stop the public website process, start/stop the Cloudflare tunnel, run emergency lockdown, disable accounts, and anonymize accounts while preserving their list, rating, and listening data.

## Production Notes

This is intentionally simple: Express, Node's built-in SQLite module, and static frontend files. There is no build step.

Before making it public:

- Put the app behind HTTPS.
- Set `APP_ORIGIN` to the public origin.
- Set `COOKIE_SECURE=true`.
- Set `DATABASE_PATH` to a persistent disk path outside ephemeral deploy directories.
- Keep the SQLite database backed up.
- Check `GET /api/health` from the load balancer or uptime monitor.
- Run `npm run check` and `npm run audit` before deploying.
- Use a process manager such as `pm2`, systemd, or a Windows service wrapper.
- If Cloudflare is in front, keep Cloudflare proxying enabled and restrict direct server access if possible.

### Backup and Restore

The app uses SQLite WAL mode, so use one of these approaches:

- Best: use the SQLite CLI online backup command, for example `sqlite3 /var/lib/albums/albums.sqlite ".backup '/var/backups/albums/albums-$(date +%F).sqlite'"`.
- Simple: stop the app, then copy the `.sqlite`, `.sqlite-wal`, and `.sqlite-shm` files together if WAL files exist.
- Restore by stopping the app, replacing the database files, then starting the app again.

Test restores before launch; an untested backup is not a launch backup.

### Public Beta Limits

This hardening targets a small public beta, not enterprise compliance. Remaining intentional limits:

- No email verification, password reset, public admin account system, or public account deletion flow yet. The admin dashboard is local-only and not intended for deployment.
- Rate limits are process-local; use one Node process or add shared rate limiting before horizontal scaling.
- Uploaded avatars are stored in SQLite as constrained data URLs, which is acceptable for a small beta but not ideal for large media volume.
- Album metadata depends on public iTunes/MusicBrainz/Spotify oEmbed endpoints and can be degraded by upstream rate limits.

Node currently prints an experimental warning for `node:sqlite`. The app uses it to avoid native npm database packages that require Windows C++ build tools.

The album search endpoint is API-key-free and currently uses cached Apple iTunes Search/Lookup calls plus MusicBrainz release search. MusicBrainz queries split mixed searches such as `album artist` or `artist album` into fielded release/artist clauses, include Albums and EPs, and are paced to respect MusicBrainz's public API limits. If Spotify, YouTube, or another metadata source is added later, keep `/api/albums/search` and `/api/albums/lookup/:providerId` as the frontend contract.

Explore data lives in `apps/main/src/explore-data.js`. The `1001-all-editions` list was generated from https://1001albumsgenerator.com/albums on April 28, 2026 and intentionally mirrors that public page across all editions, including Spotify album IDs used for cover hydration. Covers are cached in SQLite as they are viewed.

Recommendations currently use a local rating-based algorithm: high-rated albums identify similar users, then the app suggests highly rated albums the current user has not listed/rated yet. If there is not enough rating data, it falls back to explore-list albums.
