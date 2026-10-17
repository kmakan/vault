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

const peerKeys = {};
const peerPqKeys = {};
const peerKeyInput = { value: '' };
let peerKeysLoaded = {};

function _normalizeKey(email) {
  return String(email || '').toLowerCase();
}

export function createIdentityStore() {
  return {
    // state (plain — reactive через computed inj в App.setup)
    get state() {
      return { peerKeys, peerPqKeys, peerKeyInput: peerKeyInput.value, peerKeysLoaded };
    },

    getPeerKey(email) {
      const k = _normalizeKey(email);
      return peerKeys[k] || peerKeys[email || ''];
    },
    getPeerPqKey(email) {
      const k = _normalizeKey(email);
      return peerPqKeys[k] || peerPqKeys[email || ''];
    },
    // 2450: очистка на logout
    clearPeerKeys() {
      for (const k of Object.keys(peerKeys)) delete peerKeys[k];
      for (const k of Object.keys(peerPqKeys)) delete peerPqKeys[k];
      peerKeyInput.value = '';
      peerKeysLoaded = {};
    },
    // 2457-2459: bulk load из peer_keys.json
    loadPeerKeys(pks) {
      if (!pks) return;
      for (const pk of pks) {
        peerKeys[pk.email] = pk.public_key;
        peerKeysLoaded[pk.email] = true;
        if (pk.pq_public_key) peerPqKeys[pk.email] = pk.pq_public_key;
      }
    },
    setPeerKey(email, key, pq = null) {
      const norm = _normalizeKey(email);
      peerKeys[norm] = key;
      if (pq != null) peerPqKeys[norm] = pq;
    },
    // Удаление пира из всех хранилищ (смена почты: старый адрес убираем,
    // иначе второй контакт с тем же ключом). Порядок у вызывающего:
    // crypto.removePeerKey → removePeerKey → setPeerKey(new).
    removePeerKey(email) {
      const norm = _normalizeKey(email);
      const had = (norm in peerKeys) || ((email || '') in peerKeys);
      delete peerKeys[norm];
      delete peerKeys[email || ''];
      delete peerPqKeys[norm];
      delete peerPqKeys[email || ''];
      delete peerKeysLoaded[norm];
      delete peerKeysLoaded[email || ''];
      return had;
    },
    setPeerKeyInput(v) { peerKeyInput.value = v ?? ''; },
    markLoaded(email) { peerKeysLoaded[_normalizeKey(email)] = true; },
    // 2995/3030/3184 read-through (dedup)
    hasPeerKey(email) {
      const norm = _normalizeKey(email);
      return !!peerKeys[norm] || !!peerKeys[email || ''];
    },
  };
}
export const identityStore = createIdentityStore();
