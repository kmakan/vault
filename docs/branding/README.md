# Брендинг Vault — Android-лаунчер-иконка

**Официальная иконка приложения на рабочем столе Android** — историческая
голубо-жёлтая (два разъединённых полукруга с точками). Утверждена
пользователем 19.08.2026: «она мне понравилась, она и будет теперь иконкой
приложения».

Файлы:
- `vault-android-launcher-192.png` — оригинал из gen/android
  (mipmap-xxxhdpi/ic_launcher.png)
- `vault-android-launcher-512.png` — увеличенная копия для просмотра
- `vault-android-launcher-round-512.png` — round-вариант (512)

Происхождение: иконка живёт в `vault-android/src-tauri/gen/android/app/src/
main/res/mipmap-*/ic_launcher*.png` (в git). Фиолетовый контурный V — только
в окне приложения (src-tauri/icons), НЕ на рабочем столе.

⚠️ НЕ запускать `npx tauri icon` в vault-android — он перезапишет mipmap.
Если перезаписаны — восстановить:
`git checkout -- vault-android/src-tauri/gen/android/app/src/main/res/mipmap-*/ic_launcher*.png`
