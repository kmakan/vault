fn main() {
    // Build scripts run on the HOST, so cfg!() here reflects the host — not the
    // target. Use cargo's CARGO_CFG_* env vars to detect the real target.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    if target_os == "android" {
        // Cross-compiled prebuilt static Opus for Android targets.
        // Upstream's build script runs a *host* `sh configure` (autotools), which
        // produces an x86-64 library that cannot link against Android targets.
        // Link the prebuilt static library for the current target instead.
        let arch = if target_arch == "aarch64" {
            "aarch64"
        } else if target_arch == "arm" {
            "armv7"
        } else if target_arch == "x86_64" {
            "x86_64"
        } else {
            "x86"
        };

        let base = std::env::var("PREBUILT_OPUS_DIR")
            .unwrap_or_else(|_| "/home/maksim/.prebuilt-libopus".to_string());
        let dir = format!("{base}-{arch}");
        println!("cargo:rustc-link-search=native={dir}/lib");
        println!("cargo:rustc-link-lib=static=opus");
        println!("cargo:include={dir}/include");
    } else {
        // Desktop (Linux/macOS/Windows): link the system libopus dynamically.
        // No prebuilt needed — prevents ARM objects leaking into x86_64 builds.
        println!("cargo:rustc-link-search=native=/usr/lib");
        println!("cargo:rustc-link-lib=dylib=opus");
    }

    println!("cargo:rerun-if-env-changed=PREBUILT_OPUS_DIR");
}
