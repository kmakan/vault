# Whisper — Анализ текущего состояния и план Pro-версии

## 📊 Текущее состояние

### Desktop UI (Vue.js + Tauri)
| Компонент | Статус | Описание |
|-----------|--------|----------|
| Sidebar | ✅ | Контакты, поиск, навигация (💬 Чаты / 📧 Почта) |
| Chat Area | ✅ | Сообщения, ввод, отправка |
| UserAvatar | ✅ | Детерминированные аватары из email |
| GroupSettings | ✅ | Участники, promote/demote/block/unblock |
| KeyManager | ✅ | Генерация, экспорт ключей |
| QR Code | ✅ | Панель QR-кода |
| EmailSettings | ✅ | Настройка IMAP/SMTP |
| LanguageSelector | ✅ | EN/RU/CN |
| Dark Theme | ✅ | CSS variables, градиенты |

### CLI (Rust)
| Команда | Статус | Описание |
|---------|--------|----------|
| /help | ✅ | 15 топиков, aliases |
| /connect | ✅ | IMAP подключение |
| /chat | ✅ | Режим чата |
| /send | ✅ | Отправка сообщений |
| /keygen/keys | ✅ | Управление ключами |
| /keyshare | ✅ | 5 методов обмена (copy/signal/simplex/pgp/briar) |
| /encrypt/decrypt | ✅ | XChaCha20-Poly1305 |
| /attach/sendfile | ✅ | Файлы |
| /folders | ✅ | Папки (Telegram-style) |
| /thumb | ✅ | Миниатюры медиа |
| /groups | ✅ | Группы (create/invite/remove/promote/demote/block) |
| /search | ✅ | Полнотекстовый поиск (FTS5) |
| /react | ✅ | Реакции |
| /pin | ✅ | Закрепление |
| /mute | ✅ | Уведомления |

---

## ❌ Что не реализовано (Desktop UI)

### Критичное для MVP
1. **Emoji picker** — нет выбора эмодзи при вводе
2. **Реакции на сообщениях** — в CLI есть, в Desktop нет
3. **Поиск сообщений** — кнопка 🔍 есть, но searchMessages() пустой
4. **Вложение файлов** — кнопка 📎 есть, но нет обработчика
5. **Статус онлайн** — dot есть, но всегда серый
6. **Создание группы** — данные есть, но нет UI

### Важное для конкурентоспособности
7. **Пересылка сообщений** — нет UI
8. **Закрепление сообщений** — нет UI
9. **Индикатор набора текста** — нет
10. **Read receipts** — нет UI (в CLI есть)
11. **Темы оформления** — только тёмная тема
12. **Свои шрифты** — только системные

---

## 🚀 Pro-версия: План

### 1. Темы оформления (Themes)
**Реализация:** CSS variables + переключатель в настройках

```javascript
// src/themes.js
export const themes = {
  dark: {
    name: 'Dark',
    icon: '🌙',
    vars: {
      '--bg-primary': '#0a0a1a',
      '--bg-secondary': '#12122a',
      '--accent-primary': '#6366f1',
    }
  },
  light: {
    name: 'Light',
    icon: '☀️',
    vars: {
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f8fafc',
      '--accent-primary': '#6366f1',
    }
  },
  nord: {
    name: 'Nord',
    icon: '❄️',
    vars: {
      '--bg-primary': '#2e3440',
      '--bg-secondary': '#3b4252',
      '--accent-primary': '#88c0d0',
    }
  },
  dracula: {
    name: 'Dracula',
    icon: '🧛',
    vars: {
      '--bg-primary': '#282a36',
      '--bg-secondary': '#44475a',
      '--accent-primary': '#ff79c6',
    }
  },
  solarized: {
    name: 'Solarized',
    icon: '🌅',
    vars: {
      '--bg-primary': '#002b36',
      '--bg-secondary': '#073642',
      '--accent-primary': '#268bd2',
    }
  },
  pro: {
    name: 'Cyberpunk',
    icon: '🌆',
    vars: {
      '--bg-primary': '#0d0221',
      '--bg-secondary': '#150734',
      '--accent-primary': '#ff2a6d',
    }
  }
}
```

