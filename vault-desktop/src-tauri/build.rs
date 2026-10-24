fn main() {
    // TURN-креды вшиваются в бинарь при СБОРКЕ (03.10): без проброса
    // rerun-if-env-changed cargo не пересобирает пакет при смене кредов,
    // и option_env! в media.rs вернёт прошлое (пустое) значение.
    println!("cargo:rerun-if-env-changed=VAULT_TURN_CRED");
    println!("cargo:rerun-if-env-changed=VAULT_TURN_HOST");
    // Android (23.08): ndk-sys (тянется cpal → AAudio) линкует `-laaudio`,
    // но cargo не знает системный путь NDK — падает «unable to find library
    // -laaudio». Добавляем sysroot нужного таргета в путь поиска библиотек.
    //
    // Android (27.08): oboe — C++ Oboe через NDK — требует libc++_static
    // (символы __cxa_pure_virtual, operator new/delete и т.д.). Без этого
    // dlopen падает «cannot locate symbol __cxa_pure_virtual».
    //
    // ВАЖНО: build.rs компилируется для ХОСТА, поэтому #[cfg(target_os =
    // "android")] здесь НИКОГДА не срабатывает — таргет берём из env TARGET.
    let target = std::env::var("TARGET").unwrap_or_default();
    // Перезапускать build-скрипт при смене NDK-путей (28.08): без этого
    // cargo кэширует вывод с пустым путём и линковка c++_static падает.
    println!("cargo:rerun-if-env-changed=ANDROID_NDK_HOME");
    println!("cargo:rerun-if-env-changed=NDK_HOME");
    match target.as_str() {
        "aarch64-linux-android"
        | "armv7-linux-androideabi"
        | "i686-linux-android"
        | "x86_64-linux-android" => {
            let ndk = std::env::var("ANDROID_NDK_HOME").unwrap_or_default();
            let triple = if target == "armv7-linux-androideabi" {
                "arm-linux-androideabi"
            } else {
                target.as_str()
            };
            // API-level libs (aaudio, android, log) — в /34
            let lib_dir =
                format!("{ndk}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/{triple}/34");
            println!("cargo:rustc-link-search=native={lib_dir}");
            println!("cargo:rustc-link-lib=aaudio");
            println!("cargo:rustc-link-lib=android");
            println!("cargo:rustc-link-lib=log");
            // C++ runtime (libc++_static.a, libc++abi.a) — в родительской директории
            let cpp_dir =
                format!("{ndk}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/{triple}");
            println!("cargo:rustc-link-search=native={cpp_dir}");
            println!("cargo:rustc-link-lib=static=c++_static");
            println!("cargo:rustc-link-lib=static=c++abi");
        }
        _ => {}
    }

    // VP8-энкодер десктопа (ADR-005): WebKitGTK не отдаёт кадры камеры в JS,
    // поэтому захват (V4L2) и кодирование (libvpx) живут в Rust. C-шим
    // компилируется против системных заголовков libvpx — раскладку
    // vpx_codec_enc_cfg_t не описываем вручную (меняется между версиями).
    // Android-таргет не трогаем: там кадры даёт WebCodecs в WebView.
    let host_linux = cfg!(target_os = "linux") && !target.contains("android");
    if host_linux {
        cc::Build::new()
            .file("src/vp8_enc_shim.c")
            .warnings(true)
            .compile("vault_vp8_enc");
        println!("cargo:rerun-if-changed=src/vp8_enc_shim.c");
        println!("cargo:rustc-link-lib=vpx");
    }
    tauri_build::build()
}
