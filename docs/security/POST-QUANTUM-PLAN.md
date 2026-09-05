# Post-Quantum Migration Plan — Vault (ML-KEM-768 + X25519 hybrid)

> Дата: 30.08.2026. Цель: post-quantum защита ДО публикации (релиз 7–10.09).
> Контекст кода: crypto.rs (X25519 static + XChaCha20-Poly1305 AAD="VAULT"),
> key_store.rs (keypair.json + peer_keys.json), конверт {vault:1,id,text,name,avatar,key,ts}.

## Текущее состояние (проверено по коду)

- 1-на-1: X25519 ECDH на **статических** ключах → сырой shared secret → XChaCha20-Poly1305.
  Отправитель кладёт свой pubkey прямо в конверт (`key` поле buildEnvelope, App.vue:2558).
- Группы: случайный симметричный ключ, раскладка участникам через 1-на-1 ECDH (encrypt_message).
- Звонки: медиа-ключ = тот же X25519 DH (media.rs:617,636 derive_shared_key).
- QR/приглашения: передают pubkey (X25519, 32 байта).
- Хранилище ключей: ~/.vault/keys/keypair.json {public_key, private_key}, peer_keys.json [{email, public_key}].

## Целевая схема (гибрид PQ)

- Зависимости: `ml-kem` (RustCrypto, FIPS 203, pure Rust — Android без C) + `hkdf` (нормальный KDF вместо сырого SHA-256).
- Каждый аккаунт получает ДВЕ пары: X25519 (как сейчас) + ML-KEM-768 (DecapsulationKey 1568B… ~2400B, EncapsulationKey 1188B, ciphertext 1088B, shared secret 32B).
- Гибридный вывод ключа диалога:
  `K = HKDF-SHA256(ikm = x25519_ss || mlkem_ss, salt = "VAULT-PQ-V1", info = peer_pub_hash)`
- Конверт v2 (сигнальная структура, полная обратная совместимость):
  ```
  { vault: 1, ..., key: <x25519 pub>, pq: <ml-kem pub b64>, kemct: <kem ciphertext b64>, ts }
  ```
  Отправитель инкапсулирует против pq-ключа получателя, кладёт `kemct` в конверт.
  Получатель: если есть pq + kemct и у него есть pq_secret → гибрид; иначе fallback на чистый X25519 (старые контакты).
- Группы: ключ группы остаётся симметричным XChaCha20; шифрование ключа группы каждому участнику — тем же гибридным конвертом (меняется только «обёртка»).
- Звонки: media_start_outgoing/accept — media_key = гибридный KDF вместо сырого DH. Нужен pq_pub звонящего в call-конверте.
- Хранилище: keypair.json += {pq_public_key, pq_private_key} (Option, старые файлы без полей → serde default None → миграция генерирует PQ-пару при первом запуске); peer_keys.json += pq_public_key (Option). serde back-compat: поля опциональны.
- QR/приглашения: к pubkey добавляется pq_pubkey (JSON payload: {pub, pq_pub}) — старый клиент увидит {pub} и проигнорирует остальное (parseEnvelope берёт только известные поля), новый — прочитает оба.
- CLI (vault-client): CryptoClient.set_peer_key расширяется pq-полями; wire-совместимость сохраняется (конверт сам сообщает версию).

## Forward Secrecy (вторая половина «PQ + FS» из roadmap)

- Сейчас: статические ключи → утечка приватника = расшифровка всей истории. Store-now-decrypt-later НЕ закрывается PQ-инкапсуляцией на статических ключах, если ключ не ратируется.
- Минимальный FS в email-транспорте (как Delta Chat Autocrypt): периодическая ротация Prefer-Encryption ключей + новый ephemeral при явном exchange.
- Скоуп до релиза: PQ-гибрид (выше). FS-ротация — M6 (после релиза), иначе не успеваем к 7–10.09. Честно указываем на сайте/в доке: «PQ сейчас, FS-ротация в разработке».

## Этапы (оценка 2–3 дня)

1. crypto.rs: generate_hybrid_keypair, hybrid_encrypt/decrypt (envelope-aware), HKDF. Тесты: round-trip, legacy fallback, wrong-key, tamper kemct. [0.5d]
2. key_store.rs: pq-поля + миграция старых keypair.json (генерация PQ при load, если отсутствует). Тесты на старом формате файла. [0.5d]
3. lib.rs команды: generate_keypair возвращает {.., pq_public_key}, encrypt/decrypt_vault_message принимают peer pq+поддерживают конверт v2. media.rs: гибридный media_key. [0.5d]
4. Фронт (crypto.js + App.vue): buildEnvelope кладёт pq+kemct, parseEnvelope читает; peerKeys хранит {x25519, pq}; QR/invite payload с pq_pub. [0.5d]
5. CLI: pq в CryptoClient + invite/QR wire. [0.5d]
6. E2E-тест: desktop↔desktop, desktop↔CLI, desktop↔Android (APK пересборка по скиллу). Сайты: обновить таблицу безопасности (ML-KEM «в релизе»). [0.5d]

