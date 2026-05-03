# VM Deployment Autostart

These deployment helpers keep the Docker Compose deployment running after VM
reboots and restart only the public app container once per week. The Compose
file still owns the container-level restart policy (`restart: unless-stopped`)
for crashes.

The weekly timer restarts the `app` service only. It leaves `cloudflared`
running because the tunnel does not need a scheduled restart for normal app
deployments.

## Files

- `systemd/albums-compose.service`: brings the Compose project up with
  `docker compose up -d --remove-orphans` during boot.
- `systemd/albums-weekly-restart.service`: one-shot weekly restart command for
  the `app` container.
- `systemd/albums-weekly-restart.timer`: schedules the weekly restart for
  Sunday at 04:30 local VM time with a small randomized delay.
- `openrc/albums-compose`: OpenRC equivalent for Alpine Linux hosts.
- `scripts/albums-weekly-restart.sh`: cron-friendly weekly restart command for
  non-systemd hosts.

## Install On A Systemd VM

Run these commands as the VM user that manages the repo. This assumes the
production checkout lives at `/opt/Album-List`; change `APP_DIR` if your clone
is somewhere else.

```sh
sudo systemctl enable --now docker

sudo mkdir -p /etc/albums-to-listen-to
printf 'APP_DIR=/opt/Album-List\nDOCKER_BIN=/usr/bin/docker\n' | sudo tee /etc/albums-to-listen-to/deploy.env

sudo cp /opt/Album-List/deploy/systemd/albums-compose.service /etc/systemd/system/
sudo cp /opt/Album-List/deploy/systemd/albums-weekly-restart.service /etc/systemd/system/
sudo cp /opt/Album-List/deploy/systemd/albums-weekly-restart.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now albums-compose.service
sudo systemctl enable --now albums-weekly-restart.timer
```

## Install On Alpine/OpenRC

Use this on Alpine Linux VMs. This assumes the production checkout lives at
`/opt/album-list`; change `APP_DIR` if your clone is somewhere else.

```sh
sudo rc-update add docker default
sudo rc-service docker start
sudo rc-update add crond default
sudo rc-service crond start

sudo mkdir -p /etc/albums-to-listen-to /usr/local/sbin
printf 'APP_DIR=/opt/album-list\nDOCKER_BIN=/usr/bin/docker\n' | sudo tee /etc/albums-to-listen-to/deploy.env

sudo cp /opt/album-list/deploy/openrc/albums-compose /etc/init.d/albums-compose
sudo chmod 755 /etc/init.d/albums-compose
sudo cp /opt/album-list/deploy/scripts/albums-weekly-restart.sh /usr/local/sbin/albums-weekly-restart
sudo chmod 755 /usr/local/sbin/albums-weekly-restart

sudo rc-update add albums-compose default
sudo rc-service albums-compose start

(sudo crontab -l 2>/dev/null | grep -v '/usr/local/sbin/albums-weekly-restart'; \
  echo '30 4 * * 0 /usr/local/sbin/albums-weekly-restart') | sudo crontab -
```

Before enabling the service, make sure production env files are in place:

```sh
cd /opt/Album-List
cp .env.example .env
cp .env.admin.example .env.admin
cp .env.cloudflare.example .env.cloudflare
```

Edit `.env` for production (`NODE_ENV=production`, public `APP_ORIGIN`,
`COOKIE_SECURE=true`, `DATABASE_PATH=/data/albums.sqlite`, and
`TRUST_PROXY=true` when TLS is terminated by a proxy). Put the real Cloudflare
Tunnel token in `.env.cloudflare` if the `cloudflared` Compose service is used.
Set either `ADMIN_TOKEN` or `ADMIN_PASSWORD_HASH` in `.env.admin`; the private
admin service listens on host-local `127.0.0.1:3001` and refuses to start
without admin auth configured. Wrap bcrypt hashes in single quotes because they
contain `$` characters. `ADMIN_ORIGIN` may be a comma-separated list when the
same admin tunnel has more than one hostname.

To publish the admin console through a separate Cloudflare Tunnel, keep the
tunnel credentials in `/opt/album-list/.cloudflared-admin/` and enable the
`admin-cloudflare` Compose profile in the host `.env`:

```env
COMPOSE_PROFILES=admin-cloudflare
```

The admin tunnel should route only the admin hostname to
`http://127.0.0.1:3001`.

## Verify

Check that the units are valid and active:

```sh
sudo systemd-analyze verify \
  /etc/systemd/system/albums-compose.service \
  /etc/systemd/system/albums-weekly-restart.service \
  /etc/systemd/system/albums-weekly-restart.timer

systemctl status docker albums-compose.service albums-weekly-restart.timer --no-pager
systemctl list-timers albums-weekly-restart.timer --no-pager
```

On Alpine/OpenRC, check:

```sh
rc-service docker status
rc-service crond status
rc-service albums-compose status
sudo crontab -l | grep albums-weekly-restart
```

Check the Compose project and app health endpoint:

```sh
cd /opt/Album-List
docker compose config
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3001/admin/api/summary
```

If `curl` is not installed, use:

```sh
wget -qO- http://127.0.0.1:3000/api/health
wget -qO- --header="Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3001/admin/api/summary
```

The health check should return JSON like:

```json
{"ok":true,"time":"2026-05-03T00:00:00.000Z","uptimeSeconds":12,"database":"ok"}
```

To test the weekly restart command without waiting for the timer:

```sh
sudo systemctl start albums-weekly-restart.service
docker compose ps app
```
