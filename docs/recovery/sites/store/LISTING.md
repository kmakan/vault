# Тексты листинга магазинов (Google Play / RuStore)

Подготовлено 22.10.2026, сверено 29.10.2026. Тексты НЕ обещают того,
чего нет. Звонки — экспериментальная функция, включены (бета); в
описании помечены как бета.

## Короткое описание (до 80 символов)

**RU:** `Мессенджер со сквозным шифрованием. Работает через вашу обычную почту.`
(76 символов)

**EN:** `End-to-end encrypted messenger. Works through your regular email.`
(66 символов)

## Полное описание (до 4000 символов)

### RU

**Vault — мессенджер, которому не нужно проверять доверие.**

Обычные мессенджеры просят довериться: их серверы хранят вашу переписку, а
вы проверяете обещания. Здесь проверять нечего — переписка идёт прямо через
вашу обычную почту, а читается только тем устройством, у которого есть ключ.
Технология сама гарантирует то, что в других мессенджерах приходится
проверять.

**Что это значит на практике**

• Сквозное шифрование: текст шифруется на вашем устройстве и расшифровывается
  только у собеседника. Сервер не видит содержимого — у него нет ключа.
• Никаких серверов хранения: ваша переписка лежит в вашем почтовом ящике.
  Удалите её — она исчезнет оттуда же.
• Никакой телеметрии и аналитики: нет рекламных и аналитических SDK, нет
  профилирования. Обрабатывается только технический минимум, без которого
  письмо не дойдёт, — адрес вашей почты и идентификаторы доставки.
• Открытый код (AGPL-3.0): что именно шифруется и куда уходят метаданные —
  видно в исходниках, а не в обещаниях.
• Ваш аккаунт — это ваш адрес почты. Никакой отдельной регистрации, номера
  телефона и пароля в чужой базе.

**Что умеет**

• Личные чаты и группы с ролями и правами.
• Группы «по ключу»: приглашение шифруется ключом группы, её участников
  нельзя перечислить стороннему наблюдателю.
• Голосовые сообщения, файлы и вложения.
• Голосовые и видеозвонки (бета) — поверх той же почты, без отдельных
  серверов.
• «Заметки для себя» — личные заметки, которые остаются только на устройстве.
• Ускоренная доставка через релей: сообщения идут за секунды, а не за минуты.
  Релей — единственный наш сервер, и он видит только зашифрованные конверты,
  которые стираются через сутки. Без релея всё работает, просто медленнее.
• Режим аварийной защиты: отдельный код входа и код паники, который стирает
  данные, если устройство попало к тем, кто его заставил открыть.

**Чего приложение не делает**

Не читает вашу почту целиком, не показывает рекламу, не собирает контакты в
свою базу, не требует номера телефона, не продаёт данные и не передаёт их
рекламным сетям.

**Какие данные обрабатываются (для карточки магазина).** Адрес вашей
электронной почты (он же вход в приложение); адреса контактов, которые вы
добавляете сами; технические идентификаторы доставки (псевдонимный токен,
производный от отпечатка открытого ключа); IP-адрес и пуш-токен устройства —
для лимитов и уведомлений; сведения об оплате подписки (идентификатор, сумма,
дата); координаты — только если вы сами отправляете SOS-сообщение. Содержание
переписки и ключи шифрования на серверы не передаются. Подробно — в Политике
конфиденциальности и на странице «Обработка персональных данных»
(vault-msg.ru/pd.html).

**Подписка.** Базовый обмен сообщениями бесплатен навсегда. Подписка Pro —
149 ₽/мес или 1 490 ₽/год — ускоряет доставку через релей и повышает
суточные лимиты; Business — 499 ₽/мес или 4 990 ₽/год. Автопродления нет:
по окончании срока тариф возвращается к бесплатным лимитам. Покупок внутри
приложения нет — оплата принимается на официальном сайте vault-msg.ru
(ЮKassa: карты, СБП, SberPay, ЮMoney). Чек — в «Мой налог».

Требуется: Android 8.0+ или современный десктоп.

Подробности о том, как устроено шифрование и что именно хранится, — в
Политике конфиденциальности (см. ссылку в описании).

### EN

**Vault — a messenger you don't have to verify.**

