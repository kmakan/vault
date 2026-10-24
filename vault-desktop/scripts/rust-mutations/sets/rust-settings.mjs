// Набор мутаций: rust-settings — правило дефолта тумблеров возможностей.
//
// ЗАЧЕМ. Решение «что показывать, пока пользователь не выбирало» до переноса
// в ядро жило во фронте двумя копиями (стартовая строка data и `=== '1'` при
// перечитывании kv). Ни компилятор, ни JS-гейт расхождение не ловят: оно
// видно только тапом по телефону — кнопка появляется и гаснет. Поэтому
// правило теперь здесь, и каждая мутация ниже — реальный дефект такого рода.
//
// Класс мутируемого — булево правило и константа формата, а не число:
// подмена дефолта, игнор воли пользователя, «мусор в kv = включено».
export default {
  id: 'rust-settings',
  crate: 'vault-core',
  file: 'vault-core/src/settings.rs',
  smoke: 'cargo test -p vault-core --lib',
  mutations: [
    { name: 'все тумблеры включены по умолчанию (экспериментальное видео заводится само)',
      pattern: '    name == EXP_CALLS',
      replacement: '    true' },
    { name: 'звонки выключены по умолчанию (требование «звонки по умолчанию» потеряно)',
      pattern: '    name == EXP_CALLS',
      replacement: '    false' },
    { name: 'дефолт по видео вместо звонков (перепутаны местами два флага)',
      pattern: '    name == EXP_CALLS',
      replacement: '    name == EXP_VIDEO' },
    { name: 'любая строка в kv значит «включено» (мусор включает возможность)',
      pattern: '        Some(value) => value == flag_stored(true),',
      replacement: '        Some(value) => !value.is_empty(),' },
    { name: 'записанный выбор игнорируется, всегда дефолт (тумблер не работает)',
      pattern: '        Some(value) => value == flag_stored(true),',
      replacement: '        Some(_) => default_enabled(name),' },
    { name: 'отсутствие записи значит «выключено» для всех (звонки пропадут на чистом профиле)',
      pattern: '        None => default_enabled(name),',
      replacement: '        None => false,' },
    { name: 'выключенное пишется как «1» (выключить тумблер невозможно)',
      pattern: '    if enabled { "1" } else { "0" }',
      replacement: '    "1"' },
    { name: 'флаги различаются регистром хранения (запись «0» читается как «включено»)',
      pattern: '    if enabled { "1" } else { "0" }',
      replacement: '    if enabled { "1" } else { "01" }' },
    { name: 'имя флага звонков опечатка (прочитанное и записанное — разные ключи)',
      pattern: 'pub const EXP_CALLS: &str = "exp-calls";',
      replacement: 'pub const EXP_CALLS: &str = "exp-call";' },
  ],
};