### 2. Шрифты (Fonts)
**Реализация:** CSS @import + переключатель

```css
/* src/assets/fonts.css */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap');

/* Pro fonts */
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
```

**Шрифты для Pro:**
- **Manrope** — современный, чистый
- **Plus Jakarta Sans** — премиальный, круглый
- **Space Grotesk** — футуристичный
- **Outfit** — элегантный

### 3. Emoji Picker
**Реализация:** Библиотека `emoji-mart-vue3` или кастомный компонент

```
Категории:
😀 Smileys & People
🐾 Animals & Nature
🍔 Food & Drink
⚽ Activities
🚗 Travel & Places
💡 Objects
❤️ Symbols
🏁 Flags
🔒 Whisper (кастомные: 🔐, 🛡️, 🔑, 📨)
```

### 4. Pro-фичи (легко реализуемые)

| Фича | Сложность | Описание |
|------|-----------|----------|
| **Темы** | Низкая | CSS variables + localStorage |
| **Шрифты** | Низкая | @import + переключатель |
| **Emoji picker** | Средняя | Библиотека или кастом |
| **Группировка чатов** | Низкая | Папки (уже в CLI) |
| **Экспорт чата** | Низкая | JSON/TXT экспорт |
| **Закрепление** | Низкая | Pin/unpin в UI |
| **Реакции** | Низкая | Emoji на сообщениях |
| **Read receipts** | Средняя | ✓ ✓ отправитель видит |
| **Индикатор набора** | Средняя | "печатает..." |
| **Аудиосообщения** | Средняя | MediaRecorder → base64/вложение |
| **Экспорт чатов** | Низкая | JSON/TXT |
| **Мульти-аккаунт** | Средняя | Несколько email аккаунтов |

### 5. Монетизация Pro

**Free:**
- Базовые темы (Dark, Light)
- Системные шрифты
- Лимит 10 контактов
- Лимит 5 групп
- Email-транспорт

**Pro (₽99/мес):**
- Все темы (Nord, Dracula, Solarized, Cyberpunk)
- Премиум шрифты (Manrope, Plus Jakarta Sans)
- Без лимитов
- Emoji picker расширенный
- Аудиосообщения
- Приоритет поддержки (ответ в течение 24ч)
- Экспорт чатов
- Приоритетные обновления

**Team (₽299/мес):**
- Всё из Pro
- Админ панель
- Аудит безопасности
- SLA 4ч
- Мульти-аккаунт

---

## 🎯 Лёгкие улучшения для MVP (до релиза)

1. **Emoji picker** — добавить кнопку 😊 рядом с input
2. **Реакции** — клик по сообщению → popup с эмодзи
3. **Поиск** — реализовать searchMessages() с фильтрацией
4. **Создание группы** — кнопка "Новая группа" в sidebar
5. **Онлайн статус** — mock (всегда онлайн для demo)
6. **Закрепление** — иконка 📌 на сообщениях
7. **Read receipts** — ✓ после отправки

---

## 📋 Порядок реализации

### Фаза 1: MVP (до 20.08)
1. ✅ Базовый UI (сделано)
2. ✅ Группы (сделано)
3. ✅ Ключи и шифрование (сделано)
4. ✅ CLI help (сделано)
5. ❌ Emoji picker (легко)
6. ❌ Реакции (легко)
7. ❌ Поиск сообщений (легко)
8. ❌ Создание группы UI (легко)

### Фаза 2: Pro (после релиза)
1. Аудиосообщения (запись + base64/вложение)
2. Темы оформления
3. Премиум шрифты
4. Расширенный emoji picker
5. Экспорт чатов
6. Приоритетная поддержка

### Фаза 3: Team
1. Админ панель
2. Аудит безопасности
3. SLA поддержка
4. Мульти-аккаунт
