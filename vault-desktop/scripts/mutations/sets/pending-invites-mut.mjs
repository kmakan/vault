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
    // accept-письмо: запись ключа пира (тот же класс дефекта, что вернул свой
    // аккаунт в контакты — только на пути письма-подтверждения).
    { name: 'своё accept-письмо больше не отсекается после резолва алиаса (свой ключ едет в peer_keys)',
      pattern: "      // Смена почты: accept-письмо старого адреса резолвится в текущий —\n      // гейт invited/пометки/сохранение ключа идут по НОВОМУ адресу.\n      const sender = await this.resolvePeerAlias(senderRaw);\n      if (sender === this.email) continue;",
      replacement: "      // Смена почты: accept-письмо старого адреса резолвится в текущий —\n      // гейт invited/пометки/сохранение ключа идут по НОВОМУ адресу.\n      const sender = await this.resolvePeerAlias(senderRaw);\n      if (false) continue;" },
    { name: 'своя почта не уходит в save_peer_key (OWN-ADDRESS GUARD моста выключен)',
      pattern: '          ownEmail: this.email,',
      replacement: '          ownEmail: null,' },
  ],
};
