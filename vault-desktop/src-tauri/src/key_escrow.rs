// Key Recovery — восстановление личности по мнемонике (BIP39 EN).
//
// Логика формата живёт в ядре (ADR-005 §W4, `t_502b6c90`): генерация слов,
// контрольная сумма, нормализация и обёртка бэкапа. Мост только реэкспортирует
// её для команд lib.rs (`key_escrow::*`) и smoke-тестов, поэтому путь вызова
// не меняется, а протокол архива имеет одну копию и мутационную проверку.
pub use vault_client::vault::key_escrow::{
    generate_mnemonic, unwrap_backup, validate_mnemonic, wrap_backup, WrappedBackup,
};
