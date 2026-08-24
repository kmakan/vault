<template>
  <div class="settings-page">
    <!-- Left: category list -->
    <div class="settings-sidebar">
      <div class="settings-profile">
        <AvatarUpload :email="email" :avatarUrl="userAvatarUrl" @update="$emit('avatar-update', $event)" />
        <div class="profile-name">{{ displayName || email }}</div>
      </div>
      <nav class="settings-nav">
        <button v-for="cat in categories" :key="cat.id"
          :class="['settings-nav-item', { active: activeCategory === cat.id }]"
          @click="activeCategory = cat.id">
          <span class="nav-icon"><Icon :name="cat.icon" :size="16" /></span>
          <span class="nav-label">{{ t(cat.labelKey) }}</span>
          <span class="nav-arrow">›</span>
        </button>
      </nav>
    </div>

    <!-- Right: category content -->
    <div class="settings-content">
      <!-- ПРОФИЛЬ -->
      <div v-if="activeCategory === 'profile'" class="settings-section">
        <h2>Профиль</h2>
        <div class="setting-group">
          <label>Имя</label>
          <input v-model="localDisplayName" type="text" placeholder="Ваше имя" @change="saveDisplayName" @keyup.enter="saveDisplayName" />
        </div>
        <button @click="saveDisplayName" class="btn btn-primary">Сохранить</button>
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
        <AppBehavior />
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
import api from '../api.js';
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
  components: { AvatarUpload, ThemeSelector, IconPicker, FontSelector, AppBehavior, LanguageSelector, EmailSettings },
  props: { email: String, userAvatarUrl: String, displayName: String },
  emits: ['avatar-update', 'logout', 'icon-changed', 'name-update', 'change-email'],
  setup() { const { t } = useI18n(); return { t }; },
  data() {
    return {
      activeCategory: 'appearance',
      localDisplayName: this.displayName || '',
      notifSound: true,
      notifTray: true,
      notifSystem: notificationsEnabled(),
      hideLastSeen: false,
      categories: [
        { id: 'profile', icon: 'users', labelKey: 'settings_profile' },
        { id: 'appearance', icon: 'palette', labelKey: 'settings_appearance' },
        { id: 'chats', icon: 'chat', labelKey: 'settings_chats' },
        { id: 'email', icon: 'mail', labelKey: 'settings_email' },
        { id: 'notifications', icon: 'bell', labelKey: 'settings_notifications' },
        { id: 'privacy', icon: 'lock', labelKey: 'settings_privacy' },
        { id: 'language', icon: 'globe', labelKey: 'settings_language' },
        { id: 'help', icon: 'help', labelKey: 'settings_help' },
        { id: 'clear', icon: 'trash', labelKey: 'settings_clear' }
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
  methods: {
    async saveDisplayName() {
      // Имя — настройка аккаунта: хранится в kv_store (db.kvSet), не localStorage.
      try { await api.setDisplayName(this.localDisplayName); } catch (e) { console.error(e); }
      this.$emit('name-update', this.localDisplayName);
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

/* Мобильный режим (портрет телефона): навигация — горизонтальная полоса
   сверху, контент под ней. Иначе 260px sidebar + контент не помещаются
   на 412px и приходится поворачивать телефон (фикс 21.08).
   ВАЖНО: media query должен идти ПОСЛЕ базовых правил (.settings-sidebar
   width:260px) — scoped-селекторы имеют одинаковую специфичность, и
   побеждает последний. Раньше блок стоял в начале и не применялся. */
@media (max-width: 767px) {
  .settings-page {
    flex-direction: column;
  }
  .settings-sidebar {
    width: 100%;
    min-width: 0;
    flex-direction: row;
    align-items: center;
    border-right: none;
    border-bottom: 1px solid #30363d;
  }
  .settings-profile {
    padding: 12px 16px;
    border-bottom: none;
    border-right: 1px solid #30363d;
  }
  .settings-nav {
    flex: 1;
    display: flex;
    flex-direction: row;
    overflow-x: auto;
    padding: 0;
    -webkit-overflow-scrolling: touch;
  }
  .settings-nav-item {
    flex-shrink: 0;
    padding: 12px 14px;
  }
  .settings-content {
    padding: 16px;
    overflow-y: auto;
  }
}
</style>