## Риски

- Размер письма растёт на ~2.3KB base64 (kemct+pq pub) — SMTP лимиты 25MB, некритично.
- Old-client fallback обязателен: публикации до миграции нет (репозиторий закрыт), но МАКСИМ/АННА уже общаются → их ящики получат конверты v2 после апдейта ОБОИХ клиентов. Обновить desktop Максима и Анны в один день.
- ml-kem crate: pure Rust, нет C-зависимостей → кросс-компиляция aarch64-linux-android чистая (в отличие от pqcrypto-* C-обёрток).
- Keystore escrow (key_escrow.rs) шифрует mnemonic-ключом — PQ-ключи добавить в эскроу-бэкап (иначе восстановление потеряет PQ-пару).

## Конкурентный анализ (факт-чек 30.08.2026)

| Фича | Vault (после PQ) | Signal | Delta Chat | Session | SimpleX | WhatsApp/Telegram |
|---|---|---|---|---|---|---|
| PQ key exchange | ML-KEM-768+X25519 гибрид | PQXDH (PQ-safe auth, X25519+Kyber-768 hybrid) | ❌ (планы) | ❌ | ❌ | ❌ |
| Метаданные на сервере | **0 — серверов нет** | Знает кто-кому-когда | Мало (свой SMTP) | Много (сессии/маршруты) | Средне (2 хопа) | Максимум |
| Требует телефон | **Нет** | Да | Нет | Нет | Нет | Да (WA) |
| Работает через любую почту | **Да** | — | Да | — | — | — |
| Свои серверы не нужны | **Да** | Нет (Signal-сервер) | Только SMTP | Нет (нужно node) | Нет (нужен broker) | Нет |
| Открытый код | Да (после релиза) | Сервер+клиент | Да | Да | Да | ❌ (TG частично) |
| Группы | До 50 (E2E) | До 1000 | Да | Да | Да | Да |
| Звонки E2E | Да (бета, XChaCha20+Opus) | Да (PQC SAS) | ❌ (только DC-звонки нет) | Да | Да | Да |
| Forward secrecy | Статические ключи (FS в плане) | **Да** (PQXDH ratcheting) | Да (после setup) | Да | Да | Да (WA) |
| Sealed sender | Идея (zero-meta M1) | Да | n/a | Частично | Частично | ❌ |
| Клиент: desktop+mobile | Desktop+Android+CLI | Desktop+mobile | Desktop+mobile | Mobile+desktop | Mobile+desktop | Все |

### Где опережаем

1. **Полная serverless-архитектура**: ни Signal, ни Session, ни SimpleX не дают E2E-мессенджер БЕЗ собственного сервера. У них точка блокировки есть всегда (signal.org onion-маршруты Session, brokers SimpleX).
2. **PQ-гибрид + email-транспорт**: после ML-KEM мы единственные с PQ-ключами поверх произвольного IMAP/SMTP. Signal имеет PQXDH, но это и их сервер-центричная модель.
3. **Zero metadata по построению**: провайдер видит только почтовые конверты двух адресов, содержимое непрозрачно, AAD-стелс маскирует от спам-фильтров.
4. **Клиент не привязан к провайдеру**: смена ящика = смена «идентичности» без потери истории (история локальная).

### Где отстаём (честно)

1. **Forward Secrecy**: Signal ratcheting vs наши статические ключи. Главный отрыв. Плановый фикс — M6.
2. **Аудит**: у Signal и Session есть внешние аудиты; у нас — до аудита далеко. Компенсация: открытый код после релиза.
3. **Звонки/видео-зрелость**: один-на-один голос, бета; у конкурентов конференц-звонки, видео.
4. **Анонимная регистрация**: Session даёт вход без email. У нас email обязателен (это плата за serverless-транспорт).

## Действия после кода

- Обновить security-таблицу на vault-msg.ru/.tech: ML-KEM «в релизе» (когда реально в релизе).
- Cвестия бета-пользователей (Максим-Android, Анна-desktop): одновременный апдейт.
- Kanban: M6 «Устойчивость + крипто-апгрейд» — туда FS-ротацию; PQ-миграция — отдельные задачи в колонку ready.
