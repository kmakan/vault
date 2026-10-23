// Набор мутаций: rust-mail-codec — кодировки тела письма.
//
// ЗАЧЕМ. Quoted-printable и перенос строк были ДВУМЯ копиями: во мосте
// (`src-tauri/src/email.rs`) и в CLI (`api/email.rs::decode_quoted_printable`).
// Копии РАЗОШЛИСЬ, и это не теория: desktop 09.10.2026 починил съеденный
// пэйдинг base64, а слушатель CLI остался со СТАРЫМ декодером и терял пэйдинг
// до этого переноса — 67 символов вместо 68 → `isEncrypted=false` → hav/meta
// молча отбрасывался. Набор требует, чтобы ядро НЕ могло вернуться к тому
// поведению, не потеряв тест.
export default {
  id: 'rust-mail-codec',
  file: 'vault-client/src/vault/mail_codec.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'мягкий перенос в конце тела срезает «=» (регрессия X50 09.10: пэйдинг base64 потерян)',
      pattern: '                    if after < bytes.len() {',
      replacement: '                    if true {' },
    { name: 'мягкий перенос не распознаётся вовсе («=\\r\\n» остаётся в теле)',
      pattern: "                if i + 1 < bytes.len() && (bytes[i + 1] == b'\\r' || bytes[i + 1] == b'\\n') {",
      replacement: '                if false {' },
    { name: 'hex-escape =XX не раскодируется (шифротекст с «=3D» приходит битым)',
      pattern: '                if i + 2 < bytes.len() {',
      replacement: '                if false {' },
    { name: 'одиночный «=» выбрасывается вместо литерала (символы шифротекста теряются)',
      pattern: "                out.push(b'=');",
      replacement: '                // «=» отброшен' },
    { name: 'CRLF нормализуется в «\\r» вместо «\\n» (потребители режут только \\n)',
      pattern: "                out.push(b'\\n');",
      replacement: "                out.push(b'\\r');" },
    { name: 'порог переноса строк поднят до 1000 (длинные строки отвергают релеи)',
      pattern: '    const MAX: usize = 76;',
      replacement: '    const MAX: usize = 1000;' },
  ],
};
