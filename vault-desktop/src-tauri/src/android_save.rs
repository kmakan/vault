//! Сохранение файла в ПУБЛИЧНЫЕ Downloads на Android (MediaStore).
//!
//! ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ `dirs`.
//! `vault_save_file` (vault_bridge.rs) писал файл туда же, куда и desktop:
//! `dirs::download_dir().or_else(dirs::home_dir)`. На Android это неверно:
//!   · `dirs::download_dir()` = None (нет XDG-переменных);
//!   · `dirs::home_dir()` = $HOME, а его в `lib.rs::setup` мы сами и
//!     выставляем в app_data_dir — приватный каталог
//!     `/data/user/0/<pkg>`.
//! Итог: `invoke('vault_save_file')` возвращал успех, тост «Сохранено», а файл
//! лежал там, куда пользователь попасть не может (живая приёмка 19.10.2026,
//! тикет t_e66389bd: `/data/user/0/com.vault.vault/dodtest.png`, в
//! `/sdcard/Download` файла нет).
//!
//! РЕШЕНИЕ. `MediaStore.Downloads` кладёт файл в общие Downloads и не требует
//! разрешений на хранилище (scoped storage, API 29+). Класс
//! `MediaStore$Downloads` появился только в API 29, поэтому на старых
//! устройствах (minSdk=24) поведение НЕ меняем — отдаём ошибку-признак, и
//! вызывающий код использует прежний путь `dirs` (регресса для API<29 нет).
//!
//! JNI-путь скопирован с `audio/audio_android.rs` (speakerphone/incoming-call):
//! `ndk_context::android_context()` инициализируется из MainActivity.kt
//! (`nativeInitAndroidContext`), `attach_current_thread`, `catch_unwind` вокруг
//! всего блока (у нас `panic = "abort"` в release, JNI-паника убила бы процесс).

use crate::vault_bridge::sanitize_filename;
use jni::objects::{JObject, JValue};
use jni::JNIEnv;

/// Минимальная версия Android, где есть `MediaStore.Downloads` (API 29).
const MIN_SDK_MEDIASTORE: i32 = 29;

/// Сохранить base64-данные в общие Downloads через MediaStore.
///
/// Возвращает человекочитаемый путь (`Download/<имя>`) — для тоста.
/// Ошибку возвращаем строкой: вызывающий решает, откатываться ли на `dirs`.
pub fn save_base64_to_public_downloads(
    base64_data: &str,
    filename: &str,
    mime_type: &str,
) -> Result<String, String> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("base64 decode error: {e}"))?;
    let display_name = sanitize_filename(filename);
    let mime = if mime_type.trim().is_empty() {
        "application/octet-stream".to_string()
    } else {
        mime_type.to_string()
    };

    // panic=abort в release: любая паника внутри JNI (в т.ч. «android context
    // was not initialized») должна быть поймана здесь, иначе процесс умрёт.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("JavaVM from_raw: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach_current_thread: {e}"))?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let outcome = insert_into_mediastore(&mut env, &context, &bytes, &display_name, &mime);
        let outcome = match outcome {
            Ok(path) => Ok(path),
            Err(e) => {
                // Текст Java-исключения — в саму ошибку. Без него отказ выглядел
                // как «Java exception was thrown», и причину (Invalid column
                // MIME_TYPE) пришлось искать в logcat MediaProvider.
                Err(match java_exception_message(&mut env) {
                    Some(j) => format!("{e}: {j}"),
                    None => e,
                })
            }
        };
        if outcome.is_err() {
            // Pending Java-исключение гасим: иначе оно всплывёт на следующем
            // JNI-вызове этого потока и уронит процесс (FATAL EXCEPTION).
            let _ = env.exception_clear();
        }
        outcome
    }));

    match result {
        Ok(Ok(path)) => Ok(path),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("JNI panicked (MediaStore save)".to_string()),
    }
}

/// Текст текущего Java-исключения (`Throwable.toString()`), если оно есть.
///
/// ЗАЧЕМ: без него ошибка JNI выглядит как «Java exception was thrown», и
/// причину приходится искать в logcat (`E/DatabaseUtils: ... Invalid column
/// MIME_TYPE` — так и нашли). Теперь текст прилетает прямо в строку ошибки.
///
/// Порядок обязателен: `exception_occurred` снимает pending-ссылку и держит
/// local ref; `exception_clear` НУЖЕН до любых следующих JNI-вызовов (иначе
/// они падают с «exception pending») — поэтому toString вызываем уже после
/// clear, имея на руках throwable.
fn java_exception_message(env: &mut JNIEnv) -> Option<String> {
    use jni::objects::JString;
    if !env.exception_check().ok()? {
        return None;
    }
    let throwable = env.exception_occurred().ok()?;
    env.exception_clear().ok()?;
    let value = env
        .call_method(&throwable, "toString", "()Ljava/lang/String;", &[])
        .ok()?;
    let obj = value.l().ok()?;
    let text: String = env.get_string(&JString::from(obj)).ok()?.into();
    Some(text)
}

