#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

docker compose config --quiet
docker compose build --no-cache --pull obsidian-server
docker compose up -d --no-build --force-recreate obsidian-server
docker compose ps obsidian-server
