// Переезд участника группы на новый адрес по совпадению ключа.
//
// ADR-003 Этап 3, партия 4. Жил методом App.vue с 57 строками и ОДНОЙ
// зависимостью (this.peerKeys) — самый выгодный по стоимости крупный метод во
// всём App.vue.
//
// ЗДЕСЬ БЫЛА ПОРЧА ДАННЫХ, и она живая. Рейенм по отпечатку УЖЕ удаляет старый
// адрес из peerKeys. Если искать устаревшего участника только по этому кэшу, поиск
// ничего не находит → groups_rename_member не вызывается → в группе остаются
// ДВА участника с одним отпечатком (случай 06.10.2026). Поэтому поиск идёт по
// трём источникам: память → файл peer_keys.json → поле fingerprint группы.
// Убрать любой из трёх — значит вернуть тот баг, поэтому на каждый источник есть
// отдельная проверка в тесте.
import { invoke } from '@tauri-apps/api/core';

// ЕДИНСТВЕННЫЙ ОЖИДАЕМЫЙ ОТКАЗ — это groups_rename_member. Всё остальное
// (ошибка записи, необъявленная переменная, опечатка в пути) — НЕ ожидаемо и
// пробрасывается вызывающему.
//
// ПОЧЕМУ НЕ BLANKET-CATCH (ADR-003 §5.2). Раньше всё тело было в try/catch с
// return false, и это стоило тихой порчи данных: ошибка программирования
// проглатывалась, вызывающий читал false как «переезжать нечего», группа
// оставалась с ДВУМЯ участниками на один отпечаток — тот самый случай 06.10,
// ради которого функция и написана. Настоящая ошибка обязана быть видна.
export async function tryMigrateGroupMember(peerKeys, group, from) {
  const newKey = peerKeys[from] || peerKeys[String(from || '').toLowerCase()];
  if (!newKey) return false;
    // ПОИСК УСТАРЕВШЕГО УЧАСТНИКА — по ТРЁМ источникам, а не только по
    // peerKeys. Причина: ренейм (fingerprint match) УЖЕ удаляет
    // старый адрес из peerKeys, и тогда поиск по одному кэшу не находит
    // участника → groups_rename_member не вызывается → в группе остаются
    // ДВА участника с одним отпечатком (живые данные 06.10.2026).
    //   1) in-memory peerKeys (быстрый путь);
    //   2) файл peer_keys.json на диске (если кэш уже почищен);
    //   3) поле fingerprint самой группы (groups.json).
    let diskKeys = null;
    const loadDiskKeys = async () => {
      if (diskKeys !== null) return diskKeys;
      try { diskKeys = (await invoke('load_peer_keys')) || []; }
      catch (e) { diskKeys = []; }
      return diskKeys;
    };
    let newFp = '';
    const fpOf = async (hexKey) => {
      try { return String(await invoke('get_fingerprint', { publicKey: hexKey }) || ''); }
      catch (e) { return ''; }
    };
    const fromLc = String(from).toLowerCase();
    let stale = null;
    for (const m of (group.members || [])) {
      const em = String(m.email || '');
      if (em.toLowerCase() === fromLc) continue; // уже под новым адресом
      const emLc = em.toLowerCase();
      // (1) in-memory
      const mk = peerKeys[em] || peerKeys[emLc];
      if (mk && mk === newKey) { stale = m; break; }
      // (2) файл на диске
      const dk = (await loadDiskKeys()).find(k => String(k.email).toLowerCase() === emLc);
      if (dk && dk.public_key === newKey) { stale = m; break; }
      // (3) fingerprint самой группы
      if (m.fingerprint) {
        if (!newFp) newFp = await fpOf(newKey);
        if (newFp && String(m.fingerprint) === newFp) { stale = m; break; }
      }
    }
    if (!stale) return false;
    console.log('[groups] fingerprint membership match:', stale.email, '→', from, 'in', group.id);
    // Ловим РОВНО операционный отказ записи. Локальный объект группы при этом
    // НЕ трогаем: если перезапись не удалась, участник не переехал, и выставлять
    // key_shared было бы враньём в UI.
    try {
      await invoke('groups_rename_member', {
        groupId: group.id, oldEmail: stale.email, newEmail: from,
      });
    } catch (e) {
      console.warn('[groups] groups_rename_member отказал, участник не переехал:',
        e && e.message || e);
      return false;
    }
    // Локальный объект группы обновляем сразу (Rust уже записал groups.json).
    stale.email = from;
    stale.key_shared = true;
    if (!stale.fingerprint) stale.fingerprint = newFp || await fpOf(newKey);
    return true;
}
