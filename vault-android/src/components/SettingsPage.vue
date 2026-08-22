<template>
  <div class="settings-page">
    <!-- MOBILE: список разделов (когда не выбран раздел) -->
    <div v-if="!isMobile || !mobileCategory" class="settings-list">
      <div class="settings-profile">
        <AvatarUpload :email="email" :avatarUrl="userAvatarUrl" @update="$emit('avatar-update', $event)" />
        <div class="profile-name">{{ displayName || email }}</div>
      </div>
      <nav class="settings-nav">
        <button v-for="cat in categories" :key="cat.id"
          :class="['settings-nav-item', { active: !isMobile && activeCategory === cat.id }]"
          @click="selectCategory(cat.id)">
          <span class="nav-icon">{{ cat.icon }}</span>
          <span class="nav-label">{{ cat.label }}</span>
          <span v-if="isMobile" class="nav-arrow">›</span>
        </button>
      </nav>
    </div>

    <!-- MOBILE: контент раздела + DESKTOP: контент -->
    <div v-if="!isMobile || mobileCategory" class="settings-content" :class="{ 'settings-content-mobile': isMobile }">
      <!-- Кнопка назад (только мобильный) -->
      <div v-if="isMobile" class="content-header">
        <button class="content-back" @click="mobileCategory = null">←</button>
        <h2>{{ currentCategoryLabel }}</h2>
      </div>
      
      <!-- ПРОФИЛЬ -->
      <div v-if="activeCategory === 'profile'" class="settings-section">
        <h2 v-if="!isMobile">Профиль</h2>
        <div class="setting-group">
          <label>Имя</label>
          <input v-model="localDisplayName" type="text" placeholder="Ваше имя" />
        </div>
        <button @click="saveDisplayName" class="save-btn">Сохранить</button>
        <button @click="$emit('logout')" class="logout-btn">← {{ t('settings_logout') }}</button>
      </div>

      <!-- ВНЕШНИЙ ВИД -->
      <div v-if="activeCategory === 'appearance'" class="settings-section">
        <h2 v-if="!isMobile">Внешний вид</h2>
        <ThemeSelector />
        <IconPicker @icon-changed="onIconChanged" />
        <FontSelector />
      </div>

      <!-- ЧАТЫ -->
      <div v-if="activeCategory === 'chats'" class="settings-section">
        <h2 v-if="!isMobile">Чаты</h2>
        <AppBehavior />
      </div>

      <!-- ПОЧТА -->
      <div v-if="activeCategory === 'email'" class="settings-section">
        <h2 v-if="!isMobile">Почтовые аккаунты</h2>
        <EmailSettings />
      </div>

      <!-- УВЕДОМЛЕНИЯ -->
      <div v-if="activeCategory === 'notifications'" class="settings-section">
        <h2 v-if="!isMobile">Уведомления</h2>
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
        <h2 v-if="!isMobile">Приватность</h2>
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
        <h2 v-if="!isMobile">Язык</h2>
        <LanguageSelector />
      </div>

      <!-- ПОМОЩЬ -->
      <div v-if="activeCategory === 'help'" class="settings-section">
        <h2 v-if="!isMobile">Помощь</h2>
        <div class="help-links">
          <a href="https://github.com/nousresearch/vault" target="_blank">📖 Документация</a>
          <a href="https://github.com/nousresearch/vault/issues" target="_blank">🐛 Сообщить об ошибке</a>
          <div class="version">Vault v0.1.0</div>
        </div>
      </div>

      <!-- ОЧИСТИТЬ ДАННЫЕ -->
      <div v-if="activeCategory === 'clear'" class="settings-section">
        <h2 v-if="!isMobile">Очистить данные</h2>
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
import { notificationsEnabled, setNotificationsEnabled } from '../notify.js';
import AvatarUpload from './AvatarUpload.vue';
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
  emits: ['avatar-update', 'logout', 'icon-changed'],
  setup() { const { t } = useI18n(); return { t }; },
  data() {
    return {
      activeCategory: 'appearance',
      mobileCategory: null, // на мобильном: null = список, id = контент раздела
      localDisplayName: this.displayName || '',
      notifSound: true,
      notifTray: true,
      notifSystem: notificationsEnabled(),
      hideLastSeen: false,
      windowWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
      categories: [
        { id: 'profile', icon: '👤', label: 'Профиль' },
        { id: 'appearance', icon: '🎨', label: 'Внешний вид' },
        { id: 'chats', icon: '💬', label: 'Чаты' },
        { id: 'email', icon: '📧', label: 'Почта' },
        { id: 'notifications', icon: '🔔', label: 'Уведомления' },
        { id: 'privacy', icon: '🔒', label: 'Приватность' },
        { id: 'language', icon: '🌐', label: 'Язык' },
        { id: 'help', icon: '❓', label: 'Помощь' },
        { id: 'clear', icon: '🗑️', label: 'Очистить данные' }
      ]
    };
  },
  computed: {
    isMobile() { return this.windowWidth < 768; },
    currentCategoryLabel() {
      const c = this.categories.find(c => c.id === this.activeCategory);
      return c ? c.label : '';
    }
  },
  watch: {
    // Персист переключателя «Системные уведомления» (notify.js читает его
    // при каждом вызове notifyNewMessage).
    notifSystem(on) { setNotificationsEnabled(on); },
  },
  mounted() {
    this._onResize = () => this.windowWidth = window.innerWidth;
    window.addEventListener('resize', this._onResize);
  },
  beforeUnmount() {
    window.removeEventListener('resize', this._onResize);
  },
  methods: {
    selectCategory(id) {
      this.activeCategory = id;
      if (this.isMobile) this.mobileCategory = id;
    },
    saveDisplayName() {
      // Имя — настройка аккаунта: хранится в kv_store (db.kvSet), не localStorage.
      api.setDisplayName(this.localDisplayName).catch(e => console.error(e));
    },
    onIconChanged(id) {
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
/* Десктоп: две колонки (sidebar + content) */
.settings-list {
  width: 260px;
  min-width: 260px;
  background: #161b22;
  border-right: 1px solid #30363d;
  display: flex;
  flex-direction: column;
}
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}
/* Мобильный: одна колонка, список ИЛИ контент на весь экран */
@media (max-width: 767px) {
  .settings-page { flex-direction: column; }
  .settings-list {
    width: 100%;
    min-width: 0;
    border-right: none;
    border-bottom: 1px solid #30363d;
  }
  .settings-content {
    padding: 16px;
    overflow-y: auto;
  }
  .settings-content-mobile {
    padding: 0;
  }
  .content-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid #30363d;
    background: #161b22;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .content-header h2 {
    margin: 0;
    font-size: 16px;
  }
  .content-back {
    font-size: 20px;
    background: none;
    border: none;
    color: #e6edf3;
    cursor: pointer;
    padding: 4px 8px;
  }
  /* Mobile: section h2 скрыт (заголовок в content-header) */
  .settings-section h2 { display: none; }
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
.nav-icon { margin-right: 12px; font-size: 18px; width: 24px; text-align: center; }
.nav-label { flex: 1; }
.nav-arrow { color: #484f58; font-size: 18px; }
.settings-section { }
.settings-section h2 {
  margin: 0 0 20px;
  font-size: 20px;
  color: #e6edf3;
  border-bottom: 1px solid #30363d;
  padding-bottom: 12px;
}
.setting-group { margin-bottom: 16px; }
.setting-group label { display: block; margin-bottom: 6px; color: #8b949e; font-size: 13px; }
.setting-group input[type="text"] {
  width: 100%; max-width: 320px; padding: 10px 14px;
  background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
  color: #e6edf3; font-size: 14px; box-sizing: border-box;
}
.setting-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 0; border-bottom: 1px solid #21262d; font-size: 14px; color: #c9d1d9;
}
.save-btn { padding: 10px 24px; background: #238636; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
.save-btn:hover { background: #2ea043; }
.logout-btn {
  margin-top: 12px; padding: 10px 24px; background: transparent; color: #f85149;
  border: 1px solid #f85149; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;
}
.logout-btn:hover { background: rgba(248, 81, 73, 0.15); }
.danger-btn { padding: 10px 24px; background: #da3633; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
.danger-btn:hover { background: #f85149; }
.help-links { display: flex; flex-direction: column; gap: 12px; }
.help-links a { color: #58a6ff; text-decoration: none; font-size: 14px; }
.help-links a:hover { text-decoration: underline; }
.version { color: #484f58; font-size: 12px; margin-top: 16px; }
.danger-zone p { color: #f85149; margin-bottom: 12px; }
.badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge-green { background: #23863633; color: #3fb950; }
.toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
.toggle input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
  background: #30363d; border-radius: 24px; transition: 0.2s;
}
.slider::before {
  content: ""; position: absolute; height: 18px; width: 18px; left: 3px; bottom: 3px;
  background: #8b949e; border-radius: 50%; transition: 0.2s;
}
.toggle input:checked + .slider { background: #238636; }
.toggle input:checked + .slider::before { transform: translateX(20px); background: white; }
</style>