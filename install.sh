#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/docker-compose.prod.yml"
ENV_FILE="$ROOT_DIR/.env"
CERT_DIR="$ROOT_DIR/infra/nginx/certs/live/platform"
WEBROOT_DIR="$ROOT_DIR/infra/nginx/www"
BACKUP_DIR="$ROOT_DIR/backups"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Comando obrigatorio ausente: $1" >&2
    exit 1
  fi
}

require_command docker
require_command openssl

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin nao encontrado." >&2
  exit 1
fi

mkdir -p "$CERT_DIR" "$WEBROOT_DIR" "$BACKUP_DIR" "$ROOT_DIR/apps/api/data"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  echo ".env criado a partir de .env.example. Revise as senhas antes de expor em producao."
fi

set -a
source "$ENV_FILE"
set +a

ROOT_DOMAIN="${ROOT_DOMAIN:-infracode.local}"
ADMIN_SUBDOMAIN="${ADMIN_SUBDOMAIN:-admin}"

if [[ ! -f "$CERT_DIR/fullchain.pem" || ! -f "$CERT_DIR/privkey.pem" ]]; then
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" \
    -days 7 \
    -subj "/CN=${ROOT_DOMAIN}"
fi

docker compose -f "$COMPOSE_FILE" up -d postgres redis pgbouncer

docker compose -f "$COMPOSE_FILE" run --rm api pnpm --filter @infracode/api prisma:push:platform
docker compose -f "$COMPOSE_FILE" run --rm api pnpm --filter @infracode/api seed:platform-owner

if [[ -n "${LETSENCRYPT_EMAIL:-}" ]]; then
  docker compose -f "$COMPOSE_FILE" run --rm --entrypoint certbot certbot certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos \
    --non-interactive \
    -d "$ROOT_DOMAIN" \
    -d "${ADMIN_SUBDOMAIN}.${ROOT_DOMAIN}" || true
fi

docker compose -f "$COMPOSE_FILE" up -d api worker panel nginx backup prometheus grafana certbot

echo "Stack iniciada. Verifique:"
echo "  Painel InfraCode: https://${ADMIN_SUBDOMAIN}.${ROOT_DOMAIN}"
echo "  Health API interno: docker compose -f $COMPOSE_FILE exec api wget -qO- http://127.0.0.1:3333/health"