Most messengers ask you to trust them: their servers keep your conversations and
you have to take the promises on faith. Here there is nothing to verify — your
conversation travels through your regular email and can be read only by the device
that holds the key. The technology guarantees what other messengers ask you to
take on trust.

**What that means in practice**

• End-to-end encryption: text is encrypted on your device and decrypted only
  by your contact. The server never sees the content — it has no key.
• No storage servers: your conversation lives in your own mailbox. Delete it
  there and it is gone.
• No telemetry, no analytics: the app collects nothing about you. Only the
  bare technical minimum needed to deliver a message.
• Open source (AGPL-3.0): what exactly gets encrypted and where metadata
  goes is visible in the source, not in promises.
• Your account is your email address. No separate registration, no phone
  number, no password stored in someone else's database.

**What it does**

• Direct chats and groups with roles and permissions.
• Key-based groups: the invitation is encrypted with the group key, so its
  members cannot be listed to an outside observer.
• Voice messages, files and attachments.
• Voice and video calls (beta) — over the same email, no separate servers.
• "Notes to self" — personal notes that stay on your device only.
• Fast delivery through a relay: messages arrive in seconds instead of
  minutes. The relay is our only server, and it sees nothing but encrypted
  envelopes, which are deleted within a day. Without the relay everything
  still works, just slower.
• Duress mode: a separate login code and a panic code that wipes the data if
  the device is forced open by someone else.

**What the app does not do**

It does not read your whole mailbox, show ads, collect contacts into its own
database, or require a phone number.

**Subscription.** Basic messaging is free forever. The Pro subscription —
149 ₽/month or 1,490 ₽/year — accelerates relay delivery and raises daily
limits; Business — 499 ₽/month or 4,990 ₽/year. There is no automatic
renewal: when the term ends, the plan reverts to free limits. The app
contains no purchases — payment is accepted on the official website
vault-msg.ru (YooKassa: cards, SBP, SberPay, YooMoney); the receipt is
generated in the "My Tax" app.

Requires: Android 8.0+ or a modern desktop.

Details on how the encryption works and what is stored are in the Privacy
Policy (link in the listing).

## Скриншоты RuStore (7 шт., пересняты 10.11.2026)

Телефон — 1080×2400, планшет — 1600×2560. Сняты с ЭМУЛЯТОРА на демо-аккаунте
(`vault_msg@bk.ru` ↔ `vault_msg@mail.ru`): аватары — монограммы, в переписке —
живой русский текст. Старые снимки (с фото случайных людей в аватарках и с
отладочными строками вида «Тест после смены почты…», «e2e-проверка…») больше
не используются.

| Файл | Что на экране |
|---|---|
| `01-chats.png` | Список чатов: заметки для себя, контакт, группа |
| `02-chat-1to1.png` | Личный чат: замок/шифрование, бейдж PRO, живая переписка |
| `03-group.png` | Группа «Команда», 2 участника, обмен сообщениями |
| `04-settings-privacy.png` | Настройки → Приватность: E2E, политика, тариф Pro |
| `05-add-contact.png` | Добавление контакта: обмен ключами, QR-код, ID |
| `tablet/t1-tablet-chats.png` | Планшет 10" (1920×1200): двухпанельная раскладка (список + область чата) |
| `tablet/t2-tablet-chat.png` | Планшет 10" (1920×1200): двухпанельная раскладка с открытой перепиской |
| `tablet7/t1-tablet-chats.png` | Планшет 7" (1200×1920): двухпанельная раскладка |
| `tablet7/t2-tablet-chat.png` | Планшет 7" (1200×1920): двухпанельная раскладка с открытой перепиской |


**Размеры.** Телефонные кадры — строго 1080×1920 (9:16): консоль RuStore
кадры 1080×2400 не принимает (проверено подачей 0.1.288), поэтому сняты с
экраном 1080×1920. Планшет 10" — 1920×1200 (как требует Play), 7" — 1200×1920.
Все файлы побайтово разные — дубли консоль не принимает.
Приложение работает и на планшетах: вкладка «Для планшета» в консоли RuStore
должна получить снимки из `tablet/` и `tablet7/`, а в APK 0.1.289 камера/микрофон/GPS
объявлены необязательными (`uses-feature … required="false"`) — до 0.1.289
permission'ы превращали их в обязательные, и магазин исключал планшеты без
камеры или GPS.

