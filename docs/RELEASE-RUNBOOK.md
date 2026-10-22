# Релизный runbook — Vault (21.10.2026)

Пошаговый порядок выпуска версии. Собран из того, что реально ломалось;
каждый шаг — с проверкой, потому что «собралось» и «доехало» — разные вещи.

**Урок, из-за которого этот документ:** 21.10.2026 четыре релиза
(0.1.243/244/246/247) показывали «Source code» чужого коммита. На GitHub с
17.09 лежал один «хвостовой» тег, и из-за него КАЖДЫЙ следующий пуш тега
версии отклонялся («метка уже существует») — а это сообщение выглядит как
мелочь. Теперь это гейт: `vault-desktop/scripts/release-tag-check.mjs`.

---

## 0. Что где лежит (карта)

```
~/whisper/
├── vault-desktop/            # Tauri 2.0 (Rust + Vue 3) — ЕДИНСТВЕННЫЙ источник APK
│   ├── src/                  # фронт (App.vue, features/*.js, адаптеры правил)
│   ├── src-tauri/            # мост Rust (команды vault_*)
│   ├── scripts/              # смоуки, гейты, скрипты сборки и приёмки
│   └── src-tauri/target/     # кэш сборки Rust (debug 23 ГБ, aarch64 2.5 ГБ, release 4.7 ГБ)
├── vault-client/             # Rust-ядро (CLI + e2e) — общие крейты
├── docs/                     # ADR, стратегия тестирования, этот runbook
└── graphify-out/             # граф знаний (пересобирается graphify update .)

/home/maksim/vault-site/      # сайты: vault-msg.ru (RU) и vault-msg.tech (EN)
/home/maksim/Notes/Projects/mailcipher/   # STATUS.md + next.md (журнал проекта)
```

**Удалено 21.10.2026:** `vault-android/` — заброшенная копия 0.1.20 (26 ГБ,
в APK не поставлялась, но выглядела как вторая сборка Android). Плюс
неиспользуемые ABI-таргеты сборки (x86_64/i686/armv7 — APK собирается только
под aarch64, 10.5 ГБ) и старые ассеты на сайте (оставлены последние версии).

**Правило:** APK собирается **только** из `vault-desktop/src`. Если где-то
появился второй Android-проект — это мусор, а не запасной вариант.

---

## 1. Подготовка

```bash
cd ~/whisper
git status --short          # должно быть пусто (иначе — сначала закоммитить)
git rev-list --left-right --count github/refactor/adr001-stage4...HEAD   # 0 0
git rev-list --left-right --count gitverse/refactor/adr001-stage4...HEAD # 0 0
```

## 2. Проверки (обязательно перед сборкой)

```bash
cd ~/whisper/vault-desktop
npm run quality             # build + мутации JS + покрытие + гигиена + плотность + Rust-мутации (~4 мин)
npm run audit:arch          # метрики ADR-005: ctx, решения о протоколе, методы App.vue
cd ~/whisper && ./scripts/test-all.sh   # крейты: core + client + desktop
```

Гейты, которые обязаны быть зелёными: `js-logic-ratchet` (потолок не
распускается), `mutation-density` (каждый модуль >40 строк имеет набор
мутаций; дыры только сокращаются), `feature-import-gate` (фича не знает про
фичу), `feature-coverage-gate` (у каждой фичи есть смоук).

## 3. Версия

```bash
# versionCode = major*1e6 + minor*1e3 + patch  (напр. 0.1.250 → 1249+1)
python3 - <<'EOF'
p='vault-desktop/src-tauri/tauri.conf.json'
s=open(p,encoding='utf-8').read()
s=s.replace('"version": "0.1.249"','"version": "0.1.250"',1)
open(p,'w',encoding='utf-8').write(s)
EOF
```

**Версия на телефоне должна быть СТРОГО ниже** — иначе `install -r` молча
оставит старую, и приёмка проверит старый код.

```bash
adb shell dumpsys package com.vault.vault | grep versionName
```

## 4. Сборка APK

