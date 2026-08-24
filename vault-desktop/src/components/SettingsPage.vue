<template>
  <div class="settings-page">
    <!-- Left: category list (на мобильном: отдельный «экран списка» —
         скрывается, когда открыт раздел; кнопка «←» возвращает к списку) -->
    <div class="settings-sidebar" v-show="!activeCategory || !isMobile">
      <div class="settings-profile">
        <AvatarUpload :email="email" :avatarUrl="userAvatarUrl" @update="$emit('avatar-update', $event)" />
        <div class="profile-name">{{ displayName || email }}</div>
      </div>
      <nav class="settings-nav">
        <button v-for="cat in categories" :key="cat.id"
          :class="['settings-nav-item', { active: activeCategory === cat.id }]"
          @click="activeCategory = cat.id">
          <span class="nav-icon"><Icon :name="cat.icon" :size="18" /></span>
          <span class="nav-label">{{ cat.label }}</span>
          <span class="nav-arrow">›</span>
        </button>
      </nav>
    </div>

    <!-- Right: category content (на мобильном показываем только когда
         раздел выбран; сверху — единая шапка с кнопкой «← Назад») -->
    <div class="settings-content" v-show="activeCategory || !isMobile">
      <button v-if="isMobile" class="settings-back-btn" @click="activeCategory = ''">
        <Icon name="back" :size="20" /><span>Назад</span>
      </button>
      <!-- ПРОФИЛЬ -->
      <div v-if="activeCategory === 'profile'" class="settings-section">
        <h2>Профиль</h2>
        <div class="setting-group">
          <label>Имя</label>
          <input v-model="localDisplayName" type="text" placeholder="Ваше имя" @change="saveDisplayName" @keyup.enter="saveDisplayName" />
        </div>
        <div class="setting-group">
          <label>О себе (видят контакты)</label>
          <textarea v-model="localBio" rows="2" maxlength="200" placeholder="Пара слов о себе…" class="bio-input"></textarea>
          <span class="bio-counter">{{ localBio.length }}/200</span>
        </div>
        <button @click="saveProfileFields" class="btn btn-primary">Сохранить</button>
        <button @click="$emit('logout')" class="btn btn-danger logout-btn">← {{ t('settings_logout') }}</button>
      </div>

      <!-- ВНЕШНИЙ ВИД -->
      <div v-if="activeCategory === 'appearance'" class="settings-section">
        <h2>Внешний вид</h2>
        <ThemeSelector />
        <IconPicker @icon-changed="onIconChanged" />
        <FontSelector />
      </div>

      <!-- ЧАТЫ -->
      <div v-if="activeCategory === 'chats'" class="settings-section">
        <h2>Чаты</h2>
        <div class="setting-group">
          <label>Качество отправляемых медиафайлов</label>
          <select v-model="localMediaQuality" @change="saveMediaQuality" class="media-quality-select">
            <option value="high">Высокое — сжатие для быстрой доставки</option>
            <option value="low">Низкое — для плохой связи</option>
            <option value="original">Оригинал — без сжатия (большой трафик)</option>
          </select>
          <p class="setting-hint">Изображения больше выбранного размера сжимаются автоматически. Файлы всегда отправляются как есть.</p>
        </div>
        <AppBehavior />
      </div>

      <!-- ЭКСПЕРИМЕНТАЛЬНЫЕ ФУНКЦИИ (25.08, по модели Delta Chat) -->
      <div v-if="activeCategory === 'experiments'" class="settings-section">
        <h2>Экспериментальные функции</h2>
        <p class="setting-hint" style="margin-bottom:16px">
          Эти функции могут быть нестабильными и могут быть изменены или удалены.
        </p>
        <div class="setting-row">
          <span>Звонки (бета){{ experimentsCalls ? ' — включены' : '' }}</span>
          <label class="toggle"><input type="checkbox" v-model="experimentsCalls" @change="$emit('experiments-calls', experimentsCalls)" /><span class="slider"></span></label>
        </div>
        <p v-if="experimentsCalls" class="setting-hint">Кнопка вызова появится в шапке чатов с ключом собеседника. Аудио-звонки P2P, шифрование DTLS-SRTP.</p>
      </div>

      <!-- ПОЧТА -->
      <div v-if="activeCategory === 'email'" class="settings-section">
        <h2>Почтовые аккаунты</h2>
        <EmailSettings />
        <!-- Смена почты (24.08): ключи E2E не зависят от email — можно сменить
             адрес, контакты и группы останутся. Контакты узнают новый адрес
             автоматически: broadcast-письмо несёт тот же fingerprint (ключ). -->
        <div class="change-email-block">
          <button @click="$emit('change-email')" class="btn btn-secondary"><Icon name="mail" :size="14" /> {{ t('settings_change_email') || 'Сменить почту' }}</button>
          <p class="change-email-note">Контакты и группы останутся. Собеседники узнают новый адрес автоматически.</p>
        </div>
        <!-- Резервная копия (24.08): ключи + профили + пометки. Как у DC
             «Экспорт резервной копии» — файл можно хранить и восстановить
             на другом устройстве / после переустановки. -->
        <div class="change-email-block">
          <h3 class="backup-title">🗄 Резервная копия</h3>
          <button @click="exportBackup" :disabled="backupBusy" class="btn btn-secondary backup-btn">⬇ {{ backupBusy ? '…' : 'Экспорт резервной копии' }}</button>
          <label class="backup-import-label">
            <span class="btn btn-secondary backup-btn">⬆ Восстановить из копии</span>
            <input type="file" accept=".json,application/json" class="backup-file-input" @change="importBackup" />
          </label>
          <p v-if="backupResult" class="change-email-note">{{ backupResult }}</p>
          <p class="change-email-note">В копию входят: ключи E2E, контакты, профили, пометки, курсоры. Пароль почты — нет (введите при входе).</p>
        </div>
      </div>

      <!-- УВЕДОМЛЕНИЯ -->
      <div v-if="activeCategory === 'notifications'" class="settings-section">
        <h2>Уведомления</h2>
        <div class="setting-row">
          <span>Системные уведомления</span>
          <label class="toggle"><input type="checkbox" v-model="notifSystem" /><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <span>Звук уведомлений</span>
          <label class="toggle"><input type="checkbox" v-model="notifSound" /><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <span>Показывать в трее</span>
          <label class="toggle"><input type="checkbox" v-model="notifTray" /><span class="slider"></span></label>
        </div>
      </div>

      <!-- ПРИВАТНОСТЬ -->
      <div v-if="activeCategory === 'privacy'" class="settings-section">
        <h2>Приватность</h2>
        <div class="setting-row">
          <span>E2E шифрование</span>
          <span class="badge badge-green">Включено</span>
        </div>
        <div class="setting-row">
          <span>Скрыть последний вход</span>
          <label class="toggle"><input type="checkbox" v-model="hideLastSeen" /><span class="slider"></span></label>
        </div>
      </div>

      <!-- ЯЗЫК -->
      <div v-if="activeCategory === 'language'" class="settings-section">
        <h2>Язык</h2>
        <LanguageSelector />
      </div>

      <!-- ПОМОЩЬ -->
      <div v-if="activeCategory === 'help'" class="settings-section">
        <h2>Помощь</h2>
        <div class="help-links">
          <a href="https://github.com/nousresearch/vault" target="_blank">📖 Документация</a>
          <a href="https://github.com/nousresearch/vault/issues" target="_blank">🐛 Сообщить об ошибке</a>
          <div class="version">Vault v0.1.0</div>
        </div>
      </div>

      <!-- ОЧИСТИТЬ ДАННЫЕ -->
      <div v-if="activeCategory === 'clear'" class="settings-section">
        <h2>Очистить данные</h2>
        <div class="danger-zone">
          <p>⚠️ Это удалит все локальные данные: ключи, чаты, настройки.</p>
          <button @click="clearLocalData" class="danger-btn">Очистить все данные</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api, { db } from '../api.js';
