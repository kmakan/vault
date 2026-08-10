#!/usr/bin/env bash
# Run the Rust email E2E test (replaces the old Python email_test.py).
# Credentials: scripts/.email_test_env is gitignored (source: ~/Notes/Projects/mailcipher/mails.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.email_test_env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ $ENV_FILE not found. Create it from .email_test_env.example" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

cd "$SCRIPT_DIR/../vault-client"
exec cargo test --test email_e2e --test key_exchange_e2e --test vault_aad_e2e -- --ignored --nocapture