```bash
cd ~/whisper/vault-desktop
./scripts/build-android-apk.sh     # ~9 мин (компиляция Rust под aarch64)
# артефакт: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

## 5. Приёмка на устройстве

```bash
# Устройство: IP:порт меняется. Если не подключается — ищи по mDNS:
adb devices | grep adb-tls
cd ~/whisper/vault-desktop
VAULT_SER="<host:port>" ./scripts/device-accept-apk.sh
```

Скрипт: подпись (md5 APK vs keystore) → `install -r` → запуск → крэш-маркеры →
рестарты ×3 → CDP-приёмка (19 проверок, `scripts/device-accept.mjs`).

**Публиковать можно только при `echo $? = 0` у самого скрипта.** До 23.10 это
было иллюзией: шаг CDP был написан как `node device-accept.mjs 2>&1 | tail -4`,
пайп съедал код возврата node, и приёмка завершалась с нулём даже на красных
пробах (на 0.1.259 так и вышло: необработанное исключение в странице + «exit=0»).
Тихий пропуск «приложение не запущено — CDP-пробы пропущены» теперь тоже провал. И `foreground` в цикле рестартов мерился по
`mResumedActivity`, которой на Android 15 нет (строка называется
`topResumedActivity` / `ResumedActivity:`) — здоровое приложение выглядело как
`foreground=0`; теперь грепается любая форма.

Плюс отдельная проверка консоли WebView (ошибки JS = «тихий» дефект):

```bash
PID=$(adb -s "$SER" shell pidof com.vault.vault | tr -d '\r')
adb -s "$SER" forward tcp:9224 localabstract:webview_devtools_remote_$PID
node scripts/device-accept.mjs 2>&1 | tail -3
```

**Публиковать только ПРИНЯТУЮ на устройстве версию.**

### 5а. Приёмка экрана платного тарифа Pro (0.1.254+)

Стандартная приёмка (19 CDP-проверок) не покрывает покупку: она не видит
настроек. Поэтому тариф проверяется отдельно, вручную, по чек-листу.

**Подготовка сервера (временно, на время приёмки!).** Платёжный провайдер
в проде ВЫКЛЮЧЕН (нет ИП → нет ЮKassa), и все платёжные роуты честно
отвечают `402 {"error":"checkout disabled"}`. Чтобы проверить весь путь,
включается тестовый провайдер (оплата подтверждается мгновенно):

```bash
# на сервере: в env релея добавить строку и перезапустить
ssh server 'echo "VAULT_RELAY_PAYMENTS=test" >> ~/vault-relay/env
  echo "$SUDO_PASSWORD" | sudo -S systemctl restart vault-relay'