/// Версия Android (Build.VERSION.SDK_INT) — нужна, потому что
/// `MediaStore.Downloads` существует только с API 29.
fn sdk_int(env: &mut JNIEnv) -> Result<i32, String> {
    let build_version = env
        .find_class("android/os/Build$VERSION")
        .map_err(|e| format!("find Build$VERSION: {e}"))?;
    env.get_static_field(&build_version, "SDK_INT", "I")
        .map_err(|e| format!("Build.VERSION.SDK_INT: {e}"))?
        .i()
        .map_err(|e| format!("SDK_INT as int: {e}"))
}

fn insert_into_mediastore(
    env: &mut JNIEnv,
    context: &JObject,
    bytes: &[u8],
    display_name: &str,
    mime: &str,
) -> Result<String, String> {
    let sdk = sdk_int(env)?;
    if sdk < MIN_SDK_MEDIASTORE {
        return Err(format!(
            "MediaStore.Downloads недоступен на API {sdk} (< {MIN_SDK_MEDIASTORE})"
        ));
    }

    let resolver = env
        .call_method(
            context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .map_err(|e| format!("getContentResolver: {e}"))?
        .l()
        .map_err(|e| format!("ContentResolver cast: {e}"))?;

    // ContentValues: DISPLAY_NAME + MIME_TYPE + RELATIVE_PATH=Download.
    let cv_class = env
        .find_class("android/content/ContentValues")
        .map_err(|e| format!("find ContentValues: {e}"))?;
    let cv = env
        .new_object(&cv_class, "()V", &[])
        .map_err(|e| format!("new ContentValues: {e}"))?;

    // ВНИМАНИЕ: ключи ContentValues — это ИМЕНА КОЛОНОК БД, а не имена Java-констант
    // `MediaStore.MediaColumns.*`. Первая версия (19.10, 0.1.226) передавала
    // DISPLAY_NAME/MIME_TYPE/RELATIVE_PATH, и MediaProvider отверг insert:
    //   E/DatabaseUtils: java.lang.IllegalArgumentException: Invalid column MIME_TYPE
    // Правильные значения: "_display_name", "mime_type", "relative_path".
    // RELATIVE_PATH у коллекции Downloads должен начинаться с "Download/".
    put_string(env, &cv, "_display_name", display_name)?;
    put_string(env, &cv, "mime_type", mime)?;
    put_string(env, &cv, "relative_path", "Download/")?;

    let downloads_class = env
        .find_class("android/provider/MediaStore$Downloads")
        .map_err(|e| format!("find MediaStore$Downloads: {e}"))?;
    let collection = env
        .get_static_field(&downloads_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
        .map_err(|e| format!("EXTERNAL_CONTENT_URI: {e}"))?
        .l()
        .map_err(|e| format!("EXTERNAL_CONTENT_URI cast: {e}"))?;

    let inserted = env
        .call_method(
            &resolver,
            "insert",
            "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
            &[JValue::Object(&collection), JValue::Object(&cv)],
        )
        .map_err(|e| format!("ContentResolver.insert: {e}"))?
        .l()
        .map_err(|e| format!("insert result cast: {e}"))?;
    if inserted.is_null() {
        return Err("MediaStore insert вернул null (нет доступа к Downloads)".to_string());
    }

    let stream = env
        .call_method(
            &resolver,
            "openOutputStream",
            "(Landroid/net/Uri;)Ljava/io/OutputStream;",
            &[JValue::Object(&inserted)],
        )
        .map_err(|e| format!("openOutputStream: {e}"))?
        .l()
        .map_err(|e| format!("OutputStream cast: {e}"))?;
    if stream.is_null() {
        return Err("openOutputStream вернул null".to_string());
    }

    let jbytes = env
        .byte_array_from_slice(bytes)
        .map_err(|e| format!("byte_array_from_slice: {e}"))?;
    env.call_method(
        &stream,
        "write",
        "([B)V",
        &[JValue::Object(jbytes.as_ref())],
    )
    .map_err(|e| format!("OutputStream.write: {e}"))?;
    env.call_method(&stream, "close", "()V", &[])
        .map_err(|e| format!("OutputStream.close: {e}"))?;

    Ok(format!("Download/{display_name}"))
}

/// `ContentValues.put(String key, String value)`.
fn put_string(env: &mut JNIEnv, cv: &JObject, key: &str, value: &str) -> Result<(), String> {
    let jkey = env
        .new_string(key)
        .map_err(|e| format!("new_string({key}): {e}"))?;
    let jvalue = env
        .new_string(value)
        .map_err(|e| format!("new_string(value): {e}"))?;
    env.call_method(
        cv,
        "put",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(jkey.as_ref()), JValue::Object(jvalue.as_ref())],
    )
    .map_err(|e| format!("ContentValues.put({key}): {e}"))?;
    Ok(())
}

