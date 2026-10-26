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
      pattern: "      // Смена почты: accept-письмо старого адреса резолвится в текущий —\n      // гейт invited/пометки/сохранение ключа идут по НОВОМУ адресу.\n      const sender = await this.resolvePeerAlias(senderRaw);\n      if (await this.isOwnSender(sender)) continue;",
      replacement: "      // Смена почты: accept-письмо старого адреса резолвится в текущий —\n      // гейт invited/пометки/сохранение ключа идут по НОВОМУ адресу.\n      const sender = await this.resolvePeerAlias(senderRaw);\n      if (false) continue;" },
    { name: 'своя почта не уходит в save_peer_key (OWN-ADDRESS GUARD моста выключен)',
      pattern: '          ownEmail: this.email,',
      replacement: '          ownEmail: null,' },
    // Гейт «это наше письмо?» — одна мера ядра (`isOwnSender`) в четырёх
    // местах. Мутации возвращают прежнее сравнение строк НА МЕСТЕ: именно оно
    // пропускало своё письмо в другом регистре. Каждая из четырёх точек должна
    // быть поймана (смоук поднимает их все: sweep invites/accepts, попап
    // инвайта, авто-принятие accept).
    { name: 'обёртка гейта сравнивает строки в JS вместо вопроса ядру (регистр решает)',
      pattern: "  async isOwnSender(address) {\n    return isOwnSenderInCore(address, this.email);\n  }",
      replacement: "  async isOwnSender(address) {\n    return String(address || '').trim().toLowerCase() === String(this.email || '').trim().toLowerCase();\n  }" },
    { name: 'sweep инвайтов: гейт сравнением строк (своё письмо в другом регистре помечается)',
      pattern: "        // 08.10: accepted-contacts с ОБОИМИ адресами у одного uid).\n        const sender = await this.resolvePeerAlias(senderRaw);\n        if (await this.isOwnSender(sender)) continue;",
      replacement: "        // 08.10: accepted-contacts с ОБОИМИ адресами у одного uid).\n        const sender = await this.resolvePeerAlias(senderRaw);\n        if (sender === this.email) continue;" },
    { name: 'sweep accept-писем: гейт сравнением строк (своё письмо в другом регистре помечается)',
      pattern: "        const sender = await this.resolvePeerAlias(senderRaw);\n        if (await this.isOwnSender(sender)) continue;\n        const key = `${sender}|${m.uid}`;\n        if (!accepted.includes(key)) { accepted.push(key); changed = true; }",
      replacement: "        const sender = await this.resolvePeerAlias(senderRaw);\n        if (sender === this.email) continue;\n        const key = `${sender}|${m.uid}`;\n        if (!accepted.includes(key)) { accepted.push(key); changed = true; }" },
    { name: 'попап инвайта: гейт сравнением строк (свой инвайт показывается)',
      pattern: "      const sender = await this.resolvePeerAlias(senderRaw);\n      if (await this.isOwnSender(sender)) continue;\n      if (declined.includes(`${sender}|${m.uid}`)) continue;",
      replacement: "      const sender = await this.resolvePeerAlias(senderRaw);\n      if (sender === this.email) continue;\n      if (declined.includes(`${sender}|${m.uid}`)) continue;" },
  ],
};
