fn main() {
    // Cross-compiled prebuilt static Opus for Android targets.
    // Upstream's build script runs a *host* `sh configure` (autotools), which
    // produces an x86-64 library that cannot link against Android targets.
    // Link the prebuilt static library for the current target instead.
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "arm") {
        "armv7"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "x86"
    };

    let base = std::env::var("PREBUILT_OPUS_DIR")
        .unwrap_or_else(|_| "/home/maksim/.prebuilt-libopus".to_string());
    let dir = format!("{base}-{arch}");

    println!("cargo:rustc-link-search=native=/home/maksim/.prebuilt-libopus-aarch64/lib");
    println!("cargo:rustc-link-lib=static=opus");
    println!("cargo:rerun-if-env-changed=PREBUILT_OPUS_DIR");

    let include = format!("{dir}/include");
    println!("cargo:include={include}");
}
