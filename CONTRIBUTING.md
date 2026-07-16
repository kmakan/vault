# Contributing to Whisper

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

### Prerequisites
- Rust 1.75+ (`rustup`)
- Node.js 18+ (for Desktop)
- Android SDK 35 + NDK 27 (for Android)

### Clone & Build

```bash
git clone https://github.com/nickswl/mailcipher.git
cd mailcipher

# Client (CLI)
cd mailcipher-client
cargo build

# Desktop
cd ../mailcipher-desktop
npm install
npm run tauri dev
```

### Run Tests

```bash
cd mailcipher-client
cargo test  # 228 tests
```

---

## Code Style

### Rust
- Use `cargo fmt` before committing
- Follow standard Rust conventions
- Add tests for new features

### Vue.js
- Use Composition API (`<script setup>`)
- i18n: all user-facing text through `t('key')`
- New locale? Add file in `src/locales/xx.js`

---

## Pull Requests

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make changes + add tests
4. Run `cargo test` and `cargo fmt`
5. Commit with clear message
6. Open PR

### Commit Messages
```
feat: add group promote/demote
fix: resolve key exchange bug
docs: update README
test: add CLI parsing tests
```

---

## Areas for Contribution

### High Priority
- 🌐 i18n (more languages)
- 🧪 Test coverage
- 📧 Email provider compatibility

### Medium Priority
- 📱 Android UI
- 🔐 Key exchange improvements
- 📁 File organization

### Low Priority
- 🎨 UI polish
- ⚡ Performance optimization

---

## Reporting Issues

Open an issue on GitHub with:
- What you expected
- What happened
- Steps to reproduce
- OS / Rust version

---

## License

By contributing, you agree your code is licensed under MIT.
