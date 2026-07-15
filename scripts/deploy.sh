#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()  { echo -e "${RED}[deploy]${NC} $*" >&2; }

usage() {
    cat <<EOF
Usage: $0 [command]

Commands:
  build       Build all images
  up          Start all services (detached)
  down        Stop all services
  restart     Restart all services
  logs        Tail logs for all services
  status      Show service status
  migrate     Run database migrations
  health      Check health of all services
  backup      Backup PostgreSQL database
  help        Show this help

Environment:
  .env file in project root is auto-loaded.
  Override with: $0 build --env-file /path/to/.env

Examples:
  $0 build
  $0 up
  $0 logs
  $0 health
EOF
}

require_env() {
    if [ ! -f "${PROJECT_ROOT}/.env" ]; then
        err ".env file not found. Copy .env.example to .env and configure it."
        exit 1
    fi
}

cmd_build() {
    log "Building images..."
    docker compose -f "$COMPOSE_FILE" build --no-cache
    log "Build complete."
}

cmd_up() {
    require_env
    log "Starting services..."
    docker compose -f "$COMPOSE_FILE" up -d --remove-orphans
    log "Services started. Waiting for health checks..."
    sleep 5
    cmd_health
}

cmd_down() {
    log "Stopping services..."
    docker compose -f "$COMPOSE_FILE" down --remove-orphans
    log "Services stopped."
}

cmd_restart() {
    cmd_down
    cmd_up
}

cmd_logs() {
    docker compose -f "$COMPOSE_FILE" logs -f --tail=100
}

cmd_status() {
    docker compose -f "$COMPOSE_FILE" ps
}

cmd_migrate() {
    require_env
    log "Running database migrations..."
    docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U whisper -d whisper -f /docker-entrypoint-initdb.d/01-init.sql 2>/dev/null || \
        warn "Migrations may have already been applied."
    log "Migrations complete."
}

cmd_health() {
    log "Checking health..."
    local all_ok=true

    # Check PostgreSQL
    if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U whisper -d whisper >/dev/null 2>&1; then
        log "  PostgreSQL: healthy"
    else
        warn "  PostgreSQL: unhealthy"
        all_ok=false
    fi

    # Check backend
    if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
        log "  Backend:    healthy"
    else
        warn "  Backend:    unhealthy (may still be starting)"
        all_ok=false
    fi

    $all_ok
}

cmd_backup() {
    require_env
    local backup_dir="${PROJECT_ROOT}/backups"
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="${backup_dir}/whisper_${timestamp}.sql.gz"

    mkdir -p "$backup_dir"

    log "Backing up PostgreSQL database..."
    docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U whisper -d whisper | gzip > "$backup_file"
    log "Backup saved to: $backup_file"
    log "Backup size: $(du -h "$backup_file" | cut -f1)"
}

main() {
    local cmd="${1:-help}"
    shift || true

    case "$cmd" in
        build)   cmd_build "$@" ;;
        up)      cmd_up "$@" ;;
        down)    cmd_down "$@" ;;
        restart) cmd_restart "$@" ;;
        logs)    cmd_logs "$@" ;;
        status)  cmd_status "$@" ;;
        migrate) cmd_migrate "$@" ;;
        health)  cmd_health "$@" ;;
        backup)  cmd_backup "$@" ;;
        help|*)  usage ;;
    esac
}

main "$@"
