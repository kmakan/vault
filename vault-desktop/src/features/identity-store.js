// ADR-004 J.6: owner для peer-key state (быв. data this.peerKeys /
// this.peerPqKeys / this.peerKeyInput / this.peerKeysLoaded в App.vue).
//
// ЗАЧЕМ: calls.js/forward.js/ignore.js читают ctx.peerKeys* (App-inj).
// Любая правка calls.js (ctx.peerKeys) затрагивает App.data поля. Вынос
// в singleton: writes → identityStore.setX(), reads → state.* через inj.
// ctx=this computed proxy (App.setup) прокидывает через store — API calls.js
// не меняется (ctx.peerKeys = computed → identityStore.state.peerKeys).
//
// Поля:
//  - peerKeys: {email: b64-pubkey}
//  - peerPqKeys: {email: b64-pq-pubkey}  (ML-KEM ek)
//  - peerKeyInput: ''                      (form field)
//  - peerKeysLoaded: {email: true}        (dedup загрузки)
//
// 18.10.2026 (регрессия ADR-004, класс «запись мимо реактивности»): state был
// GETTER'ом, возвращавшим НОВЫЙ объект на каждое чтение:
//     get state() { return { peerKeys, peerPqKeys, peerKeyInput: ..., peerKeysLoaded }; }
// Значения внутри — одни и те же module-level объекты, но сам объект каждый раз
// новый, поэтому reactive()/computed никогда не трекали поля: прокси App.vue
// (this.peerKeys/this.peerPqKeys/this.peerKeyInput) показывали первое прочитанное
// значение навсегда. Теперь state — обычное поле с теми же четырьмя ключами,
// а мутации идут через this.state (как у остальных владельцев), поэтому
// liveState(identityStore) в App.vue делает их реактивными.

function _normalizeKey(email) {
  return String(email || '').toLowerCase();
}

export function createIdentityStore() {
  const state = {
    peerKeys: {},
    peerPqKeys: {},
    peerKeyInput: '',
    peerKeysLoaded: {},
  };
  return {
    state,

    getPeerKey(email) {
      const k = _normalizeKey(email);
      return this.state.peerKeys[k] || this.state.peerKeys[email || ''];
    },
    getPeerPqKey(email) {
      const k = _normalizeKey(email);
      return this.state.peerPqKeys[k] || this.state.peerPqKeys[email || ''];
    },
    // 2450: очистка на logout
    clearPeerKeys() {
      for (const k of Object.keys(this.state.peerKeys)) delete this.state.peerKeys[k];
      for (const k of Object.keys(this.state.peerPqKeys)) delete this.state.peerPqKeys[k];
      this.state.peerKeyInput = '';
      this.state.peerKeysLoaded = {};
    },
    // 2457-2459: bulk load из peer_keys.json
    loadPeerKeys(pks) {
      if (!pks) return;
      for (const pk of pks) {
        this.state.peerKeys[pk.email] = pk.public_key;
        this.state.peerKeysLoaded[pk.email] = true;
        if (pk.pq_public_key) this.state.peerPqKeys[pk.email] = pk.pq_public_key;
      }
    },
    setPeerKey(email, key, pq = null) {
      const norm = _normalizeKey(email);
      this.state.peerKeys[norm] = key;
      if (pq != null) this.state.peerPqKeys[norm] = pq;
    },
    // Удаление пира из всех хранилищ (смена почты: старый адрес убираем,
    // иначе второй контакт с тем же ключом). Порядок у вызывающего:
    // crypto.removePeerKey → removePeerKey → setPeerKey(new).
    removePeerKey(email) {
      const norm = _normalizeKey(email);
      const had = (norm in this.state.peerKeys) || ((email || '') in this.state.peerKeys);
      delete this.state.peerKeys[norm];
      delete this.state.peerKeys[email || ''];
      delete this.state.peerPqKeys[norm];
      delete this.state.peerPqKeys[email || ''];
      delete this.state.peerKeysLoaded[norm];
      delete this.state.peerKeysLoaded[email || ''];
      return had;
    },
    setPeerKeyInput(v) { this.state.peerKeyInput = v ?? ''; },
    markLoaded(email) { this.state.peerKeysLoaded[_normalizeKey(email)] = true; },
    // 2995/3030/3184 read-through (dedup)
    hasPeerKey(email) {
      const norm = _normalizeKey(email);
      return !!this.state.peerKeys[norm] || !!this.state.peerKeys[email || ''];
    },
  };
}
export const identityStore = createIdentityStore();