# проверить: curl -X POST .../relay/purchase/checkout -d '{"plan":"pro","months":12,"fp":"..."}'
```

⚠️ **ВКЛЮЧЁННЫЙ ТЕСТОВЫЙ ПРОВАЙДЕР В ПРОДЕ РАЗДАЁТ БЕСПЛАТНЫЕ PRO
ТОКЕНЫ ВСЕМ ПОДРЯД.** После приёмки — выключить (удалить строку из env,
перезапустить, проверить, что `/relay/purchase/checkout` снова отвечает 402).

**Чек-лист на устройстве:**

1. Настройки → раздел «Эксплуатация»/«Прочее» → секция **«Тариф Pro»**
   (она стоит ПЕРЕД блоком релея) — видно состояние и кнопку.
2. Бесплатный тариф: строка «Бесплатный тариф: 100 конвертов/день», кнопка
   **«Купить Pro»**.
3. Нажать «Купить Pro» → через несколько секунд состояние меняется на
   «Pro активен», ниже — «до <дата> · устройств 1/3», кнопка — «Продлить».
4. **В шапке чата** (открыть любой чат) — маленький бейдж **PRO** рядом с
   индикатором шифрования.
5. Токен выпущен: в разделе «Расширенные настройки» релея у нашего релея
   появился `myToken` (тот же, что выдала покупка).
6. Ошибка честная: если провайдер выключен, «Купить Pro» показывает
   сообщение «Покупка пока недоступна (платёжный провайдер не подключён)»,
   а НЕ «оплачено».
7. Офлайн-грейс: выключить сеть (авиарежим) → состояние Pro остаётся
   (7 дней по последнему подтверждённому ответу сервера).
8. Консоль WebView: ошибок JS нет (иначе «тихий» дефект).

**Проверка на сервере после приёмки:**

```bash
ssh server 'grep VAULT_RELAY_PAYMENTS ~/vault-relay/env || echo "провайдер выключен — верно"'
```

## 6. Сборка десктопа

```bash
cd ~/whisper/vault-desktop && npx tauri build --bundles deb
# артефакт: src-tauri/target/release/bundle/deb/Vault_<версия>_amd64.deb
```

## 6а. Деплой релея (vault-relay) — серверная часть

Релей — продовый сервис доставки (пуши, каналы, будилки FCM/ntfy). Собран
из `vault-relay/` и крутится на `server` как `vault-relay.service`
(WorkingDirectory `~/vault-relay`, порт 127.0.0.1:8091, nginx проксирует
`/relay/*` наружу).

### ГЛАВНОЕ ПРАВИЛО: собирать НА СЕРВЕРЕ, а не копировать локальный бинарь

22.10.2026 локально собранный бинарь (`cargo build --release`) был скопирован
на сервер — и упал: `GLIBC_2.32/2.33/2.34 not found` (на сервере glibc 2.31,
на рабочей машине — новее). Релей лежал ~2 минуты, пока не откатили на
бэкап. Rust-бинарь НЕ переносится между машинами с разной glibc.

Правильный путь: rsync исходников на сервер → сборка там → подмена бинаря.

```bash
# 1) исходники на сервер (без target/ и .git/)
cd ~/whisper/vault-relay
rsync -az --delete --exclude 'target' --exclude '.git' ./ server:~/vault-relay-build/

# 2) сборка НА СЕРВЕРЕ (cargo там есть, но не в PATH неинтерактивной сессии)
ssh server 'cd ~/vault-relay-build && PATH=$HOME/.cargo/bin:$PATH cargo build --release --bin vault-relay'

# 3) подмена: сначала копия во временный файл, потом mv
#    (`cp` прямо поверх работающего бинаря → "Text file busy")
ssh server 'cd ~/vault-relay
  STAMP=$(date +%m%d%H%M)
  cp -a vault-relay vault-relay.bak-$STAMP
  cp -a vault-relay-state.json vault-relay-state.json.bak-$STAMP
  cp ~/vault-relay-build/target/release/vault-relay vault-relay.new
  chmod +x vault-relay.new
  mv -f vault-relay.new vault-relay
  echo "$SUDO_PASSWORD" | sudo -S systemctl restart vault-relay'

# 4) проверка: сервис жив, старые роуты работают, новые — по контракту
ssh server 'systemctl is-active vault-relay
  curl -s -m 5 http://127.0.0.1:8091/health
  curl -s -m 5 -w " [%{http_code}]\n" -X POST http://127.0.0.1:8091/relay/purchase/checkout \
    -H "Content-Type: application/json" -d "{\"plan\":\"pro\",\"months\":12,\"fp\":\"testfp\"}"'
```

`sudo` через SSH требует пароль: `echo "$SUDO_PASSWORD" | sudo -S ...`, где
`SUDO_PASSWORD` берётся из `~/.hermes/.env` ЛОКАЛЬНО и подставляется в
команду (на сервере этой переменной нет).

### Платёжный провайдер

По умолчанию платежи ВЫКЛЮЧЕНЫ (`VAULT_RELAY_PAYMENTS` не задан) — все
платёжные роуты отвечают `402 {"error":"checkout disabled"}`. Это честное
состояние: реального провайдера (ЮKassa) нет до ИП (канбан ORG-2). Для
приёмки на устройстве провайдера включают на ВРЕМЯ проверки
(`VAULT_RELAY_PAYMENTS=test` → `TestProvider`, оплата подтверждается
мгновенно) и выключают сразу после: включённый тестовый провайдер в проде
раздаёт бесплатные Pro-токены всем подряд.

### Откат

```bash
ssh server 'cd ~/vault-relay
  cp -a vault-relay.bak-<STAMP> vault-relay.new && mv -f vault-relay.new vault-relay
  echo "$SUDO_PASSWORD" | sudo -S systemctl restart vault-relay'
```

Бэкапы бинаря и файла состояния лежат рядом с живыми файлами
(`vault-relay.bak-<MMDDHHMM>`, `vault-relay-state.json.bak-<MMDDHHMM>`).
Файл состояния совместим назад: новые поля помечены `serde(default)`, старый
файл читается без паники (проверено тестом `test_old_state_file_without_new_fields_loads`).

## 7. Сайты

```bash
cd /home/maksim/vault-site
# 1) положить ассеты
cp ~/whisper/vault-desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
   releases/vault-<версия>.apk
cp releases/vault-<версия>.apk releases/vault-<версия>-arm64.apk
# 2) tar.gz с десктопом
cd ~/whisper/vault-desktop/src-tauri/target/release
rm -rf /tmp/pkg && mkdir -p /tmp/pkg/vault-<версия>-linux-x86_64
cp vault-desktop /tmp/pkg/vault-<версия>-linux-x86_64/
cd /tmp/pkg && tar czf /home/maksim/vault-site/releases/vault-desktop-<версия>-linux-x86_64.tar.gz vault-<версия>-linux-x86_64
# 3) latest.json / latest-en.json / index.html (версия + дата)
# 4) выкладка (rsync С -R, иначе ломается структура каталогов)
rsync -R -avz index.html latest.json latest-en.json \
  releases/vault-<версия>.apk releases/vault-<версия>-arm64.apk \
  releases/vault-desktop-<версия>-linux-x86_64.tar.gz server:sites/vault-msg/ru/
rsync -avz en/index.html server:sites/vault-msg/en/
rsync -avz latest-en.json server:sites/vault-msg/en/latest.json
# 5) сверка живыми curl'ами (CDN кэширует по имени — добавляй ?cb=)
curl -sI "https://vault-msg.ru/releases/vault-<версия>.apk?cb=$(date +%s)" | grep -i content-length
curl -s "https://vault-msg.ru/releases/vault-<версия>.apk?cb=$(date +%s)" | sha256sum
sha256sum releases/vault-<версия>.apk
# 6) ГЕЙТ целостности публикации — обязательный шаг, а не «по желанию»
node ~/whisper/vault-desktop/scripts/release-site-check.mjs <версия> --live
```

**Зачем шаг 6.** Кнопка «Обновить» в приложении ведёт НЕ на сайт, а на
`apk_url`/`desktop_url` из `latest.json`. На 0.1.258 обновили `version` и
`changelog`, а ссылки оставить старыми — и живое кольцо было: «доступна
версия 0.1.258», по кнопке пользователь идёт качать 0.1.255. Гейт требует,
чтобы версия и оба URL в `latest.json`/`latest-en.json` называли ОДНУ сборку,
чтобы ассеты лежали в `releases/`, и (с `--live`) чтобы скачанный APK совпадал
по sha256 с локальным. Самопроверка гейта — `--selftest` (7 случаев, включая
«version обновили, apk_url забыли» и «хвост 0.1.25 не считается 0.1.258»).

**EN-сайт = корень `vault-msg.tech`** (без `/en/` — `/en/` даёт 404).

**Свежесть десктоп-ассета доказывается ПЕРЕСБОРКОЙ + sha256, а не mtime и не
поиском строк в бинаре** (правило появилось 23.10 после ложного «релиз 0.1.258
собран из устаревшего ассета»):
* имена чанков rolldown (`index-BEv6lq7N.js`) НЕ содержат хэш содержимого —
  по имени чанка нельзя сказать, свежие ли ассеты внутри;
* Linux-бинарь Tauri хранит встроенные ассеты сжатыми — `grep`/`strings` по
  нему не находит ни наших строк, ни имён чанков, и «не нашёл» ничего не значит;
* mtime обманывает: `npm run build` перелистывает время в `dist/`, а бинарь
  остаётся прежним, и наоборот — пересборка без изменений даёт новый файл с
  идентичным содержимым.
Порядок проверки: `npx tauri build` (или `--no-bundle`) после финального
`npm run build` → собрать tar.gz → `sha256sum` локального бинаря и скачанного с
сайта файла; совпали — ассет тот, что в сборке. Отдельно фиксируется время
сборки бинаря (`stat`) против времени последней правки в `src/`.

## 8. GitHub-релиз

```bash
cd ~/whisper
git tag -a v<версия> -m "Vault <версия> — <суть>"
git push gitverse v<версия>
git push github  v<версия>      # если скажет «метка уже существует» — ЭТО ОШИБКА, см. п.9
```

Релиз создаётся скриптом (сырое тело — multipart ломает файл):

```bash
python3 /tmp/opencode/gh_release.py <версия>   # body берётся из /tmp/opencode/release_body_<версия>.md
```

Ассеты: APK, tar.gz десктопа, .deb. Проверка: скачать и сверить sha256 с
локальной сборкой.

## 9. Проверка тегов (обязательно)

```bash
cd ~/whisper/vault-desktop && node scripts/release-tag-check.mjs
```

Если тег расходится с коммитом релиза:

```bash
git push <remote> :refs/tags/<tag>     # удалить неверный
git push <remote> <tag>                # поставить правильный
# и пересоздать релиз на GitHub (старый «отвалится» в untagged-… и потеряет
# ассеты) — скрипт gh_release.py это умеет
```

## 10. Хозяйство после релиза

```bash
cd ~/whisper
# документация: ADR-005 / docs/testing / журнал / STATUS — в том же коммите, что и код
hermes kanban --board vault comment t_XXXXXXXX "…доказательства…"
# graphify и OpenViking
graphify update . --force
env -u PYTHONPATH ~/.openviking-venv/bin/ov add-resource <файл> \
  --parent viking://resources --tags project=vault,topic=…,date=…
# коммит + push в оба ремоута
git add -A docs vault-desktop vault-client && git commit -m "…"
git push github refactor/adr001-stage4 && git push gitverse refactor/adr001-stage4
```

---

## Чего НЕ делать (уроки)

* **НЕ копировать Rust-бинарь на сервер из другой машины.** glibc на сервере
  2.31, на рабочей машине новее — бинарь не стартует (`GLIBC_2.32 not found`),
  и сервис лежит до ручного отката. Собирать НА сервере: `rsync` исходников +
  `cargo build --release` там (см. §6а).
* **НЕ делать `cp` поверх работающего бинаря** — «Text file busy». Сначала
  копия во временный файл, потом `mv`.

1. **Не публиковать непроверенную на устройстве версию.** Приёмка — часть
   релиза, а не «после».
2. **Не поднимать версию на телефоне раньше, чем в `tauri.conf.json`.**
   `install -r` при равной версии молча ничего не делает.
3. **«hint: метка уже существует» — это ошибка, а не успех.** Тег указывает на
   чужой коммит → «Source code» в релизе ведёт не туда.
4. **Не поднимать `version` в конфиге, не подняв её в `latest.json`** (и
   наоборот) — сайт и релиз должны называть одну версию.
5. **Не заливать ассеты multipart'ом** — GitHub API принимает СЫРОЕ тело, иначе
   в файл попадает мусор (урок 0.1.243).
6. **Не публиковать sha, не сверив скачанный файл** — CDN кэширует по имени,
   сверять с `?cb=`.
7. **Не «чинить» метрику, подгоняя прибор.** Уточнять прибор можно и нужно,
   но только когда уточнение делает его честнее (урок с двойным счётом
   протокольного долга) — и с записью в ADR, почему.
8. **Не оставлять рядом две сборки Android.** Одна — `vault-desktop`.
9. **Не удалять «старые» каталоги, не проверив, что они не нужны** — сначала
   `git ls-files <путь>` и `du -sh`, потом удаление, потом коммит.
10. **Не запускать `cargo clean` в рабочем `target`** без нужды: там 23 ГБ
    инкрементального кэша, и его пересборка стоит минут пять каждый раз.