import { useI18n } from '../i18n.js';
import { invoke } from '@tauri-apps/api/core';
import { notificationsEnabled, setNotificationsEnabled } from '../notify.js';
import AvatarUpload from './AvatarUpload.vue';
import Icon from './Icon.vue';
import ThemeSelector from './ThemeSelector.vue';
import IconPicker from './IconPicker.vue';
import FontSelector from './FontSelector.vue';
import AppBehavior from './AppBehavior.vue';
import LanguageSelector from './LanguageSelector.vue';
import EmailSettings from './EmailSettings.vue';

export default {
  name: 'SettingsPage',
  components: { AvatarUpload, ThemeSelector, IconPicker, FontSelector, AppBehavior, LanguageSelector, EmailSettings, Icon },
  props: { email: String, userAvatarUrl: String, displayName: String, bio: String },
  emits: ['avatar-update', 'logout', 'icon-changed', 'name-update', 'change-email', 'bio-save', 'experiments-calls'],
  setup() { const { t } = useI18n(); return { t }; },
  data() {
    return {
      // Мобильный режим (25.08): на телефоне список разделов и контент —
      // отдельные «экраны» (v-show), на десктопе оба видны всегда.
      isMobile: window.matchMedia('(max-width: 767px)').matches,
      // На мобильном стартуем со списка разделов, на десктопе — «Профиль».
      activeCategory: window.matchMedia('(max-width: 767px)').matches ? '' : 'profile',
      localDisplayName: this.displayName || '',
      localBio: this.bio || '',
      localMediaQuality: 'high',
      experimentsCalls: false,
      notifSound: true,
      notifTray: true,
      notifSystem: notificationsEnabled(),
      hideLastSeen: false,
      categories: [
        { id: 'profile', icon: 'users', label: 'Профиль' },
        { id: 'appearance', icon: 'palette', label: 'Внешний вид' },
        { id: 'chats', icon: 'chat', label: 'Чаты' },
        { id: 'experiments', icon: 'help', label: 'Экспериментальные функции' },
        { id: 'email', icon: 'mail', label: 'Почта' },
        { id: 'notifications', icon: 'bell', label: 'Уведомления' },
        { id: 'privacy', icon: 'lock', label: 'Приватность' },
        { id: 'language', icon: 'globe', label: 'Язык' },
        { id: 'help', icon: 'help', label: 'Помощь' },
        { id: 'clear', icon: 'trash', label: 'Очистить данные' }
      ],
      backupBusy: false,
      backupResult: '',
    };
  },
  watch: {
    // Персист переключателя «Системные уведомления» (notify.js читает его
    // при каждом вызове notifyNewMessage).
    notifSystem(on) { setNotificationsEnabled(on); },
  },
  async mounted() {
    // Настройки чатов/экспериментов (kv_store)
    try {
      this.localMediaQuality = (await db.kvGet('anon', 'media-quality')) || 'high';
      this.experimentsCalls = (await db.kvGet('anon', 'exp-calls')) === '1';
    } catch (e) { /* ignore */ }
  },
  methods: {
    async saveDisplayName() {
      // Имя — настройка аккаунта: хранится в kv_store (db.kvSet), не localStorage.
      try { await api.setDisplayName(this.localDisplayName); } catch (e) { console.error(e); }
      this.$emit('name-update', this.localDisplayName);
    },
    async saveMediaQuality() {
      try {
        await db.kvSet('anon', 'media-quality', this.localMediaQuality);
      } catch (e) { /* ignore */ }
    },
    // Имя + статус «О себе» одной кнопкой; bio уходит контактам broadcast-письмом.
    async saveProfileFields() {
      await this.saveDisplayName();
      this.$emit('bio-save', this.localBio);
    },
    // --- Резервная копия (24.08) ---
    // Экспорт: ключи + kv_store (профили, пометки, курсоры) в JSON-файл.
    async exportBackup() {
      this.backupBusy = true;
      this.backupResult = '';
      try {
        const json = await invoke('export_backup');
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
        this.backupResult = '✅ Резервная копия сохранена. Храните файл в надёжном месте.';
      } catch (e) {
        this.backupResult = '❌ Экспорт не удался: ' + (e.message || e);
      } finally {
        this.backupBusy = false;
      }
    },
    async importBackup(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (!(await confirm('Восстановить из резервной копии? Текущие локальные данные будут заменены.'))) {
        event.target.value = '';
        return;
      }
      this.backupBusy = true;
      this.backupResult = '';
      try {
        const text = await file.text();
        const result = await invoke('import_backup', { jsonData: text });
        this.backupResult = '✅ Восстановлено: ' + result + '. Перезапустите приложение.';
        this.$emit('keys-changed');
      } catch (e) {
        this.backupResult = '❌ Восстановление не удалось: ' + (e.message || e);
      } finally {
        this.backupBusy = false;
        event.target.value = '';
      }
    },
    onIconChanged(id) {
      // Forward to the app root so the visible header logo swaps live
      this.$emit('icon-changed', id);
    },
    async clearLocalData() {
      if (!(await confirm('Вы уверены? Все данные будут удалены навсегда.'))) return;
      if (!(await confirm('Точно удалить?'))) return;
      localStorage.clear();
      indexedDB.deleteDatabase('vault');
      location.reload();
    }
  }
};
</script>

