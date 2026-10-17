# ADR-002: Group calls (M3, Phase 3)

Статус: черновик → готов к реализации (переход Phase 3 после M2.9).

## Сигнатура

- `media_call_join(group_id, participant_keys)` — Tauri cmd:
  - создаёт P2P fan-out: 1 PeerConnection на участника (mesh, SFU-less).
  - для N участников → N-1 исходящих offer-ов (caller fan-out).
- `media_call_state(group_id)` — уже есть (M2.8), расширяется на `Group` enum.
- Roster: участники хранятся в `CallSession.participants: Vec<email>` (media.rs), не крестятся с `groups.rs`.

## Границы

- `media.rs` fromвит только `group_id` (String), participant keys через call-сигналы (передаются в `sendCallEnvelope`).
- Business-logика групп (members, invites) — в `groups.rs`; media.rs работает с roster'ом как с чёрным ящиком.

## Android

- bridge cmds авто-доступны через Tauri Android (lib.rs:2220+).
- WebRTC 0.20 — stub на Android (Phase 3.2+).

## Связь с MCM

- CallSignal (M2.3 core) → `call_request` с `group_id` полем (опционально).
- `media_call_join` парсит participant list из group invite flow (groups.rs → media.rs).
