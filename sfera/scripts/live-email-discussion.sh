#!/usr/bin/env bash
# Живой SMTP/IMAP тест двух отдельных экземпляров Sfera.
# Только Alice/Bob из scripts/.email_test_env; мессенджер и его аккаунты не читаются.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="${TMPDIR:-$HOME/.hermes/cache/scratch}/sfera-live-discussion"
mkdir -p "$RUN/owner" "$RUN/commenter"
export SFERA_LIVE_POST="$RUN/owner/post.json"
export SFERA_LIVE_AUTHOR="$RUN/owner/author.link.json"
export SFERA_LIVE_PEER_LINK="$RUN/commenter/peer.link.json"
export SFERA_LIVE_IMAP_SERVER=imap.gmail.com
export SFERA_LIVE_STARTED="$(python3 -c 'import time; print(time.strftime("%d-%b-%Y", time.gmtime()))')"
export SFERA_LIVE_IMAP_PORT=993
export SFERA_LIVE_SMTP_SERVER=smtp.gmail.com
export SFERA_LIVE_SMTP_PORT=587

run_phase() {
  local phase="$1" person="$2" root="$3" peer="$4"
  if [[ -n "${SFERA_LIVE_ONLY_PHASE:-}" && "$phase" != "$SFERA_LIVE_ONLY_PHASE" ]]; then return; fi
  local email_var="VAULT_TEST_${person}_EMAIL" pass_var="VAULT_TEST_${person}_PASS"
  case "$peer" in
    VAULT_TEST_ALICE_EMAIL|VAULT_TEST_BOB_EMAIL) ;;
    *) echo 'Only the isolated Alice/Bob test mailboxes are allowed' >&2; exit 2 ;;
  esac
  local envs
  envs="$(python3 - "$ROOT/scripts/.email_test_env" "$email_var" "$pass_var" "$peer" <<'PY'
import os, sys
values = {}
with open(sys.argv[1]) as source:
    for line in source:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.removeprefix('export ').strip()] = value.strip()
for name in sys.argv[2:]:
    value = values.get(name)
    if not value:
        raise SystemExit('missing test credential')
    # execve передаёт значение как один аргумент, включая пробелы.
    print(f'{name}={value}')
PY
)"
  while IFS= read -r line; do export "${line?}"; done <<< "$envs"
  export SFERA_LIVE_PHASE="$phase" SFERA_LIVE_ROOT="$root"
  echo "live phase=$phase"
  if [[ "$peer" == "VAULT_TEST_ALICE_EMAIL" ]]; then
    export SFERA_LIVE_PEER_ROOT="$RUN/owner"
  else
    export SFERA_LIVE_PEER_ROOT="$RUN/commenter"
  fi
  export SFERA_LIVE_EMAIL="${!email_var}" SFERA_LIVE_PASSWORD="${!pass_var}"
  local peer_email
  peer_email="${!peer}"
  export SFERA_LIVE_PEER_EMAIL="$peer_email"
  cargo run --quiet --manifest-path "$ROOT/sfera/src-tauri/Cargo.toml" --bin live_discussion
}

run_phase init-commenter BOB "$RUN/commenter" VAULT_TEST_ALICE_EMAIL
run_phase init-owner ALICE "$RUN/owner" VAULT_TEST_BOB_EMAIL
run_phase owner ALICE "$RUN/owner" VAULT_TEST_BOB_EMAIL
run_phase commenter BOB "$RUN/commenter" VAULT_TEST_ALICE_EMAIL
run_phase owner-receive ALICE "$RUN/owner" VAULT_TEST_BOB_EMAIL
run_phase owner-restart-receive ALICE "$RUN/owner" VAULT_TEST_BOB_EMAIL
run_phase commenter-receive BOB "$RUN/commenter" VAULT_TEST_ALICE_EMAIL
run_phase commenter-restart-restore BOB "$RUN/commenter" VAULT_TEST_ALICE_EMAIL
