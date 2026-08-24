fn main() {
    // Android (23.08): ndk-sys (тянется cpal → AAudio) линкует `-laaudio`,
    // но cargo не знает системный путь NDK — падает «unable to find library
    // -laaudio». Добавляем sysroot нужного таргета в путь поиска библиотек.
    //
    // ВАЖНО: build.rs компилируется для ХОСТА, поэтому #[cfg(target_os =
    // "android")] здесь НИКОГДА не срабатывает — таргет берём из env TARGET.
    let target = std::env::var("TARGET").unwrap_or_default();
    let lib_dir = match target.as_str() {
        "aarch64-linux-android" | "armv7-linux-androideabi" | "i686-linux-android" | "x86_64-linux-android" => {
            let ndk = std::env::var("ANDROID_NDK_HOME").unwrap_or_default();
            let triple = if target == "armv7-linux-androideabi" {
                "arm-linux-androideabi"
            } else {
                target.as_str()
            };
            format!("{ndk}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/{triple}/34")
        }
        _ => String::new(),
    };
    if !lib_dir.is_empty() {
        println!("cargo:rustc-link-search=native={lib_dir}");
        println!("cargo:rustc-link-lib=aaudio");
        println!("cargo:rustc-link-lib=android");
        println!("cargo:rustc-link-lib=log");
    }
    tauri_build::build()
}
