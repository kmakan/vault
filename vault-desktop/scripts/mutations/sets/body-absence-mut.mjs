// Набор мутаций: контракт «пустое тело = этого тела не будет никогда»
// на стороне транспорта (src/api.js).
//
// Проверяется ОДНО различие, из-за которого живёт жалоба 22.10
// («приглашения от старых email»): ответ Rust «тела нет» и ответ «не знаю»
// не должны сливаться в один случай. Если их слить — негатив не кэшируется,
// и каждый поллинг переспрашивает одно и то же письмо (замер на стенде:
// 368 одинаковых строк лога за 2,5 минуты).
export default {
  id: 'body-absence',
  file: 'src/api.js',
  smoke: 'body-absence-smoke.mjs',
  mutations: [
    { name: 'терминальное отсутствие выбрасывается из карты (слияно с «не знаю» → цикл переспроса)',
      pattern: '        if (!body) {\n          out[uid] = \'\';\n          continue;\n        }',
      replacement: '        if (!body) continue;' },
    { name: 'терминальное отсутствие пишется в body_cache (кэш хранит только настоящие тела)',
      pattern: '        if (!body) {\n          out[uid] = \'\';\n          continue;\n        }',
      replacement: '        if (!body) {\n          out[uid] = \'\';\n          db.bodyCacheSet(acc, `${f}:${uid}`, body).catch(() => {});\n          continue;\n        }' },
    { name: 'handshake не кэширует негатив: проверка «ключа нет в ответе» заменена на «тело пустое»',
      pattern: '            if (!Object.prototype.hasOwnProperty.call(bodies, k)) continue;',
      replacement: '            if (!bodies[k]) continue;' },
    { name: 'транзиторный ответ тоже кэшируется как окончательный (письмо потеряно навсегда)',
      pattern: '            if (!Object.prototype.hasOwnProperty.call(bodies, k)) continue;',
      replacement: '            if (!Object.prototype.hasOwnProperty.call(bodies, k)) { this._handshakeParsed.set(keyOf(m), null); continue; }' },
  ],
};
