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
├── vault-core/               # общее ядро правил (identity, key_store, settings,
│                             # relay, transport) — от него зависят и CLI, и мост
├── vault-relay/              # сервер: релей, квоты по тарифам, платёжный провайдер
├── docs/                     # ADR, стратегия тестирования, этот runbook
└── graphify-out/             # граф знаний (пересобирается graphify update .)

/home/maksim/vault-site/      # сайты: vault-msg.ru (RU) и vault-msg.tech (EN)
/home/maksim/Notes/Projects/mailcipher/   # STATUS.md + next.md (журнал проекта)
                              # STORE-READINESS-2026-10-11.md — чек-лист подачи (§5б)
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
npm run quality             # build + мутации JS + покрытие + гигиена + плотность + Rust-мутации
npm run audit:arch          # метрики ADR-005: ctx, решения о протоколе, методы App.vue
cd ~/whisper && ./scripts/test-all.sh   # крейты: core + client + desktop
```

Про качество целиком, записано 26.10 (чтобы не выяснять это в день релиза):
`gate:rust-mutations` — 927 мутаций в 79 наборах (после 26.10; на 873 в 74 был
снят замер полного прогона на разогретом `target/`: **48 минут**, 19:24 → 20:12),
а не «~4 мин» у команды `quality`. Шаг релиза его не выдерживает, и обрывать его посреди мутации опасно:
в рабочем дереве остаётся мутант (увидено дважды — `backup_import.rs`,
`contacts.rs`). Поэтому полный прогон гоняется ОТДЕЛЬНЫМ заданием на чистом
дереве (долг, канбан), а в цикле релиза обязательны: `gate:parse`,
`gate:mutation-patterns` (якоря всех наборов), `gate:opus-numbers` (протокольные
числа Opus — одна копия в ядре), `build` (все JS-гейты + смоуки + vite),
`gate:mutations` (JS), `gate:hygiene`, `gate:mutation-density`, `gate:jni-keep`
(провода Rust→Kotlin: keep-правило + статик-мост на каждую точку JNI) — и прогон
НАБОРОВ,
которые касаются именно этой правки (`--set <набор>`, мерка до/после). Пока
полный прогон идёт, `gate:mutation-patterns` отказывается работать (в дереве
живёт мутант) — новый набор в такую паузу сверяют счётчиком совпадений по
тексту файла. Если изменён код звонка, «зелёный quality» не заменяет приёмку на
устройстве: что метод Доедет — известно с хоста (гейт + DEX), а что он ИГРАЕТ в
канале рингтона — знает только устройство.

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

Скрипт заканчивается не «собралось», а двумя сверками артефакта: версия внутри
APK против версии дерева (`versionCode = major*1e6 + minor*1e3 + patch`, иначе
`install -r` молча оставит старую сборку) и **`node scripts/dex-jni-check.mjs
<apk>`** — каждая точка JNI, которую зовёт Rust, обязана лежать в `classes.dex`
на вызываемом классе как `static` с точным дескриптором. Это тот шаг, из-за
которого 28.10 приёмка 0.1.284 провалилась по звуку звонка: R8 в release-сборке
вырезал статик-мост `@JvmStatic` под `playCallSound`/`stopCallSound` (из Java их
никто не зовёт), JNI дал `NoSuchMethodError`, и на хосте всё было зелено —
`cargo check --target aarch64` собирает Kotlin как есть. Мост до сборки держит
`npm run gate:jni-keep` (13 точек × две стороны: keep-правило + `companion
object`/`@JvmStatic`), правда после сборки — DEX. Подробности — ADR-005, партия 5n.

## 5. Приёмка на устройстве

```bash
# Устройство: IP:порт меняется. Если не подключается — ищи по mDNS:
adb devices | grep adb-tls
cd ~/whisper/vault-desktop
VAULT_SER="<host:port>" ./scripts/device-accept-apk.sh
```

Скрипт: подпись (md5 APK vs keystore) → `install -r` → запуск → крэш-маркеры →
вердикт входа → рестарты (по умолчанию ×3) → CDP-приёмка (19 проверок,
`scripts/device-accept.mjs`).

### 5.1. Приёмка поверх БОЕВОГО аккаунта (правило #8 в AGENTS.md)

На тест-устройстве живёт рабочий ящик, а восстановление входа — дни: Яндекс
отвечает `AUTHENTICATIONFAILED` на всплеск повторов даже с валидным паролем.
Каждый запуск приложения = новый вход IMAP, поэтому «рестарты ×3» — это четыре
входа подряд. Для такой приёмки порядок другой, и он поддержан самим скриптом:

```bash
cd ~/whisper/vault-desktop
VAULT_SER="<host:port>" VAULT_ACCEPT_RESTARTS=0 VAULT_ACCEPT_CALL=1 \
  ./scripts/device-accept-apk.sh
