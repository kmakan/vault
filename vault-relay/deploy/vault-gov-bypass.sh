#!/usr/bin/env bash
# Vault: обход Amnezia для гос-хостов (ФНС lknpd, РКН, Госуслуги).
# Зачем: при поднятом туннеле маршруты 0.0.0.0/1 + 128.0.0.0/1 и DNS туннеля
# перекрывают доступ к lknpd.nalog.ru — чеки НПД не оформляются (штраф 20%).
# Решение: /32-маршруты через ЛОКАЛЬНЫЙ шлюз в main-таблице (longest-prefix
# выигрывает у /1) + записи в /etc/hosts (DNS туннеля для .ru gov не работает).
# Идемпотентно: можно запускать сколько угодно раз. Не трогает чужие маршруты.
set -uo pipefail

HOSTS_LIST="lknpd.nalog.ru lknpd.gi.nalog.ru lkfl.nalog.ru www.nalog.ru pd.rkn.gov.ru esia2.rkn.gov.ru gosuslugi.ru esia.gosuslugi.ru"
LOG=/var/log/vault-gov-bypass.log
HOSTS_FILE=/etc/hosts
STATE_DIR=/var/lib/vault-gov-bypass
STATE="$STATE_DIR/net"
MARK_BEGIN="# BEGIN vault-gov-bypass (managed by vault-gov-bypass.service)"
MARK_END="# END vault-gov-bypass"
mkdir -p "$STATE_DIR"

log(){ echo "$(date -Is) $*" >> "$LOG" 2>/dev/null || true; }

# --- шлюз и интерфейс локальной сети (не туннель) ---
read -r GW DEV < <(ip route show default 2>/dev/null | awk '!/amn0|wg|tun/ {print $3, $5; exit}')
if [ -z "${GW:-}" ] || [ -z "${DEV:-}" ]; then
  # туннель мог заменить default — берём сохранённый или ищем маршрут в LAN
  if [ -f "$STATE" ]; then read -r GW DEV < "$STATE"; fi
fi
if [ -z "${GW:-}" ] || [ -z "${DEV:-}" ]; then
  read -r GW DEV < <(ip route show 2>/dev/null | awk '$1 ~ /^192\.168\./ && $2=="dev" {print $3, $1; exit}')
fi
if [ -z "${GW:-}" ] || [ -z "${DEV:-}" ]; then
  log "SKIP: не найден локальный шлюз"; exit 0
fi
printf '%s %s\n' "$GW" "$DEV" > "$STATE"

# --- резолв (локально; при поднятом VPN DNS туннеля не отвечает → через сервер) ---
resolve(){
  local h="$1" ips
  ips=$(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' | sort -u)
  if [ -z "$ips" ]; then
    ips=$(runuser -u maksim -- ssh -o BatchMode=yes -o ConnectTimeout=8 server "getent ahostsv4 $h" 2>/dev/null | awk '{print $1}' | sort -u)
  fi
  printf '%s\n' "$ips"
}

block="$MARK_BEGIN"
all_ips=""
for h in $HOSTS_LIST; do
  ips=$(resolve "$h")
  if [ -z "$ips" ]; then log "WARN: не резолвится $h"; continue; fi
  for ip in $ips; do
    block="$block
$ip $h"
    all_ips="$all_ips $ip"
  done
done
block="$block
$MARK_END"

# --- переписать управляемый блок в /etc/hosts ---
tmp=$(mktemp)
awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
  $0==b{skip=1;next} $0==e{skip=0;next} !skip{print}
' "$HOSTS_FILE" > "$tmp" 2>/dev/null
printf '%s\n' "$block" >> "$tmp"
cat "$tmp" > "$HOSTS_FILE"
rm -f "$tmp"

# --- маршруты /32 через локальный шлюз ---
n=0
for ip in $(printf '%s\n' $all_ips | sort -u); do
  if ip route replace "$ip/32" via "$GW" dev "$DEV" 2>>"$LOG"; then
    n=$((n+1))
  else
    log "WARN: маршрут $ip не добавлен"
  fi
done

resolvectl flush-caches >/dev/null 2>&1 || true
log "OK: hosts-блок обновлён, /32 маршрутов: $n, gw=$GW dev=$DEV"
