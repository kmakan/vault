// Набор мутаций: мета-скан групп (src/features/group-meta.js) и решение Rust
// «этого тела не будет никогда».
//
// Именно этот скан производил шум на стенде: последние письма участников
// перебираются каждым поллингом, и конверт с пустым телом (RELAY, мёртвый uid)
// запрашивался ЗАНОВО на каждом проходе, потому что фича не различала «пусто
// навсегда» и «мост упал». Различие и проверяют мутации ниже.
export default {
  id: 'group-meta-absence',
  file: 'src/features/group-meta.js',
  smoke: 'body-absence-smoke.mjs',
  mutations: [
    { name: 'пометка applied-sig снята (скан переспрашивает то же письмо каждым поллингом)',
      pattern: '            if (!body || !crypto.isEncrypted(body)) {\n              alreadyApplied.add(appliedSig);\n              await db.kvSet(\'anon\', appliedKey, [...alreadyApplied].join(\',\'));\n              continue;\n            }',
      replacement: '            if (!body || !crypto.isEncrypted(body)) continue;' },
    { name: 'applied-sig пишется и при падении моста (временный сбой becomes «письма нет»)',
      pattern: '          } catch (e) { /* не meta или битое — не критично */ }',
      replacement: '          } catch (e) {\n            alreadyApplied.add(appliedSig);\n            await db.kvSet(\'anon\', appliedKey, [...alreadyApplied].join(\',\'));\n          }' },
  ],
};