```

* `VAULT_ACCEPT_RESTARTS=0` — один запуск вместо четырёх. Дожить без рестартов
  можно: крэш-маркеры, вердикт входа и все CDP-пробы снимаются на первом
  запуске, а повторные входы ничего не измеряют, только рискуют;
* скрипт останавливается сам, если в logcat после первого запуска попался
  отказ входа (`AUTHENTICATIONFAILED`, `IMAP login failed`, `credentials kept`,
  `temporarily blocked`, `invalid credentials`): приложение гасится
  `force-stop`, рестарты не гонятся, код возврата — единица. Это инцидент, а не
  деталь приёмки: повторять попытки нельзя, надо сообщать владельцу;
* `VAULT_ACCEPT_CALL=1` — шаг 7: звонок делает человек (меди-громкость 0,
  рингтон 15), скрипт снимает доказательство из лога сервиса — строку
  `call sound: … ringtoneChannel=true`. Без такой строки приёмка НЕ принята:
  хостовые меры (#71) подтверждают только «имя → класс», а что слышно на
  динамике — знает только устройство;
* то же доказательство снимается ОТДЕЛЬНО, без переустановки и без ещё одного
  входа — `scripts/device-call-proof.sh` (он же печатает `STREAM_RING`/
  `STREAM_MUSIC`, чтобы «не слышно» не путать с «не играет», и отличает отказ
  провода JNI от «не позвонили»). Приложение уже должно бежать и быть
  залогиненным:
  `VAULT_SER=<host:port> VAULT_CALL_WAIT=120 scripts/device-call-proof.sh`,
  а уже снятый захват проверяется без звонка — `VAULT_CALL_LOG=<файл>`.

Порядок действий руками (чтобы не потерять вход): не трогать приложение и не
открывать форму входа до установки; `install -r` ставится поверх, данные и
сохранённые креды остаются; после установки — один запуск и сразу смотреть
вердикт. На сборках старше 0.1.284 неудачный авто-вход ещё и стирал сохранённый
пароль (ветка `login failed` → `delete_credentials`); с #75 вердикт даёт ядро
(`vault::login_failure`), а `delete_credentials` остался только за явным
действием человека.

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
2. Бесплатный тариф: строка «Бесплатный тариф: 100 действий релея в сутки
   (письма и звонки)», кнопка **«Купить Pro»**.
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

## 5б. Подача в магазины (RuStore и Google Play)

Мастер-чеклист всех артефактов и требований —
`~/Notes/Projects/mailcipher/STORE-READINESS-2026-10-11.md` (раздел 9), тексты
листинга — `vault-site/store/LISTING.md`. Здесь только процедура; цифры, статус
кандидата и блок-листы владельца живут в чеклисте, не дублируются.

**Правило:** в сторы идёт только версия, принятая пунктом 5, и оба артефакта
обязаны быть ИЗ ОДНОГО ДЕРЕВА. Если после приёмки в производство вошла хоть одна
правка — версия для подачи следующая, а не та, что уже принята (так случилось с
0.1.271: APK собран утром, правки были вечером).

Правило больше не держится на памяти: `build-android-apk.sh` сравнивает версию
внутри артефакта (APK — `versionName`, бандл — `base/assets/tauri.conf.json`) с
`src-tauri/tauri.conf.json` и падает на расхождении; `device-accept-apk.sh`
делает то же перед установкой. Проверить артефакт на соответствие дереву можно
и без пересборки: `unzip -p <aab> base/assets/tauri.conf.json | grep version`.

**Одно дерево ≠ один файл.** APK и AAB одной версии собираются из одного дерева,
но флаг канала (`VAULT_NO_PURCHASES` → `VITE_NO_PURCHASES`) делает их разными
сборками: `aab` включает его сам, `apk` — нет. Поэтому «принято на устройстве»
значит принято ОБА DOM'а: проба `pro` читает `purchasesAllowed` из живого
компонента и проверяет, что в сборке без покупок нет ни кнопки тарифа, ни входа
в промо-ключ, а в сборке с покупками они есть. Принятый APK не перекрывает
непринятый бандл, и наоборот.

Бандл принимается тем же прогоном, а не на веру по логам сборки — adb файл
`.aab` не ставит, поэтому из НЕГО (именно из того файла, что пойдёт в Play)
собирают установочный APK:

```bash
JAR=$HOME/.local/share/vault/tools/bundletool-all-1.18.3.jar   # sha256 a099cfa1…
mkdir -p /tmp/play-accept
tr -d '\n' < ~/.local/share/vault/keystore-pass.txt > /tmp/.ks && chmod 600 /tmp/.ks
java -jar "$JAR" build-apks --bundle=/home/maksim/vault-releases/<версия>/vault-<версия>.aab \
  --mode=universal --output=/tmp/play-accept/universal.apks \
  --ks=~/.local/share/vault/vault-release.keystore --ks-key-alias=vault \
  --ks-pass=file:/tmp/.ks --key-pass=file:/tmp/.ks
