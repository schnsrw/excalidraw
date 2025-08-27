#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="$ROOT_DIR/docker"
ENV_FILE="$DOCKER_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  cp "$DOCKER_DIR/.env.example" "$ENV_FILE"
  echo "Created default env file at $ENV_FILE. Please review and update it before running again."
fi

docker compose -f "$DOCKER_DIR/docker-compose.yml" --env-file "$ENV_FILE" up --build -d