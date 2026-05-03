# Turntable

Turntable is a music list website for saving albums you want to hear, tracking
what you have listened to, rating songs and albums, and sharing lists with
friends. Use it as a personal album backlog, a listening diary, or a shared
record-club list where people add albums, chat, and compare ratings.

## What You Can Do

- Save albums you want to listen to later.
- Mark albums as listened and keep a personal listening history.
- Rate full albums or individual tracks.
- Share public or unlisted album lists with other people.
- Build collaborative lists with friends, invites, roles, and chat.
- Discover albums from built-in starter collections and public shared lists.
- Use the site as a guest first, then move your list into an account later.

A small album-list web app with guest lists, username/email/password accounts,
collaborative lists, share links, listening status, track ratings, album
averages, and light/dark/late-90s themes.

## Project Layout

```
server/    Express JSON API + node:sqlite (Node 22, no build step)
web/       Svelte 5 + Vite SPA frontend (TypeScript)
shared/    Config and DB helpers (@albums/shared)
data/      SQLite database (gitignored, mounted as a volume in Docker)
```

npm workspaces monorepo. The frontend is built with Vite and served as static
files by the Node server in production.

## Run Locally

```sh
npm install
npm run dev
```

Vite serves the SPA at http://localhost:5173 and proxies `/api` to the API
server at http://localhost:3000.

For a single-process production-style run:

```sh
npm run build
npm start            # serves built SPA + API at http://localhost:3000
```

`npm start` refuses to start unless `web/dist/index.html` exists — run
`npm run build` first.

## Run with Docker

```sh
cp .env.example .env   # edit for production
docker compose up --build
```

The compose file mounts `./data` to `/data` inside the container so the SQLite
database persists across rebuilds. The public app listens on container port
3000, and Compose binds it to `127.0.0.1:3000` on the host so Cloudflare Tunnel
can publish it without exposing direct internet access to port 3000. The image
includes a healthcheck against `/api/health`. The base image is
`node:22-alpine` and builds for `linux/amd64` and `linux/arm64`.

Pushes to `main` publish a multi-architecture Docker image to GitHub Container
Registry at `ghcr.io/ben0333/album-list:latest`, with SHA tags for pinned
deployments.

The default Compose file runs only the public app. Optional services are split
into overlays so a normal self-hosted install does not start private tooling:

```sh
docker compose up -d
docker compose -f docker-compose.yml -f docker-compose.admin.yml up -d
docker compose -f docker-compose.yml -f docker-compose.admin.yml -f docker-compose.cloudflare.yml up -d
```

Use `docker-compose.admin.yml` when you want the private admin backend. Use
`docker-compose.cloudflare.yml` when this host should run the Cloudflare Tunnel.
The optional `cloudflared` service reads `TUNNEL_TOKEN` from `.env.cloudflare`,
which is gitignored so the connector token does not end up in the repository.

The optional private admin backend runs as a separate `admin` workspace on port
3001. It has no routes in the public SPA and should stay bound to localhost.
Docker Compose publishes it as `127.0.0.1:3001:3001`; keep real admin auth
secrets in `.env.admin` on the host only. Reach it from another machine with an
SSH tunnel such as `ssh -N -L 3001:127.0.0.1:3001 turntable`. The admin server
rejects non-localhost Host headers. The admin console can download a consistent
SQLite backup; save those files under `backups/` in this workspace if you want
them next to the repo. `backups/` is gitignored and must stay out of Git.

VM autostart and weekly app-container restart units are documented in
`deploy/README.md`.

## Configuration

Copy `.env.example` to `.env` for custom settings. Defaults work for
development.

```env
NODE_ENV=development
PORT=3000
APP_ORIGIN=http://localhost:3000
SESSION_COOKIE_NAME=albums_sid
SESSION_DAYS=30
COOKIE_SECURE=false
DATABASE_PATH=./data/albums.sqlite
TRUST_PROXY=false
SLOW_REQUEST_MS=750
```

In production, set `NODE_ENV=production`, `APP_ORIGIN` to the public `https://`
origin, `COOKIE_SECURE=true`, an explicit persistent `DATABASE_PATH`, and
`TRUST_PROXY=true` when Express is behind a reverse proxy that terminates TLS.
The server refuses to start in production if those public-facing settings are
unsafe.

For the private admin backend, copy `.env.admin.example` to `.env.admin` on the
server and set either `ADMIN_TOKEN` or `ADMIN_PASSWORD_HASH`. Password login
also checks `ADMIN_USERNAME`, which defaults to `admin`. The admin service
refuses to start without one of those auth values. Do not commit the real
`.env.admin` file. Wrap bcrypt hashes in single quotes in `.env.admin` because
they contain `$` characters. Keep `ADMIN_ORIGIN` on the localhost origin used by
the SSH tunnel unless you intentionally add another private local origin.

## Features

- Guests can build a local album list in the browser; albums transfer into the
  personal list during signup or login.
- Accounts use username, email, and password. Email is not verified; passwords
  are hashed with bcrypt.
- Sessions are stored in SQLite and set with HTTP-only cookies.
- Each account gets one personal list and can create unlimited collaborative
  lists.
- Collaborative list owners can invite accounts by username/email; invitees see
  in-app notifications and can accept or decline.
- Users and guests can submit bug reports from the floating report button;
  reports are rate limited and stored in SQLite for follow-up.
- Share opens an access panel: copy link gives view-only access, while
  searched/invited users can become members.
- Collaborative lists have a closeable member chat panel with unread counts and
  timestamps; chat and other live state poll every 5 s.