Иконка: 512×512 — `vault-site/og-image.png` (проверить квадрат и прозрачность
перед загрузкой; для Play нужен ровно 512×512 PNG без прозрачности).

## Что осталось за пользователем (анкеты магазинов)

1. **Возрастной рейтинг** (анкета): насилие — нет; секс — нет; азартные
   игры — нет. Для мессенджера обычно «3+» / «Everyone».
2. **Data Safety** (Play Console): приложение НЕ собирает и НЕ делится
   пользовательскими данными. Пункт «сбор данных» — «Нет данных собираются».
   Персонализированные рекламные ID — «Нет». Финансовая информация — «Нет».
   Секрет — нет. Ответы пользователей — нет.
3. **Целевая аудитория**: 13+ (или без возрастных ограничений — зависит от
   формулировок в аккаунте Google).
4. **Оплата в приложении**: с 0.1.289 НЕТ ни в одной магазинной сборке —
   и в RuStore, и в Play экран покупки отключён флагом сборки
   (`VITE_NO_PURCHASES=1`); в описании — «оплата на официальном сайте».
   Подача 0.1.288 в RuStore остаётся как есть (экран Pro с внешним
   платежом ЮKassa, комиссия RuStore 0%) — модерация объявлена. С 0.1.289
   объявлять нечего: покупок в сборке нет; модератору в комментарии —
   «in-app purchases: none; subscription is bought on vault-msg.ru».
   (0.1.288 в Play не подаётся: AAB без покупок.)

---

# Google Play — отдельный пакет текстов (сборка БЕЗ покупок)

Решение 01.11.2026: **Play остаётся полностью бесплатным** (Play Billing не
платит на расчётный счёт в РФ, а внешний платёж за цифровые товары запрещён
политикой Play). Поэтому для Play — СВОИ тексты без цен и без упоминания
внешней оплаты: декларация «Приложение содержит цифровые товары/подписки» =
**Нет**, и описание не должно противоречить этому ответу. Монетизация Pro —
только через сайт vault-msg.ru (решение 01.11: и в RuStore сборки без
покупок с 0.1.289, покупка — на сайте, включая крипту для не-₽ плательщиков).

Короткое описание — то же, что выше (RU 76 / EN 66 символов): цен там нет.

## Полное описание для Play — RU (заменяет абзац «Подписка»)

Весь текст RU выше остаётся, КРОМЕ абзаца «**Подписка.** …». Вместо него:

**Стоимость.** Приложение бесплатное и не содержит покупок внутри приложения.
Обмен сообщениями работает сразу после входа; ускоренная доставка через релей
доступна в бесплатных суточных лимитах. Ни рекламы, ни платных функций, ни
подписок в этой версии нет.

## Полное описание для Play — EN (replaces the "Subscription" paragraph)

Keep the full EN text above EXCEPT the "**Subscription.** …" paragraph. Replace it with:

**Cost.** The app is free and contains no in-app purchases. Messaging works
right after you sign in; fast delivery through the relay is available within
free daily limits. There are no ads, no paid features, and no subscriptions in
this version.

## Скриншоты для Play

Набор снят с APK, собранного с `VITE_WEB_PAY=0` (та же фронтовая сборка, что
у AAB): `~/vault-releases/0.1.289/screenshots/play/` — 5 телефонных
(1080×2400) + 2 планшетных (1600×2560).

Для Play **не используется** `04-settings-privacy.png`: на экране тарифа видна
кнопка продления, а декларация «покупок нет» не должна противоречить кадрам.
Бейдж «PRO» в шапке чата (кадр 02) — это статус собеседника (демо-аккаунт с
активным Pro), а не продажа внутри приложения, поэтому кадр оставлен.

Иконка — ровно 512×512 PNG БЕЗ прозрачности.

## Комментарий ревьюерам (поле «Notes for reviewers», Play Console)

Короткий EN (ревью Play читают по-английски) — см. `PLAY-SUBMISSION.md` рядом
с артефактами версии: вход = собственная почта пользователя (IMAP/SMTP по
паролю приложения), тест-ящик `vault_msg@mail.ru` (пароль передаётся отдельно),
покупки в сборке отсутствуют намеренно, что проверить.