<style scoped>
.settings-page {
  display: flex;
  height: 100%;
  background: #0d1117;
  color: #e6edf3;
}

.settings-sidebar {
  width: 260px;
  min-width: 260px;
  background: #161b22;
  border-right: 1px solid #30363d;
  display: flex;
  flex-direction: column;
}

.settings-profile {
  padding: 24px 20px 16px;
  text-align: center;
  border-bottom: 1px solid #30363d;
}

.profile-name {
  margin-top: 8px;
  font-size: 16px;
  font-weight: 600;
  color: #e6edf3;
}

.settings-nav {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 12px 20px;
  background: none;
  border: none;
  color: #8b949e;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
}

.settings-nav-item:hover {
  background: #21262d;
  color: #e6edf3;
}

.settings-nav-item.active {
  background: #1f6feb22;
  color: #58a6ff;
  border-right: 2px solid #58a6ff;
}

.nav-icon {
  margin-right: 12px;
  font-size: 18px;
  width: 24px;
  text-align: center;
}

.nav-label { flex: 1; }

.nav-arrow {
  color: #484f58;
  font-size: 18px;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

.settings-section h2 {
  margin: 0 0 20px;
  font-size: 20px;
  color: #e6edf3;
  border-bottom: 1px solid #30363d;
  padding-bottom: 12px;
}

.setting-group {
  margin-bottom: 16px;
}

.setting-group label {
  display: block;
  margin-bottom: 6px;
  color: #8b949e;
  font-size: 13px;
}

.setting-group input[type="text"] {
  width: 100%;
  max-width: 320px;
  padding: 10px 14px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 8px;
  color: #e6edf3;
  font-size: 14px;
  box-sizing: border-box;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid #21262d;
  font-size: 14px;
  color: #c9d1d9;
}

/* Единая система кнопок (глобальная в App.vue): .btn, .btn-primary,
   .btn-secondary, .btn-danger, .btn-ghost, .btn-sm, .btn-lg.
   Здесь только локальные доводки. */
.logout-btn { margin-top: 8px; }

/* Toggle switch */
.toggle {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  cursor: pointer;
}

.toggle input { opacity: 0; width: 0; height: 0; }

.slider {
  position: absolute;
  inset: 0;
  background: #30363d;
  border-radius: 12px;
  transition: 0.2s;
}

.slider::before {
  content: '';
  position: absolute;
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background: white;
  border-radius: 50%;
  transition: 0.2s;
}

.toggle input:checked + .slider { background: #238636; }
.toggle input:checked + .slider::before { transform: translateX(20px); }

/* Badges */
.badge {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.badge-green { background: #23863622; color: #3fb950; border: 1px solid #238636; }

/* Danger zone */
.danger-zone {
  padding: 20px;
  background: #da363322;
  border: 1px solid #da3633;
  border-radius: 8px;
}

.danger-zone p { color: #f85149; margin: 0 0 16px; }

.danger-btn {
  padding: 10px 24px;
  background: #da3633;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
}

.danger-btn:hover { background: #f85149; }

.logout-btn {
  margin-top: 12px;
  padding: 10px 24px;
  background: transparent;
  color: #f85149;
  border: 1px solid #f85149;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
}

.logout-btn:hover { background: rgba(248, 81, 73, 0.15); }

/* Блоки в секции «Почта»: смена почты + резервная копия */
.change-email-block { margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.08); }
.change-email-note { color: #8b949e; font-size: 12px; margin-top: 8px; }
.backup-title { color: #e6edf3; font-size: 14px; margin: 0 0 10px; }
.backup-btn { display: inline-block; margin-right: 8px; margin-bottom: 4px; }
.backup-import-label { display: inline-block; cursor: pointer; }
.backup-file-input { display: none; }

/* Help */

/* Help */
.help-links { display: flex; flex-direction: column; gap: 12px; }
.help-links a { color: #58a6ff; text-decoration: none; font-size: 14px; }
.help-links a:hover { text-decoration: underline; }
.version { color: #484f58; font-size: 12px; margin-top: 16px; }

/* Мобильный режим (25.08): список разделов и контент — два «экрана»,
   переключаются v-show (см. шаблон): экран списка (профиль + вертикальный
   список) → тап по разделу → экран раздела с кнопкой «← Назад» сверху.
   Прежний вариант (горизонтальная полоса вкладок) терял разделы:
   пункты с width:100% уезжали в скролл и полоса выглядела пустой.
   ВАЖНО: media query после базовых правил — scoped-специфичность равная,
   побеждает последний. */
@media (max-width: 767px) {
  .settings-page {
    display: block;
    height: 100%;
  }
  .settings-sidebar {
    width: 100%;
    min-width: 0;
    height: 100%;
    overflow-y: auto;
    border-right: none;
  }
  .settings-profile {
    padding: 20px 16px 16px;
    border-bottom: 1px solid #30363d;
  }
  .settings-nav {
    display: flex;
    flex-direction: column;
    overflow: visible;
    padding: 4px 0;
    /* Android: env(safe-area-inset-bottom) в WebView часто = 0, поэтому
       запас ФИКСИРОВАННЫЙ — иначе последний пункт («Очистить данные»)
       при полной прокрутке остаётся под панелью жестов/кнопок и на него
       невозможно нажать. */
    padding-bottom: calc(48px + var(--safe-bottom, 0px));
  }
  .settings-nav-item {
    width: 100%;
    padding: 14px 20px;
  }
  .settings-content {
    height: 100%;
    overflow-y: auto;
    padding: 0 16px calc(72px + var(--safe-bottom, 0px));
    box-sizing: border-box;
  }
}

/* Кнопка «← Назад» (мобильный, экран раздела): липкая шапка, фирменная
   янтарная иконка back — единый стиль иконок Vault. На десктопе кнопка
   не рендерится (v-if), правило ни на что не влияет. */
.settings-back-btn {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 -16px 8px;
  padding: 12px 16px;
  background: #0d1117;
  border: none;
  color: #e6edf3;
  font-size: 15px;
  cursor: pointer;
  text-align: left;
}
.settings-back-btn:hover { background: #161b22; }

/* Статус «О себе» (25.08) */
.bio-input {
  width: 100%; max-width: 320px;
  padding: 10px 14px;
  background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
  color: #e6edf3; font-size: 14px; box-sizing: border-box; resize: vertical;
}
.bio-counter { display: block; margin-top: 4px; color: #8b949e; font-size: 11px; text-align: right; max-width: 320px; }
</style>
