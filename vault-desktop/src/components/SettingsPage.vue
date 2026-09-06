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
          <span class="nav-label">{{ t('settings_' + cat.id) }}</span>
          <span class="nav-arrow">›</span>
        </button>
      </nav>
    </div>

    <!-- Right: category content (на мобильном показываем только когда
         раздел выбран; сверху — единая шапка с кнопкой «← Назад») -->
    <div class="settings-content" v-show="activeCategory || !isMobile">
      <button v-if="isMobile" class="settings-back-btn" @click="activeCategory = ''">
        <Icon name="back" :size="20" /><span>{{ t('settings_back') }}</span>
      </button>
      <!-- ПРОФИЛЬ -->
      <div v-if="activeCategory === 'profile'" class="settings-section">
        <h2>{{ t('settings_profile') }}</h2>
        <div class="setting-group">
          <label>{{ t('settings_name') }}</label>
          <input v-model="localDisplayName" type="text" :placeholder="t('settings_name_ph')" @change="saveDisplayName" @keyup.enter="saveDisplayName" />
        </div>
        <div class="setting-group">
          <label>{{ t('settings_bio') }}</label>
          <textarea v-model="localBio" rows="2" maxlength="200" :placeholder="t('settings_bio_ph')" class="bio-input"></textarea>
          <span class="bio-counter">{{ localBio.length }}/200</span>
        </div>
        <div class="profile-actions">
          <button @click="saveProfileFields" class="btn btn-primary">{{ t('settings_save_profile') }}</button>
          <button @click="$emit('logout')" class="btn btn-danger logout-btn">← {{ t('settings_logout') }}</button>
        </div>
      </div>

      <!-- ВНЕШНИЙ ВИД -->
      <div v-if="activeCategory === 'appearance'" class="settings-section">
        <h2>{{ t('settings_appearance') }}</h2>
        <ThemeSelector />
        <IconPicker @icon-changed="onIconChanged" />
        <FontSelector />
      </div>

      <!-- ЧАТЫ -->
      <div v-if="activeCategory === 'chats'" class="settings-section">
        <h2>{{ t('settings_chats') }}</h2>
        <div class="setting-group">
          <label>{{ t('settings_media_quality') }}</label>
          <select v-model="localMediaQuality" @change="saveMediaQuality" class="media-quality-select">
            <option value="high">{{ t('media_high') }}</option>
            <option value="low">{{ t('media_low') }}</option>
            <option value="original">{{ t('media_original') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings_media_hint') }}</p>
        </div>
        <!-- автоочистка — удалять старые
             письма с УСТРОЙСТВА (с сервера ничего не уходит; при возврате
             в чат они догрузятся по IMAP).
             -->
        <div class="setting-group">
          <label>{{ t('settings_autoclean') }}</label>
          <select v-model="localAutoclean" @change="saveAutoclean" class="media-quality-select">
            <option value="off">{{ t('autoclean_off') }}</option>
            <option value="1d">{{ t('autoclean_1d') }}</option>
            <option value="7d">{{ t('autoclean_7d') }}</option>
            <option value="30d">{{ t('autoclean_30d') }}</option>
            <option value="365d">{{ t('autoclean_365d') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings_autoclean_hint') }}</p>
        </div>
        <AppBehavior />
      </div>

      <!-- ЭКСПЕРИМЕНТАЛЬНЫЕ ФУНКЦИИ -->
      <div v-if="activeCategory === 'experiments'" class="settings-section">
        <h2>{{ t('settings_experiments') }}</h2>
        <p class="setting-hint" style="margin-bottom:16px">
          {{ t('experiments_warning') }}
        </p>
        <div class="setting-row">
          <span>{{ t('experiments_calls') }}{{ experimentsCalls ? t('experiments_calls_on') : '' }}</span>
          <label class="toggle"><input type="checkbox" v-model="experimentsCalls" @change="$emit('experiments-calls', experimentsCalls)" /><span class="slider"></span></label>
        </div>
        <p v-if="experimentsCalls" class="setting-hint">{{ t('experiments_calls_hint') }}</p>
      </div>

      <!-- ПОЧТА -->
      <div v-if="activeCategory === 'email'" class="settings-section">
        <h2>{{ t('settings_email_accounts') }}</h2>
        <EmailSettings />
        <!-- Смена почты: ключи E2E не зависят от email — можно сменить
             адрес, контакты и группы останутся. Контакты узнают новый адрес
             автоматически: broadcast-письмо несёт тот же fingerprint (ключ).
             -->
        <div class="change-email-block">
          <button @click="$emit('change-email')" class="btn btn-secondary"><Icon name="mail" :size="14" /> {{ t('settings_change_email') || 'Сменить почту' }}</button>
          <p class="change-email-note">{{ t('settings_change_email_note') }}</p>
        </div>
        <!-- Резервная копия: ключи + профили + пометки.
             «Экспорт резервной копии» — файл можно хранить и восстановить
             на другом устройстве / после переустановки.
             -->
        <div class="change-email-block">
          <h3 class="backup-title">{{ t('settings_backup_title') }}</h3>
          <button @click="exportBackup" :disabled="backupBusy" class="btn btn-secondary backup-btn"><Icon name="download" :size="14" /> {{ backupBusy ? '…' : t('settings_backup_export') }}</button>
          <label class="backup-import-label">
            <span class="btn btn-secondary backup-btn"><Icon name="upload" :size="14" /> {{ t('settings_backup_import') }}</span>
            <input type="file" accept=".json,application/json" class="backup-file-input" @change="importBackup" />
          </label>
          <p v-if="backupResult" class="change-email-note">{{ backupResult }}</p>
          <p class="change-email-note">{{ t('settings_backup_note') }}</p>
        </div>
      </div>

      <!-- УВЕДОМЛЕНИЯ -->
      <div v-if="activeCategory === 'notifications'" class="settings-section">
        <h2>{{ t('settings_notifications') }}</h2>
        <div class="setting-row">
          <span>{{ t('settings_notif_system') }}</span>
          <label class="toggle"><input type="checkbox" v-model="notifSystem" /><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <span>{{ t('settings_notif_sound') }}</span>
          <label class="toggle"><input type="checkbox" v-model="notifSound" /><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <span>{{ t('settings_notif_tray') }}</span>
          <label class="toggle"><input type="checkbox" v-model="notifTray" /><span class="slider"></span></label>
        </div>
      </div>

      <!-- ЗВОНКИ: рингтон входящего, сигнал ожидания, превью -->
      <div v-if="activeCategory === 'calls'" class="settings-section">
        <h2>{{ t('settings_calls') }}</h2>
        <div class="setting-group">
          <label>{{ t('calls_ringtone_incoming') }}</label>
          <div class="ringtone-row">
            <select v-model="ringtoneIncoming" @change="saveRingtoneIncoming" class="media-quality-select">
              <option value="incoming">{{ t('calls_ring_vault') }}</option>
              <option value="incoming_classic">{{ t('calls_ring_classic') }}</option>
              <option value="incoming_pulse">{{ t('calls_ring_pulse') }}</option>
            </select>
            <button class="btn btn-secondary ringtone-preview" @click="previewSound(ringtoneIncoming, true)" :title="t('calls_preview')">
              <Icon name="volume" :size="16" />
            </button>
          </div>
        </div>
        <div class="setting-group">
          <label>{{ t('calls_ringtone_outgoing') }}</label>
          <div class="ringtone-row">
            <select v-model="ringtoneOutgoing" @change="saveRingtoneOutgoing" class="media-quality-select">
              <option value="outgoing">{{ t('calls_ring_vault') }}</option>
              <option value="outgoing_classic">{{ t('calls_ring_classic') }}</option>
            </select>
            <button class="btn btn-secondary ringtone-preview" @click="previewSound(ringtoneOutgoing, true)" :title="t('calls_preview')">
              <Icon name="volume" :size="16" />
            </button>
          </div>
        </div>
        <button v-if="previewPlaying" class="btn btn-secondary" @click="stopPreview">■ {{ t('calls_stop_preview') }}</button>
        <p class="setting-hint">{{ t('calls_settings_hint') }}</p>
      </div>

      <!-- ПРИВАТНОСТЬ -->
      <div v-if="activeCategory === 'privacy'" class="settings-section">
        <h2>{{ t('settings_privacy') }}</h2>
        <div class="setting-row">
          <span>{{ t('settings_e2e') }}</span>
          <span class="badge badge-green">{{ t('settings_e2e_on') }}</span>
        </div>
        <div class="setting-row">
          <span>{{ t('settings_hide_last_seen') }}</span>
          <label class="toggle"><input type="checkbox" v-model="hideLastSeen" /><span class="slider"></span></label>
        </div>

        <!-- Duress-защита: замок, panic-PIN, duress-PIN -->
      <div class="setting-row" style="display:block">
        <div style="margin-bottom:14px">
          <label class="toggle"><input type="checkbox" v-model="duressEnabled" @change="duressToggleLock" /><span class="slider"></span></label>
          <span style="margin-left:10px">{{ t('duress_lock_enable') || 'Блокировка приложения (PIN/пароль)' }}</span>
        </div>
        <div v-if="duressEnabled" style="display:flex;flex-direction:column;gap:12px;padding-left:2px">
          <div>
            <div class="duress-label">{{ t('duress_lock_code') || 'Код разблокировки' }}</div>
            <input v-model="duressLockCode" type="password" class="duress-input" :placeholder="t('duress_code_ph') || 'минимум 4 символа'" />
          </div>
          <div>
            <div class="duress-label">{{ t('duress_panic') || 'Panic-код (стирает все данные при вводе)' }}</div>
            <input v-model="duressPanicCode" type="password" class="duress-input" :placeholder="t('duress_optional') || 'необязательно'" />
          </div>
          <div>
            <div class="duress-label">{{ t('duress_duress') || 'Duress-код (тихо отправит SOS и откроет приложение)' }}</div>
            <input v-model="duressDuressCode" type="password" class="duress-input" :placeholder="t('duress_optional') || 'необязательно'" />
          </div>
          <div>
            <div class="duress-label">{{ t('duress_sos_text') || 'Текст SOS-сообщения ({coords} — подставит координаты)' }}</div>
            <input v-model="duressSosText" class="duress-input" :placeholder="t('sos_text_ph')" />
          </div>
          <div>
            <label class="toggle"><input type="checkbox" v-model="duressSosGeo" @change="onSosGeoChange" /><span class="slider"></span></label>
            <span style="margin-left:10px;font-size:13.5px;color:#8b93a7">{{ t('duress_geo') || 'Добавлять координаты в SOS (запросит доступ к геолокации)' }}</span>
          </div>
          <div v-if="isAndroid">
            <label class="toggle"><input type="checkbox" v-model="duressBio" @change="onBioChange" /><span class="slider"></span></label>
            <span style="margin-left:10px;font-size:13.5px;color:#8b93a7">{{ t('duress_bio') || 'Снимать замок по отпечатку пальца' }}</span>
          </div>
          <div>
            <div class="duress-label">{{ t('duress_recipients') || 'Кому отправлять SOS' }}</div>
            <div class="duress-contacts">
              <label v-for="c in duressContacts" :key="c" class="duress-contact">
                <input type="checkbox" :value="c" v-model="duressRecipients" />
                <span>{{ c }}</span>
              </label>
              <p v-if="!duressContacts.length" class="duress-warn">{{ t('duress_no_contacts') || 'Добавьте контакты, чтобы отправлять им SOS' }}</p>
            </div>
          </div>
          <button class="btn-primary" style="align-self:flex-start;padding:8px 16px;border-radius:8px;border:none;cursor:pointer" @click="duressSave">
            {{ t('duress_save') || 'Сохранить аварийную защиту' }}
          </button>
          <div class="duress-warn">{{ t('duress_warn') || 'Запомните коды! Panic-код стирает ВСЕ данные безвозвратно. Duress-код выглядит как обычный вход, но тихо предупреждает выбранные контакты.' }}</div>
        </div>
      </div>

      <!-- M2.2: Push-релеи (список с фолбэком, свои/community) — стиль как у остальных строк -->
      <div class="setting-row" style="display:flex;justify-content:space-between;align-items:center;margin-top:18px">
        <span>{{ t('relay_enable') || 'Push-релеи (ускоренная доставка)' }}</span>
        <label class="toggle"><input type="checkbox" v-model="relayEnabled" @change="relaySave" /><span class="slider"></span></label>
      </div>
        <div v-if="relayEnabled" style="display:flex;flex-direction:column;gap:12px;padding-left:2px">
          <div>
            <div class="duress-label">{{ t('relay_list') || 'Релеи (первый живой используется автоматически)' }}</div>
            <div v-for="(r, i) in relayList" :key="r.url" class="duress-contact" style="align-items:center;gap:8px">
              <span style="flex:1;font-size:12.5px">{{ r.label || r.url }}</span>
              <span style="font-size:11px;opacity:.7">{{ r.myToken ? '✓' : '—' }}</span>
              <span :style="{color: r._health === true ? '#22c55e' : r._health === false ? '#ef4444' : 'inherit', fontSize:'12px'}">{{ r._health === true ? '●' : r._health === false ? '○' : '' }}</span>
              <button class="duress-remove" :title="t('relay_check') || 'Проверить'" @click="relayCheckOne(i)">↻</button>
              <button class="duress-remove" @click="relayRemoveRelay(i)">×</button>
            </div>
            <div style="display:flex;gap:8px;margin-top:6px">
              <input v-model="relayNewUrl" class="duress-input" style="flex:2" :placeholder="t('relay_base_url_ph') || 'https://…/relay'" />
              <input v-model="relayNewToken" class="duress-input" style="flex:2" type="password" :placeholder="t('relay_token_ph') || 'мой read-токен этого релея'" />
              <button class="btn-primary" style="padding:8px 14px;border-radius:8px;border:none;cursor:pointer;white-space:nowrap" @click="relayAddRelay">{{ t('add') || 'Добавить' }}</button>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <input v-model="relayPromoKey" class="duress-input" style="flex:1" :placeholder="t('relay_promo_ph') || 'промо-ключ безлимита (если есть)'" />
              <button class="btn-primary" style="padding:8px 14px;border-radius:8px;border:none;cursor:pointer;white-space:nowrap" @click="relayAutoRegister">
                {{ t('relay_auto') || 'Получить токен автоматически (наш релей)' }}
              </button>
            </div>
            <div v-if="relayNtfyLink" class="duress-contact" style="align-items:center;gap:8px">
              <span style="flex:1;font-size:12.5px">{{ t('relay_ntfy_hint') || 'Для пушей при закрытом приложении подпишите ntfy-клиент на ваш topic:' }}</span>
              <a :href="relayNtfyLink" style="color:#f59e0b;font-size:12.5px">ntfy://…</a>
            </div>
          </div>
          <div v-if="relayActiveUrl">
            <div class="duress-label">{{ t('relay_peer_tokens') || 'Токены собеседников на активном релее (email = read-токен)' }}</div>
            <div v-for="(tok, addr) in relayPeerTokens" :key="addr" class="duress-contact">
              <span>{{ addr }}</span>
              <button class="duress-remove" @click="relayRemovePeer(addr)">×</button>
            </div>
            <div style="display:flex;gap:8px;margin-top:6px">
              <input v-model="relayNewPeerAddr" class="duress-input" style="flex:1" :placeholder="t('relay_peer_addr_ph') || 'email собеседника'" />
              <input v-model="relayNewPeerToken" class="duress-input" style="flex:2" :placeholder="t('relay_peer_token_ph') || 'его read-токен'" />
              <button class="btn-primary" style="padding:8px 14px;border-radius:8px;border:none;cursor:pointer" @click="relayAddPeer">{{ t('add') || 'Добавить' }}</button>
            </div>
          </div>
          <p class="duress-warn">{{ t('relay_note') || 'Релеи — анонимные подписки: без email и содержимого. Если релей перестал отвечать, клиент сам переключится на следующий из списка. Почта остаётся основным каналом.' }}</p>
        </div>

      <!-- M2.3: экономный режим — в Приватности рядом с релеем (эко зависит от него) -->
      <div class="setting-row">
        <span>{{ t('eco_mode') || 'Экономный режим (батарея)' }}</span>
        <label class="toggle"><input type="checkbox" v-model="ecoMode" @change="ecoSave" /><span class="slider"></span></label>
      </div>
      <p class="setting-hint" style="margin-top:8px">{{ t('eco_mode_hint') || 'Выключает постоянное фоновое соединение: доставка через релей + редкая проверка почты. При выключении — классический режим с постоянным соединением.' }}</p>
      </div>

      <!-- ЯЗЫК -->
      <div v-if="activeCategory === 'language'" class="settings-section">
        <h2>{{ t('settings_language') }}</h2>
        <LanguageSelector />
      </div>

      <!-- ПОМОЩЬ -->
      <div v-if="activeCategory === 'help'" class="settings-section">
        <h2>{{ t('settings_help') }}</h2>
        <div class="help-links">
          <a href="https://vault-msg.ru" target="_blank"><Icon name="book" :size="15" /> {{ t('settings_docs') }}</a>
          <a href="mailto:kmakan@zoho.com"><Icon name="bug" :size="15" /> {{ t('settings_report_bug') }}</a>
          <div class="update-check">
            <button
              class="update-btn"
              :disabled="updateChecking"
              @click="checkForUpdates"
            >
              <Icon v-if="!updateChecking" name="refresh" :size="14" /> {{ updateChecking ? t('update_checking') : t('update_check_btn') }}
            </button>
            <template v-if="updateAvailable">
              <div class="update-banner">
                <span class="update-badge">{{ t('update_new') }} v{{ updateInfo.version }}</span>
                <button class="update-download-btn" @click="openDownloadPage">{{ t('update_download') }}</button>
              </div>
              <p v-if="updateInfo.changelog" class="update-changelog">{{ updateInfo.changelog }}</p>
            </template>
            <p v-else-if="updateStatus" :class="['update-status', { 'update-status-err': updateStatusIsErr }]">{{ updateStatus }}</p>
          </div>
          <!-- Обратная связь: письмо через SMTP пользователя (serverless-путь) -->
          <div class="feedback-block">
            <textarea
              v-model="feedbackText"
              class="feedback-input"
              rows="3"
              :placeholder="t('feedback_placeholder')"
            ></textarea>
            <div class="feedback-row">
              <button
                class="update-btn"
                :disabled="feedbackSending || !feedbackText.trim()"
                @click="sendFeedback"
              >
                <Icon v-if="!feedbackSending" name="send" :size="14" /> {{ feedbackSending ? t('feedback_sending') : t('feedback_send') }}
              </button>
              <span v-if="feedbackStatus" :class="['update-status', { 'update-status-err': feedbackStatusIsErr }]">{{ feedbackStatus }}</span>
            </div>
          </div>
          <div v-if="appVersion" class="version">Vault v{{ appVersion }}</div>
        </div>
      </div>

      <!-- ОЧИСТИТЬ ДАННЫЕ -->
      <div v-if="activeCategory === 'clear'" class="settings-section">
        <h2>{{ t('settings_clear') }}</h2>
        <div class="danger-zone">
          <p>{{ t('settings_clear_warning') }}</p>
          <button @click="clearLocalData" class="danger-btn">{{ t('settings_clear_btn') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api, { db } from '../api.js';
import { useI18n } from '../i18n.js';
import { invoke } from '@tauri-apps/api/core';
import { duressApi } from '../api.js';
import { openUrl as shellOpen } from '@tauri-apps/plugin-opener';
import { notificationsEnabled, setNotificationsEnabled } from '../notify.js';
import * as relayClient from '../relay-client.js';
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
  emits: ['avatar-update', 'logout', 'icon-changed', 'name-update', 'change-email', 'bio-save', 'experiments-calls', 'autoclean-change', 'eco-mode'],
  setup() { const { t } = useI18n(); return { t }; },
  data() {
    return {
      // Duress
      duressEnabled: false,
      duressLockCode: '',
      duressPanicCode: '',
      duressDuressCode: '',
      duressSosText: '',
      duressSosGeo: false,
      duressBio: false,
      isAndroid: /android/i.test(navigator.userAgent),
      duressContacts: [],
      duressRecipients: [],
      // M2.2: релеи (список)
      relayEnabled: false,
      // M2.3: экономный режим
      ecoMode: false,
      relayList: [],
      relayActive: 0,
      relayActiveUrl: '',
      relayPeerTokens: {},
      relayNewPeerAddr: '',
      relayNewPeerToken: '',
      relayNewUrl: '',
      relayNewToken: '',
      relayNtfyLink: '',
      relayPromoKey: '',
      // Мобильный режим: на телефоне список разделов и контент
      // отдельные «экраны» (v-show), на десктопе оба видны всегда.
      isMobile: window.matchMedia('(max-width: 767px)').matches,
      // На мобильном стартуем со списка разделов, на десктопе — «Профиль».
      activeCategory: window.matchMedia('(max-width: 767px)').matches ? '' : 'profile',
      localDisplayName: this.displayName || '',
      localBio: this.bio || '',
      localMediaQuality: 'high',
      // период автоочистки ('off'|'1d'|'7d'|'30d'|'365d').
      localAutoclean: 'off',
      experimentsCalls: false,
      notifSound: true,
      // RELEASE-PREP: проверка обновлений через latest.json.
      appVersion: '',
      updateChecking: false,
      updateAvailable: false,
      updateStatus: '',
      updateStatusIsErr: false,
      updateInfo: { version: '', changelog: '', apk_url: '', desktop_url: '' },
      // Обратная связь: письмо через SMTP пользователя.
      feedbackText: '',
      feedbackSending: false,
      feedbackStatus: '',
      feedbackStatusIsErr: false,
      notifTray: true,
      notifSystem: notificationsEnabled(),
      hideLastSeen: false,
      categories: [
        { id: 'profile', icon: 'user', label: 'Профиль' },
        { id: 'appearance', icon: 'palette', label: 'Внешний вид' },
        { id: 'chats', icon: 'chat', label: 'Чаты' },
        { id: 'calls', icon: 'phone', label: 'Звонки' },
        { id: 'experiments', icon: 'help', label: 'Экспериментальные функции' },
        { id: 'email', icon: 'mail', label: 'Почта' },
        { id: 'notifications', icon: 'bell', label: 'Уведомления' },
        { id: 'privacy', icon: 'lock', label: 'Приватность' },
        { id: 'language', icon: 'globe', label: 'Язык' },
        { id: 'help', icon: 'help', label: 'Помощь' },
        { id: 'clear', icon: 'trash', label: 'Очистить данные' }
      ],
      // Звонки: выбранные рингтоны (имена WAV без ring_/.wav).
      ringtoneIncoming: 'incoming',
      ringtoneOutgoing: 'outgoing',
      previewPlaying: false,
      _previewEl: null,
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
    // Версия приложения для отображения в «Помощи» (без клика «Проверить»).
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      this.appVersion = await getVersion();
    } catch (e) { /* dev-окружение без Tauri — остаётся data-дефолт */ }
    // Настройки чатов/экспериментов (kv_store)
    try {
      this.localMediaQuality = (await db.kvGet('anon', 'media-quality')) || 'high';
      this.localAutoclean = (await db.kvGet('anon', 'autoclean-period')) || 'off';
      this.experimentsCalls = (await db.kvGet('anon', 'exp-calls')) === '1';
      this.ecoMode = (await db.kvGet('anon', 'eco-mode')) === '1';
      // Звонки: выбранные рингтоны.
      this.ringtoneIncoming = (await db.kvGet('anon', 'call-ringtone-incoming')) || 'incoming';
      this.ringtoneOutgoing = (await db.kvGet('anon', 'call-ringtone-outgoing')) || 'outgoing';
      // Duress: восстановить состояние тумблера из конфига — иначе
      // после перезапуска тумблер выглядит выключенным, даже если замок активен.
      try {
        const dcfg = await duressApi.getConfig();
        this.duressEnabled = !!(dcfg && dcfg.lock_enabled && dcfg.lock_hash);
        if (this.duressEnabled) {
          this.duressSosText = dcfg.sos_text || '';
          this.duressSosGeo = !!dcfg.sos_geo;
          this.duressBio = !!dcfg.bio_enabled;
          this.duressRecipients = [...(dcfg.sos_recipients || [])];
          const all = await api.getContacts();
          this.duressContacts = (all || []).map(c => c.email).filter(Boolean);
        }
      } catch (e) { /* ignore */ }
      // M2.2: список релеев (per-account).
      try {
        const rs = await relayClient.getSettings(this.email || 'anon');
        this.relayEnabled = rs.enabled;
        this.relayList = rs.relays.map(r => ({ ...r }));
        this.relayActive = rs.active;
        this.relayRefreshPeersView();
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  },
  methods: {
    // ── M2.2: релеи (список с фолбэком) ─────────────────────
    async relayRefreshPeersView() {
      const rs = await relayClient.getSettings(this.email || 'anon');
      const active = rs.relays[rs.active];
      this.relayActiveUrl = active ? active.url : '';
      this.relayPeerTokens = (rs.peers && active && rs.peers[active.url]) || {};
    },
    async ecoSave() {
      try {
        await db.kvSet('anon', 'eco-mode', this.ecoMode ? '1' : '0');
        // Применение — живое: сообщаем ядру (App слушает kv-событие простым полем)
        this.$emit('eco-mode', this.ecoMode);
      } catch (e) { /* kv */ }
    },
    async relaySave() {
      try {
        await relayClient.setEnabled(this.email || 'anon', this.relayEnabled);
      } catch (e) { /* kv недоступен */ }
    },
    async relayAddRelay() {
      const url = (this.relayNewUrl || '').trim();
      const token = (this.relayNewToken || '').trim();
      if (!url) return;
      try {
        await relayClient.addRelay(this.email || 'anon', url, token, '');
        this.relayNewUrl = ''; this.relayNewToken = '';
        const rs = await relayClient.getSettings(this.email || 'anon');
        this.relayList = rs.relays.map(r => ({ ...r }));
        this.relayActive = rs.active;
        this.relayRefreshPeersView();
      } catch (e) { alert(e && e.message || e); }
    },
    // M2.4: авто-получение read-токена на нашем релее (freemium, rate-limit
    // 3/день на сервере). Токен = адрес очереди + ntfy-topic.
    async relayAutoRegister() {
      try {
        const base = 'https://vault-msg.ru';
        const promo = (this.relayPromoKey || '').trim();
        const r = await fetch(base + '/relay/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(promo ? { promo } : {}),
        });
        const dataUnlimited = (await r.clone().json().catch(() => ({}))).unlimited;
        if (!r.ok) { alert('register: HTTP ' + r.status); return; }
        const d = await r.json();
        const url = base + '/relay';
        const rs = await relayClient.getSettings(this.email || 'anon');
        const list = rs.relays.filter(x => x.url !== url);
        list.unshift({ url, myToken: d.token, label: 'Vault' });
        await relayClient.saveRelays(this.email || 'anon', list);
        await relayClient.setEnabled(this.email || 'anon', true);
        this.relayEnabled = true;
        const rs2 = await relayClient.getSettings(this.email || 'anon');
        this.relayList = rs2.relays.map(r => ({ ...r }));
        this.relayActive = rs2.active;
        this.relayNtfyLink = 'ntfy://' + 'ntfy.vault-msg.ru/' + d.topic;
        this.relayPromoKey = '';
        alert(dataUnlimited
          ? 'Безлимитный токен получен (10 лет). Установите ntfy-клиент и откройте ссылку ntfy://… для пушей при закрытом приложении.'
          : 'Токен получен (30 дней, продлевается бесплатно той же кнопкой). Установите ntfy-клиент и откройте ссылку ntfy://… для пушей при закрытом приложении.');
      } catch (e) { alert('register failed: ' + (e && e.message || e)); }
    },
    async relayRemoveRelay(i) {
      const list = [...this.relayList];
      const gone = list.splice(i, 1);
      await relayClient.saveRelays(this.email || 'anon', list.map(({ _health, ...r }) => r));
      this.relayList = list;
      const rs = await relayClient.getSettings(this.email || 'anon');
      this.relayActive = rs.active;
      this.relayRefreshPeersView();
    },
    async relayCheckOne(i) {
      const r = this.relayList[i];
      if (!r) return;
      r._health = null;
      r._health = await relayClient.relayHealthUrl(r.url);
      this.relayList = [...this.relayList];
    },
    async relayAddPeer() {
      const addr = (this.relayNewPeerAddr || '').trim().toLowerCase();
      const tok = (this.relayNewPeerToken || '').trim();
      if (!addr || !tok || !addr.includes('@') || !this.relayActiveUrl) return;
      await relayClient.setPeerToken(this.email || 'anon', this.relayActiveUrl, addr, tok);
      this.relayNewPeerAddr = '';
      this.relayNewPeerToken = '';
      this.relayRefreshPeersView();
    },
    async relayRemovePeer(addr) {
      if (!this.relayActiveUrl) return;
      await relayClient.setPeerToken(this.email || 'anon', this.relayActiveUrl, addr, null);
      this.relayRefreshPeersView();
    },
    // ── RELEASE-PREP: проверка обновлений ─────────────────
    // Rust-команда check_app_update сравнивает semver-численно и возвращает
    // latest.json только если версия новее текущей. Скачивание — через
    // браузер на страницу релизов (t('update_download') → shell-open).
    // ── Duress ─────────────────────────────────────────────
    async duressToggleLock() {
      try {
        const cfg = await duressApi.getConfig();
        if (this.duressEnabled) {
          // Включили: тянем существующий конфиг (если уже настраивали)
          this.duressSosText = cfg.sos_text || '';
          this.duressSosGeo = !!cfg.sos_geo;
          this.duressBio = !!cfg.bio_enabled;
          this.duressRecipients = [...(cfg.sos_recipients || [])];
          const all = await api.getContacts();
          this.duressContacts = (all || []).map(c => c.email).filter(Boolean);
          // Если коды уже были заданы ранее — сразу включаем замок (не заставляем
          // повторно вводить): иначе тумблер выглядит «слетевшим».
          if (cfg.lock_hash) {
            cfg.lock_enabled = true;
            await duressApi.saveConfig(cfg);
          }
        } else {
          // Выключили: lock_enabled=false, остальное сохраняем
          cfg.lock_enabled = false;
          await duressApi.saveConfig(cfg);
        }
      } catch (e) {
        console.warn('[duress] toggle failed:', e);
      }
    },
    onSosGeoChange(on) {
      if (on && /android/i.test(navigator.userAgent)) {
        // Мост в MainActivity: runtime-запрос ACCESS_FINE_LOCATION
        try { window.__vaultRequestGeo && window.__vaultRequestGeo(); } catch (e) { /* ignore */ }
      }
    },
    // писал только duressSave — требовал повторного ввода кода разблокировки;
    // юзер переключал тумблер и выходил, bio не доезжал до prefs → замок
    // открывался без предложения отпечатка.
    async onBioChange() {
      try {
        const cfg = await duressApi.getConfig();
        cfg.bio_enabled = this.isAndroid && this.duressBio;
        await duressApi.saveConfig(cfg);
        console.log('[duress] bio toggle saved, bio_enabled =', cfg.bio_enabled);
      } catch (e) {
        console.warn('[duress] bio toggle save failed:', e);
      }
    },
    async duressSave() {
      try {
        const cfg = await duressApi.getConfig();
        // Пустое поле кода = «без изменений» (hash сохраняется из cfg):
        // иначе повторное сохранение (после очистки полей) валидилось по
        // пустому коду, сбрасывало тумблер и стирало panic/duress-коды.
        if (this.duressLockCode) {
          if (this.duressLockCode.length < 4) {
            alert(this.t('duress_err_short') || 'Код разблокировки: минимум 4 символа');
            return;
          }
          cfg.lock_hash = await duressApi.hashSecret(this.duressLockCode);
        } else if (!cfg.lock_hash) {
          alert(this.t('duress_err_short') || 'Код разблокировки: минимум 4 символа');
          this.duressEnabled = false; // замок реально не настроен
          return;
        }
        if (this.duressPanicCode) {
          if (this.duressPanicCode === this.duressLockCode) {
            alert(this.t('duress_err_same') || 'Panic-код не должен совпадать с кодом разблокировки');
            return;
          }
          cfg.panic_hash = await duressApi.hashSecret(this.duressPanicCode);
        }
        if (this.duressDuressCode) {
          if (this.duressDuressCode === this.duressLockCode ||
              this.duressDuressCode === this.duressPanicCode) {
            alert(this.t('duress_err_same') || 'Коды не должны совпадать');
            return;
          }
          cfg.duress_hash = await duressApi.hashSecret(this.duressDuressCode);
        }
        cfg.lock_enabled = this.duressEnabled;
        cfg.sos_text = this.duressSosText || '';
        cfg.sos_geo = this.duressSosGeo;
        cfg.bio_enabled = this.isAndroid && this.duressBio;
        // Получатели SOS: пока из существующих контактов через запятую (этап 3 — UI-выбор)
        cfg.sos_recipients = [...this.duressRecipients];
        await duressApi.saveConfig(cfg);
        console.log('[duress] config saved, lock_enabled =', cfg.lock_enabled);
        alert(this.t('duress_saved') || 'Аварийная защита сохранена');
        // Очистить введённое в память
        this.duressLockCode = ''; this.duressPanicCode = ''; this.duressDuressCode = '';
      } catch (e) {
        alert('Duress save failed: ' + (e && e.message || e));
      }
    },
    async checkForUpdates() {
      this.updateChecking = true;
      this.updateAvailable = false;
      this.updateStatus = '';
      this.updateStatusIsErr = false;
      try {
        // Реальная версия из tauri.conf (не хардкод в data).
        const { getVersion } = await import('@tauri-apps/api/app');
        this.appVersion = await getVersion();
      } catch (e) { /* dev-окружение без Tauri — остаётся data-дефолт */ }
      try {
        const res = await invoke('check_app_update', { currentVersion: this.appVersion });
        if (res) {
          this.updateInfo = {
            version: res.version || '',
            changelog: res.changelog || '',
            apk_url: res.apk_url || '',
            desktop_url: res.desktop_url || '',
          };
          this.updateAvailable = true;
        } else {
          this.updateStatus = this.t('update_uptodate').replace('{v}', this.appVersion);
        }
      } catch (e) {
        this.updateStatus = this.t('update_error');
        this.updateStatusIsErr = true;
      } finally {
        this.updateChecking = false;
      }
    },
    // «Обновить»: на Android ведём на страницу релизов (пользователь ставит
    // APK сам — маркетов пока нет); ссылка из latest.json, фолбэк — сайт.
    // window.open в Tauri WebView молча НЕ открывает внешние
    // ссылки — используем системный opener-плагин (shell:allow-open в
    // capabilities, тот же механизм, что openExternal в App.vue).
    async openDownloadPage() {
      const isAndroid = /android/i.test(navigator.userAgent);
      const url = (isAndroid && this.updateInfo.apk_url) ||
        this.updateInfo.desktop_url ||
        'https://vault-msg.ru';
      // плагина молча падал) — зовём НАТИВНУЮ команду android_open_url
      // (Rust→JNI→VaultForegroundService.openUrlCompat→ACTION_VIEW).
      // Desktop оставляет anchor-click (там он работает).
      if (/android/i.test(navigator.userAgent)) {
        try {
          await invoke('android_open_url', { url });
        } catch (e) {
          console.warn('[update] android_open_url failed:', e);
        }
        return;
      }
      try {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) {
        console.warn('anchor click failed:', e);
        shellOpen(url).catch((e2) => console.warn('shellOpen failed:', e2));
      }
    },
    async sendFeedback() {
      const text = this.feedbackText.trim();
      if (!text || this.feedbackSending) return;
      this.feedbackSending = true;
      this.feedbackStatus = '';
      this.feedbackStatusIsErr = false;
      try {
        let ver = this.appVersion;
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          ver = await getVersion();
        } catch (e) { /* dev-окружение без Tauri */ }
        const sent = await this._feedbackPost({
          text, version: ver, account: this.email || '', ua: navigator.userAgent,
        });
        if (!sent) {
          const body = text + '\n\n—\nVault v' + ver + '\n' + navigator.userAgent +
            (this.email ? '\nAccount: ' + this.email : '');
          await invoke('email_send', {
            to: 'kmakan@zoho.com',
            subject: '[feedback] v' + ver,
            body,
          });
        }
        this.feedbackStatus = this.t('feedback_sent');
        this.feedbackText = '';
      } catch (e) {
        this.feedbackStatus = this.t('feedback_err') + ': ' + (e.message || e);
        this.feedbackStatusIsErr = true;
      } finally {
        this.feedbackSending = false;
      }
    },
    // Основной канал — сервер (структурированно, без SMTP-настроек).
    // false = недоступен → вызывающий делает email fallback.
    async _feedbackPost(payload) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch('https://vault-msg.ru/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        return r.ok;
      } catch (e) {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
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
    // событие autoclean-change).
    async saveAutoclean() {
      try {
        await db.kvSet('anon', 'autoclean-period', this.localAutoclean);
      } catch (e) { /* ignore */ }
      this.$emit('autoclean-change', this.localAutoclean);
    },
    // ── Звонки: сохранение + превью рингтонов ──────────────────
    async saveRingtoneIncoming() {
      try { await db.kvSet('anon', 'call-ringtone-incoming', this.ringtoneIncoming); } catch (e) { /* ignore */ }
    },
    async saveRingtoneOutgoing() {
      try { await db.kvSet('anon', 'call-ringtone-outgoing', this.ringtoneOutgoing); } catch (e) { /* ignore */ }
    },
    // Превью: desktop — cpal в Rust (media_sound_play), Android — HTML5
    // Audio. Зацикленный звук — стоп кнопкой.
    previewSound(name, looped) {
      this.stopPreview();
      try {
        if (/android/i.test(navigator.userAgent || '')) {
          const el = new Audio('/sounds/ring_' + name + '.wav');
          el.loop = !!looped;
          el.volume = 0.85;
          el.play().catch(e => console.warn('[calls] preview failed:', e));
          this._previewEl = el;
          if (!looped) el.onended = () => { if (this._previewEl === el) { this._previewEl = null; this.previewPlaying = false; } };
        } else {
          api.mediaSoundPlay(name, !!looped).catch(e => console.warn('[calls] preview failed:', e));
        }
        this.previewPlaying = !!looped;
      } catch (e) {
        console.warn('[calls] preview failed:', e && e.message || e);
      }
    },
    stopPreview() {
      try {
        if (this._previewEl) { try { this._previewEl.pause(); } catch (_) {} this._previewEl = null; }
        if (!/android/i.test(navigator.userAgent || '')) api.mediaSoundStop().catch(() => {});
      } catch (_) {}
      this.previewPlaying = false;
    },
    // Имя + статус «О себе» одной кнопкой; bio уходит контактам broadcast-письмом.
    async saveProfileFields() {
      await this.saveDisplayName();
      this.$emit('bio-save', this.localBio);
      // Единое письмо с именем+аватаром+статусом: чтобы все три
      // сущности ушли вместе с одним ts — иначе три отдельных письма с
      // разными ts создают чехарду на приёме (аватар «возвращается» старый).
      this.$emit('profile-save');
    },
    // --- Резервная копия
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
        this.backupResult = t('settings_backup_ok');
      } catch (e) {
        this.backupResult = t('settings_backup_fail') + (e.message || e);
      } finally {
        this.backupBusy = false;
      }
    },
    async importBackup(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (!(await confirm(t('settings_restore_confirm')))) {
        event.target.value = '';
        return;
      }
      this.backupBusy = true;
      this.backupResult = '';
      try {
        const text = await file.text();
        const result = await invoke('import_backup', { jsonData: text });
        this.backupResult = t('settings_restore_ok') + result + t('settings_restart_hint');
        this.$emit('keys-changed');
      } catch (e) {
        this.backupResult = t('settings_restore_fail') + (e.message || e);
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
      if (!(await confirm(t('settings_clear_confirm1')))) return;
      if (!(await confirm(t('settings_clear_confirm2')))) return;
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

/* Селект настроек */
.media-quality-select {
  width: 100%;
  max-width: 320px;
  /* нативная стрелка убрана, своя chevron-иконка с отступом справа. */
  appearance: none;
  -webkit-appearance: none;
  padding: 10px 36px 10px 14px;
  background: #0d1117;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b949e' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  border: 1px solid #30363d;
  border-radius: 8px;
  color: #e6edf3;
  font-size: 14px;
  box-sizing: border-box;
}

/* Ряд «селект + кнопка превью» */
.ringtone-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ringtone-row .media-quality-select {
  flex: 1;
}
.ringtone-preview {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.setting-hint {
  margin-top: 14px;
  font-size: 12px;
  color: #8b949e;
  line-height: 1.5;
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
.help-links a { color: #58a6ff; text-decoration: none; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; }
.help-links a:hover { text-decoration: underline; }
.version { color: #484f58; font-size: 12px; margin-top: 16px; }

/* RELEASE-PREP: блок проверки обновлений */
.update-check { display: flex; flex-direction: column; gap: 10px; }
.feedback-block { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.feedback-input {
  width: 100%; max-width: 420px; box-sizing: border-box; resize: vertical;
  padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.4;
  border: 1px solid var(--border, #30363d); background: var(--bg-secondary, #0d1117);
  color: var(--text-primary, #e6edf3); font-family: inherit;
}
.feedback-input:focus { outline: none; border-color: var(--accent, #58a6ff); }
.feedback-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.update-btn {
  align-self: flex-start; padding: 8px 14px; border-radius: 8px;
  border: 1px solid var(--accent, #58a6ff); background: transparent;
  color: var(--accent, #58a6ff); font-size: 13px; cursor: pointer;
  transition: background .15s;
}
.update-btn:hover:not(:disabled) { background: rgba(88, 166, 255, .12); }
.update-btn:disabled { opacity: .5; cursor: wait; }
.update-banner {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 12px; border-radius: 8px;
  border: 1px solid rgba(63, 185, 80, .4); background: rgba(63, 185, 80, .08);
}
.update-badge { color: #3fb950; font-weight: 600; font-size: 14px; }
.update-download-btn {
  padding: 6px 12px; border-radius: 6px; border: none; cursor: pointer;
  background: #238636; color: #fff; font-size: 13px; font-weight: 600;
}
.update-download-btn:hover { background: #2ea043; }
.update-changelog { color: var(--text-secondary, #8b949e); font-size: 13px; margin: 0; white-space: pre-line; }
.update-status { color: var(--text-secondary, #8b949e); font-size: 13px; margin: 0; }
.update-status-err { color: #f85149; }

/* Мобильный режим: список разделов и контент — два «экрана»
   переключаются v-show (см. шаблон): экран списка (профиль + вертикальный
   список) → тап по разделу → экран раздела с кнопкой «← Назад» сверху.
   пункты с width:100% уезжали в скролл и полоса выглядела пустой.
   ВАЖНО: media query после базовых правил — scoped-специфичность равная
   побеждает последний.
   */
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
       при полной прокрутке остаётся под панелью жестов/кнопок и на него
       невозможно нажать.
       */
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

/* Статус «О себе» */
.bio-input {
  width: 100%; max-width: 320px;
  padding: 10px 14px;
  background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
  color: #e6edf3; font-size: 14px; box-sizing: border-box; resize: vertical;
}
.bio-counter { display: block; margin-top: 4px; color: #8b949e; font-size: 11px; text-align: right; max-width: 320px; }

/* Кнопки профиля: столбик с зазором */
.profile-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}
.profile-actions .btn { width: 100%; max-width: 320px; }
.profile-actions .logout-btn { margin-top: 0; }



.duress-block{display:flex;flex-direction:column;align-items:stretch;gap:8px}
.duress-title{font-size:15px;color:var(--text,#e7ecf5)}
.duress-toggle-row{display:flex;align-items:center;gap:10px;width:100%;padding:6px 0}
.duress-toggle-row .slider{flex:none}
.duress-toggle-label{flex:1;font-size:14px;color:var(--text,#e7ecf5)}
.duress-label{display:block;width:100%;font-size:13px;color:var(--muted,#8b93a7);margin-top:6px}
.duress-input{display:block;width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;border:1px solid var(--border,#1f2940);background:var(--bg-soft,#0f1522);color:var(--text,#e7ecf5);font-size:14px}
.duress-warn{display:block;width:100%;font-size:12.5px;color:var(--gold,#f59e0b);margin:6px 0 0}
.duress-contacts{width:100%;max-height:160px;overflow-y:auto;border:1px solid var(--border,#1f2940);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}
.duress-contact{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text,#e7ecf5);cursor:pointer}
.duress-block .btn-primary{align-self:flex-start}

</style>