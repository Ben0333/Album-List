#!/bin/sh
set -eu

if [ ! -r /etc/albums-to-listen-to/deploy.env ]; then
  echo "/etc/albums-to-listen-to/deploy.env is missing" >&2
  exit 1
fi

. /etc/albums-to-listen-to/deploy.env

if [ -z "${APP_DIR:-}" ]; then
  echo "APP_DIR is not set in /etc/albums-to-listen-to/deploy.env" >&2
  exit 1
fi

cd "$APP_DIR"
"${DOCKER_BIN:-/usr/bin/docker}" compose restart app
