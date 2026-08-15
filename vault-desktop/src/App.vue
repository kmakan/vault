<template>
  <div class="app-container">
    <!-- LOGIN SCREEN -->
    <div v-if="!isLoggedIn" class="login-screen">
      <div class="login-box">
        <h1>🔒 Vault</h1>
        <p>E2E Encrypted Messenger</p>
        <form @submit.prevent="login">
          <input v-model="email" type="email" placeholder="Email" required />
          <input v-model="password" type="password" placeholder="Password" required />
          <button type="submit" :disabled="loginLoading">
            {{ loginLoading ? '...' : t('login') || 'Login' }}
          </button>
          <p v-if="loginError" class="login-error">{{ loginError }}</p>
        </form>
        <p class="login-hint">{{ t('login_hint') || 'Регистрация не нужна: у Vault нет сервера — приложение работает поверх вашей почты. Войдите под своим email, ключи создадутся автоматически. Добавляйте собеседников по id участника или QR-коду (🔗 вверху).' }}</p>
      </div>
    </div>
    <!-- MAIN APP -->
    <div v-else class="sidebar">
      <div class="sidebar-header">
        <div class="app-logo" :title="t('app_name') || 'Vault'">
          <img :src="appIconUrl" alt="Vault" class="app-logo-img" />
          <span class="app-logo-name">Vault</span>
        </div>
        <div class="header-actions">
          <button :title="t('nav_keys')" @click="showKeyManager = true">🔑</button>
          <button :title="t('nav_add_contact')" @click="showQRCode = true">🔗</button>
          <button :title="t('cipher_title')" @click="showCipher = true">🛡</button>
          <button @click="showSettings = true" title="Settings">⚙️</button>
        </div>
      </div>
      
      <div class="contacts-list">
        <div class="search-box">
          <input type="text" :placeholder="t('contacts_search')" v-model="searchQuery" />
        </div>
        <!-- Onboarding: no contacts and no peer keys yet -->
        <div v-if="contacts.length === 0 && Object.keys(peerKeys).length === 0" class="contacts-empty">
          <div class="contacts-empty-title">{{ t('contacts_empty_title') }}</div>
          <div class="contacts-empty-hint">{{ t('contacts_empty_hint') }}</div>
          <div class="contacts-empty-actions">
            <button class="btn-primary" @click="showKeyManager = true">🔑 {{ t('nav_keys') }}</button>
            <button class="btn-secondary" @click="showQRCode = true">🔗 {{ t('nav_add_contact') }}</button>
          </div>
        </div>
        <div class="group-create-row">
          <button class="group-create-btn" @click="showCreateGroup = true">
            <span>➕</span> {{ t('group_create') || 'New Group' }}
          </button>
        </div>
        <div 
          v-for="contact in filteredContacts" 
          :key="contact.email"
          :class="['contact-item', { active: activeChat === contact.email }]"
          @click="selectChat(contact.email)"
        >
          <UserAvatar :email="contact.email" :size="36" />
          <div class="contact-info">
            <div class="contact-name">{{ contact.name }}</div>
            <div class="contact-email">{{ contact.email }}</div>
          </div>
          <div class="contact-status">
            <span v-if="!peerKeys[contact.email]" class="contact-no-key" :title="t('contact_no_key_hint') || 'Нет ключа собеседника — обменяйтесь ключами через 🔗 (по id участника или QR)'">🔓</span>
            <span class="status-dot" :class="{ online: contact.online }"></span>
          </div>
        </div>
        
        <!-- Email load error (debug aid) -->
        <div v-if="emailError" class="email-error-hint">{{ emailError }}</div>

        <!-- Groups Section -->
        <div v-if="groups.length > 0" class="groups-section">
          <div class="groups-header">
            <span>👥 {{ t('groups') || 'Groups' }}</span>
          </div>
          <div 
            v-for="group in groups" 
            :key="group.id"
            :class="['contact-item', { active: activeChat === `group:${group.id}` }]"
            @click="selectGroup(group)"
          >
            <div class="group-avatar">
              {{ group.name.charAt(0).toUpperCase() }}
            </div>
            <div class="contact-info">
              <div class="contact-name">{{ group.name }}</div>
              <div class="contact-email">{{ group.member_count || 0 }} members</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="main-area">
      <div v-if="showKeyManager" class="key-manager">
        <KeyManager @close="showKeyManager = false" @keys-changed="onKeysChanged" />
      </div>
    
      <div v-if="showQRCode" class="qr-code-overlay">
        <QRCodePanel 
          :publicKey="publicKey" 
          :myEmail="email"
          @close="showQRCode = false"
          @key-scanned="addPeerKey"
          @invite-by-id="inviteContactById"
        />
      </div>

      <!-- CIPHER TOOL -->
      <CipherTool v-if="showCipher" :peerKeys="peerKeys" :contacts="contacts" @close="showCipher = false" @open-keys="showCipher = false; showKeyManager = true" />

      <!-- SETTINGS MODAL -->
      <div v-if="showSettings" class="modal-overlay" @click.self="showSettings = false">
        <div class="modal-settings">
          <button class="modal-close" @click="showSettings = false">←</button>
          <SettingsPage :email="email" :userAvatarUrl="userAvatarUrl" :displayName="displayName" @avatar-update="onAvatarUpdate" @icon-changed="onAppIconChanged" @logout="handleLogout" />
        </div>
      </div>

      <!-- INVITE POPUP (приглашение в группу с согласием) -->
      <div v-if="showInvitePopup && pendingInvites.length" class="modal-overlay" @click.self="showInvitePopup = false">
        <div class="modal-settings">
          <button class="modal-close" @click="showInvitePopup = false">←</button>
          <template v-if="pendingInvites[invitePopupIndex]">
            <h3 class="invite-popup-title">{{ t('invite_title') || 'Приглашение в группу' }}</h3>
            <p class="invite-popup-text">{{ t('invite_text') }}</p>
            <p class="invite-popup-name">{{ pendingInvites[invitePopupIndex].group_name }}</p>
            <div class="invite-popup-sender">
              <UserAvatar
                :email="pendingInvites[invitePopupIndex].sender"
                :avatarUrl="pendingInvites[invitePopupIndex].sender_avatar"
                :size="28"
              />
              <span class="invite-popup-sender-name">
                {{ pendingInvites[invitePopupIndex].sender_name || pendingInvites[invitePopupIndex].sender }}
              </span>
            </div>
            <div class="invite-popup-actions">
              <button class="btn btn-primary" @click="acceptInvite(pendingInvites[invitePopupIndex])">
                {{ t('invite_accept') || 'Принять' }}
              </button>
              <button class="btn btn-secondary" @click="declineInvite(pendingInvites[invitePopupIndex])">
                {{ t('invite_decline') || 'Отклонить' }}
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- CONTACT REQUEST POPUP (1-на-1: приглашение по id участника/QR, как в Session) -->
      <div v-if="showContactPopup && pendingContacts.length" class="modal-overlay" @click.self="showContactPopup = false">
        <div class="modal-settings">
          <button class="modal-close" @click="showContactPopup = false">←</button>
          <template v-if="pendingContacts[contactPopupIndex]">
            <h3 class="invite-popup-title">{{ t('contact_request_title') || 'Запрос контакта' }}</h3>
            <p class="invite-popup-text">{{ t('contact_request_text') || 'Примите запрос — и собеседник появится в ваших контактах.' }}</p>
            <div class="invite-popup-sender">
              <UserAvatar
                :email="pendingContacts[contactPopupIndex].sender"
                :avatarUrl="pendingContacts[contactPopupIndex].sender_avatar"
                :size="28"
              />
              <span class="invite-popup-sender-name">
                {{ pendingContacts[contactPopupIndex].sender_name || pendingContacts[contactPopupIndex].sender }}
              </span>
            </div>
            <div class="invite-popup-actions">
              <button class="btn btn-primary" @click="acceptContactInvite(pendingContacts[contactPopupIndex])">
                {{ t('invite_accept') || 'Принять' }}
              </button>
              <button class="btn btn-secondary" @click="declineContactInvite(pendingContacts[contactPopupIndex])">
                {{ t('invite_decline') || 'Отклонить' }}
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- ADD MEMBER POPUP (выбор контактов) -->
      <div v-if="showAddMemberPopup" class="modal-overlay" @click.self="showAddMemberPopup = false">
        <div class="modal-settings">
          <button class="modal-close" @click="showAddMemberPopup = false">←</button>
          <h3 class="add-member-popup-title">{{ t('add_member_from_contacts') || 'Добавить участника из контактов' }}</h3>
          <input
            v-model="addMemberQuery"
            type="text"
            :placeholder="t('search_contacts') || 'Поиск контактов…'"
            class="add-member-search"
            @keyup.enter="enterManualEmail"
          />
          <div class="add-member-contacts">
            <div
              v-for="c in filteredAddContacts"
              :key="c.email"
              class="add-member-contact"
              @click="inviteContact(c.email)"
            >
              <UserAvatar :email="c.email" :size="28" />
              <span class="add-member-contact-name">{{ c.name || c.email }}</span>
              <span class="add-member-contact-email">{{ c.email }}</span>
            </div>
            <div v-if="filteredAddContacts.length === 0" class="add-member-none">
              {{ t('no_contacts') || 'Контакты не найдены' }}
            </div>
            <div class="add-member-manual" @click="enterManualEmail">
              ✏️ {{ t('enter_email_manual') || 'Ввести email вручную' }}
              <span v-if="addMemberQuery" class="add-member-manual-email">— {{ addMemberQuery }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- AVATAR UPLOAD MODAL -->
      <div v-if="showAvatarUpload" class="modal-overlay" @click.self="showAvatarUpload = false">
        <div class="modal-avatar">
          <button class="modal-close" @click="showAvatarUpload = false">←</button>
          <h3>Фото профиля</h3>
          <div class="avatar-preview-circle">
            <img v-if="userAvatarUrl" :src="userAvatarUrl" class="avatar-preview-img" />
            <span v-else class="avatar-initials avatar-preview-initials">{{ emailInitials }}</span>
          </div>
          <p class="avatar-hint">Формат: PNG, JPG, SVG. Рекомендуется 100×100 px.</p>
          <label class="avatar-upload-btn">
            📷 Выбрать файл
            <input type="file" accept="image/png,image/jpeg,image/svg+xml" @change="onAvatarFileSelect" hidden />
          </label>
        </div>
      </div>
      
      <!-- GROUP SETTINGS MODAL (полноценный оверлей, не сжимает чат) -->
      <div v-if="showGroupSettings && currentGroup" class="modal-overlay" @click.self="showGroupSettings = false">
        <div class="group-settings-panel">
          <GroupSettings
            :group="currentGroup"
            :currentUser="email"
            :profiles="profiles"
            @close="showGroupSettings = false"
            @promote="promoteMember"
            @demote="demoteMember"
            @role-change="changeMemberRole"
            @remove="removeMember"
            @unblock="unblockUser"
            @leave="leaveGroup"
            @delete="deleteGroup"
            @add-member="addMember"
          />
        </div>
      </div>

      <!-- CHAT VIEW -->
      <div v-if="currentView !== 'email'" class="chat-area">
        <div class="chat-header" v-if="activeChat">
          <div class="chat-header-info">
            <template v-if="activeChatType === 'group'">
              <div class="group-avatar">
                {{ currentGroup?.name?.charAt(0).toUpperCase() || '?' }}
              </div>
            </template>
            <template v-else>
              <UserAvatar :email="activeChat" :size="40" />
            </template>
            <div>
              <h3>{{ activeChatName }}</h3>
              <div class="chat-status">
                <template v-if="activeChatType === 'group'">
                  👥 {{ currentGroup?.member_count || 0 }} members
                </template>
                <template v-else>
                  {{ peerKeys[activeChat] ? '🔒 Encrypted' : '⚠️ No key' }}
                </template>
              </div>
            </div>
          </div>
          <div class="chat-actions">
            <template v-if="activeChatType === 'group'">
              <button class="chat-action-btn" @click="openAddMemberPopup" :title="t('add_member') || 'Добавить участника'">➕ {{ t('add_member') || 'Добавить участника' }}</button>
              <button class="chat-action-btn" @click="showGroupSettings = !showGroupSettings" :title="t('group_settings') || 'Настройки группы'">⚙️ {{ t('group_settings') || 'Настройки' }}</button>
            </template>
            <button @click="showChatSearch = !showChatSearch" title="Search">🔍</button>
            <div class="export-dropdown" v-if="activeChat">
              <button @click="showExportMenu = !showExportMenu" title="Export">📥</button>
              <div v-if="showExportMenu" class="export-menu">
                <button @click="exportAsJSON">📄 JSON</button>
                <button @click="exportAsTXT">📝 TXT</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Chat search bar -->
        <div v-if="showChatSearch" class="chat-search-bar">
          <input
            v-model="chatSearchQuery"
            :placeholder="(t('general_search') || 'Search') + '...'"
            class="chat-search-input"
            ref="chatSearchInput"
          />
          <span v-if="chatSearchQuery" class="chat-search-count">
            {{ filteredMessages.length }}/{{ messages.length }}
          </span>
          <button class="chat-search-close" @click="chatSearchQuery = ''; showChatSearch = false">✕</button>
        </div>

        <div class="messages" ref="messagesContainer">
          <div v-if="activeChat && messages.length === 0" class="messages-empty">
            <div class="empty-icon">🔒</div>
            <div class="empty-text">{{ t('chat_empty') || 'Нет сообщений — отправьте первое 🔒' }}</div>
          </div>
          <div
            v-for="msg in filteredMessages"
            :key="msg.id"
            :class="['message', { own: msg.from === 'me' }]"
            @click.stop="toggleReactionPicker(msg.id)"
          >
            <!-- Отправитель в групповом чате (имя/аватар из профиля) -->
            <div v-if="activeChatType === 'group' && msg.from !== 'me'" class="message-sender">
              <UserAvatar :email="msg.sender_id" :avatarUrl="avatarOf(msg.sender_id)" :size="20" />
              <span class="message-sender-name">{{ nameOf(msg.sender_id) }}</span>
            </div>
            <div class="message-content">
              <div v-if="hasReplyQuote(msg.content)" class="reply-quote">{{ replyQuote(msg.content) }}</div>
              <span>{{ replyBody(msg.content) }}</span>
              <div v-if="msg.attachment && msg.attachment.isImage" class="attachment-preview">
                <img :src="'data:' + msg.attachment.type + ';base64,' + msg.attachment.data" 
                     :alt="msg.attachment.name" 
                     class="attachment-image" />
              </div>
              <div v-else-if="msg.attachment" class="attachment-preview">
                <div class="attachment-file">
                  📄 {{ msg.attachment.name }} ({{ (msg.attachment.size / 1024).toFixed(1) }}KB)
                </div>
              </div>
              <span v-if="msg.encrypted" class="encrypted-badge" title="End-to-end encrypted">🔒</span>
            </div>
            <!-- Reply button (visible on hover) -->
            <button class="reply-btn" title="Reply" @click.stop="setReply(msg)">↩</button>
            <!-- Reactions -->
            <div class="message-reactions" v-if="msg.reactions && msg.reactions.length">
              <span
                v-for="(r, ri) in msg.reactions"
                :key="ri"
                class="reaction-badge"
                @click.stop="toggleReaction(msg.id, r)"
              >{{ r }}</span>
            </div>
            <div class="message-footer">
              <div class="message-time">{{ msg.time }}</div>
              <span v-if="msg.from === 'me'" class="message-status" :title="msg.status === 'read' ? 'Read' : msg.status === 'delivered' ? 'Delivered' : 'Sent'">
                {{ msg.status === 'read' ? '✓✓' : msg.status === 'delivered' ? '✓✓' : '✓' }}
              </span>
            </div>
            <!-- Reaction picker popup -->
            <div
              v-if="reactionPickerMsgId === msg.id"
              class="reaction-picker"
              @click.stop
            >
              <button v-for="emoji in quickReactions" :key="emoji" class="reaction-emoji" @click="addReaction(msg.id, emoji)">{{ emoji }}</button>
            </div>
          </div>
        </div>
        
        <!-- Typing indicator -->
        <div v-if="Object.keys(typingUsers).length > 0" class="typing-indicator">
          <span class="typing-dots">
            <span></span><span></span><span></span>
          </span>
          <span class="typing-text">{{ t('typing') || 'typing...' }}</span>
        </div>

        <!-- Reply quote bar (shown while replying to a message) -->
        <div v-if="replyTo" class="reply-bar">
          <span class="reply-bar-label">↩ {{ t('chat_reply_to') || 'Ответ на' }}</span>
          <span class="reply-bar-text">{{ replyPreview(replyTo) }}</span>
          <button class="reply-bar-close" @click="cancelReply" title="Cancel reply">✕</button>
        </div>

        <div class="message-input" v-if="activeChat">
        <div class="input-wrapper">
          <button class="emoji-btn" @click="showEmojiPicker = !showEmojiPicker" title="Emoji">😊</button>
          <EmojiPicker
            :show="showEmojiPicker"
            @select="insertEmoji"
            @close="showEmojiPicker = false"
          />
          <input
            v-model="newMessage"
            @keyup.enter="sendMessage"
            @input="onTypingInput"
            :placeholder="(t('message_placeholder') || 'Type a message') + '...'"
            class="message-field"
          />
        </div>
        <button class="attach-btn" title="Attach file" @click="$refs.fileInput.click()">📎</button>
        <input ref="fileInput" type="file" multiple style="display:none" @change="handleFileSelect" accept="image/*,.pdf,.doc,.docx,.txt,.zip" />
        <button class="mic-btn" @click="showAudioRecorder = !showAudioRecorder" title="Voice message">🎙️</button>
        <AudioRecorder
          :show="showAudioRecorder"
          @send="sendAudioMessage"
          @close="showAudioRecorder = false"
        />
          <button class="send-btn" @click="sendMessage">
            <span class="send-icon">➤</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Create Group Modal -->
    <div v-if="showCreateGroup" class="modal-overlay" @click.self="showCreateGroup = false">
      <div class="modal-card">
        <div class="modal-header">
          <h3>{{ t('group_create_title') || 'New Group' }}</h3>
          <button class="modal-close" @click="showCreateGroup = false">←</button>
        </div>
        <div class="modal-body">
          <label>{{ t('group_name') || 'Group Name' }}</label>
          <input
            v-model="newGroupName"
            :placeholder="(t('group_name') || 'Group Name') + '...'"
            class="modal-input"
            @keyup.enter="createGroupAndClose"
          />
          <label>Icon</label>
          <div class="icon-picker">
            <button v-for="ic in groupIcons" :key="ic" :class="['icon-btn', { active: newGroupIcon === ic }]" @click="newGroupIcon = ic">{{ ic }}</button>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showCreateGroup = false">{{ t('general_cancel') || 'Cancel' }}</button>
          <button class="btn-primary" @click="createGroupAndClose" :disabled="!newGroupName.trim()">
            {{ t('group_create') || 'Create' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from './api.js';
import crypto from './crypto.js';
import ws from './ws.js';
import { useI18n } from './i18n.js';
import SettingsPage from './components/SettingsPage.vue';
import EmailSettings from './components/EmailSettings.vue';
import KeyManager from './components/KeyManager.vue';
import LanguageSelector from './components/LanguageSelector.vue';
import UserAvatar from './components/UserAvatar.vue';
import GroupSettings from './components/GroupSettings.vue';
import EmojiPicker from './components/EmojiPicker.vue';
import AudioRecorder from './components/AudioRecorder.vue';
import ThemeSelector from './components/ThemeSelector.vue';
import FontSelector from './components/FontSelector.vue';
import IconPicker from './components/IconPicker.vue';
import AppBehavior from './components/AppBehavior.vue';
import AvatarUpload from './components/AvatarUpload.vue';
import CipherTool from './components/CipherTool.vue';
import QRCodePanel from './components/QRCodePanel.vue';
import { applyTheme, loadSavedTheme } from './themes.js';
import { applyFont, loadSavedFont } from './fonts.js';
import { exportChatJSON, exportChatTXT, downloadFile } from './chatExport.js';
import { detectProvider, checkFileSize, formatBytes } from './providerLimits.js';

export default {
  name: 'ChatApp',
  components: {
    SettingsPage,
    EmailSettings,
    KeyManager,
    LanguageSelector,
    UserAvatar,
    GroupSettings,
    EmojiPicker,
    AudioRecorder,
    ThemeSelector,
    FontSelector,
    IconPicker,
    AppBehavior,
    AvatarUpload,
    CipherTool,
    QRCodePanel
  },
  setup() {
    const { t, setLocale, availableLocales, currentLocale } = useI18n();
    return { t, setLocale, availableLocales, currentLocale };
  },
  data() {
    return {
      currentView: 'chats',
      appIconId: 'letter',
      contacts: [],
      activeChat: null,
      messages: [],
      newMessage: '',
      replyTo: null,
      showSettings: false,
      showMembers: false,
      isLoggedIn: false,
      email: '',
      password: '',
      loginLoading: false,
      loginError: '',
      emails: [],
      emailsLoading: false,
      emailError: '',
      pollTimer: null,
      cryptoReady: false,
      publicKey: null,
      fingerprint: null,
      peerKeys: {},
      peerKeyInput: '',
      showKeyManager: false,
      showQRCode: false,
      showCipher: false,
      peerKeysLoaded: {},
      searchQuery: '',
      // Groups
      groups: [],
      groupKeys: {},  // group_id → groupKeyHex (shared symmetric key)
      currentGroup: null,
      activeChatType: 'chat', // 'chat' or 'group'
      newGroupName: '',
      newGroupIcon: '📁',
      // Group Settings
      showGroupSettings: false,
      // Invite popup (приглашение в группу с согласием)
      pendingInvites: [],
      showInvitePopup: false,
      invitePopupIndex: 0,
      pendingContacts: [],
      showContactPopup: false,
      contactPopupIndex: 0,
      // Add-member popup (выбор контактов)
      showAddMemberPopup: false,
      addMemberQuery: '',
      // Profile cache (имя/аватар из настроек)
      profiles: {},
      // Emoji
      showEmojiPicker: false,
      // Reactions
      reactionPickerMsgId: null,
      quickReactions: ['👍', '❤️', '😂', '😮', '😢', '🔥', '✅', '👀'],
      // Search in chat
      chatSearchQuery: '',
      showChatSearch: false,
      // Create group modal
      showCreateGroup: false,
      inviteEmail: '',
      groupIcons: ['📁', '👥', '💬', '🔐', '💼', '🎮', '📚', '🎵', '🔬', '🌐', '🚀', '⭐', '🎯', '💡'],
      // Audio
      showAudioRecorder: false,
      // Export
      showExportMenu: false,
      showAvatarUpload: false,
      // Avatar
      userAvatarUrl: '',
      displayName: '',
      // User identity
      userId: null,
      // Typing indicators
      typingUsers: {},
      typingTimeout: null,
    }
  },
  computed: {
    appIconUrl() {
      return `/icons/vault-${this.appIconId}.svg`;
    },
    emailInitials() {
      if (!this.email) return '?';
      return this.email.split('@')[0].substring(0, 2).toUpperCase();
    },
    filteredContacts() {
      if (!this.searchQuery) return this.contacts;
      const q = this.searchQuery.toLowerCase();
      return this.contacts.filter(c =>
        c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)
      );
    },
    filteredMessages() {
      if (!this.chatSearchQuery) return this.messages;
      const q = this.chatSearchQuery.toLowerCase();
      return this.messages.filter(m =>
        m.content && m.content.toLowerCase().includes(q)
      );
    },
    filteredAddContacts() {
      const q = (this.addMemberQuery || '').toLowerCase();
      const seen = new Set();
      const list = [];
      for (const c of this.contacts) {
        if (!c.email || seen.has(c.email)) continue;
        seen.add(c.email);
        const name = c.name || c.email;
        if (!q || name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)) {
          list.push(c);
        }
      }
      return list;
    },
    activeChatName() {
      if (this.activeChatType === 'group') return this.currentGroup?.name || this.activeChat;
      if (!this.activeChat) return '';
      const c = this.contacts.find(c => c.email === this.activeChat);
      return c ? c.name : this.activeChat;
    }
  },
  async mounted() {
    applyTheme(loadSavedTheme())
    applyFont(loadSavedFont())
    // Apply saved icon
    const savedIcon = localStorage.getItem('vault-icon') || 'letter'
    this.appIconId = savedIcon
    // Apply the saved native window icon (waybar/dock), ignoring failures so
    // startup is never blocked.
    api.setAppIcon(savedIcon).catch(() => { /* ignore window icon failures */ })
    const link = document.querySelector("link[rel='icon']")
    if (link) link.href = `/icons/vault-${savedIcon}.svg`
    // React to icon changes even when the picker lives in a detached settings
    // view — a simple window-level event bus keeps the sidebar icon in sync.
    window.addEventListener('vault-icon-changed', (e) => {
      if (e && e.detail) this.onAppIconChanged(e.detail)
    })
    // Load avatar from localStorage
    if (this.email) {
      this.userAvatarUrl = localStorage.getItem(`vault-avatar-${this.email}`) || ''
    }
    // Display name + кэш профилей (имя/аватар участников групп).
    this.displayName = localStorage.getItem('vault-display-name') || this.email || ''
    this.loadProfiles()
    // Validate saved token
    if (api.token) {
      try {
        await api.getChats();
        await this.loadContacts();
        await this.loadGroups();
        // This throws "Not connected" if the IMAP session died on restart —
        // then we must ask for the password again.
        await this.loadEmails();
        this.isLoggedIn = true;
        ws.connect(api.token);
        ws.on('typing', (msg) => this.onTypingEvent(msg));
        this.startPolling()
      } catch (e) {
        // Session died on restart (parole не храним) — просим ввести пароль снова
        api.token = null;
        localStorage.removeItem('vault-token');
        this.email = api.email || this.email; // pre-fill login form
      }
    }
    await this.initCrypto()
  },
  beforeUnmount() {
    this.stopPolling()
  },
  methods: {
    onAppIconChanged(id) {
      this.appIconId = id;
      // Persist so the chosen icon survives restarts and is reflected everywhere.
      localStorage.setItem('vault-icon', id);
      const favicon = document.querySelector("link[rel='icon']");
      if (favicon) favicon.href = `/icons/vault-${id}.svg`;
      // Update the native window icon (waybar/dock).
      api.setAppIcon(id).catch(() => { /* ignore window icon failures */ });
    },
    async initCrypto() {
      try {
        const result = await crypto.initFromStorage();
        if (result.loaded) {
          this.publicKey = result.keypair.public_key;
        } else {
          const keypair = await crypto.generateKeypair();
          this.publicKey = keypair.public_key;
          await crypto.saveToStorage();
        }
        this.fingerprint = await crypto.fingerprint();
        this.cryptoReady = true;
        await this.loadStoredPeerKeys();
      } catch (error) {
        console.error('Crypto init failed:', error);
      }
    },
    async loadStoredPeerKeys() {
      try {
        const stored = await crypto.loadPeerKeys();
        for (const pk of stored) {
          this.peerKeys[pk.email] = pk.public_key;
          this.peerKeysLoaded[pk.email] = true;
        }
      } catch (error) {
        console.error('Failed to load peer keys:', error);
      }
    },
    async login() {
      this.loginLoading = true;
      this.loginError = '';
      try {
        const data = await api.login(this.email, this.password);
        this.userId = data.user_id;
        this.isLoggedIn = true;
        ws.connect(api.token);
        ws.on('typing', (msg) => this.onTypingEvent(msg));
        await this.loadContacts();
        await this.loadGroups();
        await this.loadEmails();
        this.startPolling()
      } catch (error) {
        this.loginError = error.message;
      } finally {
        this.loginLoading = false;
      }
    },
    async handleLogout() {
      this.stopPolling();
      try { ws.disconnect(); } catch (e) { /* ignore */ }
      try { await api.logout(); } catch (e) { /* ignore */ }
      // Сбрасываем всё состояние сессии к экрану логина.
      this.isLoggedIn = false;
      this.userId = null;
      this.email = '';
      this.password = '';
      this.groups = [];
      this.groupKeys = {};
      this.currentGroup = null;
      this.activeChatType = 'chat';
      this.contacts = [];
      this.activeChat = null;
      this.messages = [];
      this.emails = [];
      this.emailError = '';
      this.pendingInvites = [];
      this.showInvitePopup = false;
      this.pendingContacts = [];
      this.showContactPopup = false;
      this.showSettings = false;
      this.showGroupSettings = false;
      this.showAddMemberPopup = false;
      this.profiles = {};
      this.userAvatarUrl = '';
      this.displayName = '';
      localStorage.removeItem('vault-display-name');
    },
    async loadContacts() {
      try {
        const all = await api.getContacts();
        // Контакты — общий peer-key store на машину; себя не показываем.
        this.contacts = (all || []).filter(c => c.email !== this.email);
      } catch (error) {
        // /api/contacts may not exist yet
        this.contacts = [];
      }
    },
    async loadGroups() {
      try {
        const all = await api.getGroups();
        // groups.json — общий файл на машину для всех аккаунтов. Показываем
        // только группы, где текущий пользователь участник или создатель.
        this.groups = (all || []).filter(g =>
          g.created_by === this.email ||
          (g.members || []).some(m => m.email === this.email)
        );
        // Участники групп — тоже контакты (кроме себя): так под приглашённым
        // аккаунтом виден отправитель инвайта (icemaksim → koanmak и наоборот).
        const seen = new Set(this.contacts.map(c => c.email));
        for (const g of this.groups) {
          for (const m of g.members || []) {
            if (m.email === this.email || seen.has(m.email)) continue;
            seen.add(m.email);
            this.contacts.push({ id: m.email, email: m.email, name: m.email, online: false });
          }
        }
      } catch (error) {
        console.error('Failed to load groups:', error);
      }
    },
    setPeerKey(email, key) {
      this.peerKeys[email] = key;
      crypto.setPeerPublicKey(key);
      crypto.savePeerKey(email, key, null).catch(err => {
        console.error('Failed to save peer key:', err);
      });
    },
    setPeerKeyFromInput() {
      if (!this.peerKeyInput || !this.activeChat) return;
      this.setPeerKey(this.activeChat, this.peerKeyInput);
      this.peerKeyInput = '';
    },
    async selectChat(email) {
      // Vault chat requires a peer key — without it there is nothing (and nothing
      // encrypted) to show. Contacts without keys are already hidden from the list;
      // this is a hard guard on top.
      if (!this.peerKeys[email]) {
        // Не молчим: объясняем, что нужно обменяться ключами, и сразу открываем
        // панель 🔗 (QRCodePanel) — ввод id участника или сканирование QR.
        alert(this.t('chat_no_key') || 'Нет ключа собеседника — обменяйтесь ключами: нажмите 🔗 (Добавить контакт) и введите id участника или отсканируйте QR-код.');
        this.showQRCode = true;
        return;
      }
      // Unsubscribe from previous chat
      if (this.activeChat) {
        ws.unsubscribe(this.activeChat);
      }
      this.activeChat = email;
      this.activeChatType = 'chat';
      this.currentView = 'chats';
      // Subscribe to new chat channel
      ws.subscribe(email);
      if (this.peerKeys[email]) {
        crypto.setPeerPublicKey(this.peerKeys[email]);
      }
      await this.loadMessages(email);
    },
    async selectGroup(group) {
      // Unsubscribe from previous chat
      if (this.activeChat) {
        ws.unsubscribe(this.activeChat);
      }
      this.activeChat = `group:${group.id}`;
      this.activeChatType = 'group';
      this.currentGroup = group;
      // Subscribe to group channel
      ws.subscribe(`group:${group.id}`);

      // Load group key if not already in memory
      if (!this.groupKeys[group.id] && this.cryptoReady) {
        try {
          const keyData = await api.getMyGroupKey(group.id);
          if (keyData && keyData.group_key) {
            // Serverless: group key is stored locally in ~/.vault/groups.json
            // (the same file the CLI reads) — no per-user encryption needed.
            this.groupKeys[group.id] = keyData.group_key;
          } else if (keyData && keyData.encrypted_key) {
            // Decrypt the group key with our private key
            // The encrypted_key was encrypted with our public key by the group creator
            // We need the group creator's public key to decrypt
            // For now, try to decrypt using the stored peer keys
            const creatorEmail = group.created_by;
            if (this.peerKeys[creatorEmail]) {
              const groupKeyHex = await crypto.decryptGroupKey(
                keyData.encrypted_key,
                this.peerKeys[creatorEmail]
              );
              this.groupKeys[group.id] = groupKeyHex;
            }
          }
        } catch (e) {
          console.warn('Could not load group key:', e);
        }
      }

      await this.loadGroupMessages(group.id);
    },
    // Parse message content — detect vault_attachment JSON and extract preview
    parseMessageContent(content) {
      if (!content || typeof content !== 'string') return { text: content, attachment: null };
      try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.vault_attachment) {
          const isImage = parsed.type && parsed.type.startsWith('image/');
          return {
            text: isImage ? `📎 ${parsed.name}` : `📎 ${parsed.name} (${(parsed.size / 1024).toFixed(1)}KB)`,
            attachment: { name: parsed.name, type: parsed.type, size: parsed.size, data: parsed.data, isImage },
          };
        }
      } catch { /* not JSON — plain text message */ }
      return { text: content, attachment: null };
    },
    // Split a message into its reply-quote portion (leading "> " lines) and body.
    splitReply(content) {
      if (!content || typeof content !== 'string' || content.indexOf('>') !== 0) {
        return { quote: '', body: content || '' };
      }
      const lines = content.split('\n');
      const quoteLines = [];
      let i = 0;
      for (; i < lines.length; i++) {
        if (lines[i].indexOf('>') === 0) quoteLines.push(lines[i].slice(1).trim());
        else break;
      }
      // Skip blank separator lines between the quote and the new body.
      while (i < lines.length && !lines[i].trim()) i++;
      return { quote: quoteLines.join('\n'), body: lines.slice(i).join('\n') };
    },
    hasReplyQuote(content) {
      return this.splitReply(content).quote !== '';
    },
    replyQuote(content) {
      return this.splitReply(content).quote;
    },
    replyBody(content) {
      return this.splitReply(content).body;
    },
    // Short excerpt used for the reply bar and for the "> " quote prefix.
    replyPreview(msg) {
      if (!msg) return '';
      let text = this.splitReply(msg.content || msg.text || '').body;
      if (!text) text = msg.content || '';
      text = String(text).replace(/\s+/g, ' ').trim();
      if (text.length > 60) text = text.slice(0, 60).trim() + '…';
      return text;
    },
    setReply(msg) {
      this.replyTo = msg;
    },
    cancelReply() {
      this.replyTo = null;
    },
    async loadMessages(email) {
      // Vault chat: only show mail FOR this contact, and only decrypt if we
      // hold their key (contact must be a Vault peer).
      if (!this.peerKeys[email]) {
        this.messages = [];
        return;
      }
      const related = this.emails.filter(m => {
        const f = (m.from || '').toLowerCase();
        const t = (m.to || '').toLowerCase();
        return f.includes(email.toLowerCase()) || t.includes(email.toLowerCase());
      });
      if (related.length > 0) {
        crypto.setPeerPublicKey(this.peerKeys[email]);
        const rendered = await Promise.all(related.map(async (m) => {
          const isOut = (m.from || '').toLowerCase().includes(email.toLowerCase());
          let content = m.subject || '(no subject)';
          try {
            const body = await api.fetchEmailBody(m.accountId || 'local', m.uid || m.id);
            const parsed = this.parseMessageContent(body);
            content = parsed.text || content;
            if (parsed.attachment) {
              content = `${content}\n📎 ${parsed.attachment.name}`;
            }
            // Vault messages carry a raw base64 body — decrypt with AAD="VAULT".
            // Only a message that authenticates as a vault message is shown in
            // the chat; anything else is treated as ordinary/foreign mail.
            if (this.cryptoReady) {
              try {
                const text = await crypto.decryptVault(body);
                const pp = this.parseMessageContent(text);
                content = pp.text || content;
              } catch (de) {
                // Cannot authenticate/decrypt as a vault message — not ours.
                return null;
              }
            } else {
              // No crypto — not a vault message.
              return null;
            }
            return {
              id: m.uid || m.id,
              content,
              from: isOut ? 'them' : 'me',
              time: m.date ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              encrypted: true,
              vault: true,
              email: m,
            };
          } catch (e) {
            return {
              id: m.uid || m.id,
              content,
              from: isOut ? 'them' : 'me',
              time: m.date ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              encrypted: false,
              email: m,
            };
          }
        }));
        this.messages = rendered.filter(r => r && r.vault).sort((a, b) => new Date(a.email?.date || 0) - new Date(b.email?.date || 0));
        return;
      }

      // Fallback: legacy backend path (groups, peer-key chats)
      try {
        const raw = await api.getMessages(email);
        if (this.cryptoReady && this.peerKeys[email]) {
          crypto.setPeerPublicKey(this.peerKeys[email]);
          const decrypted = await Promise.all(
            raw.map(async (msg) => {
              const { text, attachment } = this.parseMessageContent(msg.content);
              const base = {
                ...msg,
                content: text,
                from: msg.sender_id === this.userId ? 'me' : 'them',
                time: new Date(msg.created_at).toLocaleTimeString(),
                status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
                attachment,
              };
              if (crypto.isEncrypted(msg.content)) {
                try {
                  const text = await crypto.decryptVault(msg.content);
                  const parsed = this.parseMessageContent(text);
                  return { ...base, content: parsed.text, attachment: parsed.attachment, encrypted: true };
                } catch {
                  return { ...base, encrypted: false };
                }
              }
              return { ...base, encrypted: false };
            })
          );
          this.messages = decrypted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        } else {
          this.messages = raw.map(msg => {
            const { text, attachment } = this.parseMessageContent(msg.content);
            return {
              ...msg,
              content: text,
              from: msg.sender_id === this.userId ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: false,
              attachment,
            };
          }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        }
      } catch (error) {
        console.error('Failed to load messages:', error);
        this.messages = [];
      }
    },
    async loadGroupMessages(groupId) {
      try {
        const raw = await api.getGroupMessages(groupId);
        const groupKey = this.groupKeys[groupId];

        if (groupKey) {
          // Decrypt messages with group key
          const decrypted = await Promise.all(
            raw.map(async (msg) => {
              const { text, attachment } = this.parseMessageContent(msg.content);
              const base = {
                ...msg,
                content: text,
                from: msg.sender_id === this.userId ? 'me' : 'them',
                time: new Date(msg.created_at).toLocaleTimeString(),
                status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
                attachment,
              };
              if (crypto.isEncrypted(msg.content)) {
                try {
                  const plaintext = await crypto.decryptWithGroupKey(msg.content, groupKey);
                  const parsed = this.parseMessageContent(plaintext);
                  return { ...base, content: parsed.text, attachment: parsed.attachment, encrypted: true };
                } catch {
                  return { ...base, encrypted: false };
                }
              }
              return { ...base, encrypted: false };
            })
          );
          this.messages = decrypted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        } else {
          // No group key — show as-is (unencrypted)
          this.messages = raw.map(msg => {
            const { text, attachment } = this.parseMessageContent(msg.content);
            return {
              ...msg,
              content: text,
              from: msg.sender_id === this.userId ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: false,
              attachment,
            };
          }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        }
      } catch (error) {
        console.error('Failed to load group messages:', error);
        this.messages = [];
      }
    },
    onAvatarUpdate(dataUrl) {
      this.userAvatarUrl = dataUrl
      // Сохраняем свой профиль в кэш, чтобы имя/аватар отображались и у других.
      localStorage.setItem(`vault-avatar-${this.email}`, dataUrl || '')
      api.saveProfile(this.email, this.displayName || this.email, dataUrl || '')
      this.loadProfiles()
    },
    onAvatarFileSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        alert('Файл слишком большой (макс 2MB)');
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        this.userAvatarUrl = ev.target.result;
        localStorage.setItem(`vault-avatar-${this.email}`, ev.target.result);
        this.showAvatarUpload = false;
      };
      reader.readAsDataURL(file);
    },
    onTypingEvent(msg) {
      if (msg.user_id === this.userId) return;
      if (msg.chat === this.activeChat) {
        this.typingUsers[msg.user_id] = Date.now();
        this.typingUsers = { ...this.typingUsers };
        // Clear after 3 seconds
        setTimeout(() => {
          if (this.typingUsers[msg.user_id] && Date.now() - this.typingUsers[msg.user_id] >= 2900) {
            delete this.typingUsers[msg.user_id];
            this.typingUsers = { ...this.typingUsers };
          }
        }, 3100);
      }
    },
    onTypingInput() {
      if (!this.activeChat) return;
      ws.sendTyping(this.activeChat);
    },
    async sendMessage() {
      if (!this.newMessage.trim()) return;

      try {
        // If replying, prefix the message with a "> quote" block (kept in plaintext —
        // the whole thing is still enclosed in the vault AAD-encrypted payload below).
        let payload = this.newMessage;
        if (this.replyTo) {
          const quote = this.replyPreview(this.replyTo);
          if (quote) payload = `> ${quote}\n\n${this.newMessage}`;
        }

        let content = payload;

        if (this.activeChatType === 'group') {
          // Group message — encrypt with group key; never send plaintext without it
          const groupKey = this.groupKeys[this.currentGroup.id];
          if (!groupKey) {
            alert('Групповой ключ не загружен — переоткройте группу');
            return;
          }
          content = await crypto.encryptWithGroupKey(payload, groupKey);
          await api.sendGroupMessage(this.currentGroup.id, content);
          // Reload from server to get proper server timestamp and UUID
          await this.loadGroupMessages(this.currentGroup.id);
        } else {
          // Regular chat message
          if (this.cryptoReady && this.peerKeys[this.activeChat]) {
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat]);
            // Encrypt as a vault message (AAD="VAULT") so the peer can recognize
            // and authenticate it as ours.
            content = await crypto.encryptVault(payload);
          }
          await api.sendMessage(this.activeChat, content);
          // Reload from server to get proper server timestamp and UUID
          await this.loadMessages(this.activeChat);
        }

        this.newMessage = '';
        this.cancelReply();
        this.$nextTick(() => {
          this.$refs.messagesContainer.scrollTop = this.$refs.messagesContainer.scrollHeight;
        });
      } catch (error) {
        alert('Failed to send message: ' + error.message);
      }
    },
    searchMessages() {
      alert('Search coming soon!');
    },
    async onKeysChanged() {
      if (this.cryptoReady) {
        this.fingerprint = await crypto.fingerprint();
      }
      await this.loadStoredPeerKeys();
    },
    async addPeerKey(publicKeyHex) {
      try {
        if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
          alert('Invalid public key format');
          return;
        }
        // QR-скан даёт только публичный ключ (без email) — спросим email контакта,
        // т.к. peerKeys индексируется по email (см. loadStoredPeerKeys).
        const email = await prompt('Email контакта?');
        if (!email || !email.includes('@')) {
          alert('Введите email контакта');
          return;
        }
        const normalized = email.trim().toLowerCase();
        await crypto.savePeerKey(normalized, publicKeyHex, null);
        this.peerKeys[normalized] = publicKeyHex;
        this.peerKeysLoaded[normalized] = true;
        await this.loadContacts(); // список чатов обновится из load_peer_keys
        this.showQRCode = false;
      } catch (error) {
        alert('Failed to add peer key: ' + error.message);
      }
    },
    async loadEmails(silent = false) {
      if (!silent) {
        this.emailsLoading = true;
        this.emailError = '';
      }
      try {
        const accounts = await api.getEmailAccounts();
        this.emails = [];
        for (const account of accounts) {
          try {
            const msgs = await api.fetchEmails(account.id, { limit: 50 });
            this.emails = this.emails.concat(msgs || []);
          } catch (e) {
            console.error('Failed to fetch emails for account:', e);
            if (!silent) this.emailError = 'fetch: ' + (e && e.message || e);
            // Re-throw "Not connected" so mounted() can ask for the password again
            if (String(e && e.message || e).toLowerCase().includes('not connected')) {
              throw e;
            }
          }
        }
        console.log(`[Emails] loaded ${this.emails.length} messages`);
        if (!silent && this.emails.length === 0 && !this.emailError) {
          this.emailError = 'INBOX пуст или письма не найдены';
        }
        // После поллинга разбираем инвайты/подтверждения групп (попап согласия).
        await this.processInvites();
      } catch (error) {
        // let "Not connected" propagate to the caller (app restart re-login)
        if (String(error && error.message || error).toLowerCase().includes('not connected')) {
          throw error;
        }
        console.error('Failed to load emails:', error);
        if (!silent) this.emailError = 'load: ' + (error && error.message || error);
      } finally {
        if (!silent) this.emailsLoading = false;
      }
    },
    startPolling(intervalMs = 30000) {
      if (this.pollTimer) return;
      this.pollTimer = setInterval(async () => {
        if (!this.isLoggedIn) return;
        try {
          // Тихий поллинг: не трогает спиннер/ошибки почты, но разбирает
          // инвайты (попап согласия) и обновляет список писем.
          await this.loadEmails(true);
        } catch (e) {
          // "Not connected" — сессия IMAP умерла; останавливаем поллинг,
          // следующий релог через mounted()/экран логина.
          if (String(e && e.message || e).toLowerCase().includes('not connected')) {
            this.stopPolling();
          } else {
            console.error('Polling loadEmails failed:', e);
          }
        }
      }, intervalMs);
    },
    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    },
    // Emoji
    insertEmoji(emoji) {
      this.newMessage += emoji
      this.showEmojiPicker = false
    },
    // Audio messages
    sendAudioMessage(audioData) {
      // Audio is encrypted and sent as attachment
      // For now, show as text indicator
      const msg = {
        id: Date.now().toString(36),
        content: `🎙️ [Voice ${audioData.duration}s — ${Math.round(audioData.size / 1024)}KB]`,
        from: 'me',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        encrypted: this.cryptoReady,
        audioData: audioData.base64,
      }
      this.messages.push(msg)
      this.showAudioRecorder = false
    },
    // File attachments
    async handleFileSelect(event) {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      for (const file of files) {
        try {
          const reader = new FileReader();
          reader.onload = async (e) => {
            const base64 = e.target.result.split(',')[1];
            const isImage = file.type.startsWith('image/');

            // Encode attachment as structured JSON for server storage
            const attachmentPayload = JSON.stringify({
              vault_attachment: true,
              name: file.name,
              type: file.type,
              size: file.size,
              data: base64,
            });

            const displayContent = isImage
              ? `📎 ${file.name}`
              : `📎 ${file.name} (${(file.size / 1024).toFixed(1)}KB)`;

            // Create preview message
            const msg = {
              id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
              content: displayContent,
              from: 'me',
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              encrypted: this.cryptoReady,
              attachment: {
                name: file.name,
                type: file.type,
                size: file.size,
                data: base64,
                isImage: isImage,
              },
            };
            this.messages.push(msg);

            // Send to API — content is the JSON payload, server stores it as-is
            if (this.activeChat) {
              try {
                await api.sendMessage(this.activeChat, attachmentPayload, file.type);
              } catch (err) {
                console.error('Failed to send attachment:', err);
              }
            }
          };
          reader.readAsDataURL(file);
        } catch (err) {
          console.error('File read error:', err);
        }
      }

      // Reset input
      event.target.value = '';
    },
    // Reactions
    toggleReactionPicker(msgId) {
      this.reactionPickerMsgId = this.reactionPickerMsgId === msgId ? null : msgId
    },
    addReaction(msgId, emoji) {
      const msg = this.messages.find(m => m.id === msgId)
      if (!msg) return
      if (!msg.reactions) msg.reactions = []
      if (!msg.reactions.includes(emoji)) {
        msg.reactions.push(emoji)
      }
      this.reactionPickerMsgId = null
    },
    toggleReaction(msgId, emoji) {
      const msg = this.messages.find(m => m.id === msgId)
      if (!msg || !msg.reactions) return
      const idx = msg.reactions.indexOf(emoji)
      if (idx >= 0) {
        msg.reactions.splice(idx, 1)
      }
    },
    // Export
    exportAsJSON() {
      const json = exportChatJSON(this.messages, this.activeChat)
      downloadFile(json, `vault-${this.activeChat}-${Date.now()}.json`, 'application/json')
      this.showExportMenu = false
    },
    exportAsTXT() {
      const txt = exportChatTXT(this.messages, this.activeChat)
      downloadFile(txt, `vault-${this.activeChat}-${Date.now()}.txt`, 'text/plain')
      this.showExportMenu = false
    },
    // Group management
    async createGroup() {
      if (!this.newGroupName.trim()) return;
      try {
        const group = await api.createGroup(this.newGroupName.trim(), '');
        group.members = group.members || [];
        group.blocked = group.blocked || [];
        this.groups.push(group);
        this.currentGroup = group;

        // Generate and store a group encryption key
        if (this.cryptoReady) {
          const groupKey = await crypto.generateGroupKey();
          this.groupKeys[group.id] = groupKey;
          console.log('Generated group key for', group.id);
        }

        this.showGroupSettings = true;
        this.newGroupName = '';
      } catch (error) {
        console.error('Failed to create group:', error);
        alert('Failed to create group: ' + error.message);
      }
    },
    createGroupAndClose() {
      this.createGroup();
      this.showCreateGroup = false;
    },
    promoteMember(email) {
      if (!this.currentGroup) return;
      const member = this.currentGroup.members.find(m => m.email === email);
      if (member) member.role = 'Admin';
    },
    demoteMember(email) {
      if (!this.currentGroup) return;
      const member = this.currentGroup.members.find(m => m.email === email);
      if (member && email !== this.currentGroup.created_by) {
        member.role = 'Member';
      }
    },
    removeMember(email) {
      if (!this.currentGroup) return;
      api.removeGroupMember(this.currentGroup.id, email)
        .then(() => this.refreshGroupMembers())
        .catch(e => console.error('removeMember failed:', e));
    },
    async changeMemberRole(email, role) {
      if (!this.currentGroup) return;
      try {
        await api.setGroupMemberRole(this.currentGroup.id, email, role);
        const m = this.currentGroup.members.find(m => m.email === email);
        if (m) m.role = role;
      } catch (e) {
        alert('Failed to set role: ' + e.message);
      }
    },
    async addMember(email) {
      // Основной UX добавления участника — попап выбора контактов.
      this.openAddMemberPopup();
    },
    openAddMemberPopup() {
      this.addMemberQuery = '';
      this.showAddMemberPopup = true;
    },
    async inviteContact(email) {
      if (!this.currentGroup || !email) return;
      try {
        // Ключ группы шифруем на публичном ключе ПОЛУЧАТЕЛЯ (ECDH X25519).
        // Без ключа собеседника безопасный инвайт невозможен — как в Session:
        // в группу добавляют только установленные контакты.
        const peerPub = this.peerKeys[email] || null;
        if (!peerPub) {
          alert('Сначала добавьте контакт: обменяйтесь ключами через 🔗 (по id участника или QR). Тогда собеседник сможет расшифровать приглашение в группу.');
          return;
        }
        const groupKeys = await api.getGroupKeys(this.currentGroup.id);
        if (!groupKeys.length) throw new Error('No group key');
        const enc = await crypto.encryptGroupKeyForUser(groupKeys[0], peerPub);
        await api.inviteGroupMember(this.currentGroup.id, email, enc, this.publicKey);
        this.showAddMemberPopup = false;
        // Помечаем локально как «приглашён» в списке участников (появится после accept).
        const members = this.currentGroup.members || [];
        if (!members.some(m => m.email === email)) {
          members.push({ email, role: 'Member', invited: true });
        }
        alert((this.t('invite_sent') || 'Приглашение отправлено') + ': ' + email);
      } catch (e) {
        alert('Failed to invite member: ' + e.message);
      }
    },
    enterManualEmail() {
      const email = (this.addMemberQuery || '').trim();
      if (!email) return;
      this.inviteContact(email);
    },
    // --- Инвайты группы + запросы контактов 1-на-1: попапы согласия ---
    async processInvites() {
      try {
        // Обрабатываем accept-письма (добавление принявших участников).
        const accepts = await api.fetchPendingAccepts();
        if (accepts.length) {
          await this.loadGroups();
          if (this.currentGroup) {
            await this.loadGroupMessages(this.currentGroup.id);
            await this.refreshGroupMembers();
          }
        }
        // Контакты 1-на-1 (Session-модель): accept-письма → добавляем ключи.
        const contactAccepts = await api.fetchPendingContactAccepts();
        if (contactAccepts.length) {
          this.peerKeys = Object.assign({}, this.peerKeys);
          await this.loadContacts();
        }
        // Собираем непрочитанные инвайты для попапа согласия.
        const invites = await api.fetchPendingInvites();
        if (invites.length) {
          this.pendingInvites = invites;
          this.invitePopupIndex = 0;
          this.showInvitePopup = true;
        }
        // Запросы контактов 1-на-1 — попап «Принять/Отклонить».
        const contacts = await api.fetchPendingContactInvites();
        if (contacts.length) {
          // Групповой попап имеет приоритет; контактный покажем следом.
          if (!this.showInvitePopup) {
            this.pendingContacts = contacts;
            this.contactPopupIndex = 0;
            this.showContactPopup = true;
          }
        }
        this.loadProfiles();
      } catch (e) {
        console.error('processInvites failed:', e);
      }
    },
    async refreshGroupMembers() {
      if (!this.currentGroup) return;
      try {
        this.currentGroup.members = await api.getGroupMembers(this.currentGroup.id);
      } catch (e) {
        console.error('refreshGroupMembers failed:', e);
      }
    },
    async acceptInvite(inv) {
      try {
        // Новый формат: group_key зашифрован на нашем публичном ключе —
        // расшифровываем своим приватным ключом (ECDH + sender_public_key).
        let groupKey = inv.group_key || null;
        if (!groupKey && inv.group_key_enc && inv.sender_public_key && this.cryptoReady) {
          groupKey = await crypto.decryptGroupKey(inv.group_key_enc, inv.sender_public_key);
          if (!groupKey) throw new Error('Не удалось расшифровать ключ группы');
        }
        if (!groupKey) throw new Error('В приглашении нет ключа группы');
        await api.acceptGroupInvite(inv.group_id, { ...inv, group_key: groupKey });
      } catch (e) {
        alert('Failed to accept invite: ' + e.message);
      }
      this.pendingInvites.splice(this.invitePopupIndex, 1);
      this.showInvitePopup = false;
      await this.loadGroups();
      if (this.currentGroup?.id === inv.group_id) {
        await this.loadGroupMessages(inv.group_id);
      }
      this.showNextInvite();
    },
    async declineInvite(inv) {
      try {
        await api.declineGroupInvite(inv.group_id, inv.uid, inv.sender);
      } catch (e) {
        // ignore
      }
      this.pendingInvites.splice(this.invitePopupIndex, 1);
      this.showInvitePopup = false;
      this.showNextInvite();
    },
    showNextInvite() {
      if (this.pendingInvites.length > 0) {
        if (this.invitePopupIndex >= this.pendingInvites.length) this.invitePopupIndex = 0;
        this.showInvitePopup = true;
      } else {
        this.showInvitePopup = false;
        // Групповой попап закрыт — показываем накопившиеся запросы контактов.
        if (this.pendingContacts.length) {
          this.showContactPopup = true;
        }
      }
    },
    // --- Контакты 1-на-1: принять/отклонить запрос (Session-модель) ---
    async acceptContactInvite(c) {
      try {
        await crypto.savePeerKey(c.sender, c.public_key, c.sender_name || null);
        await api.addContact(c.sender);
        api.saveProfile(c.sender, c.sender_name, c.sender_avatar);
        this.loadProfiles();
        // Отвечаем своим публичным ключом — у пригласившего появится наш контакт.
        await api.sendContactAccept(c.sender, this.publicKey);
        await this.loadContacts();
      } catch (e) {
        alert('Failed to accept contact: ' + e.message);
      }
      this.pendingContacts.splice(this.contactPopupIndex, 1);
      this.showNextContact();
    },
    async declineContactInvite(c) {
      const key = `${c.sender}|${c.uid}`;
      try {
        const declined = JSON.parse(localStorage.getItem('vault-declined-contacts') || '[]');
        if (!declined.includes(key)) declined.push(key);
        localStorage.setItem('vault-declined-contacts', JSON.stringify(declined));
      } catch (e) { /* ignore */ }
      this.pendingContacts.splice(this.contactPopupIndex, 1);
      this.showNextContact();
    },
    showNextContact() {
      if (this.pendingContacts.length > 0) {
        if (this.contactPopupIndex >= this.pendingContacts.length) this.contactPopupIndex = 0;
        this.showContactPopup = true;
      } else {
        this.showContactPopup = false;
      }
    },
    async inviteContactById(email) {
      const id = (email || '').trim();
      if (!id) return;
      try {
        await api.sendContactInvite(id, this.publicKey);
        alert((this.t('invite_sent') || 'Приглашение отправлено') + ': ' + id);
      } catch (e) {
        alert('Failed to send invite: ' + e.message);
      }
    },
    // --- Профили (имя/аватар отправителей в групповых чатах) ---
    profileOf(email) {
      return this.profiles[email] || null;
    },
    nameOf(email) {
      const p = this.profileOf(email);
      return (p && p.name) || email;
    },
    avatarOf(email) {
      const p = this.profileOf(email);
      return (p && p.avatar) || '';
    },
    loadProfiles() {
      try {
        this.profiles = JSON.parse(localStorage.getItem('vault-profiles') || '{}');
      } catch (e) {
        this.profiles = {};
      }
    },
    blockUser(email) {
      if (!this.currentGroup) return;
      if (!this.currentGroup.blocked.includes(email)) {
        this.currentGroup.blocked.push(email);
      }
    },
    unblockUser(email) {
      if (!this.currentGroup) return;
      this.currentGroup.blocked = this.currentGroup.blocked.filter(e => e !== email);
    },
    async leaveGroup() {
      if (!this.currentGroup) return;
      const gid = this.currentGroup.id;
      try {
        await api.leaveGroup(gid);
      } catch (e) {
        console.error('leaveGroup failed:', e);
      }
      // Покинутая группа исчезает из списка (мы больше не участник).
      this.groups = this.groups.filter(g => g.id !== gid);
      this.showGroupSettings = false;
      this.currentGroup = null;
      if (this.activeChat === `group:${gid}`) {
        ws.unsubscribe(`group:${gid}`);
        this.activeChat = null;
        this.messages = [];
      }
    },
    async deleteGroup() {
      if (!this.currentGroup) return;
      const gid = this.currentGroup.id;
      try {
        await api.deleteGroup(gid);
      } catch (e) {
        console.error('deleteGroup failed:', e);
      }
      this.groups = this.groups.filter(g => g.id !== gid);
      this.showGroupSettings = false;
      this.currentGroup = null;
      if (this.activeChat === `group:${gid}`) {
        ws.unsubscribe(`group:${gid}`);
        this.activeChat = null;
        this.messages = [];
      }
    }
  }
}
</script>

