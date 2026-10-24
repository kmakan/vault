// Набор мутаций: rust-transport — план транспорта и цикл выбора.
//
// ЗАЧЕМ. Требование владельца: «пользователь сам определяет, почтой или через
// релей, но если релей не работает — сообщение и вызов всё равно доходят по
// почте». Это свойство нельзя проверить «глазами» на стенде: оно проявляется
// только когда релей лежит или лимит кончился, а тогда недошедшее письмо
// выглядит как «отправка сломалась вообще». Поэтому каждая мутация ниже —
// реальный способ потерять гарантийный почтовый путь или обмануть чип.
export default {
  id: 'rust-transport',
  crate: 'vault-core',
  file: 'vault-core/src/transport.rs',
  smoke: 'cargo test -p vault-core --lib transport',
  mutations: [
    { name: 'выбран релей — письма нет вовсе (при отказе релея сообщение не уходит)',
      pattern: '        (Pref::Relay, true) => Plan {\n            mail: false,\n            relay: true,\n            mail_fallback: true,\n        },',
      replacement: '        (Pref::Relay, true) => Plan {\n            mail: false,\n            relay: true,\n            mail_fallback: false,\n        },' },
    { name: 'выбран релей, его нет — доставка пропадает вместо почты (главная гарантия)',
      pattern: '        (Pref::Relay, false) => mail_only(),',
      replacement: '        (Pref::Relay, false) => Plan { mail: false, relay: false, mail_fallback: false },' },
    { name: 'выбрана почта — релей всё равно публикуется (настройка не слушается, лимит тратится)',
      pattern: '        (Pref::Mail, _) => mail_only(),',
      replacement: '        (Pref::Mail, _) => Plan { mail: true, relay: true, mail_fallback: false },' },
    { name: 'авто забывает про релей (ускоритель выключается сам, доставка — минуты вместо секунд)',
      pattern: '        (Pref::Auto, true) => Plan {\n            mail: true,\n            relay: true,\n            mail_fallback: false,\n        },',
      replacement: '        (Pref::Auto, true) => Plan {\n            mail: true,\n            relay: false,\n            mail_fallback: false,\n        },' },
    { name: 'авто не шлёт письмо параллельно (если релей молчит — доставка ждёт фолбэка, которого нет)',
      pattern: '        (Pref::Auto, true) => Plan {\n            mail: true,\n            relay: true,\n            mail_fallback: false,\n        },',
      replacement: '        (Pref::Auto, true) => Plan {\n            mail: false,\n            relay: true,\n            mail_fallback: true,\n        },' },
    { name: 'неизвестное значение kv значит «только почта» вместо «авто» (испорченная настройка тихо выключает релей)',
      pattern: '            PREFERENCE_RELAY => Pref::Relay,\n            _ => Pref::Auto,',
      replacement: '            PREFERENCE_RELAY => Pref::Relay,\n            _ => Pref::Mail,' },
    { name: 'имя настройки relay с опечаткой (чип показывает релей, план — авто)',
      pattern: 'pub const PREFERENCE_RELAY: &str = "relay";',
      replacement: 'pub const PREFERENCE_RELAY: &str = "reley";' },
    { name: 'имя настройки mail с опечаткой (почтовый выбор не читается никогда)',
      pattern: 'pub const PREFERENCE_MAIL: &str = "mail";',
      replacement: 'pub const PREFERENCE_MAIL: &str = "smtp";' },
    { name: 'цикл переключения не замыкается (после почты чип возвращается к почте)',
      pattern: '    CYCLE[(i + 1) % CYCLE.len()]',
      replacement: '    CYCLE[i]' },
    { name: 'цикл стартует с середины (первый клик минует авто)',
      pattern: 'pub const CYCLE: [&str; 3] = [PREFERENCE_AUTO, PREFERENCE_RELAY, PREFERENCE_MAIL];',
      replacement: 'pub const CYCLE: [&str; 3] = [PREFERENCE_RELAY, PREFERENCE_MAIL, PREFERENCE_AUTO];' },
    { name: 'настройки нет — считается «только почта» (новый аккаунт не узнает про релей)',
      pattern: '    parse(stored.unwrap_or(PREFERENCE_AUTO))',
      replacement: '    parse(stored.unwrap_or(PREFERENCE_MAIL))' },
  ],
};
