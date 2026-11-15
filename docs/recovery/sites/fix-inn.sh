#!/usr/bin/env bash
# Замена ИНН на сайте и в заметках — одной командой.
#
# Зачем: ИНН оператора печатается в реквизитах, оферте, политике, /pd.html,
# pricing и pay (и в их EN-версиях). Если в значении опечатка — её надо
# исправить ОДИН раз здесь, а не по двадцати местам руками.
#
# Использование: ./fix-inn.sh <новый_ИНН>
set -euo pipefail
NEW="${1:-}"
OLD="774338097699"
if [ -z "$NEW" ]; then
  echo "usage: $0 <новый_ИНН>" >&2
  exit 2
fi
if [ "$NEW" = "$OLD" ]; then
  echo "значение не изменилось — нечего делать" >&2
  exit 2
fi

SITE=/home/maksim/vault-site
NOTES=/home/maksim/Notes/Projects/mailcipher

echo "== замена $OLD → $NEW"
# сайт: все файлы (RU и EN)
grep -rl "$OLD" "$SITE" --include="*.html" --include="*.md" | while read -r f; do
  sed -i "s/$OLD/$NEW/g" "$f"
  echo "  сайт: ${f#$SITE/}"
done
# заметки
if [ -d "$NOTES" ]; then
  grep -rl "$OLD" "$NOTES" --include="*.md" | while read -r f; do
    sed -i "s/$OLD/$NEW/g" "$f"
    echo "  заметки: ${f#$NOTES/}"
  done
fi

echo "== выкладка сайта"
rsync -az "$SITE"/{index.html,privacy.html,requisites.html,offer.html,pricing.html,pay.html,pd.html,terms.html} server:sites/vault-msg/ru/
rsync -az "$SITE"/en/ server:sites/vault-msg/en/

echo "== проверка на живых сайтах"
for u in https://vault-msg.ru/requisites.html https://vault-msg.ru/privacy.html https://vault-msg.ru/pd.html https://vault-msg.tech/requisites.html https://vault-msg.tech/pd.html; do
  n=$(curl -s "$u?cb=$RANDOM" | grep -c "$NEW")
  o=$(curl -s "$u?cb=$RANDOM" | grep -c "$OLD" || true)
  echo "  $u: новое=$n старое=$o"
done
echo "готово"