<style>
.login-screen {
  display: flex; align-items: center; justify-content: center;
  width: 100vw; height: 100vh;
  background: var(--bg-primary, #0d1117); color: var(--text-primary, #e6edf3);
  font-family: system-ui, -apple-system, sans-serif;
}
.login-box {
  background: var(--bg-secondary, #161b22); border: 1px solid var(--border, #30363d);
  border-radius: 12px; padding: 40px; width: 360px; text-align: center;
}
.login-box h1 { margin: 0 0 8px; font-size: 28px; }
.login-box p { margin: 0 0 20px; color: var(--text-secondary, #8b949e); }
.login-box input {
  width: 100%; padding: 10px 14px; margin-bottom: 12px; border-radius: 8px;
  border: 1px solid var(--border, #30363d); background: var(--bg-primary, #0d1117);
  color: var(--text-primary, #e6edf3); font-size: 14px; box-sizing: border-box;
}
.login-box button {
  width: 100%; padding: 10px; border-radius: 8px; border: none; cursor: pointer;
  background: #238636; color: white; font-size: 14px; font-weight: 600;
}
.login-box button:disabled { opacity: 0.5; cursor: not-allowed; }
.login-error { color: #f85149; font-size: 13px; margin-top: 4px; }
.login-hint { font-size: 13px; margin: 16px 0 8px !important; }
.login-box hr { border: none; border-top: 1px solid var(--border, #30363d); margin: 20px 0; }
/* ═══════════════════════════════════════════════════════════════
   Vault — Professional Design System
   ═══════════════════════════════════════════════════════════════ */

:root {
  /* Primary palette */
  --bg-primary: #0a0a1a;
  --bg-secondary: #12122a;
  --bg-tertiary: #1a1a3e;
  --bg-hover: #1e1e4a;
  --bg-active: #252560;
  
  /* Accent colors */
  --accent-primary: #6366f1;
  --accent-secondary: #818cf8;
  --accent-glow: rgba(99, 102, 241, 0.3);
  
  /* Text colors */
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  
  /* Status colors */
  --status-online: #22c55e;
  --status-encrypted: #6366f1;
  --status-warning: #f59e0b;
  
  /* Borders */
  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-hover: rgba(255, 255, 255, 0.1);
  
  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  
  /* Transitions */
  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
  
  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  
  /* Spacing */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-full: 9999px;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  background: var(--bg-primary);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}

.app-container {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* ═══════════════════════════════════════════════════════════════
   Sidebar
   ═══════════════════════════════════════════════════════════════ */

.sidebar {
  width: 320px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
}
.app-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.app-logo-img {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  object-fit: cover;
}

.app-logo-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

/* Bottom nav switch (Чаты / Почта) — two side-by-side toggle buttons.
   Mirrors .sidebar-header spacing (20px 24px) so buttons don't stick to
   the window edge. */
.nav-switch {
  display: flex;
  flex-direction: row;
  margin-top: auto;
  border-top: 1px solid var(--border-subtle);
  padding: 16px 24px 20px;
  gap: 8px;
}

.nav-chats-btn,
.mail-nav-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.nav-chats-btn + .mail-nav-btn {
  border-left: none;
}

.nav-chats-btn:hover,
.mail-nav-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-chats-btn.active,
.mail-nav-btn.active {
  background: var(--bg-active);
  color: var(--text-primary);
  box-shadow: inset 0 0 0 1px var(--accent-primary);
}

.mail-nav-ico {
  font-size: 16px;
  width: 24px;
  text-align: center;
}

.mail-nav-label {
  flex: 1;
  text-align: left;
}

.mail-nav-count {
  background: var(--accent-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  min-width: 20px;
  text-align: center;
}

/* Email view (mailbox) */
.email-view {
  flex: 1;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  min-width: 0;
}

.email-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.email-detail-header {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-subtle);
}

.email-back-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.email-back-btn:hover {
  background: var(--bg-hover);
}

.email-detail-meta {
  min-width: 0;
}

.email-detail-from {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.email-detail-subject {
  font-size: 14px;
  color: var(--text-secondary);
  margin-top: 4px;
  word-break: break-word;
}

.email-detail-date {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.email-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.email-detail-locked {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  height: 100%;
  min-height: 220px;
  padding: 24px;
  border: 1px dashed var(--status-encrypted, #6366f1);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
}

.locked-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.locked-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.locked-note {
  font-size: 13px;
  color: var(--text-secondary);
  max-width: 420px;
}

.email-detail-text {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
  margin: 0;
}

.email-body-loading {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  padding: 40px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo-icon {
  font-size: 24px;
}

.logo-text {
  font-size: 20px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.header-actions button {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 18px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.header-actions button:hover {
  background: var(--bg-hover);
}

/* ═══════════════════════════════════════════════════════════════
   Avatar Circle (sidebar header)
   ═══════════════════════════════════════════════════════════════ */

.avatar-circle {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--bg-tertiary, #1a1a3e);
  border: 2px solid var(--border-subtle, rgba(255,255,255,0.06));
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.2s, transform 0.15s;
  flex-shrink: 0;
}

.avatar-circle:hover {
  border-color: var(--accent-primary, #6366f1);
  transform: scale(1.05);
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.avatar-initials {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  user-select: none;
}

/* ═══════════════════════════════════════════════════════════════
   Settings Modal
   ═══════════════════════════════════════════════════════════════ */

.modal-settings {
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 16px;
  width: calc(100% - 40px);
  max-width: 720px;
  max-height: calc(100% - 40px);
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.5));
  animation: slideUp 0.2s ease;
  position: relative;
  overflow-y: auto;
}

/* Group settings modal — рамка вокруг GroupSettings.vue (оверлей, не инлайн) */
.group-settings-panel {
  position: relative;
  background: transparent;
  width: calc(100% - 40px);
  max-width: 620px;
  max-height: calc(100% - 40px);
  overflow-y: auto;
  animation: slideUp 0.2s ease;
}

/* ═══════════════════════════════════════════════════════════════
   Avatar Upload Modal
   ═══════════════════════════════════════════════════════════════ */

.modal-avatar {
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 16px;
  width: 380px;
  max-width: 90vw;
  padding: 32px;
  text-align: center;
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.5));
  animation: slideUp 0.2s ease;
  position: relative;
}

.modal-avatar h3 {
  margin: 0 0 24px 0;
  font-size: 18px;
  color: var(--text-primary, #f1f5f9);
}

.avatar-preview-circle {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: var(--bg-tertiary, #1a1a3e);
  border: 3px solid var(--border-subtle, rgba(255,255,255,0.06));
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 20px;
  overflow: hidden;
}

.avatar-preview-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.avatar-preview-initials {
  font-size: 36px;
}

.avatar-hint {
  font-size: 13px;
  color: var(--text-muted, #64748b);
  margin: 0 0 20px 0;
}

.avatar-upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: var(--accent-primary, #6366f1);
  color: white;
  border: none;
  border-radius: var(--radius-md, 8px);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.avatar-upload-btn:hover {
  background: var(--accent-hover, #5558e6);
  transform: translateY(-1px);
}

/* ═══════════════════════════════════════════════════════════════
   Navigation Tabs
   ═══════════════════════════════════════════════════════════════ */

.nav-tabs {
  display: flex;
  padding: 8px;
  gap: 4px;
  border-bottom: 1px solid var(--border-subtle);
}

.nav-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 16px;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.nav-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-tab.active {
  background: var(--accent-primary);
  color: white;
}

.nav-icon {
  font-size: 14px;
}

/* ═══════════════════════════════════════════════════════════════
   Search Box
   ═══════════════════════════════════════════════════════════════ */

.email-error-hint {
  margin: 8px 10px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--text-secondary, #94a3b8);
  background: var(--bg-tertiary, #1a1a3e);
  border: 1px solid var(--danger, #ef4444);
  border-radius: 6px;
  word-break: break-word;
}

.search-box {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.search-box input {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: all var(--transition-fast);
}

.search-box input::placeholder {
  color: var(--text-muted);
}

.search-box input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

/* ═══════════════════════════════════════════════════════════════
   Contacts List
   ═══════════════════════════════════════════════════════════════ */

.contacts-list {
  flex: 1;
  overflow-y: auto;
}

.contacts-empty {
  padding: 24px 20px;
  text-align: center;
}

.contacts-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.contacts-empty-hint {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.contacts-empty-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.contacts-empty-actions .btn-primary,
.contacts-empty-actions .btn-secondary {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.contact-item {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  cursor: pointer;
  transition: all var(--transition-fast);
  border-left: 3px solid transparent;
}

.contact-item:hover {
  background: var(--bg-hover);
}

.contact-item.active {
  background: var(--bg-active);
  border-left-color: var(--accent-primary);
}

.contact-avatar {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 14px;
  flex-shrink: 0;
}

.avatar-initial {
  font-size: 18px;
  font-weight: 600;
  color: white;
}

.contact-info {
  flex: 1;
  min-width: 0;
}

.contact-name {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.contact-email {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.contact-status {
  margin-left: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Бейдж «нет ключа» — контакт виден (напр. из участников группы), но для
   чата 1-на-1 нужно сначала обменяться ключами (🔗). */
.contact-no-key {
  font-size: 12px;
  opacity: 0.7;
  cursor: help;
}

.status-dot {
  display: block;
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  background: var(--text-muted);
}

.status-dot.online {
  background: var(--status-online);
  box-shadow: 0 0 8px var(--status-online);
}

/* Groups */
.groups-section {
  margin-top: 16px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.groups-header {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.group-avatar {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
}

/* ═══════════════════════════════════════════════════════════════
   Main Chat Area
   ═══════════════════════════════════════════════════════════════ */

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.chat-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-secondary);
}

.chat-header-info {
  display: flex;
  align-items: center;
  gap: 14px;
}

.chat-avatar {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-header-info h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 2px;
}

.chat-status {
  font-size: 12px;
  color: var(--text-muted);
}

.chat-actions {
  display: flex;
  gap: 4px;
}

.chat-actions button {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 18px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.chat-actions button:hover {
  background: var(--bg-hover);
}

/* Текстовые кнопки действий в шапке группового чата
   («Добавить участника», «Настройки») — заметнее, чем голые эмодзи. */
.chat-actions button.chat-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 10px;
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
  border-radius: var(--radius-sm, 8px);
  color: var(--text-secondary, #aaa);
  white-space: nowrap;
}

.chat-actions button.chat-action-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary, #fff);
  border-color: var(--border, rgba(255,255,255,0.2));
}

/* ═══════════════════════════════════════════════════════════════
   Messages
   ═══════════════════════════════════════════════════════════════ */

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.message {
  max-width: 70%;
  animation: messageIn 0.2s ease;
}

@keyframes messageIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message.own {
  margin-left: auto;
}

.message-content {
  background: var(--bg-tertiary);
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  border-bottom-left-radius: 4px;
  color: var(--text-primary);
  line-height: 1.5;
  box-shadow: var(--shadow-sm);
}

.message.own .message-content {
  background: linear-gradient(135deg, var(--accent-primary), #4f46e5);
  border-bottom-left-radius: var(--radius-lg);
  border-bottom-right-radius: 4px;
}

.encrypted-badge {
  margin-left: 6px;
  font-size: 12px;
}

/* Reply (quote a message, like other messengers) */
.reply-quote {
  color: var(--text-secondary, #94a3b8);
  border-left: 3px solid var(--accent-primary, #6366f1);
  padding-left: 8px;
  margin-bottom: 6px;
  font-size: 13px;
  font-style: italic;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.reply-btn {
  position: absolute;
  top: 12px;
  right: 8px;
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: var(--radius-sm, 6px);
  color: var(--text-secondary, #94a3b8);
  cursor: pointer;
  font-size: 14px;
  width: 28px;
  height: 28px;
  line-height: 1;
  opacity: 0;
  transition: opacity var(--transition-fast, 150ms ease);
  z-index: 10;
}

.message:hover .reply-btn {
  opacity: 1;
}

.reply-btn:hover {
  background: var(--bg-hover, #1e1e4a);
  color: var(--text-primary, #f1f5f9);
}

/* Reply quote bar above the message input */
.reply-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 24px;
  background: var(--bg-tertiary, #1e1e3a);
  border-top: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  font-size: 13px;
}

.reply-bar-label {
  color: var(--accent-primary, #6366f1);
  font-weight: 600;
  white-space: nowrap;
}

.reply-bar-text {
  flex: 1;
  color: var(--text-secondary, #94a3b8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reply-bar-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #64748b);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: var(--radius-sm, 6px);
}

.reply-bar-close:hover {
  background: var(--bg-hover, #1e1e4a);
  color: var(--text-primary, #f1f5f9);
}

.messages-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  gap: 12px;
}

/* Attachment previews */
.attachment-preview {
  margin-top: 8px;
}

.attachment-image {
  max-width: 300px;
  max-height: 200px;
  border-radius: 8px;
  cursor: pointer;
  transition: transform 0.2s;
}

.attachment-image:hover {
  transform: scale(1.02);
}

.attachment-file {
  background: rgba(255, 255, 255, 0.1);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.message-time {
  font-size: 11px;
  color: var(--text-muted);
}

.message-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 6px;
}

.message-status {
  font-size: 12px;
  color: var(--text-muted);
  opacity: 0.7;
}

.message-status.read {
  color: #6366f1;
  opacity: 1;
}

/* Typing indicator */
.typing-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-muted);
}

.typing-dots {
  display: flex;
  gap: 3px;
}

.typing-dots span {
  width: 6px;
  height: 6px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: typing-bounce 1.4s infinite ease-in-out;
}

.typing-dots span:nth-child(1) { animation-delay: 0s; }
.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* Reactions */
.message-reactions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.reaction-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  background: var(--bg-hover, rgba(99, 102, 241, 0.15));
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 12px;
  font-size: 14px;
  cursor: pointer;
  transition: all var(--transition-fast, 150ms ease);
}

.reaction-badge:hover {
  background: var(--accent-glow, rgba(99, 102, 241, 0.3));
  transform: scale(1.1);
}

.reaction-picker {
  position: absolute;
  bottom: 100%;
  left: 0;
  display: flex;
  gap: 2px;
  padding: 6px 8px;
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 20px;
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.4));
  z-index: 50;
  animation: fadeInUp 0.15s ease;
}

@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.reaction-emoji {
  background: none;
  border: none;
  font-size: 20px;
  padding: 4px 6px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.1s;
}

.reaction-emoji:hover {
  background: var(--bg-hover, #1e1e4a);
  transform: scale(1.2);
}

.message {
  position: relative;
}

/* Chat search bar */
.chat-search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  background: var(--bg-secondary, #12122a);
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
}

.chat-search-input {
  flex: 1;
  padding: 8px 12px;
  background: var(--bg-tertiary, #1a1a3e);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 8px;
  color: var(--text-primary, #f1f5f9);
  font-size: 13px;
  outline: none;
}

.chat-search-input:focus {
  border-color: var(--accent-primary, #6366f1);
}

.chat-search-count {
  font-size: 12px;
  color: var(--text-muted, #64748b);
  white-space: nowrap;
}

.chat-search-close {
  background: none;
  border: none;
  color: var(--text-muted, #64748b);
  cursor: pointer;
  font-size: 16px;
}

.chat-search-close:hover {
  color: var(--text-primary, #f1f5f9);
}

/* Group create button */
.group-create-row {
  padding: 8px 16px;
}

.group-create-btn {
  width: 100%;
  padding: 8px 12px;
  background: linear-gradient(135deg, var(--accent-primary, #6366f1), #4f46e5);
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all var(--transition-fast, 150ms ease);
}

.group-create-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--accent-glow, rgba(99, 102, 241, 0.3));
}

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: fadeIn 0.15s ease;
}

/* QR code overlay — обёртка для QRCodePanel (обмен ключами :id / QR) */
.qr-code-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal-card {
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 16px;
  width: 380px;
  max-width: 90vw;
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.5));
  animation: slideUp 0.2s ease;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px 0;
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
  color: var(--text-primary, #f1f5f9);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-muted, #64748b);
  cursor: pointer;
  font-size: 22px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  transition: color 0.15s;
  line-height: 1;
}

.modal-close:hover {
  color: var(--text-primary, #f1f5f9);
}

.modal-body {
  padding: 20px 24px;
}

.modal-body label {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #64748b);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.modal-input {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-tertiary, #1a1a3e);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 8px;
  color: var(--text-primary, #f1f5f9);
  font-size: 14px;
  outline: none;
  margin-bottom: 16px;
  transition: border-color 0.15s;
}

.modal-input:focus {
  border-color: var(--accent-primary, #6366f1);
}

.icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.icon-btn {
  width: 36px;
  height: 36px;
  background: var(--bg-tertiary, #1a1a3e);
  border: 2px solid transparent;
  border-radius: 8px;
  font-size: 18px;
  cursor: pointer;
  transition: all 0.15s;
}

.icon-btn:hover {
  background: var(--bg-hover, #1e1e4a);
}

.icon-btn.active {
  border-color: var(--accent-primary, #6366f1);
  background: var(--accent-glow, rgba(99, 102, 241, 0.15));
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 0 24px 20px;
}

.btn-cancel {
  padding: 8px 16px;
  background: var(--bg-tertiary, #1a1a3e);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 8px;
  color: var(--text-secondary, #94a3b8);
  cursor: pointer;
  font-size: 13px;
}

.btn-cancel:hover {
  background: var(--bg-hover, #1e1e4a);
}

.btn-primary {
  padding: 8px 16px;
  background: linear-gradient(135deg, var(--accent-primary, #6366f1), #4f46e5);
  border: none;
  border-radius: 8px;
  color: white;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s;
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--accent-glow, rgba(99, 102, 241, 0.3));
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.btn-secondary {
  padding: 8px 16px;
  background: var(--bg-tertiary, #1a1a3a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.12));
  border-radius: 8px;
  color: var(--text-primary, #f1f5f9);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s;
}

.btn-secondary:hover {
  border-color: var(--accent-primary, #6366f1);
  color: var(--text-primary, #f1f5f9);
}

/* Export dropdown */
.export-dropdown {
  position: relative;
}

.export-menu {
  position: absolute;
  top: 100%;
  right: 0;
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 8px;
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.4));
  overflow: hidden;
  z-index: 50;
  min-width: 120px;
}

.export-menu button {
  display: block;
  width: 100%;
  padding: 10px 14px;
  background: none;
  border: none;
  color: var(--text-primary, #f1f5f9);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.export-menu button:hover {
  background: var(--bg-hover, #1e1e4a);
}

/* ═══════════════════════════════════════════════════════════════
   Message Input
   ═══════════════════════════════════════════════════════════════ */

.message-input {
  padding: 16px 24px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--bg-secondary);
}

.input-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  position: relative;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  transition: all var(--transition-fast);
}

.input-wrapper:focus-within {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.emoji-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 20px;
  padding: 8px 4px 8px 12px;
  transition: transform 0.15s;
}

.emoji-btn:hover {
  transform: scale(1.15);
}

.message-field {
  flex: 1;
  padding: 12px 12px 12px 0;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}

.message-field::placeholder {
  color: var(--text-muted);
}

.attach-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 20px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.attach-btn:hover {
  background: var(--bg-hover);
}

.mic-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 20px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.mic-btn:hover {
  background: var(--bg-hover);
  transform: scale(1.1);
}

.send-btn {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), #4f46e5);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
  box-shadow: var(--shadow-md);
}

.send-btn:hover {
  transform: scale(1.05);
  box-shadow: 0 0 20px var(--accent-glow);
}

.send-icon {
  font-size: 18px;
  color: white;
}

/* ═══════════════════════════════════════════════════════════════
   Empty State
   ═══════════════════════════════════════════════════════════════ */

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-text {
  font-size: 16px;
}

/* ═══════════════════════════════════════════════════════════════
   Key Manager
   ═══════════════════════════════════════════════════════════════ */

.key-manager {
  padding: 24px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
}

.key-manager h3 {
  margin: 0 0 20px 0;
  font-size: 18px;
  font-weight: 600;
}

/* ═══════════════════════════════════════════════════════════════
   Settings Panel
   ═══════════════════════════════════════════════════════════════ */

.settings-panel {
  padding: 24px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
  overflow-y: auto;
  flex: 1;
}

.settings-fullscreen {
  padding: 0;
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 100;
  background: #0d1117;
}

.settings-panel h3 {
  margin: 0 0 20px 0;
  font-size: 18px;
  font-weight: 600;
}

/* ═══════════════════════════════════════════════════════════════
   Email View
   ═══════════════════════════════════════════════════════════════ */

.email-view {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.email-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px;
}

.email-detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.back-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  padding: 8px 16px;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.back-btn:hover {
  background: var(--bg-hover);
}

.email-detail-header h3 {
  font-size: 20px;
  font-weight: 600;
}

.email-detail-meta {
  display: flex;
  gap: 24px;
  color: var(--text-secondary);
  font-size: 14px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.email-detail-body {
  flex: 1;
  line-height: 1.7;
  color: var(--text-primary);
}

/* ═══════════════════════════════════════════════════════════════
   Scrollbar Styling
   ═══════════════════════════════════════════════════════════════ */

::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

/* ═══════════════════════════════════════════════════════════════
   Responsive (for future use)
   ═══════════════════════════════════════════════════════════════ */

@media (max-width: 768px) {
  .sidebar {
    width: 100%;
  }
  
  .main-area {
    display: none;
  }
}

/* ── Invite popup (приглашение в группу) ── */
.invite-popup-title {
  margin: 0 0 12px;
}
.invite-popup-text {
  margin: 0 0 4px;
  color: var(--text-muted, #888);
  font-size: 13px;
}
.invite-popup-name {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #fff);
}
.invite-popup-sender {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.invite-popup-sender-name {
  font-size: 13px;
  color: var(--text-primary, #fff);
}
.invite-popup-actions {
  display: flex;
  gap: 8px;
}

/* ── Add-member popup (выбор контактов) ── */
.add-member-popup-title {
  margin: 0 0 12px;
}
.add-member-search {
  width: 100%;
  padding: 8px;
  margin-bottom: 12px;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid var(--border-color, #333);
  background: var(--bg-primary, #0d0d1a);
  color: var(--text-primary, #fff);
  font-size: 13px;
}
.add-member-contacts {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.add-member-contact {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  background: var(--bg-primary, #0d0d1a);
}
.add-member-contact:hover {
  background: var(--bg-hover, #1e1e4a);
}
.add-member-contact-name {
  font-size: 13px;
  color: var(--text-primary, #fff);
  flex: 1;
}
.add-member-contact-email {
  font-size: 12px;
  color: var(--text-muted, #888);
}
.add-member-none {
  padding: 12px;
  color: var(--text-muted, #888);
  font-size: 13px;
  text-align: center;
}
.add-member-manual {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #fff);
  border: 1px dashed var(--border-color, #333);
}
.add-member-manual:hover {
  background: var(--bg-hover, #1e1e4a);
}
.add-member-manual-email {
  color: var(--text-muted, #888);
}

/* ── Sender line in group messages ── */
.message-sender {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  padding-left: 4px;
}
.message-sender-name {
  font-size: 12px;
  color: var(--text-muted, #aaa);
}
</style>