- Collaborative album removal is vote based; at least one quarter of list
  members must vote before removal.
- Users can upload a profile photo and crop it square in the app.
- Music platform and accent color are configurable per user; the accent color
  follows the platform by default.
- Public/unlisted lists let logged-in viewers copy any album into their own
  editable list via a list picker.
- Broken album-cover images fall back to initials immediately; editable list
  albums can refresh their cover from the metadata APIs.
- Explore lists at `/explore` include popular public shared lists, a
  1,088-album 1001 Albums Generator snapshot, Rolling Stone 500, Needle Drop
  7-10s, famous band essentials, and other starter lists.
- Shuffle picks an unlistened album when possible, scrolls to it, and
  highlights it.
- Albums are added by clicking a metadata search result. Covers and track lists
  are filled automatically from the iTunes Search/Lookup API, with MusicBrainz
  as fallback.
- List members can mark albums listened, rate tracks 0-10, exclude individual
  track ratings from album averages, or rate the album directly when track
  metadata is unavailable.
- Rating every track on an album automatically marks that album listened.
- Track and listened state are reused by normalized album/track keys across
  lists, so a user's rating follows the same album wherever it appears.
- Users have profile pages at `/u/:username` showing public lists and rated
  albums; fully listened albums sort above unfinished rated albums.
- Rated albums open detail views with the user's track-level ratings. On your
  own profile those ratings are editable.

## Production Notes

The frontend is a Vite-built static bundle served by Express. The DB is
node:sqlite in WAL mode (no native npm packages required).

Before making it public:

- Put the app behind HTTPS (Caddy, nginx, Cloudflare Tunnel, etc.).
- Set `APP_ORIGIN` to the public origin.
- Set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
- Set `DATABASE_PATH` to a persistent disk path (the Docker image defaults to
  `/data/albums.sqlite`, mounted as a volume in `docker-compose.yml`).
- If using the Compose `cloudflared` service, keep the real tunnel token in
  `.env.cloudflare` on the server only and include
  `docker-compose.cloudflare.yml` when starting Compose.
- If using the private admin backend, keep real admin auth in `.env.admin` on
  the server only and include `docker-compose.admin.yml` when starting Compose.
- Keep the Docker app and admin port bindings on `127.0.0.1` unless you have a
  separate firewall rule blocking direct public access.
- Keep the SQLite database backed up.
- Use the private admin backup download or SQLite CLI online backup for manual
  copies, and store local copies under gitignored `backups/`.
- Check `GET /api/health` from the load balancer or uptime monitor.
- Run `npm run check` and `npm run audit` before deploying.

### Backup and Restore

The app uses SQLite WAL mode, so use one of these approaches:

- Best: SQLite CLI online backup —
  `sqlite3 /data/albums.sqlite ".backup '/backups/albums-$(date +%F).sqlite'"`.
- App helper: `DATABASE_PATH=/data/albums.sqlite npm run db:backup` writes a
  consistent `VACUUM INTO` backup to `backups/` by default. Set `BACKUP_DIR` to
  choose another output directory.
- Simple: stop the app, then copy the `.sqlite`, `.sqlite-wal`, and
  `.sqlite-shm` files together if WAL files exist.
- Restore by stopping the app, replacing the database files, then starting the
  app again.

Test restores before launch; an untested backup is not a launch backup.

### Load Testing

Write-heavy load tests live in `scripts/stress/` and use only Node built-ins.
They create identifiable test users, collaborative lists, albums, completions,
ratings, chat messages, and low-volume bug reports. They do not call external
album metadata APIs.

```sh
npm run check
npm run audit
CONCURRENCY=10 DURATION_SECONDS=30 npm run stress:local
```

Results are written to gitignored `stress-results/`. For a disposable database,
remove generated rows with:

```sh
DATABASE_PATH=./data/disposable.sqlite TEST_PREFIX=loadtest CONFIRM_CLEANUP=true npm run stress:cleanup
```

Remote targets must be explicit:

```sh
TARGET_URL=http://127.0.0.1:3000 CONCURRENCY=10 DURATION_SECONDS=60 npm run stress:target
```

The harness refuses non-local write targets, including production, unless
`ALLOW_PRODUCTION_WRITES=true` and `CONFIRM_TARGET=turntable` are set. Take a
backup first and start with a small smoke run. Expected beta thresholds are 0
HTTP 500s, no script timeouts, p95 under 1000 ms at 100 local/staging
concurrency, and p95 under 2000 ms at 300 local/staging concurrency. HTTP 429s
from configured rate limits are reported separately and can be acceptable.

### Limits

This hardening targets a small public beta, not enterprise compliance.

- No email verification, password reset, or public account deletion flow yet.
- Rate limits are process-local; use one Node process or add shared rate
  limiting before horizontal scaling.
- Uploaded avatars are stored in SQLite as constrained data URLs.
- Album metadata depends on public iTunes/MusicBrainz endpoints and can be
  degraded by upstream rate limits.

Node prints an experimental warning for `node:sqlite`. We use it deliberately
to avoid native npm database packages that need C++ build tools.

The album search endpoint is API-key-free and uses cached Apple iTunes
Search/Lookup calls plus MusicBrainz release search.

Explore data lives in `server/src/explore-data.js`. The `1001-all-editions`
list mirrors `https://1001albumsgenerator.com/albums` as of April 28, 2026.
Covers are cached in SQLite as they are viewed.

A local rating-based recommendation algorithm exists at `/api/recommendations`
but is not currently surfaced in the UI.
