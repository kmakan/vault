// Модуль-владелец relay-состояния (ADR-004, Этап A13).
//
// ЗАЧЕМ ЭТОТ ФАЙЛ, КОГДА ecoMode/relayEnabled/relayDeliveryMode — В ЖЕ.
//
// Три связанных с relay поля пишут 3 модуля: recovery.js (восстановление
// сохранённого эком-режима и статуса реле после рестарта), relay.js
// (управление режимом/вкл-выкл/режим доставки на ходу) и send.js (выбор
// email-vs-relay для конкретного письма). Два из трёх — relay.js и recovery.js
// — не импортируют друг друга, а оба пишут `ctx.ecoMode`/`ctx.relayEnabled`
// независимо: race при restore + входящем переключении режима даёт неопределённый
// статус relay и может отправить письмо в неверный канал.
//
// До A13 relay-state жило в ctx как data() поля App.vue. ctx — транспорт для
// этого канала. Владелец централизует: все writes → ctx.enableEco()/
// ctx.setRelayMode() и т. п., а читатели идут через proxy.
//
// ПОЧЕМУ ЗДЕСЬ НЕТ ИМПОРТА VUE — см. chat-store.js (ADR-004 A1): framework-agnostic.
//
// Создаётся один раз на приложение (в композиционном корне App.vue).
// Для state-machine relay.js (не Vue) используется singleton relayState,
// создаваемый один раз через createRelayStore() — App.vue оборачивает его
// reactive() для шаблона, а relay.js пишет напрямую (ADR-004 I.4).
export function createRelayStore() {
  const state = {
    ecoMode: false,
    relayEnabled: false,
    relayDeliveryMode: 'relay',
    // relay-resilience: автономный fallback + health. Владелец — relay.js,
    // но state лежит здесь (ADR-004 I.4): до этого live в App.data как
    // ecoAutonomous/relayOfflineSince/_relayFails/_lastRelayHealth.
    ecoAutonomous: false,
    relayOfflineSince: null,
    relayFails: 0,
    lastRelayHealth: null,
    // Состояние платной подписки Pro (тариф, срок, устройства). Владелец —
    // этот же стор: подписка относится к релею, и читателей много (экран
    // настроек, бейдж в шапке чата, гейт отправки).
    proState: null,
  };

  return {
    state,

    // ── ecoAutonomous (auto fallback) ───────────────────────────────
    setEcoAutonomous(v) { this.state.ecoAutonomous = !!v; return this.state.ecoAutonomous; },
    isEcoAutonomous() { return this.state.ecoAutonomous; },

    // ── relayOfflineSince (epoch ms или null) ───────────────────────
    setRelayOfflineSince(v) { this.state.relayOfflineSince = v; return this.state.relayOfflineSince; },
    getRelayOfflineSince() { return this.state.relayOfflineSince; },

    // ── relayFails / lastRelayHealth (resilience) ───────────────────
    setRelayFails(n) { this.state.relayFails = n; return this.state.relayFails; },
    bumpRelayFails() { this.state.relayFails += 1; return this.state.relayFails; },
    resetRelayFails() { this.state.relayFails = 0; return this.state.relayFails; },

    setLastRelayHealth(v) { this.state.lastRelayHealth = v; return this.state.lastRelayHealth; },
    getLastRelayHealth() { return this.state.lastRelayHealth; },

    // ── ecoMode ────────────────────────────────────────────────────────────
    enableEco(on = true) {
      this.state.ecoMode = !!on;
      return this.state.ecoMode;
    },
    isEcoMode() {
      return this.state.ecoMode;
    },

    // ── relayEnabled ───────────────────────────────────────────────────────
    enableRelay(on = true) {
      this.state.relayEnabled = !!on;
      return this.state.relayEnabled;
    },
    isRelayEnabled() {
      return this.state.relayEnabled;
    },

    // ── relayDeliveryMode ──────────────────────────────────────────────────
    // 'email' | 'relay' — канал доставки исходящего письма.
    setRelayMode(mode) {
      this.state.relayDeliveryMode = mode;
      return this.state.relayDeliveryMode;
    },
    deliveryMode() {
      return this.state.relayDeliveryMode;
    },
  
    // ── Состояние подписки Pro ────────────────────────────────────────
    setProState(v) { this.state.proState = v || null; return this.state.proState; },
    getProState() { return this.state.proState; },
};
}