rm -f /tmp/.ks && cd /tmp/play-accept && unzip -o -q universal.apks
VAULT_APK=/tmp/play-accept/universal.apk ./scripts/device-accept-apk.sh
```

Ловушка, из-за которой проверка подписи обязательна: без `--ks` bundletool
молча берёт **отладочный** ключ из `~/.android/debug.keystore`. Подпись шага 2
приёмки тогда не сходится, а поставить такой APK поверх рабочего нельзя без
удаления приложения — то есть без потери данных на тест-устройстве. Пароль не
перечисляется в аргументах (`--ks-pass` не принимает `env:`), поэтому он
временный файл `0600`, который удаляется в той же команде.

```bash
# после успешной приёмки, не меняя дерево:
vault-desktop/scripts/build-android-apk.sh aab   # бандл для Play
mkdir -p /home/maksim/vault-releases/<версия>
cp vault-desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
   /home/maksim/vault-releases/<версия>/vault-<версия>-universal.apk
cp vault-desktop/src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab \
   /home/maksim/vault-releases/<версия>/vault-<версия>.aab
cd /home/maksim/vault-releases/<версия> && sha256sum *.apk *.aab > SHA256SUMS.txt
```

Подпись — релизный keystore (`~/.local/share/vault/`), MD5 сертификата сверяется
шагом 2 приёмки. Менять ключ нельзя: апдейты у существующих установок сломаются.
Пароль и сам ключ не попадают ни в чат, ни в репозиторий, ни в анкеты сторов.

| | RuStore | Google Play |
|---|---|---|
| Файл | universal APK | AAB (APK не примет) |
| Иконка | 512×512, `vault-desktop/src-tauri/icons/512x512.png` | там же + feature graphic 1024×500 |
| Скриншоты | ≥3, 1080×2400, реальный UI | ≥2, те же |
| Тексты | `vault-site/store/LISTING.md` + `~/Notes/Projects/mailcipher/store-listing-2026-10-06.md` | те же, EN-колонка |
| Политики | https://vault-msg.ru/privacy.html, /terms.html | https://vault-msg.tech/privacy.html, /terms.html |
| Анкеты | возрастной рейтинг, доступ к данным, тест-аккаунт модераторов | Data Safety («не собираем и не делимся»), целевая аудитория, декларация разрешений |
| Платный экран | есть (ЮKassa/Pay SDK) | **нет** — флаг сборки; внешняя оплата цифровых товаров в этой конфигурации запрещена политикой Play |

Перед `submit`, живьем:

```bash
curl -sI https://vault-msg.ru/privacy.html?cb=$(date +%s) | head -1
curl -sI https://vault-msg.tech/terms.html?cb=$(date +%s) | head -1
sha256sum -c /home/maksim/vault-releases/<версия>/SHA256SUMS.txt
```

Скриншоты снимаются только с демо-ящика модераторов и с синтетическими
контактами: на личном аккаунте в кадр попадают реальные адреса собеседников.
Логин и пароль тестового аккаунта передаются в защищённом канале, не в тексте
заявки. Сам факт подачи (и тем более публикация релиза) — только по команде
владельца.

**После подачи.** Отправленный файл уходит на модерацию и до её ответа не
меняется: правка, вошедшая в дерево во время проверки, делает кандидатом
СЛЕДУЮЩУЮ версию (то же правило в начале раздела), а не патч того же артефакта.
Статус читается в консоли стора, внешний анонс и выкладка на сайт — только после
ответа модерации и только по команде владельца. При отказе: комментарий
модератора переносится в чек-лист пунктом с причиной, правка проходит полный
цикл (проверки → сборка → приёмка на устройстве), подаётся версия выше
отклонённой. Отклонение не переписывает историю тегов и релизов.

## 6. Сборка десктопа

```bash
cd ~/whisper/vault-desktop && npx tauri build --bundles deb
# артефакт: src-tauri/target/release/bundle/deb/Vault_<версия>_amd64.deb
```

AppImage — только с `NO_STRIP=1`: `env NO_STRIP=1 npx tauri build --bundles
appimage` (в `scripts/build-desktop.sh --release` это уже стоит). Без него
`linuxdeploy` падает с `failed to run linuxdeploy`, и причина не в нашем коде:
его встроенный `strip` (старый binutils внутри AppImage) не разбирает секцию
`.relr.dyn`, с которой Arch собирает системные библиотеки, и отказ на каждой из
183 библиотек AppDir означает провал бандла. Бинарь стрипнут самой сборкой,
поэтому второй strip ничего не экономит; цена — вес файла: 116 МБ
(`Vault_0.1.285_amd64.AppImage`). На канале выдачи по-прежнему deb + tar.gz
(§7): AppImage собирается, но живой запуск на X11/Wayland не проверялся, и
класть его в релиз без проверки не нужно.

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
