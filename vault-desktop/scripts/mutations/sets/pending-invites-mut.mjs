// Набор мутаций: фильтр приглашений (ADR-005 W4, партия 4d).
//
// Цель — ветка `fetchPendingInvites`, где «моя ли группа» решает мост
// (`groups_access.is_mine`). До партии 4d в этом месте жили два сравнения
// адреса в JS, и ни один смоук туда не заглядывал: invites-smoke подменяет
// api целиком, а api.js поднимали смоуки про восстановление, не про инвайты.
// Мутации проверяют ровно договор: null = «локально не сохранена, показываем»,
// только is_mine прячет попап, а отказ моста попап не теряет.
export default {
  id: 'pending-invites-mut',
  file: 'src/api.js',
  smoke: 'pending-invites-smoke.mjs',
  mutations: [
    { name: 'null от моста считается «чужая группа не сохранена» — инвайт прячется',
      pattern: '        if (access && access.is_mine) continue;',
      replacement: '        if (access) continue;' },
    { name: 'своя группа больше не скрывается (попап по уже принятой группе)',
      pattern: '        if (access && access.is_mine) continue;',
      replacement: '        if (false) continue;' },
    { name: 'в мост уходит поле транспорта вместо адреса идентичности',
      pattern: "          email: me.email || this.email || '',",
      replacement: "          email: this.email || ''," },
    { name: 'отпечаток не передаётся (участник после смены почты не найден)',
      pattern: "          fingerprint: String(me.fingerprint || ''),",
      replacement: "          fingerprint: ''," },
    { name: 'алиасы не передаются (старый адрес участника не найден)',
      pattern: '          aliases: me.aliases || [],',
      replacement: '          aliases: [],' },
    { name: 'функция идентичности не вызывается',
      pattern: '    const me = typeof identity === \'function\' ? identity() || {} : {};',
      replacement: '    const me = {};' },
    { name: 'отказ моста вылетает наружу (попап теряется)',
      pattern: '      } catch (e) { /* локальный список групп недоступен — попап не теряем */ }',
      replacement: '      } catch (e) { throw e; }' },
  ],
};
