<template>
  <div class="app-container">
    <!-- RESTORING SESSION (авто-вход: не показываем пустую форму логина) -->
    <div v-if="!isLoggedIn && restoringSession" class="login-screen">
      <div class="login-box">
        <h1>🔒 Vault</h1>
        <p class="login-hint">{{ t('restoring_session') || 'Подключение к почте…' }}</p>
      </div>
    </div>
    <!-- LOGIN SCREEN -->
    <div v-else-if="!isLoggedIn" class="login-screen">
      <div class="login-box">
        <h1>🔒 Vault</h1>
        <p>E2E Encrypted Messenger</p>
        <form @submit.prevent="login">
          <input v-model="email" type="email" placeholder="Email" required />
          <input v-model="password" type="password" placeholder="Password" required />
          <label class="remember-label">
            <input type="checkbox" v-model="rememberMe" />
            <span>{{ t('login_remember') || 'Запомнить на этом устройстве' }}</span>
          </label>
          <!-- Настройки серверов почты: провайдер может сменить IMAP/SMTP,
               пользователь должен мочь исправить их вручную. -->
          <button type="button" class="server-toggle" @click="showServerSettings = !showServerSettings">
            ⚙ {{ t('server_settings') || 'Настройки сервера' }}
            <span class="server-toggle-arrow">{{ showServerSettings ? '▾' : '▸' }}</span>
          </button>
          <div v-if="showServerSettings" class="server-settings">
            <div class="server-row">
              <label>{{ t('provider') || 'Провайдер' }}</label>
              <select v-model="mailProvider" class="server-provider" @change="onMailProviderChange">
                <option v-for="p in mailProviders" :key="p.id" :value="p.id">{{ p.label }}</option>
                <option :value="customProviderId">{{ t('provider_custom') || 'Другой (вручную)' }}</option>
              </select>
            </div>
            <div class="server-row">
              <label>IMAP</label>
              <input v-model="imapServer" type="text" placeholder="imap.gmail.com" />
              <input v-model="imapPort" type="text" placeholder="993" class="server-port" />
            </div>
            <div class="server-row">
              <label>SMTP</label>
              <input v-model="smtpServer" type="text" placeholder="smtp.gmail.com" />
              <input v-model="smtpPort" type="text" placeholder="587" class="server-port" />
            </div>
            <p v-if="mailProviderHint" class="server-hint">{{ mailProviderHint }}</p>
            <p class="server-hint">{{ t('server_hint') || 'Оставьте пустыми для значений по умолчанию (Gmail).' }}</p>
          </div>
          <button type="submit" :disabled="loginLoading">
            {{ loginLoading ? '...' : t('login') || 'Login' }}
          </button>
          <p v-if="loginError" class="login-error">{{ loginError }}</p>
        </form>
        <p class="login-hint">{{ t('login_hint') || 'Регистрация не нужна: у Vault нет сервера — приложение работает поверх вашей почты. Войдите под своим email, ключи создадутся автоматически. Добавляйте собеседников по id участника или QR-коду (🔗 вверху).' }}</p>
      </div>
    </div>
    <!-- MAIN APP -->
    <div v-else class="sidebar" :class="{ 'mobile-hidden': isMobile && mobileChatOpen }">
      <div class="sidebar-header">
        <div class="app-logo" :title="t('app_name') || 'Vault'" @click="openAppSite">
          <img :src="appIconUrl" alt="Vault" class="app-logo-img" />
        </div>
        <div class="header-actions">
          <button class="group-create-btn" :title="t('group_create') || 'New Group'" @click="showCreateGroup = true">
            <Icon name="user-plus" :size="22" gradient cls="group-create-icon" />
          </button>
          <button :title="t('nav_add_contact')" @click="showQRCode = true"><Icon name="link" :size="20" /></button>
          <button :title="t('nav_keys')" @click="showKeyManager = true"><Icon name="key" :size="20" /></button>
          <button :title="t('cipher_title')" @click="showCipher = true"><Icon name="shield" :size="20" /></button>
          <button @click="showSettings = true" :title="t('nav_settings') || 'Settings'"><Icon name="settings" :size="20" /></button>
        </div>
      </div>
      
      <div class="contacts-list">
        <div class="search-box">
          <input type="text" :placeholder="t('contacts_search')" v-model="searchQuery" />
        </div>

        <!-- Заметки для себя: локальный чат с собой (Session/Telegram pattern).
             Не зависит от peer_keys, почты и шифрования — хранится только
             в localStorage vault-notes-<email>. -->
        <div
          class="contact-item notes-self"
          :class="{ active: activeChat === '__notes__' }"
          @click="selectNotes"
        >
          <div class="notes-self-avatar">
            <Icon name="pencil" :size="18" gradient cls="notes-self-icon" />
          </div>
          <div class="contact-info">
            <div class="contact-name">{{ t('notes_self') || 'Заметки для себя' }}</div>
            <div class="contact-email">{{ t('notes_self_hint') || 'Только на этом устройстве' }}</div>
          </div>
        </div>
        <!-- Onboarding: no contacts and no peer keys yet -->
        <div v-if="contacts.length === 0 && Object.keys(peerKeys).length === 0" class="contacts-empty">
          <div class="contacts-empty-title">{{ t('contacts_empty_title') }}</div>
          <div class="contacts-empty-hint">{{ t('contacts_empty_hint') }}</div>
          <div class="contacts-empty-actions">
            <button class="btn-primary" @click="showKeyManager = true"><Icon name="key" :size="15" /> {{ t('nav_keys') }}</button>
            <button class="btn-secondary" @click="showQRCode = true"><Icon name="link" :size="15" /> {{ t('nav_add_contact') }}</button>
          </div>
        </div>
        <div 
          v-for="contact in filteredContacts" 
          :key="contact.email"
          :class="['contact-item', { active: activeChat === contact.email }]"
          @click="selectChat(contact.email)"
        >
          <UserAvatar :email="contact.email" :avatarUrl="avatarOf(contact.email)" :size="36" />
          <div class="contact-info">
            <div class="contact-name">{{ localProfileOf(contact.email)?.name || contact.name }}</div>
            <div class="contact-email">{{ contact.email }}</div>
          </div>
          <div class="contact-status">
            <span v-if="unreadOf(contact.email)" class="unread-badge">{{ unreadOf(contact.email) }}</span>
            <span v-if="!peerKeys[contact.email]" class="contact-no-key" :title="t('contact_no_key_hint') || 'Нет ключа собеседника — обменяйтесь ключами через 🔗 (по id участника или QR)'">🔓</span>
            <span class="status-dot" :class="{ online: contact.online }"></span>
            <button class="contact-delete" :title="t('contact_delete') || 'Удалить контакт'" @click.stop="deleteContact(contact.email)"><Icon name="trash" :size="14" /></button>
          </div>
        </div>
        
        <!-- Email load error (debug aid) -->
        <div v-if="emailError" class="email-error-hint">{{ emailError }}</div>

        <!-- Groups Section -->
        <div v-if="groups.length > 0" class="groups-section">
          <div class="groups-header">
            <Icon name="users" :size="14" cls="groups-header-icon" />
            {{ t('nav_groups') || 'Groups' }}
          </div>
          <div 
            v-for="group in groups" 
            :key="group.id"
            :class="['contact-item', { active: activeChat === `group:${group.id}` }]"
            @click="selectGroup(group)"
          >
            <img v-if="groupAvatars[group.id]" :src="groupAvatars[group.id]" class="group-avatar group-avatar-img" :alt="group.name" />
            <div v-else class="group-avatar">
              {{ groupIconMap[group.id] || group.name.charAt(0).toUpperCase() }}
            </div>
            <div class="contact-info">
              <div class="contact-name">{{ group.name }}</div>
              <div class="contact-email">{{ (group.members || []).length }} {{ membersLabel((group.members || []).length) }}</div>
            </div>
            <div class="contact-status" v-if="unreadOf('group:' + group.id)">
              <span class="unread-badge">{{ unreadOf('group:' + group.id) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="main-area" :class="{ 'mobile-hidden': isMobile && !mobileChatOpen }">
      <!-- CHAT VIEW -->
      <div v-if="currentView !== 'email'" class="chat-area">
        <div class="chat-header" v-if="activeChat">
          <div class="chat-header-info">
            <button v-if="isMobile" class="chat-back-btn" @click="closeMobileChat" :title="t('back') || 'Назад'">
              <Icon name="chevron-left" :size="22" />
            </button>
            <template v-if="activeChatType === 'group'">
              <img v-if="currentGroup && groupAvatars[currentGroup.id]" :src="groupAvatars[currentGroup.id]" class="group-avatar group-avatar-img" :alt="currentGroup.name" />
              <div v-else class="group-avatar">
                {{ (currentGroup && (groupIconMap[currentGroup.id] || currentGroup.name?.charAt(0).toUpperCase())) || '?' }}
              </div>
            </template>
            <template v-else-if="activeChat === '__notes__'">
              <div class="notes-self-avatar notes-self-avatar-lg">
                <Icon name="pencil" :size="20" gradient cls="notes-self-icon" />
              </div>
            </template>
            <template v-else>
              <div class="chat-avatar-col">
                <UserAvatar :email="activeChat" :avatarUrl="avatarOf(activeChat)" :size="40" />
                <div class="chat-avatar-email" :title="activeChat">{{ activeChat }}</div>
              </div>
            </template>
            <div class="chat-header-text">
              <h3 v-if="activeChatName !== activeChat">{{ activeChatName }}</h3>
              <div class="chat-status">
                <template v-if="activeChatType === 'group'">
                  <span class="members-count" @click="showMembersList = true">
                    <Icon name="users" :size="15" gradient cls="members-count-icon" />
                    {{ (currentGroup?.members || []).length }} {{ membersLabel((currentGroup?.members || []).length) }}
                  </span>
                </template>
                <template v-else-if="activeChat === '__notes__'">
                  <span>{{ t('notes_self_status') || 'Локально · только на этом устройстве' }}</span>
                </template>
                <template v-else>
                  {{ peerKeys[activeChat] ? '🔒 Encrypted' : '⚠️ No key' }}
                </template>
              </div>
            </div>
          </div>
          <div class="chat-actions">
            <template v-if="activeChatType === 'group'">
              <button v-if="isGroupAdmin" class="chat-action-btn" @click="openAddMemberPopup" :title="t('add_member') || 'Добавить участника'"><Icon name="user-plus" :size="17" /><span class="chat-action-label">{{ t('add_member') || 'Добавить участника' }}</span></button>
              <button class="chat-action-btn" @click="showGroupSettings = !showGroupSettings" :title="t('group_settings') || 'Настройки группы'"><Icon name="settings" :size="17" /><span class="chat-action-label">{{ t('group_settings') || 'Настройки' }}</span></button>
            </template>
            <template v-else-if="activeChat && activeChat !== '__notes__'">
              <button class="chat-action-btn" @click="openContactEdit(activeChat)" :title="t('contact_edit') || 'Локальные имя и аватар контакта'"><Icon name="pencil" :size="17" /></button>
            </template>
            <button @click="showChatSearch = !showChatSearch" :title="t('nav_search') || 'Search'"><Icon name="search" :size="17" /></button>
            <div class="export-dropdown" v-if="activeChat">
              <button class="export-btn" @click="showExportMenu = !showExportMenu" :title="t('chat_export') || 'Export'">
                <Icon name="download" :size="17" cls="export-icon" />
              </button>
              <div v-if="showExportMenu" class="export-menu">
                <button @click="exportAsJSON"><Icon name="copy" :size="14" /> JSON</button>
                <button @click="exportAsTXT"><Icon name="pencil" :size="14" /> TXT</button>
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
          <button class="chat-search-close" @click="chatSearchQuery = ''; showChatSearch = false"><Icon name="x" :size="13" /></button>
        </div>

        <div class="messages" ref="messagesContainer" @scroll="onMessagesScroll">
          <div v-if="activeChat && messages.length === 0" class="messages-empty">
            <div class="empty-icon">🔒</div>
            <div class="empty-text">{{ t('chat_empty') || 'Нет сообщений — отправьте первое 🔒' }}</div>
          </div>
          <!-- Закреплённое сообщение группы (баннер; открепить может админ) -->
          <div v-if="activeChatType === 'group' && pinnedMsgId" class="pinned-banner" @click="scrollPinnedToView">
            <Icon name="pin" :size="14" cls="pinned-banner-icon" />
            <span class="pinned-banner-text">{{ pinnedPreview || t('pinned_message') || 'Закреплённое сообщение' }}</span>
            <button v-if="isGroupAdmin" class="pinned-banner-unpin" :title="t('unpin_message') || 'Открепить'" @click.stop="unpinGroupMessage"><Icon name="x" :size="13" /></button>
          </div>
          <div
            v-for="msg in filteredMessages"
            :key="msg.id"
            :data-msg-id="msg.id"
            :class="['message', { own: msg.from === 'me', 'drag-over-before': dragOverNoteId === msg.id && dragOverPos === 'before', 'drag-over-after': dragOverNoteId === msg.id && dragOverPos === 'after' }]"
            :draggable="activeChat === '__notes__'"
            @dragstart="onNoteDragStart($event, msg)"
            @dragover="onNoteDragOver($event, msg)"
            @dragleave="onNoteDragLeave($event, msg)"
            @drop="onNoteDrop($event, msg)"
            @dragend="draggedNoteId = null; dragOverNoteId = null; dragOverPos = null"
            @click.stop="toggleReactionPicker(msg.id)"
            @contextmenu.prevent="openMessageMenu($event, msg)"
          >
            <!-- Отправитель в групповом чате (имя/аватар из профиля) -->
            <div v-if="activeChatType === 'group' && msg.from !== 'me'" class="message-sender">
              <UserAvatar :email="senderEmail(msg.sender_id)" :avatarUrl="avatarOf(senderEmail(msg.sender_id))" :size="26" />
              <span class="message-sender-name">{{ nameOf(senderEmail(msg.sender_id)) }}</span>
            </div>
            <div class="message-content">
              <template v-if="msg.deleted">
                <span class="message-deleted">🚫 {{ t('message_deleted') || 'Сообщение удалено' }}</span>
              </template>
              <template v-else>
              <div v-if="hasReplyQuote(msg.content)" class="reply-quote">{{ replyQuote(msg.content) }}</div>
              <span>{{ replyBody(msg.content) }}</span>
              <span v-if="msg.edited" class="message-edited-badge" :title="t('edited') || 'Отредактировано'">✎</span>
              <div v-if="msg.attachment && msg.attachment.isImage" class="attachment-preview">
                <img :src="'data:' + msg.attachment.type + ';base64,' + msg.attachment.data"
                     :alt="msg.attachment.name"
                     class="attachment-image"
                     @click="openImageViewer(msg.attachment)" />
                <button class="attachment-dl-btn" @click.stop="downloadAttachment(msg.attachment)"><Icon name="download" :size="13" /> {{ t('download') || 'Скачать' }}</button>
              </div>
              <div v-else-if="msg.attachment && msg.attachment.isAudio" class="attachment-preview">
                <audio controls class="attachment-audio"
                       :src="'data:' + msg.attachment.type + ';base64,' + msg.attachment.data"></audio>
                <button class="attachment-dl-btn" @click.stop="downloadAttachment(msg.attachment)"><Icon name="download" :size="13" /> {{ t('download') || 'Скачать' }}</button>
              </div>
              <div v-else-if="msg.attachment && msg.attachment.isText" class="attachment-preview">
                <pre class="attachment-text">{{ msg.attachment.textContent }}</pre>
                <button class="attachment-dl-btn" @click.stop="downloadAttachment(msg.attachment)"><Icon name="download" :size="13" /> {{ t('download') || 'Скачать' }}</button>
              </div>
              <div v-else-if="msg.attachment" class="attachment-preview">
                <div class="attachment-file" @click.stop="downloadAttachment(msg.attachment)">
                  📄 {{ msg.attachment.name }} ({{ (msg.attachment.size / 1024).toFixed(1) }}KB)
                  <span class="attachment-dl-btn"><Icon name="download" :size="13" /> {{ t('download') || 'Скачать' }}</span>
                </div>
              </div>
              </template>
            </div>
            <!-- Reply button (visible on hover) -->
            <button class="reply-btn" :title="t('chat_reply_to') || 'Reply'" @click.stop="setReply(msg)"><Icon name="reply" :size="13" /></button>
            <!-- Copy button (visible on hover) -->
            <button class="copy-btn" :title="t('copy_text') || 'Копировать текст'" @click.stop="copyMessageText(msg)"><Icon name="copy" :size="13" /></button>
            <!-- Pin — только админ группы (hover) -->
            <button v-if="activeChatType === 'group' && isGroupAdmin" class="pin-btn" :title="t('pin_message') || 'Закрепить'" @click.stop="pinGroupMessage(msg)"><Icon name="pin" :size="13" /></button>
            <!-- Edit/Delete — только свои сообщения (видны на hover) -->
            <button v-if="msg.from === 'me' && !msg.deleted" class="edit-btn" :title="t('edit_message') || 'Редактировать'" @click.stop="startEditMessage(msg)"><Icon name="pencil" :size="13" /></button>
            <button v-if="msg.from === 'me' && !msg.deleted" class="delete-btn" :title="t('delete_message') || 'Удалить'" @click.stop="deleteMessage(msg)"><Icon name="trash" :size="13" /></button>
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
              <!-- Статус — маленький цветной кружок (без текста, чтобы не
                   путаться с языками): красный=отправка, жёлтый=отправлено,
                   зелёный=доставлено, синий=просмотрено -->
              <span
                v-if="msg.from === 'me'"
                class="message-status-dot"
                :class="msg.status || 'sent'"
                :title="statusTitle(msg)"
              ></span>
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

        <!-- Стрелка «вниз к последним сообщениям» (длинные чаты) — поверх чата,
             вне scroll-контейнера, чтобы не уезжала вместе с контентом -->
        <button v-if="showJumpToBottom" class="jump-to-bottom" :title="t('jump_to_bottom') || 'К последним сообщениям'" @click="jumpToBottom"><Icon name="arrow-down" :size="18" /></button>

        <!-- Контекстное меню сообщения (правый клик): копирование -->
        <div v-if="messageMenu" class="message-menu-overlay" @click="messageMenu = null" @contextmenu.prevent="messageMenu = null">
          <div class="message-menu" :style="{ left: messageMenu.x + 'px', top: messageMenu.y + 'px' }" @click.stop>
            <button @click="setReply(messageMenu.msg); messageMenu = null"><Icon name="reply" :size="14" /> {{ t('chat_reply_to') || 'Ответить' }}</button>
            <button @click="copyMessageText(messageMenu.msg); messageMenu = null"><Icon name="copy" :size="14" /> {{ t('copy_text') || 'Копировать текст' }}</button>
            <button @click="copyMessageAll(messageMenu.msg); messageMenu = null"><Icon name="copy" :size="14" /> {{ t('copy_all') || 'Копировать всё' }}</button>
            <button v-if="activeChatType === 'group' && isGroupAdmin" @click="pinGroupMessage(messageMenu.msg); messageMenu = null"><Icon name="pin" :size="14" /> {{ t('pin_message') || 'Закрепить' }}</button>
            <button v-if="messageMenu.msg.from === 'me' && !messageMenu.msg.deleted" @click="startEditMessage(messageMenu.msg); messageMenu = null"><Icon name="pencil" :size="14" /> {{ t('edit_message') || 'Редактировать' }}</button>
            <button v-if="messageMenu.msg.from === 'me' && !messageMenu.msg.deleted" @click="deleteMessage(messageMenu.msg); messageMenu = null"><Icon name="trash" :size="14" /> {{ t('delete_message') || 'Удалить' }}</button>
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
          <Icon name="reply" :size="14" cls="reply-bar-ic" />
          <span class="reply-bar-label">{{ t('chat_reply_to') || 'Ответ на' }}</span>
          <span class="reply-bar-text">{{ replyPreview(replyTo) }}</span>
          <button class="reply-bar-close" @click="cancelReply" title="Cancel reply"><Icon name="x" :size="13" /></button>
        </div>

        <!-- Edit bar (shown while editing own message) -->
        <div v-if="editingMessage" class="reply-bar edit-bar">
          <span class="reply-bar-label">{{ t('editing_message') || 'Редактирование' }}</span>
          <span class="reply-bar-text">{{ replyPreview(editingMessage) }}</span>
          <button class="reply-bar-close" @click="cancelEdit" title="Cancel edit"><Icon name="x" :size="13" /></button>
        </div>

        <div class="message-input" v-if="activeChat">
        <div class="input-wrapper">
          <button class="emoji-btn" @click="showEmojiPicker = !showEmojiPicker" title="Emoji"><Icon name="smile" :size="19" /></button>
          <EmojiPicker
            :show="showEmojiPicker"
            @select="insertEmoji"
            @close="showEmojiPicker = false"
          />
          <input
            ref="messageInput"
            v-model="newMessage"
            @keyup.enter="sendMessage"
            @input="onTypingInput"
            :placeholder="(t('message_placeholder') || 'Type a message') + '...'"
            class="message-field"
          />
        </div>
        <button class="attach-btn" title="Attach file" @click="$refs.fileInput.click()"><Icon name="paperclip" :size="19" /></button>
        <input ref="fileInput" type="file" multiple style="display:none" @change="handleFileSelect" accept="image/*,.pdf,.doc,.docx,.txt,.zip" />
        <button class="mic-btn" @click="showAudioRecorder = !showAudioRecorder" title="Voice message"><Icon name="mic" :size="19" /></button>
        <AudioRecorder
          :show="showAudioRecorder"
          @send="sendAudioMessage"
          @close="showAudioRecorder = false"
        />
          <button class="send-btn" @click="sendMessage" :disabled="sending">
            <span class="send-icon">➤</span>
          </button>
        </div>
      </div>
    </div>

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
        <div class="modal-settings invite-popup-panel">
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
        <div class="modal-settings invite-popup-panel">
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

      <!-- ADD MEMBER POPUP (выбор контактов, мульти-выбор чекбоксами) -->
      <div v-if="showAddMemberPopup" class="modal-overlay" @click.self="showAddMemberPopup = false">
        <div class="modal-settings invite-popup-panel">
          <button class="modal-close" @click="showAddMemberPopup = false">←</button>
          <h3 class="add-member-popup-title">{{ t('add_member_from_contacts') || 'Добавить участника из контактов' }}</h3>
          <input
            v-model="addMemberQuery"
            type="text"
            :placeholder="t('search_contacts') || 'Поиск контактов…'"
            class="add-member-search"
            @keyup.enter="addManualEmail"
          />
          <div class="add-member-contacts">
            <div
              v-for="c in filteredAddContacts"
              :key="c.email"
              class="add-member-contact"
              :class="{ selected: addMemberSelected.includes(c.email) }"
              @click="toggleAddMember(c.email)"
            >
              <span class="add-member-checkbox" :class="{ checked: addMemberSelected.includes(c.email) }">{{ addMemberSelected.includes(c.email) ? '✓' : '' }}</span>
              <UserAvatar :email="c.email" :size="28" />
              <span class="add-member-contact-name">{{ c.name || c.email }}</span>
              <span class="add-member-contact-email">{{ c.email }}</span>
            </div>
            <div v-if="filteredAddContacts.length === 0" class="add-member-none">
              {{ t('no_contacts') || 'Контакты не найдены' }}
            </div>
            <div v-if="addMemberQuery.includes('@')" class="add-member-manual" @click="addManualEmail">
              ✏️ {{ t('enter_email_manual') || 'Ввести email вручную' }}
              <span class="add-member-manual-email">— {{ addMemberQuery }}</span>
            </div>
          </div>
          <div v-if="addMemberSelected.length" class="add-member-selected-chips">
            <span
              v-for="em in addMemberSelected"
              :key="em"
              class="add-member-chip"
              :title="t('general_cancel') || 'Cancel'"
              @click="toggleAddMember(em)"
            >{{ em }} ✕</span>
          </div>
          <button
            class="btn-primary add-member-invite-btn"
            :disabled="addMemberSelected.length === 0"
            @click="inviteSelectedMembers"
          >
            {{ t('add_member_invite_btn') || 'Пригласить' }}<template v-if="addMemberSelected.length"> ({{ addMemberSelected.length }})</template>
          </button>
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
            <Icon name="camera" :size="14" /> Выбрать файл
            <input type="file" accept="image/png,image/jpeg,image/svg+xml" @change="onAvatarFileSelect" hidden />
          </label>
        </div>
      </div>

      <!-- CONTACT EDIT MODAL: локальные имя/аватар контакта (видны только мне,
           реальные имя/аватар собеседника не меняются) -->
      <div v-if="showContactEdit && editingContact" class="modal-overlay" @click.self="showContactEdit = false">
        <div class="modal-content contact-edit-panel">
          <h3>{{ t('contact_edit_title') || 'Имя и аватар контакта' }}</h3>
          <p class="contact-edit-email">{{ editingContact }}</p>
          <p class="avatar-hint">{{ t('contact_edit_hint') || 'Видно только вам — реальные имя и аватар собеседника не меняются.' }}</p>
          <div class="avatar-preview-circle">
            <img v-if="editContactAvatar" :src="editContactAvatar" class="avatar-preview-img" />
            <span v-else class="avatar-initials avatar-preview-initials">{{ (nameOf(editingContact) || '?').charAt(0).toUpperCase() }}</span>
          </div>
          <input
            v-model="editContactName"
            class="contact-edit-name-input"
            :placeholder="t('contact_edit_name_placeholder') || 'Локальное имя (например: Мама, Босс)'"
            maxlength="64"
          />
          <div class="contact-edit-actions">
            <label class="avatar-upload-btn">
              <Icon name="camera" :size="14" /> {{ t('contact_edit_avatar') || 'Аватар' }}
              <input type="file" accept="image/png,image/jpeg,image/svg+xml" @change="handleContactAvatarSelect" hidden />
            </label>
            <button v-if="editContactAvatar" class="contact-edit-btn contact-edit-btn--ghost" @click="editContactAvatar = ''">✕ {{ t('contact_edit_remove_avatar') || 'Убрать аватар' }}</button>
          </div>
          <div class="contact-edit-footer">
            <button class="contact-edit-btn contact-edit-btn--ghost" @click="resetContactEdit">{{ t('contact_edit_reset') || 'Сбросить' }}</button>
            <div class="contact-edit-footer-right">
              <button class="contact-edit-btn contact-edit-btn--ghost" @click="showContactEdit = false">{{ t('general_cancel') || 'Отмена' }}</button>
              <button class="contact-edit-btn contact-edit-btn--primary" @click="saveContactEdit">{{ t('general_save') || 'Сохранить' }}</button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- GROUP SETTINGS MODAL (полноценный оверлей, не сжимает чат) -->
      <div v-if="showGroupSettings && currentGroup" class="modal-overlay" @click.self="showGroupSettings = false">
        <div class="group-settings-panel">
          <GroupSettings
            :group="currentGroup"
            :currentUser="email"
            :profiles="mergedProfiles"
            @close="showGroupSettings = false"
            @role-change="changeMemberRole"
            @remove="removeMember"
            @unblock="unblockUser"
            @leave="leaveGroup"
            @delete="deleteGroup"
            @add-member="addMember"
            @avatar-update="onGroupAvatarUpdate"
          />
        </div>
      </div>




    <!-- Image viewer (полноэкранный просмотр вложения-изображения) -->
    <div v-if="viewingImage" class="modal-overlay image-viewer-overlay" @click.self="closeImageViewer">
      <div class="image-viewer">
        <button class="modal-close" @click="closeImageViewer">←</button>
        <img :src="'data:' + viewingImage.type + ';base64,' + viewingImage.data"
             :alt="viewingImage.name" class="image-viewer-img" />
        <div class="image-viewer-actions">
          <span class="image-viewer-name">{{ viewingImage.name }}</span>
          <button class="btn btn-primary" @click="downloadAttachment(viewingImage)"><Icon name="download" :size="14" /> {{ t('download') || 'Скачать' }}</button>
        </div>
      </div>
    </div>

    <!-- Members list (список участников группы по клику на счётчик) -->
    <div v-if="showMembersList && currentGroup" class="modal-overlay" @click.self="showMembersList = false">
      <div class="modal-settings">
        <button class="modal-close" @click="showMembersList = false">←</button>
        <h3 class="invite-popup-title">{{ (currentGroup.members || []).length }} {{ membersLabel((currentGroup.members || []).length) }}</h3>
        <div class="member-list">
          <div v-for="member in (currentGroup.members || [])" :key="member.email" class="member-item">
            <UserAvatar :email="member.email" :avatarUrl="avatarOf(member.email)" :size="36" />
            <div class="member-item__info">
              <span class="member-item__email">{{ nameOf(member.email) }}</span>
              <span class="member-item__role" :class="'role--' + (member.role || 'Member').toLowerCase()">{{ member.role || 'Member' }}</span>
            </div>
            <span v-if="member.invited" class="member-invited-badge">{{ t('invite_pending') || 'приглашён' }}</span>
          </div>
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
import { db } from './api.js';
import crypto from './crypto.js';
import { initNotifications, notifyNewMessage } from './notify.js';
// ws.js удалён (16.08): WebSocket к backend (localhost:9443) мёртв — backend
// убран в serverless-архитектуре. Typing-индикатор вернётся с транспортом на M3.
import { useI18n } from './i18n.js';
import SettingsPage from './components/SettingsPage.vue';
import EmailSettings from './components/EmailSettings.vue';
import KeyManager from './components/KeyManager.vue';
import LanguageSelector from './components/LanguageSelector.vue';
import UserAvatar from './components/UserAvatar.vue';
import GroupSettings from './components/GroupSettings.vue';
import Icon from './components/Icon.vue';
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
import { exportChatJSON, exportChatTXT, downloadFile, downloadBase64 } from './chatExport.js';
import { saveHistory, loadHistory } from './history.js';
import { detectProvider, checkFileSize, formatBytes } from './providerLimits.js';
import { MAIL_PROVIDERS, CUSTOM_PROVIDER_ID, findProvider, detectProviderByServer, detectProviderByEmail, getAttachmentLimitMb } from './mailProviders.js';
import { open as openExternal } from '@tauri-apps/plugin-shell';

// Сайт приложения (лендинг, веха M4). Пока сайта нет — пустая строка:
// когда появится, подставить адрес (vault-msg.ru / vault-msg.tech),
// и клик по логотипу в шапке откроет его во внешнем браузере.
const APP_SITE_URL = '';

export default {
  name: 'ChatApp',
  components: {
    SettingsPage,
    EmailSettings,
    KeyManager,
    LanguageSelector,
    UserAvatar,
    GroupSettings,
    Icon,
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
      // Мобильная навигация (Telegram/Delta Chat паттерн): на узком экране
      // видна ОДНА панель — список чатов ИЛИ открытый чат на весь экран.
      // mobileChatOpen=true — показан чат (main-area), кнопка «назад» в шапке.
      mobileChatOpen: false,
      // Счётчики непрочитанных по чатам (email | 'group:<id>' → число).
      // Хранятся в sqlite kv_store (НЕ localStorage — он запрещён как
      // источник данных Vault); сбрасываются при открытии чата.
      unreadCounts: {},
      // Ширина окна — для определения мобильного режима (<768px).
      windowWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
      appIconId: 'letter',
      contacts: [],
      activeChat: null,
      messages: [],
      newMessage: '',
      // Анти-дубль отправки: SMTP медленный, повторный Enter/клик не должен
      // слать копию письма (двойные сообщения у получателей, 20.08).
      sending: false,
      // Анти-дубль ПОСЛЕ завершения отправки: если тот же текст ушёл в этот
      // чат секунды назад (двойной Enter с паузой), повторную отправку
      // игнорируем — иначе получатели видят «одно сообщение дважды».
      lastSend: null,
      // Кэш тел писем (folder:uid -> body) — поллинг перерисовывает чат,
      // не перефетчивая и не расшифровывая повторно. Персистится в
      // localStorage (loadBodyCache/persistBodyCache) — после перезапуска
      // чат открывается без повторного фетча тел из IMAP.
      emailBodyCache: {},
      bodyCacheOrder: [],       // ключи кэша, старые первые (для trimming'а)
      bodyCacheSaveTimer: null, // debounce записи в localStorage
      // Токен загрузки: инкремент в selectChat/selectGroup. Медленный
      // loadMessages старого чата не должен перезаписать новый чат.
      loadSeq: 0,
      // Контекстное меню сообщения (копирование)
      messageMenu: null,
      replyTo: null,
      // Перетаскивание заметок (__notes__): ид заметки и цель drop.
      draggedNoteId: null,
      dragOverNoteId: null,
      dragOverPos: null, // 'before' | 'after'
      // Закреплённое сообщение группы (админ): id + превью для баннера.
      pinnedMsgId: null,
      pinnedPreview: '',
      // Стрелка «вниз к последним сообщениям» в длинных чатах.
      showJumpToBottom: false,
      // Сообщение, которое сейчас редактируется (только своё).
      editingMessage: null,
      showSettings: false,
      showMembers: false,
      isLoggedIn: false,
      restoringSession: false,
      email: '',
      password: '',
      rememberMe: true,
      loginLoading: false,
      loginError: '',
      // Настройки серверов почты в форме входа (провайдер может сменить
      // IMAP/SMTP — пользователь должен мочь исправить их вручную).
      showServerSettings: false,
      imapServer: '',
      imapPort: '',
      smtpServer: '',
      smtpPort: '',
      // Выбранный провайдер почты (каталог IMAP/SMTP в mailProviders.js).
      // '' = ещё не выбран; 'custom' = ручные поля.
      mailProvider: '',
      emails: [],
      emailsLoading: false,
      emailError: '',
      pollTimer: null,
      // Оптимистичные исходящие, ещё не подтверждённые письмом из ящика:
      // chatKey → { msgId: msg }. Поллинг перестраивает messages из IMAP и
      // стирал ещё не доставленное сообщение (оно «появлялось и исчезало»);
      // теперь mergePending подмешивает их обратно, пока копия письма не
      // придёт из Sent/All Mail — тогда реальное письмо заменяет запись.
      pendingOutgoing: {},
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
      groupAvatars: {},  // group_id → dataUrl (загруженный аватар группы)
      groupIconMap: {},  // group_id → эмодзи-иконка (выбор при создании)
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
      // Инвайты/запросы в обработке: пока идёт медленный SMTP, поллинг не
      // должен показать их повторно (ключи «group_id|uid» / «sender|uid»).
      handledInviteKeys: [],
      handledContactKeys: [],
      // Add-member popup (выбор контактов, мульти-выбор)
      showAddMemberPopup: false,
      addMemberQuery: '',
      addMemberSelected: [],
      // Список участников группы (модалка по клику на счётчик)
      showMembersList: false,
      // Полноэкранный просмотр изображения-вложения
      viewingImage: null,
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
      // Локальные переопределения имён/аватаров контактов (per-account):
      // пользователь может называть собеседника как удобно и ставить свой
      // аватар для него — это НЕ меняет реальные имя/аватар собеседника.
      localProfiles: {},
      showContactEdit: false,
      editingContact: null,
      editContactName: '',
      editContactAvatar: '',
      // User identity
      userId: null,
      // Typing indicators
      typingUsers: {},
      typingTimeout: null,
    }
  },
  computed: {
    // Мобильный режим: ширина экрана < 768px (портрет телефона).
    isMobile() {
      return this.windowWidth < 768;
    },
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
      return this.contacts.filter(c => {
        const lp = this.localProfileOf(c.email);
        const localName = (lp && lp.name) || '';
        return c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || localName.toLowerCase().includes(q);
      });
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
      // Уже в группе — не показываем: инвайтить их не нужно.
      const members = new Set((this.currentGroup?.members || []).map(m => m.email));
      for (const c of this.contacts) {
        if (!c.email || seen.has(c.email)) continue;
        if (members.has(c.email)) continue;
        seen.add(c.email);
        const name = c.name || c.email;
        if (!q || name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)) {
          list.push(c);
        }
      }
      return list;
    },
    activeChatName() {
      if (this.activeChat === '__notes__') return this.t('notes_self') || 'Заметки для себя';
      if (this.activeChatType === 'group') return this.currentGroup?.name || this.activeChat;
      if (!this.activeChat) return '';
      // Локальное имя контакта (если задано) — выше реального.
      const lp = this.localProfileOf(this.activeChat);
      if (lp && lp.name) return lp.name;
      const c = this.contacts.find(c => c.email === this.activeChat);
      return c ? c.name : this.activeChat;
    },
    // Я — админ текущей группы (создатель или назначенный админ). Управление
    // составом (добавление/удаление участников) и ролями — только у админов.
    isGroupAdmin() {
      if (this.activeChatType !== 'group' || !this.currentGroup) return false;
      if (this.currentGroup.created_by === this.email) return true;
      const me = (this.currentGroup.members || []).find(m => m.email === this.email);
      return !!(me && me.role === 'Admin');
    },
    // Профили с локальными переопределениями — для GroupSettings (список
    // участников группы тоже показывает локальные имена/аватары).
    mergedProfiles() {
      const merged = { ...this.profiles };
      for (const [email, lp] of Object.entries(this.localProfiles)) {
        merged[email] = { ...(merged[email] || {}), ...lp };
      }
      return merged;
    },
    // Каталог провайдеров для селекта в «Настройках сервера».
    mailProviders() {
      return MAIL_PROVIDERS;
    },
    customProviderId() {
      return CUSTOM_PROVIDER_ID;
    },
    // Подсказка выбранного провайдера (пароли приложений, региональные домены).
    mailProviderHint() {
      const p = findProvider(this.mailProvider);
      return (p && p.hint) || '';
    }
  },
  watch: {
    // Автоподбор провайдера по домену введённого email: пользователь вводит
    // kmakan@zoho.com — селект сам становится на Zoho, поля IMAP/SMTP
    // заполняются, вводить серверы вручную не нужно.
    email(val) {
      if (this.mailProvider) return; // уже выбран вручную — не переопределяем
      const id = detectProviderByEmail(val);
      if (id) this.applyMailProvider(id);
    }
  },
  async mounted() {
    applyTheme(loadSavedTheme())
    applyFont(loadSavedFont())
    // Мобильная навигация: следим за шириной окна (поворот телефона),
    // чтобы переключать одну-панель-за-раз.
    this.onWindowResize = () => {
      this.windowWidth = window.innerWidth;
      // В ландшафте/на десктопе обе панели видны — чат всегда «открыт».
      if (!this.isMobile) this.mobileChatOpen = false;
    };
    window.addEventListener('resize', this.onWindowResize);
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
    // Display name + кэш профилей (имя/аватар участников групп).
    this.displayName = (await api.getDisplayName()) || this.email || ''
    await this.loadProfiles()
    if (this.email) {
      this.userAvatarUrl = (this.profiles[this.email] || {}).avatar || ''
    }
    this.loadLocalProfiles()
    // Validate saved token
    if (api.token) {
      // Авто-вход: IMAP-сессия Rust умирает при перезапуске приложения, но
      // учётные данные почты зашифрованы на устройстве (device-ключ) —
      // восстанавливаем подключение без повторного ввода пароля.
      this.restoringSession = true;
      let restored = false;
      try { restored = await api.restoreSession(); } catch (e) { console.error('restoreSession error:', e); }
      if (!restored) {
        // Авто-вход не удался — показываем форму входа с объяснением,
        // чтобы пользователь мог исправить пароль/настройки серверов.
        this.showRestoreFailure();
        this.restoringSession = false;
      } else {
        try {
          // Восстанавливаем email в UI (при авто-входе форма не заполнялась,
          // а loadGroups/профили фильтруют по this.email).
          this.email = api.email || this.email;
          // Перечитываем всё, что привязано к email: в mounted() эти вызовы
          // отработали с пустым email (авто-вход ещё не восстановил его),
          // поэтому локальные имена контактов и свой аватар «пропадали»
          // после перезапуска.
          await this.initLocalDb(); // sqlite: tombstones + курсоры для аккаунта
          await this.loadProfiles(); // профили (имя/аватар) из kv_store
          this.userAvatarUrl = (this.profiles[this.email] || {}).avatar || '';
          this.displayName = (await api.getDisplayName()) || this.email || '';
          this.loadLocalProfiles(); // локальные имена/аватары контактов (per-account)
          await this.loadBodyCache(); // персистентный кэш тел — мгновенное открытие чатов
          await api.getChats();
          await this.loadContacts();
          await this.loadGroups();
          // Скорость входа: UI показывается СРАЗУ (история/кэши в памяти),
          // фетч почты идёт в фоне — вход не должен ждать IMAP (20.08).
          this.isLoggedIn = true;
          initNotifications().catch(() => {}); // push-уведомления (не блокирует вход)
          this.loadUnreadCounts(); // счётчики непрочитанных из sqlite kv_store
          this.startPolling()
          // Не блокируем вход: письма догружаются асинхронно (поллинг уже
          // запущен — он подхватит). Ошибки IMAP не роняют вход.
          this.loadEmails().catch(e => {
            if (String(e && e.message || e).toLowerCase().includes('not connected')) {
              this.showRestoreFailure();
            }
          });
        } catch (e) {
          // Session died on restart and auto-login could not restore it —
          // просим ввести пароль снова
          api.token = null;
          localStorage.removeItem('vault-token');
          this.showRestoreFailure();
        } finally {
          this.restoringSession = false;
        }
      }
    }
    await this.initCrypto()
  },
  beforeUnmount() {
    this.stopPolling()
  },
  methods: {
    // Мобильная навигация: открыть чат на весь экран (портрет телефона).
    openMobileChat() {
      if (this.isMobile) this.mobileChatOpen = true;
    },
    // Вернуться к списку чатов (кнопка «назад» в шапке чата).
    closeMobileChat() {
      this.mobileChatOpen = false;
    },
    // Плюрализация «участник/участника/участников» по текущей локали.
    // Вызывается из шаблона рядом со счётчиком участников.
    membersLabel(n) {
      const locale = String(this.currentLocale || 'en').slice(0, 2);
      if (locale === 'ru') {
        const m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return 'участник';
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'участника';
        return 'участников';
      }
      return n === 1 ? 'member' : 'members';
    },
    // Скачивание вложения (байты из base64 → Blob → file download)
    downloadAttachment(attachment) {
      if (!attachment || !attachment.data) return;
      downloadBase64(attachment.data, attachment.name, attachment.type);
    },
    // Полноэкранный просмотр изображения-вложения
    openImageViewer(attachment) {
      this.viewingImage = attachment;
    },
    closeImageViewer() {
      this.viewingImage = null;
    },
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
    // Авто-вход не удался: показываем форму входа с понятным сообщением и
    // предзаполняем email + сохранённые серверы (провайдер мог сменить
    // IMAP/SMTP — пользователь может исправить их в «Настройках сервера»).
    showRestoreFailure() {
      this.email = api.email || this.email;
      const reason = api.lastRestoreError;
      if (reason === 'auth') {
        this.loginError = this.t('restore_failed_auth') ||
          'Пара email/пароль не сработала: пароль был изменён или отозван. Введите пароль заново.';
      } else if (reason === 'network') {
        this.loginError = this.t('restore_failed_network') ||
          'Не удалось подключиться к почте: сервер недоступен или настройки IMAP/SMTP изменились. Проверьте интернет или откройте «Настройки сервера».';
      } else {
        this.loginError = this.t('restore_failed_generic') ||
          'Автоматический вход не удался. Войдите заново.';
      }
      // Предзаполняем сохранённые серверные настройки, чтобы их можно было
      // исправить прямо в форме входа.
      const c = api.savedConfig || {};
      this.imapServer = c.imap_server || '';
      this.imapPort = c.imap_port ? String(c.imap_port) : '';
      this.smtpServer = c.smtp_server || '';
      this.smtpPort = c.smtp_port ? String(c.smtp_port) : '';
      if (this.imapServer || this.smtpServer) this.showServerSettings = true;
      // Восстанавливаем селект провайдера по сохранённому IMAP-хосту,
      // чтобы пользователь видел, какой провайдер был выбран.
      this.mailProvider = detectProviderByServer(this.imapServer);
    },
    // Заполнить поля IMAP/SMTP из каталога провайдеров. Вызывается при выборе
    // провайдера в селекте и при автоподборе по домену email (watch: email).
    applyMailProvider(id) {
      this.mailProvider = id;
      const p = findProvider(id);
      if (!p) return; // 'custom' или пусто — поля остаются как есть
      this.imapServer = p.imap_server;
      this.imapPort = String(p.imap_port);
      this.smtpServer = p.smtp_server;
      this.smtpPort = String(p.smtp_port);
    },
    // Обработчик селекта: «Другой (вручную)» очищает поля для ручного ввода.
    onMailProviderChange() {
      if (this.mailProvider === CUSTOM_PROVIDER_ID) {
        this.imapServer = '';
        this.imapPort = '';
        this.smtpServer = '';
        this.smtpPort = '';
      } else {
        this.applyMailProvider(this.mailProvider);
      }
    },
    async login() {
      this.loginLoading = true;
      this.loginError = '';
      try {
        // Пользовательские настройки серверов (если заполнены) — иначе
        // дефолты Gmail внутри emailConnect.
        const config = {};
        if (this.imapServer.trim()) config.imap_server = this.imapServer.trim();
        if (this.imapPort.trim()) config.imap_port = parseInt(this.imapPort.trim(), 10);
        if (this.smtpServer.trim()) config.smtp_server = this.smtpServer.trim();
        if (this.smtpPort.trim()) config.smtp_port = parseInt(this.smtpPort.trim(), 10);
        const data = await api.login(this.email, this.password, { remember: this.rememberMe, config });
        this.userId = data.user_id;
        this.isLoggedIn = true;
        initNotifications().catch(() => {}); // push-уведомления (не блокирует вход)
        await this.initLocalDb(); // sqlite: tombstones + курсоры для аккаунта
        this.loadUnreadCounts(); // счётчики непрочитанных из sqlite kv_store (после initLocalDb)
        this.loadLocalProfiles(); // локальные имена/аватары контактов (per-account)
        await this.loadBodyCache(); // персистентный кэш тел — мгновенное открытие чатов
        await this.loadContacts();
        await this.loadGroups();
        // Скорость входа: UI сразу, фетч почты в фоне (не блокирует вход).
        this.startPolling()
        this.loadEmails().catch(e => {
          if (String(e && e.message || e).toLowerCase().includes('not connected')) {
            this.loginError = e.message;
          }
        });
      } catch (error) {
        this.loginError = error.message;
      } finally {
        this.loginLoading = false;
      }
    },
    async handleLogout() {
      this.stopPolling();
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
          // Аватар/иконка группы: sqlite kv_store — аватар устанавливает
          // админ, участникам он приходит письмами (см. конверт).
          const av = await db.kvGet('anon', 'group-avatar:' + g.id);
          if (av) this.groupAvatars[g.id] = av;
          const ic = await db.kvGet('anon', 'group-icon:' + g.id);
          if (ic) this.groupIconMap[g.id] = ic;
          for (const m of g.members || []) {
            if (m.email === this.email || seen.has(m.email)) continue;
            // Модель Delta Chat: удаление контакта НЕ трогает группы —
            // участник остаётся полноценным контактом в списке.
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
      // Сбрасываем чат сразу — иначе при медленной загрузке нового чата
      // пользователь видит сообщения предыдущего (одни и те же во всех чатах).
      this.messages = [];
      this.newMessage = '';
      this.cancelReply();
      // Мгновенное открытие: показываем кэш прошлой сессии, пока идёт
      // загрузка из IMAP. Свежие данные перезапишут кэш по завершении.
      const cachedChat = await this.loadChatCache(email);
      if (cachedChat && cachedChat.length) {
        cachedChat.sort((a, b) => this.msgTs(a) - this.msgTs(b));
        this.messages = cachedChat;
      }
      // Токен загрузки: незавершённый loadMessages прошлого чата увидит
      // новый seq и не применит свои результаты.
      this.loadSeq++;
      this.activeChat = email;
      this.activeChatType = 'chat';
      this.currentView = 'chats';
      this.resetUnread(email); // чат открыт — сбрасываем счётчик непрочитанных
      this.openMobileChat();
      if (this.peerKeys[email]) {
        crypto.setPeerPublicKey(this.peerKeys[email]);
      }
      // Если письма ещё не загружены (клик сразу после входа — поллинг идёт
      // раз в 30 сек), загружаем их немедленно, иначе чат выглядит пустым.
      if (this.emails.length === 0) {
        try {
          await this.loadEmails(true);
        } catch (e) { /* Not connected — тихий фолбэк */ }
      }
      await this.loadMessages(email);
      // Как в других мессенджерах: при открытии чата — сразу к последнему
      // сообщению (вниз).
      this.scrollToBottom(true);
    },
    // Прокрутка списка сообщений вниз. force=true — всегда (открытие чата,
    // своя отправка); force=false — только если пользователь уже у низа
    // (поллинг не должен выдёргивать из чтения истории).
    scrollToBottom(force = false) {
      this.$nextTick(() => {
        const el = this.$refs.messagesContainer;
        if (!el) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        if (force || nearBottom) {
          el.scrollTop = el.scrollHeight;
        }
      });
    },
    // Стрелка «вниз к последним сообщениям»: показываем, когда пользователь
    // ушёл от низа чата больше чем на 200px (поллинг/свои отправки его не
    // выдёргивают — только клик по стрелке).
    onMessagesScroll() {
      const el = this.$refs.messagesContainer;
      if (!el) return;
      this.showJumpToBottom = el.scrollHeight - el.scrollTop - el.clientHeight > 200;
    },
    jumpToBottom() {
      const el = this.$refs.messagesContainer;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      this.showJumpToBottom = false;
    },
    // --- Закрепление сообщения в группе (только админ) ---
    // Хранится в sqlite kv_store (pinned:<groupId>; последнее по дате — как
    // meta-аватар) + бродкастится письмом {pin:1, msg_id, action, preview}
    // под групповым ключом (stealth, пустая тема — единый проход
    // loadGroupMessages классифицирует по содержимому).
    async readPinned(groupId) {
      try {
        const raw = await db.kvGet('anon', 'pinned:' + groupId);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    async setPinnedState(groupId, pin) {
      if (pin && pin.msg_id) {
        await db.kvSet('anon', 'pinned:' + groupId, JSON.stringify({ msg_id: pin.msg_id, preview: pin.preview || '', ts: pin.ts || Date.now() }));
        this.pinnedMsgId = pin.msg_id;
        this.pinnedPreview = pin.preview || '';
      } else {
        await db.kvDelete('anon', 'pinned:' + groupId);
        this.pinnedMsgId = null;
        this.pinnedPreview = '';
      }
    },
    async applyPinFromWire(groupId, pin) {
      // Последний по дате pin-письмо авторитетно (unpin = пустой pin.msg_id).
      const cur = await this.readPinned(groupId);
      if (pin.ts && cur && cur.ts && Number(pin.ts) < Number(cur.ts)) return;
      if (!pin.msg_id) {
        await this.setPinnedState(groupId, null);
      } else {
        await this.setPinnedState(groupId, { msg_id: pin.msg_id, preview: pin.preview, ts: pin.ts });
      }
    },
    async pinGroupMessage(msg) {
      if (!this.isGroupAdmin || !this.currentGroup || !msg || !msg.id) return;
      const gid = this.currentGroup.id;
      const currentlyPinned = await this.readPinned(gid);
      const pinning = !(currentlyPinned && currentlyPinned.msg_id === msg.id);
      const pin = {
        msg_id: msg.id,
        action: pinning ? 'pin' : 'unpin',
        preview: String(msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        ts: Date.now(),
      };
      // Оптимистично применяем локально (SMTP-круг займёт десятки секунд).
      await this.setPinnedState(gid, pinning ? pin : null);
      try {
        const groupKey = this.groupKeys[gid] || (await api.getMyGroupKey(gid))?.group_key;
        if (!groupKey) return;
        const content = await crypto.encryptWithGroupKey(JSON.stringify({ pin: 1, msg_id: pin.msg_id, action: pin.action, preview: pin.preview, ts: pin.ts }), groupKey);
        await api.sendGroupMeta(gid, content);
      } catch (e) {
        console.error('pinGroupMessage failed:', e);
      }
    },
    unpinGroupMessage() {
      if (!this.isGroupAdmin || !this.currentGroup) return;
      this.pinGroupMessage({ id: this.pinnedMsgId, content: '' });
    },
    scrollPinnedToView() {
      const el = this.$refs.messagesContainer;
      if (!el) return;
      const t = el.querySelector('[data-msg-id="' + CSS.escape(this.pinnedMsgId) + '"]');
      if (!t) { this.jumpToBottom(); return; }
      el.scrollTo({ top: t.offsetTop - 24, behavior: 'smooth' });
    },
    // --- Персистентный кэш тел: SQLite (20.08 — localStorage запрещён) ---
    bodyCacheKey() { return 'vault-body-cache:' + (this.email || 'anon'); },
    chatCacheKey(chat) { return 'vault-chat-cache:' + (this.email || 'anon') + ':' + chat; },
    // Загрузка кэша тел писем из SQLite — вызывается после логина/восстановления
    // сессии. localStorage НЕ источник истины (юзер, 20.08).
    async loadBodyCache() {
      try {
        const rows = await db.bodyCacheLoadAll(this.email || 'anon');
        const bodies = {};
        const order = [];
        for (const [key, body] of rows || []) {
          bodies[key] = body;
          order.push(key);
        }
        this.emailBodyCache = bodies;
        this.bodyCacheOrder = order;
      } catch (e) {
        console.warn('loadBodyCache (sqlite) failed:', JSON.stringify(e), String(e));
        this.emailBodyCache = {};
        this.bodyCacheOrder = [];
      }
    },
    // Запись тела в кэш: SQLite (db_body_cache_set) + память. Лимит ~400 тел:
    // старые вытесняются (FIFO по bodyCacheOrder).
    cacheBody(key, body) {
      this.emailBodyCache[key] = body;
      const i = this.bodyCacheOrder.indexOf(key);
      if (i >= 0) this.bodyCacheOrder.splice(i, 1);
      this.bodyCacheOrder.push(key);
      while (this.bodyCacheOrder.length > 400) {
        const old = this.bodyCacheOrder.shift();
        delete this.emailBodyCache[old];
      }
      if (this.bodyCacheSaveTimer) clearTimeout(this.bodyCacheSaveTimer);
      this.bodyCacheSaveTimer = setTimeout(() => this.persistBodyCache(), 2000);
    },
    persistBodyCache() {
      // SQLite-персистенция (debounce сохранён в cacheBody): каждое тело — своя
      // строка body_cache(account, cache_key, body). localStorage не используется.
      const acc = this.email || 'anon';
      try {
        for (const k of Object.keys(this.emailBodyCache)) {
          db.bodyCacheSet(acc, k, this.emailBodyCache[k]).catch(() => {});
        }
      } catch (e) {
        // Кэш не критичен — молча пропускаем.
      }
    },
    // Кэш отрисованных сообщений чата (без тяжёлых полей email-объектов).
    // Хранится в SQLite kv_store (20.08 — localStorage запрещён как источник).
    async loadChatCache(chat) {
      try {
        const raw = await db.kvGet(this.email || 'anon', 'chat-cache:' + chat);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    saveChatCache(chat, list) {
      try {
        // email-объект письма не персистим (тяжёлый и не нужен для рендера).
        // attachment персистим: без него из кэша пропадают плеер аудио,
        // кнопка «скачать» и текст вложения (регрессия демо 17.08).
        const slim = (list || []).map(m => ({
          id: m.id, content: m.content, from: m.from, time: m.time,
          encrypted: m.encrypted, vault: m.vault, status: m.status,
          // ts нужен для сортировки кэша при мгновенном открытии чата
          // (кэш в sqlite может быть в порядке вставки — 20.08).
          ts: m.ts || this.msgTs(m) || undefined,
          reactions: m.reactions || undefined,
          deleted: m.deleted || undefined,
          edited: m.edited || undefined,
          // sender_id нужен групповому рендеру (аватар/имя отправителя над
          // чужим сообщением) — без него из кэша блок отправителя исчезал,
          // хотя при свежем фетче появлялся («аватарки то есть, то нет»).
          sender_id: m.sender_id || undefined,
          attachment: m.attachment || undefined,
        }));
        db.kvSet(this.email || 'anon', 'chat-cache:' + chat, JSON.stringify(slim)).catch(() => {});
      } catch (e) { /* quota — не критично */ }
    },
    // --- Оптимистичные исходящие (pendingOutgoing) ---
    // Отправка SMTP медленная (до минуты), а поллинг каждые 30 с перестраивает
    // messages из IMAP. Без этого сообщение «появлялось и исчезало» у
    // отправителя: оптимистичная запись стиралась, пока письмо не сделает
    // круг SMTP → ящик → INBOX/Sent. Здесь:
    //  - markPending: регистрируем оптимистичное сообщение;
    //  - mergePending: при перестроении списка подмешиваем ещё не
    //    подтверждённые записи (их нет в IMAP-списке), а подтверждённые
    //    (id уже отрисован из письма) — удаляем из реестра.
    markPending(chatKey, msg) {
      if (!msg || !msg.id) return;
      const bucket = this.pendingOutgoing[chatKey] || {};
      bucket[msg.id] = msg;
      this.pendingOutgoing = { ...this.pendingOutgoing, [chatKey]: bucket };
    },
    mergePending(chatKey, list) {
      const bucket = this.pendingOutgoing[chatKey];
      if (!bucket || !Object.keys(bucket).length) return list;
      const now = Date.now();
      const out = [...list];
      const seen = new Set(list.map(m => m.id));
      const remaining = {};
      for (const [id, msg] of Object.entries(bucket)) {
        if (seen.has(id)) continue; // письмо уже в списке — реальное заменило оптимистичное
        // Удалённое сообщение не возвращается из pending (tombstone).
        if (this.isTombstoned(id)) continue;
        // Страховка: не держим запись дольше 10 минут (если SMTP молча не
        // отправил письмо, сообщение не должно висеть «отправленным» вечно).
        // failed-записи (частичный фейл отправки) НЕ выкидываем — пользователь
        // должен видеть, что сообщение не дошло (фикс 20.08).
        if (msg.status !== 'failed' && msg._pendingAt && now - msg._pendingAt > 10 * 60 * 1000) continue;
        remaining[id] = msg;
        out.push(msg);
      }
      if (Object.keys(remaining).length) {
        this.pendingOutgoing = { ...this.pendingOutgoing, [chatKey]: remaining };
      } else {
        const copy = { ...this.pendingOutgoing };
        delete copy[chatKey];
        this.pendingOutgoing = copy;
      }
      // msgTs учитывает ts / email.date / created_at / _pendingAt — у групповых
      // сообщений и вложений нет email-объекта, сортировка по email.date давала
      // 0 и рвала хронологию (баг 20.08: «сообщения перестроились»).
      out.sort((a, b) => this.msgTs(a) - this.msgTs(b));
      return out;
    },
    // Удалённые сообщения не возвращаются в чат никогда: tombstone (msg_id
    // удалён навсегда) или deleted-метка из истории — фильтруются при
    // каждом построении чата (история + письма + pending). Message-ID
    // tombstones (mid) отсекают письма, вернувшиеся из другой папки/All
    // Mail с новым uid (DC-аналог rfc724_mid).
    filterDeleted(list) {
      const tombs = this.loadTombstones();
      const mids = this.loadMidTombstones();
      return (list || []).filter(m => m && !m.deleted && !(m.id && tombs.includes(m.id)) && !(m.mid && mids.includes(m.mid)));
    },
    // mergeHistory: чат = письма из IMAP (свежие) + ПОЛНАЯ локальная история
    // из IndexedDB. История — источник истины: отправленные/полученные
    // сообщения (с датами) остаются в чате навсегда, даже если письма ушли
    // за лимиты фетча, легли в спам или исчезли из ящика. Почта — только
    // транспорт: приносит НОВЫЕ письма, уже показанное не затирает (20.08).
    // Локальная история чата: SQLite (db.history_load) — единственный
    // источник. localStorage-копии НЕТ: WebKitGTK-localStorage ограничен
    // ~5 МБ (body-cache уже 3–7 МБ), история живёт в sqlite vault.db
    // (таблица chat_history) с 20.08 (фикс юзера).
    async loadLocalHistory(chatKey) {
      let hist = null;
      try {
        hist = await loadHistory(this.email, chatKey);
      } catch (e) { /* sqlite недоступен — чат откроется из писем */ }
      return this.normalizeStaleSending(hist);
    },
    // 'sending' — переходный статус, он не должен долго жить в истории: его
    // персистят оптимистично ДО отправки, а финальный пишут после. После
    // перезапуска промис отправки мёртв, и запись со старым 'sending' (>60 с)
    // вечно горела красным. Повышаем до 'sent' (письмо либо принято SMTP, либо
    // умерло вместе с процессом — квитанции получателей уточнят статус позже).
    normalizeStaleSending(hist) {
      if (!hist || !hist.length) return hist;
      const now = Date.now();
      for (const m of hist) {
        if (m && m.from === 'me' && m.status === 'sending') {
          const t = this.msgTs(m);
          if (t && now - t > 60 * 1000) m.status = 'sent';
        }
      }
      return hist;
    },
    // mergeHistory: ИСТОРИЯ — источник истины (сообщения, отправленные или
    // полученные когда-либо, остаются в чате навсегда, с датами), а письма
    // из IMAP только ДОБАВЛЯЮТ новое. Раньше было наоборот — чат каждый
    // поллинг перестраивался из писем: старые письма (за курсорами/лимитами)
    // выпадали, чат «мерцал» и рассинхронизировался между аккаунтами (20.08).
    async mergeHistory(chatKey, list) {
      const hist = await this.loadLocalHistory(chatKey);
      if (!hist || !hist.length) return list;
      const ids = new Set();
      for (const m of hist) if (m && m.id) ids.add(m.id);
      // Из писем добавляем только то, чего ещё нет в истории (новое).
      const extra = list.filter(m => m && m.id && !ids.has(m.id));
      // Сортировка ОБЯЗАТЕЛЬНА всегда: история в sqlite хранится в порядке
      // вставки (старые баги mergePending записывали её не по времени), и
      // возврат без сортировки показывал сообщения в порядке хранения (20.08:
      // «16:37 20:31 18:06 18:07 20:38»).
      if (!extra.length) {
        hist.sort((a, b) => this.msgTs(a) - this.msgTs(b));
        return this.filterDeleted(hist);
      }
      const merged = [...hist, ...extra];
      merged.sort((a, b) => this.msgTs(a) - this.msgTs(b));
      return this.filterDeleted(merged);
    },
    // Машинная временная метка сообщения для сортировки чата.
    msgTs(m) {
      if (!m) return 0;
      if (m.ts) return m.ts;
      if (m.email && m.email.date) return new Date(m.email.date).getTime();
      if (m.created_at) return new Date(m.created_at).getTime();
      // Оптимистичные исходящие (вложения/голос) персистились без ts —
      // только _pendingAt; без этого фолбэка они сортировались в начало (20.08).
      if (m._pendingAt) return m._pendingAt;
      return 0;
    },
    async selectGroup(group) {
      this.messages = [];
      this.newMessage = '';
      this.cancelReply();
      // Мгновенное открытие группы из кэша (как и 1-на-1 чаты).
      const cachedGroup = await this.loadChatCache(`group:${group.id}`);
      if (cachedGroup && cachedGroup.length) {
        cachedGroup.sort((a, b) => this.msgTs(a) - this.msgTs(b));
        this.messages = cachedGroup;
      }
      this.loadSeq++;
      this.activeChat = `group:${group.id}`;
      this.activeChatType = 'group';
      this.currentGroup = group;
      this.openMobileChat();
      this.resetUnread('group:' + group.id); // группа открыта — сбрасываем счётчик

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
      this.scrollToBottom(true);
    },
    // --- Заметки для себя (локальный чат, Session/Telegram pattern) ---
    // Хранятся ТОЛЬКО в localStorage (vault-notes-<email>), не шифруются,
    // не уходят по почте, работают офлайн и мгновенно.
    notesStoreKey() {
      return 'vault-notes-' + (this.email || 'anon');
    },
    loadNotes() {
      try {
        return JSON.parse(localStorage.getItem(this.notesStoreKey()) || '[]');
      } catch (e) {
        return [];
      }
    },
    saveNotes(list) {
      try {
        localStorage.setItem(this.notesStoreKey(), JSON.stringify(list));
        return true;
      } catch (e) {
        console.error('Failed to save notes:', e);
        return false;
      }
    },
    selectNotes() {
      this.messages = this.loadNotes();
      this.loadSeq++;
      this.activeChat = '__notes__';
      this.activeChatType = 'chat';
      this.currentGroup = null;
      this.openMobileChat();
      this.scrollToBottom(true);
    },
    // --- Перетаскивание заметок (__notes__): ручной порядок ---
    onNoteDragStart(e, msg) {
      this.draggedNoteId = msg.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', msg.id);
    },
    onNoteDragOver(e, msg) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!this.draggedNoteId || msg.id === this.draggedNoteId) {
        this.dragOverNoteId = null;
        this.dragOverPos = null;
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      this.dragOverNoteId = msg.id;
      this.dragOverPos = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
    },
    onNoteDragLeave(e, msg) {
      if (this.dragOverNoteId === msg.id) {
        this.dragOverNoteId = null;
        this.dragOverPos = null;
      }
    },
    onNoteDrop(e, msg) {
      e.preventDefault();
      const id = this.draggedNoteId || e.dataTransfer.getData('text/plain');
      this.draggedNoteId = null;
      const overId = this.dragOverNoteId;
      const pos = this.dragOverPos;
      this.dragOverNoteId = null;
      this.dragOverPos = null;
      if (!id || !overId || id === overId) return;
      const list = this.loadNotes();
      const from = list.findIndex(n => n.id === id);
      if (from < 0) return;
      const [moved] = list.splice(from, 1);
      const to = list.findIndex(n => n.id === overId);
      if (to < 0) { list.splice(from, 0, moved); return; }
      list.splice(pos === 'after' ? to + 1 : to, 0, moved);
      if (this.saveNotes(list)) this.messages = list;
    },
    // Parse message content — detect vault_attachment JSON and extract preview
    isTextMime(type, name) {
      if (type && (type.startsWith('text/') || /^(application\/(json|xml|javascript|x-sh)|application\/(x-)?(yaml|csv|markdown))$/.test(type))) return true;
      const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
      if (ext) {
        const textExts = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'sh', 'bash', 'zsh', 'py', 'js', 'ts', 'vue', 'html', 'css', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift', 'sql', 'env', 'gitignore', 'editorconfig'];
        if (textExts.includes(ext[1])) return true;
      }
      return false;
    },
    parseMessageContent(content) {
      if (!content || typeof content !== 'string') return { text: content, attachment: null };
      try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.vault_attachment) {
          const isImage = parsed.type && parsed.type.startsWith('image/');
          const isAudio = parsed.type && parsed.type.startsWith('audio/');
          // Текстовые файлы (text/*, json, md, csv...) показываем инлайн,
          // как картинки/аудио, а не только как файл для скачивания.
          const isText = !isImage && !isAudio && this.isTextMime(parsed.type, parsed.name);
          let textContent = '';
          if (isText) {
            try {
              textContent = atob(String(parsed.data || '').replace(/-/g, '+').replace(/_/g, '/'));
              try { textContent = decodeURIComponent(escape(textContent)); } catch { /* уже utf-8 */ }
            } catch { textContent = ''; }
            if (textContent.length > 8000) textContent = textContent.slice(0, 8000) + '\n…';
          }
          const label = isAudio
            ? `🎙️ ${parsed.name}`
            : (isImage ? `📎 ${parsed.name}` : `📎 ${parsed.name} (${(parsed.size / 1024).toFixed(1)}KB)`);
          return {
            text: label,
            attachment: { name: parsed.name, type: parsed.type, size: parsed.size, data: parsed.data, isImage, isAudio, isText, textContent },
          };
        }
      } catch { /* not JSON — plain text message */ }
      return { text: content, attachment: null };
    },
    // --- Конверт сообщения (метаданные ВНУТРИ шифра) ---
    // Формат: {"vault":1,"id":"<uuid>","text":"...","name":"...","avatar":"dataURL"}
    // Всё под E2E — провайдер видит только base64. Обратная совместимость:
    // не-JSON или vault!==1 = старый формат (простой текст).
    newMessageId() {
      try {
        // ВАЖНО: window.crypto — НЕ импортированный модуль crypto.js!
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      } catch (e) { /* fallback below */ }
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    },
    // Уменьшить аватар до 64x64 JPEG, если dataURL слишком большой (чтобы не
    // раздувать каждое письмо). НИКОГДА не возвращает '' для валидного аватара:
    // если сжатие не удалось/не помогло — отправляем оригинал (письмо стерпит
    // 200KB, а вот пустой аватар = собеседник никогда не увидит картинку).
    async shrinkAvatar(dataUrl) {
      if (!dataUrl) return '';
      if (dataUrl.length <= 8192) return dataUrl;
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 64, 64);
        const small = canvas.toDataURL('image/jpeg', 0.7);
        // Берём сжатый только если он реально получился и меньше оригинала.
        if (small && small.length > 0 && small.length < dataUrl.length) return small;
        return dataUrl; // сжатие не помогло — шлём оригинал, не роняем аватар
      } catch (e) {
        return dataUrl; // canvas недоступен — шлём оригинал, не роняем аватар
      }
    },
    // Обернуть текст в конверт перед шифрованием.
    async buildEnvelope(text) {
      const name = (await api.getDisplayName()) || this.email || '';
      let avatar = (this.profiles[this.email] || {}).avatar || '';
      const rawLen = avatar.length;
      avatar = await this.shrinkAvatar(avatar);
      return JSON.stringify({
        vault: 1,
        id: this.newMessageId(),
        text: text,
        name: name,
        avatar: avatar,
      });
    },
    // Распарсить расшифрованный конверт. null = старый формат (простой текст).
    parseEnvelope(decrypted) {
      if (!decrypted || typeof decrypted !== 'string') return null;
      try {
        const obj = JSON.parse(decrypted);
        if (obj && obj.vault === 1 && typeof obj.text === 'string') {
          return { id: obj.id || '', text: obj.text, name: obj.name || '', avatar: obj.avatar || '' };
        }
      } catch { /* not an envelope — legacy plaintext */ }
      return null;
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
    // Подпись (tooltip) к цветному кружку статуса исходящего сообщения.
    statusTitle(msg) {
      const st = (msg && msg.status) || 'sent';
      if (st === 'read') return this.t('status_read') || 'Read';
      if (st === 'delivered') return this.t('status_delivered') || 'Delivered';
      if (st === 'sending') return this.t('status_sending') || 'Sending';
      if (st === 'failed') {
        const who = msg.failedTo && msg.failedTo.length ? ': ' + msg.failedTo.join(', ') : '';
        return 'Not delivered' + who;
      }
      return this.t('status_sent') || 'Sent';
    },
    setReply(msg) {
      this.replyTo = msg;
    },
    cancelReply() {
      this.replyTo = null;
    },
    // --- Редактирование/удаление сообщений (только свои) ---
    startEditMessage(msg) {
      if (!msg || msg.from !== 'me' || msg.deleted) return;
      // Вложения редактировать нельзя — только текст.
      if (msg.attachment) return;
      this.editingMessage = msg;
      this.replyTo = null;
      // Редактируем только тело ответа; цитата "> ..." остаётся нетронутой
      // (раньше в поле попадал весь content с цитатой — правка её стирала).
      this.newMessage = this.replyBody(msg.content || '');
      this.$nextTick(() => {
        const input = this.$refs.messageInput;
        if (input && input.focus) input.focus();
      });
    },
    cancelEdit() {
      this.editingMessage = null;
      this.newMessage = '';
    },
    async deleteMessage(msg) {
      if (!msg || msg.from !== 'me' || msg.deleted) return;
      // Заметки для себя: удаляем заметку ПОЛНОСТЬЮ (никаких писем по почте
      // и «воскрешения» поллингом — заметки не читаются из IMAP).
      if (this.activeChat === '__notes__') {
        const ok = await confirm(this.t('delete_message_confirm') || 'Удалить заметку?');
        if (!ok) return;
        const list = this.loadNotes().filter(n => n.id !== msg.id);
        this.saveNotes(list);
        this.messages = list;
        return;
      }
      const ok = await confirm(this.t('delete_message_confirm') || 'Удалить сообщение у всех?');
      if (!ok) return;
      // Оптимистично помечаем удалённым локально + tombstone (поллинг
      // не «воскресит» сообщение: письмо-оригинал и история фильтруются).
      this.addTombstone(msg.id);
      this.addMidTombstone(msg.mid);
      msg.deleted = true;
      msg.content = '';
      // Мгновенно убираем из чата — удалённое сообщение исчезает у всех
      // (у получателей — после доставки delete-письма).
      const idx = this.messages.indexOf(msg);
      if (idx !== -1) this.messages.splice(idx, 1);
      const chatKey = this.activeChatType === 'group' && this.currentGroup
        ? 'group:' + this.currentGroup.id
        : this.activeChat;
      this.recordLocalEdit(chatKey, msg.id, null, 'delete');
      await this.sendEditEmail(msg.id, null, 'delete');
    },
    // Транспорт правок (паттерн sendReactionEmail):
    // 1-на-1 — encryptVault(JSON {edit:1,msg_id,text?,action}) с пустой темой;
    // группа — encryptWithGroupKey, письма VaultGroupEdit: <id>.
    sendEditEmail(msgId, text, action) {
      // Метки письма (аналог DC Chat-Edit/Chat-Delete + rfc724_mid, но в
      // зашифрованном теле — стелс): msg_id (сопоставление с оригиналом),
      // sender (проверка «автор оригинала» на стороне получателя), ts
      // (последняя по времени правка авторитетна).
      const payload = JSON.stringify({ edit: 1, msg_id: msgId, text: text || '', action, sender: this.email, ts: Date.now() });
      (async () => {
        try {
          if (this.activeChatType === 'group' && this.currentGroup) {
            const groupKey = this.groupKeys[this.currentGroup.id];
            if (!groupKey) return;
            const content = await crypto.encryptWithGroupKey(payload, groupKey);
            await api.sendGroupEdit(this.currentGroup.id, content);
          } else if (this.activeChat && this.peerKeys[this.activeChat]) {
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat]);
            const content = await crypto.encryptVault(payload);
            await api.sendEdit(this.activeChat, content);
          }
        } catch (e) {
          console.error('Failed to send edit email:', e);
        }
      })();
    },
    // Локальная история: мгновенный показ до живого фетча — чат открывается
    // без ожидания IMAP, история переживает перезапуск (IndexedDB + копия
    // в localStorage, см. loadLocalHistory).
    showHistoryFirst(chatKey, isStale) {
      return this.loadLocalHistory(chatKey).then(hist => {
        if (hist && hist.length && !isStale()) {
          // История в sqlite — в порядке вставки; показываем сразу по времени.
          hist.sort((a, b) => this.msgTs(a) - this.msgTs(b));
          this.messages = hist;
        }
      });
    },
    saveCurrentHistory(chatKey) {
      // SQLite (db.history_save) — единственный источник истории. Сбои
      // sqlite не критичны: чат пересоберётся из писем IMAP при поллинге.
      try {
        saveHistory(this.email, chatKey, this.messages);
      } catch (e) {
        console.warn('saveHistory (sqlite) failed:', e);
      }
    },
    async loadMessages(email) {
      // Токен загрузки: если пользователь уже переключился на другой чат,
      // результаты этого (медленного) фетча применять нельзя — иначе
      // сообщения прошлого чата перезапишут новый.
      const seq = this.loadSeq;
      const chat = email;
      const stale = () => seq !== this.loadSeq || this.activeChat !== chat;
      // Мгновенный показ локальной истории (если есть) до живого фетча.
      // ВАЖНО (20.08): await — история должна загрузиться ДО мержа, иначе
      // гонка с loadMessages: merged=[] без истории и saveCurrentHistory([])
      // затирал сохранённую историю → сообщения «пропадали» (kmakan).
      await this.showHistoryFirst(chat, stale);
      // Vault chat: only show mail FOR this contact, and only decrypt if we
      // hold their key (contact must be a Vault peer).
      if (!this.peerKeys[email]) {
        this.messages = [];
        return;
      }
      const relatedAll = this.emails
        .filter(m => {
          const f = (m.from || '').toLowerCase();
          const t = (m.to || '').toLowerCase();
          return f.includes(email.toLowerCase()) || t.includes(email.toLowerCase());
        })
        // Свежие сверху. Расшифровываем только последние 30: фетч тела идёт
        // по одному письму (с переключением папки) — на всю переписку это
        // минуты и чат выглядит пустым. Старая история — отдельная задача
        // (локальное хранилище, инкрементальный поиск с последнего письма).
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
        .slice(0, 30);
      // STEALTH: больше НЕ разделяем письма по теме. И сообщения, и реакции
      // 1-на-1 идут с ПУСТОЙ темой (см. api.sendMessage / sendReaction) —
      // провайдер не видит никаких Vault-маркеров. Классификация идёт по
      // расшифрованному содержимому: {react:1,...} = реакция, {vault:1,...}
      // = конверт сообщения, иначе = legacy-текст.
      const related = relatedAll;
      console.log('[loadMessages] email=' + email + ' emailsTotal=' + this.emails.length + ' related=' + related.length);
      if (related.length > 0) {
        crypto.setPeerPublicKey(this.peerKeys[email]);
        // Батч-фетч тел: группируем по папке и запрашиваем все тела одной
        // командой (Rust выбирает папку один раз). Поштучный фетч делал
        // чат пустым на минуту — теперь открытие чата почти мгновенно.
        const byFolder = {};
        for (const m of related) {
          const f = m.folder || 'INBOX';
          (byFolder[f] = byFolder[f] || []).push(m);
        }
        console.log('[loadMessages] byFolder=' + JSON.stringify(Object.keys(byFolder)));
        for (const [folder, msgs] of Object.entries(byFolder)) {
          // Пустое тело = ошибка фетча (IMAP-сессия вернула пусто при рассинхроне),
          // а НЕ валидный кэш. Такие письма не кэшируем и перефетчиваем каждый
          // поллинг — иначе инвайты/вложения/голосовые «застревают» пустыми
          // навсегда (так пропадали приглашения и аудио после гонки доставки).
          const missing = msgs.filter(m => {
            const b = this.emailBodyCache[`${folder}:${m.uid || m.id}`];
            return b === undefined || b === '';
          });
          console.log('[loadMessages] folder=' + folder + ' total=' + msgs.length + ' missing=' + missing.length);
          if (missing.length) {
            // Ошибка батча (IMAP-рассинхрон, одно пустое тело роняет весь
            // запрос в Rust) НЕ должна обнулять чат: без try/catch падал
            // весь loadMessages и чат застревал на slim-кэше без вложений
            // (регрессия демо 17.08 — получатель не видел сообщения).
            let bodies = {};
            try {
              bodies = await api.fetchEmailBodies(folder, missing.map(m => m.uid || m.id));
            } catch (e) {
              console.log('[loadMessages] fetchEmailBodies failed folder=' + folder + ' n=' + missing.length + ' err=' + (e && e.message || e));
            }
            console.log('[loadMessages] fetched bodies n=' + Object.keys(bodies).length);
            if (stale()) return;
            for (const m of missing) {
              const b = bodies[String(m.uid || m.id)];
              if (b) this.cacheBody(`${folder}:${m.uid || m.id}`, b);
            }
          }
        }
        // Единый проход: расшифровываем каждое письмо и классифицируем по
        // содержимому (реакция / правка / конверт / legacy-текст).
        const wireReactions = {}; // msg_id -> [{emoji, user, action}]
        const wireEdits = {}; // msg_id -> [{text, action, date}]
        // Квитанции получателя: {delivered:1|read:1, msg_ids:[...]} — для
        // меток статуса наших сообщений (🟢 доставлено / 🔵 просмотрено).
        const wireAcks = {}; // msg_id -> {delivered: bool, read: bool}
        const rendered = await Promise.all(related.map(async (m) => {
          const isOut = (m.from || '').toLowerCase().includes(email.toLowerCase());
          let content = m.subject || '(no subject)';
          let msgId = m.uid || m.id;
          let attachment = null;
          try {
            const cacheKey = (m.folder || 'INBOX') + ':' + (m.uid || m.id);
            const body = this.emailBodyCache[cacheKey] || '';
            // Vault messages carry a raw base64 body — decrypt with AAD="VAULT".
            // Only a message that authenticates as a vault message is shown in
            // the chat; anything else is treated as ordinary/foreign mail.
            if (this.cryptoReady) {
              let text;
              try {
                text = await crypto.decryptVault(body);
              } catch (de) {
                // Cannot authenticate/decrypt as a vault message — not ours.
                console.log('[decrypt fail] uid=' + (m.uid || m.id) + ' folder=' + (m.folder || 'INBOX') + ' err=' + (de && de.message || de));
                return null;
              }
              // 1) Реакция: {react:1, msg_id, emoji, action} — в чат не
              //    показываем, накапливаем для applyReactions.
              try {
                const robj = JSON.parse(text);
                if (robj && robj.react === 1 && robj.msg_id && robj.emoji) {
                  (wireReactions[robj.msg_id] = wireReactions[robj.msg_id] || []).push({
                    emoji: robj.emoji,
                    user: isOut ? email : this.email,
                    action: robj.action === 'remove' ? 'remove' : 'add',
                  });
                  return null; // не сообщение
                }
                // 1б) Правка: {edit:1, msg_id, text?, action:'edit'|'delete'} —
                //     накапливаем для applyEdits, в чат не показываем.
                if (robj && robj.edit === 1 && robj.msg_id) {
                  (wireEdits[robj.msg_id] = wireEdits[robj.msg_id] || []).push({
                    text: robj.text || '',
                    action: robj.action === 'delete' ? 'delete' : 'edit',
                    date: robj.ts || m.date || 0,
                    sender: robj.sender || (isOut ? email : (m.from || '')),
                  });
                  return null; // не сообщение
                }
                // 1в) Квитанции получателя: {delivered:1|read:1, msg_ids:[...]} —
                //     его клиент обработал (доставлено) / открыл (просмотрено)
                //     наши сообщения; накапливаем для меток статуса.
                if (robj && (robj.read === 1 || robj.delivered === 1) && Array.isArray(robj.msg_ids)) {
                  const level = robj.read === 1 ? 'read' : 'delivered';
                  for (const rid of robj.msg_ids) {
                    (wireAcks[rid] = wireAcks[rid] || {})[level] = true;
                  }
                  return null; // не сообщение
                }
              } catch (e) { /* не JSON — продолжаем как сообщение */ }
              // 2) Конверт {vault:1,id,text,name,avatar}: имя/аватар
              //    отправителя и стабильный id (для реакций).
              const env = this.parseEnvelope(text);
              if (env) {
                content = env.text;
                if (env.id) msgId = env.id;
                // Вложение внутри конверта: text = JSON {vault_attachment,...}
                // (файлы и голосовые идут этим путём).
                const pp = this.parseMessageContent(env.text);
                if (pp.attachment) {
                  attachment = pp.attachment;
                  content = pp.text;
                }
                // isOut=true = письмо прислал СОБЕСЕДНИК (см. from: isOut?'them':'me').
                // Аватар/имя в конверте принадлежат отправителю письма:
                //   входящее (isOut) -> собеседник (email), исходящее -> я (this.email).
                // Раньше было наоборот — входящий аватар сохранялся под МОИМ email,
                // поэтому avatarOf(собеседник) возвращал пусто (асимметрия аватаров).
                const sender = isOut ? email : this.email;
                if (env.name || env.avatar) {
                  api.saveProfile(sender, env.name, env.avatar);
                }
              } else {
                // 3) Legacy: простой текст (старые письма без конверта).
                const pp = this.parseMessageContent(text);
                content = pp.text || content;
                if (pp.attachment) {
                  attachment = pp.attachment;
                }
              }
            } else {
              // No crypto — not a vault message.
              return null;
            }
            return {
              id: msgId,
              content,
              attachment,
              from: isOut ? 'them' : 'me',
              time: m.date ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              encrypted: true,
              vault: true,
              mid: m.message_id || '',
              email: m,
            };
          } catch (e) {
            return {
              id: msgId,
              content,
              from: isOut ? 'them' : 'me',
              time: m.date ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              encrypted: false,
              mid: m.message_id || '',
              email: m,
            };
          }
        }));
        if (stale()) return;
        this.loadProfiles();
        // Дедупликация по id конверта: одно письмо может лежать в нескольких
        // папках (Rust дедуплицирует по Message-ID, но письма без заголовка
        // проскакивают дважды; плюс Sent-копии наших исходящих).
        const dedup = new Map();
        for (const r of rendered.filter(r => r && r.vault)) {
          if (!dedup.has(r.id)) dedup.set(r.id, r);
        }
        const list = [...dedup.values()].sort((a, b) => new Date(a.email?.date || 0) - new Date(b.email?.date || 0));
        // Статусы наших сообщений: квитанции получателя (delivered/read);
        // если квитанций нет, но письмо уже в ящике — круг через сервер
        // завершён, считаем доставленным.
        for (const m of list) {
          if (m.from !== 'me') continue;
          const ack = wireAcks[m.id];
          m.status = ack && ack.read ? 'read' : 'delivered';
        }
        // pending-записи отправителя: квитанции {read:1}/{delivered:1} снимают
        // 'failed'/'sent' → 'read'/'delivered' (фикс 20.08).
        const pb = this.pendingOutgoing[chat] || {};
        for (const [pid, pmsg] of Object.entries(pb)) {
          const ack = wireAcks[pid];
          if (!ack) continue;
          if (ack.read) pmsg.status = 'read';
          else if (ack.delivered) pmsg.status = 'delivered';
        }
        // ИСТОРИЯ — основа чата, письма — дополнение; статусы/реакции/правки
        // применяются к merged; pending — подмешиваются; удалённые фильтруются.
        const hadMessages = this.messages && this.messages.length > 0;
        const merged0 = await this.mergeHistory(chat, list);
        const statusById = new Map();
        for (const m of list) if (m.id && m.status) statusById.set(m.id, m.status);
        for (const m of merged0) {
          const st = statusById.get(m.id);
          if (st) m.status = st;
        }
        // Квитанции получателя — к СВОИМ сообщениям в истории (Sent не
        // читается, свои сообщения в `list` из IMAP не попадают; без этого
        // шага их статус после перезапуска не обновлялся — 20.08).
        for (const m of merged0) {
          if (m.from !== 'me' || !m.id) continue;
          const ack = wireAcks[m.id];
          if (ack && ack.read) m.status = 'read';
          else if (ack && ack.delivered) m.status = 'delivered';
        }
        this.applyReactions(merged0, chat, wireReactions);
        this.applyEdits(merged0, chat, wireEdits);
        const merged = this.filterDeleted(this.mergePending(chat, merged0));
        if (!merged.length && hadMessages && !stale()) {
          // Письма не пришли, но чат уже показан (кэш/история/оптимистичные)
          // — оставляем его, кэш не переписываем (иначе пустота затёрла бы
          // сохранённую историю чата).
          return;
        }
        this.messages = merged;
        // Персистим отрисованный чат: следующее открытие — мгновенно из кэша.
        this.saveChatCache(chat, this.messages);
        // Локальная история (IndexedDB) — полный архив чата.
        this.saveCurrentHistory(chat);
        // Открыли чат — шлём отправителю квитанции «просмотрено» по входящим.
        const incoming = this.messages.filter(m => m.from === 'them' && m.id).map(m => m.id);
        this.sendReadReceipts(incoming);
        return;
      }

      // Fallback: legacy backend path (groups, peer-key chats)
      // Фикс 19.08: если в фетче писем НЕТ (все старее лимитов/курсоров),
      // а локальная история чата уже показана (showHistoryFirst) — не
      // затираем её. Иначе после перезапуска чаты «пустели», хотя кэш
      // истории на месте (регрессия инкрементального фетча 5e9e4e6).
      if (this.messages && this.messages.length) return;
      try {
        const raw = await api.getMessages(email);
        if (stale()) return;
        if (this.cryptoReady && this.peerKeys[email]) {
          crypto.setPeerPublicKey(this.peerKeys[email]);
          const decrypted = await Promise.all(
            raw.map(async (msg) => {
              const { text, attachment } = this.parseMessageContent(msg.content);
              const base = {
                ...msg,
                content: text,
                from: this.isOwnSender(msg.sender_id) ? 'me' : 'them',
                time: new Date(msg.created_at).toLocaleTimeString(),
                status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
                attachment,
              };
              if (crypto.isEncrypted(msg.content)) {
                try {
                  const text = await crypto.decryptVault(msg.content);
                  const env = this.parseEnvelope(text);
                  if (env) {
                    const parsed = this.parseMessageContent(env.text);
                    return { ...base, id: env.id || base.id, content: parsed.text, attachment: parsed.attachment, encrypted: true };
                  }
                  const parsed = this.parseMessageContent(text);
                  return { ...base, content: parsed.text, attachment: parsed.attachment, encrypted: true };
                } catch {
                  return { ...base, encrypted: false };
                }
              }
              return { ...base, encrypted: false };
            })
          );
          if (stale()) return;
          this.messages = decrypted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        } else {
          this.messages = raw.map(msg => {
            const { text, attachment } = this.parseMessageContent(msg.content);
            return {
              ...msg,
              content: text,
              from: this.isOwnSender(msg.sender_id) ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: false,
              attachment,
            };
          }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        }
      } catch (error) {
        console.error('Failed to load messages:', error);
        if (!stale()) this.messages = [];
      }
    },
    async loadGroupMessages(groupId) {
      // Токен загрузки — см. loadMessages (защита от гонки переключения).
      const seq = this.loadSeq;
      const chat = 'group:' + groupId;
      const stale = () => seq !== this.loadSeq || this.activeChat !== chat;
      // Закреплённое сообщение группы — баннер виден сразу (без ожидания
      // поллинга), потом pin-письма из цикла ниже обновят его по дате.
      if (!stale()) {
        const pin = await this.readPinned(groupId);
        this.pinnedMsgId = (pin && pin.msg_id) || null;
        this.pinnedPreview = (pin && pin.preview) || '';
      }
      // Мгновенный показ локальной истории (если есть) до живого фетча.
      // ВАЖНО (20.08): await — история должна загрузиться ДО мержа, иначе
      // гонка с loadGroupMessages: merged=[] без истории и saveCurrentHistory
      // затирал сохранённую историю → сообщения «пропадали» (kmakan).
      await this.showHistoryFirst(chat, stale);
      try {
        const raw = await api.getGroupMessages(groupId, this.emails);
        if (stale()) return;
        let groupKey = this.groupKeys[groupId];
        // Гонка инициализации: группа могла открыться (или восстановиться
        // из кэша) до того, как crypto завершил initCrypto() — тогда в
        // selectGroup загрузка ключа была пропущена (guard `cryptoReady`),
        // и в памяти ключа нет, хотя группы.json уже содержит его. Догружаем
        // ключ прямо здесь, чтобы групповые сообщения не рендерились
        // шифротекстом (баг демо 17.08 — группа «Три» у koanmak).
        if (!groupKey && this.cryptoReady) {
          try {
            const kd = await api.getMyGroupKey(groupId);
            if (kd && kd.group_key) {
              this.groupKeys[groupId] = kd.group_key;
              groupKey = kd.group_key;
            }
          } catch (e) {
            console.warn('Could not lazily load group key:', e);
          }
        }

        // STEALTH-ГРУППЫ (18.08): у групповых писем темы ПУСТЫЕ (как в 1:1),
        // поэтому subject-фильтрации нет. getGroupMessages вернул ВСЕ письма,
        // чей отправитель — участник группы; здесь — единый проход:
        //   1) расшифровка групповым ключом (не расшифровалось = чужое
        //      письмо/1:1/инвайт — криптография сама отфильтровала);
        //   2) классификация по СОДЕРЖИМОМУ: реакция / правка / квитанция
        //      чтения / meta (аватар) / сообщение (конверт или legacy).
        const wireReactions = {}; // msg_id -> [{emoji, user, action}]
        const wireEdits = {}; // msg_id -> [{text, action, date}]
        const wireAcks = {}; // msg_id -> {email участника: true}
        const decrypted = [];
        let metaLatest = null; // {avatar, created_at} — последний по дате
        if (groupKey) {
          for (const msg of raw || []) {
            if (!crypto.isEncrypted(msg.content)) continue; // не наше
            let plaintext;
            try {
              plaintext = await crypto.decryptWithGroupKey(msg.content, groupKey);
            } catch (e) {
              continue; // расшифровка не прошла — письмо не из этой группы
            }
            let obj = null;
            try { obj = JSON.parse(plaintext); } catch { /* не JSON */ }
            if (obj && obj.react === 1 && obj.msg_id && obj.emoji) {
              (wireReactions[obj.msg_id] = wireReactions[obj.msg_id] || []).push({
                emoji: obj.emoji,
                user: msg.sender_id,
                action: obj.action === 'remove' ? 'remove' : 'add',
              });
              continue; // реакция не рендерится как сообщение
            }
            if (obj && obj.edit === 1 && obj.msg_id) {
              (wireEdits[obj.msg_id] = wireEdits[obj.msg_id] || []).push({
                text: obj.text || '',
                action: obj.action === 'delete' ? 'delete' : 'edit',
                date: obj.ts || msg.created_at || 0,
                sender: obj.sender || msg.sender_id || '',
              });
              continue; // правка не рендерится как сообщение
            }
            if (obj && obj.read === 1 && Array.isArray(obj.msg_ids)) {
              for (const rid of obj.msg_ids) {
                (wireAcks[rid] = wireAcks[rid] || {})[msg.sender_id] = true;
              }
              continue; // квитанция не рендерится как сообщение
            }
            // 1г) Закрепление: {pin:1, msg_id, action:'pin'|'unpin', preview,
            //     ts} — последнее по ts авторитетно; не рендерится.
            if (obj && obj.pin === 1 && obj.msg_id) {
              const ts = obj.ts || Date.parse(msg.created_at || 0) || 0;
              await this.applyPinFromWire(groupId, {
                msg_id: obj.action === 'unpin' ? null : obj.msg_id,
                preview: obj.preview || '',
                ts,
              });
              continue;
            }
            if (obj && obj.meta === 1 && obj.avatar) {
              if (!metaLatest || new Date(msg.created_at) >= new Date(metaLatest.created_at)) {
                metaLatest = { avatar: obj.avatar, created_at: msg.created_at };
              }
              continue; // meta (аватар) не рендерится как сообщение
            }
            // Сообщение: конверт {vault:1,id,text,name,avatar} или legacy-текст.
            const env = this.parseEnvelope(plaintext);
            if (env) {
              if ((env.name || env.avatar) && msg.sender_id) {
                api.saveProfile(msg.sender_id, env.name, env.avatar);
              }
              plaintext = env.text; // содержимое конверта
            }
            const { text, attachment } = this.parseMessageContent(plaintext);
            decrypted.push({
              ...msg,
              content: text,
              attachment,
              from: this.isOwnSender(msg.sender_id) ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: true,
              mid: msg.message_id || '',
              ...(env && env.id ? { id: env.id } : {}),
            });
          }
          if (stale()) return;
          // Мета-обновления группы (аватар): последнее по дате — авторитетно.
          if (metaLatest && metaLatest.avatar !== (await db.kvGet('anon', 'group-avatar:' + groupId))) {
            await db.kvSet('anon', 'group-avatar:' + groupId, metaLatest.avatar);
            this.groupAvatars[groupId] = metaLatest.avatar;
          }
          this.loadProfiles();
          // Дедупликация по id конверта: sendGroupMessage шлёт каждому
          // участнику отдельное письмо, поэтому в Sent отправителя лежит
          // N−1 копий одного сообщения — все расшифровываются в один
          // конверт с одинаковым id. Без дедупликации отправитель видел
          // дубли (у получателя копия одна — дубля не было).
          const dedup = new Map();
          for (const m of decrypted) {
            if (!dedup.has(m.id)) dedup.set(m.id, m);
          }
          const list = [...dedup.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          // Статусы наших сообщений: письмо уже в ящике = доставлено;
          // квитанции {read:1} от участников = просмотрено.
          for (const m of list) {
            if (m.from !== 'me') continue;
            const acks = wireAcks[m.id];
            m.status = acks && Object.keys(acks).length ? 'read' : 'delivered';
          }
          // pending-записи отправителя (свою копию он не получает — живут
          // только в pendingOutgoing): квитанции {read:1} участников снимают
          // 'failed'/'sent' → 'read' (фикс 20.08).
          const pb = this.pendingOutgoing[chat] || {};
          for (const [pid, pmsg] of Object.entries(pb)) {
            const ack = wireAcks[pid];
            if (ack && Object.keys(ack).length) pmsg.status = 'read';
          }
          // История — основа чата, письма добавляют новое (mergeHistory).
          // Статусы/реакции/правки — к итоговому списку (в истории старые
          // статусы, письмо приносит свежий).
          const hadMessages = this.messages && this.messages.length > 0;
          const merged0 = await this.mergeHistory(chat, list);
          const statusById = new Map();
          for (const m of list) if (m.id && m.status) statusById.set(m.id, m.status);
          for (const m of merged0) {
            const st = statusById.get(m.id);
            if (st) m.status = st;
          }
          // Квитанции «прочитано» от участников — к СВОИМ сообщениям в истории.
          // У отправителя группы нет самокопии письма (Sent не читается), его
          // сообщения живут только в истории и в `list` из IMAP не попадают,
          // поэтому без этого шага их статус после перезапуска не обновлялся
          // до 'read' (20.08: «красный, хотя дошло до всех»).
          for (const m of merged0) {
            if (m.from !== 'me' || !m.id) continue;
            const acks = wireAcks[m.id];
            if (acks && Object.keys(acks).length) m.status = 'read';
          }
          this.applyReactions(merged0, chat, wireReactions);
          this.applyEdits(merged0, chat, wireEdits);
          const merged = this.filterDeleted(this.mergePending(chat, merged0));
          if (!merged.length && hadMessages && !stale()) {
            return;
          }
          this.messages = merged;
          this.saveChatCache(chat, this.messages);
          // Локальная история (IndexedDB) — полный архив группы.
          this.saveCurrentHistory(chat);
          // Открыли группу — шлём участникам квитанции «просмотрено» по входящим.
          const incoming = this.messages.filter(m => m.from === 'them' && m.id).map(m => m.id);
          this.sendReadReceipts(incoming);
        } else {
          // No group key — show as-is (unencrypted)
          this.messages = raw.map(msg => {
            const { text, attachment } = this.parseMessageContent(msg.content);
            return {
              ...msg,
              content: text,
              from: this.isOwnSender(msg.sender_id) ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: false,
              attachment,
            };
          }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        }
      } catch (error) {
        console.error('Failed to load group messages:', error);
        if (!stale()) this.messages = [];
      }
    },
    // Мета-письма групп (VaultGroupMeta: <id>, аватар от админа) — для ВСЕХ
    // групп, где мы участники, а не только для открытой. Вызывается из
    // loadEmails (поллинг): участник, не открывавший группу после смены
    // аватара, всё равно получает его (sidebar + шапка при следующем
    // открытии). Расшифровка — групповым ключом, как в loadGroupMessages.
    // Список писем НЕ фетчим заново: берём уже загруженный this.emails
    // (loadEmails вызвал fetchEmails выше) — только тела новых meta-писем
    // подтягиваются по одному. Применённый uid кэшируем в localStorage,
    // чтобы не перечитывать одно и то же письмо на каждом поллинге.
    async syncGroupAvatarsFromMeta() {
      if (!this.isLoggedIn || !this.groups || !this.groups.length) return;
      const emails = this.emails || [];
      for (const g of this.groups) {
        if (!g || !g.id) continue;
        // STEALTH (18.08): тема пустая, поэтому meta-письмо ищем по
        // отправителю — участнику группы (как getGroupMessages).
        const members = (g.members || [])
          .map(m => String(m.email || '').toLowerCase())
          .filter(Boolean);
        // Ищем meta-письмо среди ПОСЛЕДНИХ писем участников (не только
        // самое последнее): после загрузки аватара могло прийти обычное
        // сообщение, и `latest` перестал быть meta-письмом — участники
        // навсегда оставались без аватара. Проверяем до 10 последних.
        const memberMails = emails
          .filter(m => {
            const from = String(m.from || '').toLowerCase();
            return members.some(e => from.includes(e));
          })
          .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
          .slice(0, 10);
        const appliedKey = 'group-meta-applied:' + g.id;
        const alreadyApplied = new Set(
          ((await db.kvGet('anon', appliedKey)) || '').split(',').filter(Boolean)
        );
        let metaFound = false;
        for (const latest of memberMails) {
          const appliedSig = String(latest.uid) + '@' + (latest.folder || 'INBOX');
          if (alreadyApplied.has(appliedSig)) continue;
          let groupKey = this.groupKeys[g.id];
          if (!groupKey && this.cryptoReady) {
            try {
              const kd = await api.getMyGroupKey(g.id);
              if (kd && kd.group_key) {
                this.groupKeys[g.id] = kd.group_key;
                groupKey = kd.group_key;
              }
            } catch (e) { /* ключ не загрузился — группу пропускаем */ }
          }
          if (!groupKey) break;
          try {
            const body = await api.fetchEmailBody('local', latest.uid, latest.folder);
            if (!body || !crypto.isEncrypted(body)) continue;
            const plaintext = await crypto.decryptWithGroupKey(body, groupKey);
            const obj = JSON.parse(plaintext);
            if (obj && obj.meta === 1 && obj.avatar) {
              if ((await db.kvGet('anon', 'group-avatar:' + g.id)) !== obj.avatar) {
                await db.kvSet('anon', 'group-avatar:' + g.id, obj.avatar);
                this.groupAvatars[g.id] = obj.avatar;
              }
              metaFound = true;
              alreadyApplied.add(appliedSig);
              await db.kvSet('anon', appliedKey, [...alreadyApplied].join(','));
              break; // аватар найден — хватит
            }
          } catch (e) { /* не meta или битое — не критично */ }
        }
      }
    },
    async onAvatarUpdate(dataUrl) {
      this.userAvatarUrl = dataUrl
      // Сохраняем свой профиль в kv_store, чтобы имя/аватар отображались и у других.
      if (!this.profiles[this.email]) this.profiles[this.email] = {};
      this.profiles[this.email].avatar = dataUrl || '';
      await api.saveProfile(this.email, this.displayName || this.email, dataUrl || '')
      this.loadProfiles()
    },
    // Аватар группы обновил админ (GroupSettings): сохраняем локально и
    // рассылаем участникам meta-письмо (шифр групповым ключом) — как реакции.
    async onGroupAvatarUpdate({ groupId, avatar }) {
      this.groupAvatars[groupId] = avatar;
      await db.kvSet('anon', 'group-avatar:' + groupId, avatar || '');
      if (!avatar) return;
      // Ключ группы мог быть ещё не загружен (настройки открыты без чата) —
      // тогда `if (!groupKey) return` выше МОЛЧА пропускал рассылку и у
      // участников аватар не появлялся никогда. Догружаем ключ (как в
      // selectGroup) и шлём meta-письма в любом случае.
      let groupKey = this.groupKeys[groupId];
      if (!groupKey && this.cryptoReady) {
        try {
          const kd = await api.getMyGroupKey(groupId);
          if (kd && kd.group_key) {
            this.groupKeys[groupId] = kd.group_key;
            groupKey = kd.group_key;
          }
        } catch (e) {
          console.warn('Could not load group key for avatar broadcast:', e);
        }
      }
      if (!groupKey) return;
      try {
        const payload = JSON.stringify({ meta: 1, avatar });
        const content = await crypto.encryptWithGroupKey(payload, groupKey);
        await api.sendGroupMeta(groupId, content);
      } catch (e) {
        console.error('Failed to broadcast group avatar:', e);
      }
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
        // Аватар — данные: sqlite kv_store, не localStorage.
        api.setAvatar(this.email, ev.target.result).catch(() => {});
        if (!this.profiles[this.email]) this.profiles[this.email] = {};
        this.profiles[this.email].avatar = ev.target.result;
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
      // typing-индикатор: транспорт появится на M3 (ws.js удалён 16.08)
    },
    async sendMessage() {
      if (!this.newMessage.trim()) return;
      // Анти-дубль: пока идёт отправка (SMTP медленный), повторный Enter/клик
      // игнорируем — иначе уходит 2+ письма с разными id и получатели видят
      // «одно сообщение несколько раз».
      if (this.sending) return;
      // Анти-дубль ПОСЛЕ отправки: двойной Enter с паузой (первая отправка
      // уже завершилась) — тот же текст в тот же чат в течение 30 секунд
      // не отправляется повторно (фикс 20.08: «сообщение отправляется не
      // один раз»).
      const chatId = this.activeChatType === 'group' && this.currentGroup
        ? 'group:' + this.currentGroup.id
        : this.activeChat;
      const text = this.newMessage.trim();
      if (this.lastSend && this.lastSend.chat === chatId && this.lastSend.text === text
          && Date.now() - this.lastSend.ts < 30000) {
        console.log('[sendMessage] duplicate ignored (same text sent recently)');
        return;
      }
      this.lastSend = { chat: chatId, text, ts: Date.now() };

      // Режим редактирования: вместо нового сообщения отправляем правку
      // существующего (edit-письмо), обновляем локально и выходим.
      if (this.editingMessage) {
        const msg = this.editingMessage;
        const newText = this.newMessage.trim();
        this.cancelEdit();
        const oldBody = this.replyBody(msg.content || '');
        if (!newText || newText === oldBody) return;
        // Цитата "> ..." сохраняется: правка заменяет только тело ответа,
        // а в edit-письмо и локальную запись идёт полный content.
        const quote = this.replyQuote(msg.content || '');
        const fullText = quote ? `> ${quote}\n\n${newText}` : newText;
        msg.content = fullText;
        msg.edited = true;
        const chatKey = this.activeChatType === 'group' && this.currentGroup
          ? 'group:' + this.currentGroup.id
          : this.activeChat;
        this.recordLocalEdit(chatKey, msg.id, fullText, 'edit');
        this.sendEditEmail(msg.id, fullText, 'edit');
        return;
      }

      try {
        this.sending = true;
        // Watchdog (20.08): если отправка зависла (SMTP/IMAP не ответил в
        // таймаут, JS-ошибка вне try), sending должен разблокироваться —
        // иначе кнопка/Enter навсегда блокируются, сообщение «висит» в поле.
        clearTimeout(this._sendingWatchdog);
        this._sendingWatchdog = setTimeout(() => { this.sending = false; }, 60000);
        // If replying, prefix the message with a "> quote" block (kept in plaintext —
        // the whole thing is still enclosed in the vault AAD-encrypted payload below).
        let payload = this.newMessage;
        if (this.replyTo) {
          const quote = this.replyPreview(this.replyTo);
          if (quote) payload = `> ${quote}\n\n${this.newMessage}`;
        }
        // Очищаем поле и ответ СРАЗУ — SMTP медленный (30–60 с), UI не должен
        // ждать завершения отправки, чтобы поле опустело.
        this.newMessage = '';
        this.cancelReply();

        let content = payload;

        // Заметки для себя: локальная запись без почты и шифрования.
        if (this.activeChat === '__notes__') {
          const note = {
            id: 'note-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            content: payload,
            from: 'me',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            encrypted: false,
            vault: false,
            status: 'sent',
            _notes: true,
          };
          const list = this.loadNotes();
          list.push(note);
          if (!this.saveNotes(list)) {
            list.pop();
            this.messages = [...list];
            alert('Локальное хранилище заметок переполнено — заметка не сохранена.');
            return;
          }
          this.messages = [...list];
          this.scrollToBottom(true);
          return;
        }

        // Конверт {vault:1,id,text,name,avatar} — метаданные отправителя
        // (имя/аватар) и стабильный id сообщения внутри шифра.
        const envelope = await this.buildEnvelope(payload);
        const envelopeId = (() => { try { return JSON.parse(envelope).id; } catch (e) { return ''; } })();

        if (this.activeChatType === 'group') {
          // Group message — encrypt with group key; never send plaintext without it
          let groupKey = this.groupKeys[this.currentGroup.id];
          // Lazy-backfill: ключ мог не загрузиться (гонка cryptoReady/selectGroup).
          if (!groupKey && this.cryptoReady) {
            try {
              const kd = await api.getMyGroupKey(this.currentGroup.id);
              if (kd && kd.group_key) {
                this.groupKeys[this.currentGroup.id] = kd.group_key;
                groupKey = kd.group_key;
              }
            } catch (e) { /* не удалось — alert ниже */ }
          }
          if (!groupKey) {
            alert('Групповой ключ не загружен — переоткройте группу');
            return;
          }
          content = await crypto.encryptWithGroupKey(envelope, groupKey);
          // Оптимистичный показ (как в 1-на-1): Gmail SMTP отвечает медленно,
          // а немедленная перезагрузка чата стирала ещё не доставленное
          // сообщение — выглядело как будто ответ/сообщение не отправилось.
          // Запись регистрируется в pendingOutgoing: поллинг подмешивает её
          // обратно, пока письмо не сделает круг через ящик (mergePending).
          const pendingMsg = {
            id: envelopeId || ('local-' + Date.now()),
            content: payload,
            from: 'me',
            sender_id: this.email,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ts: Date.now(),
            encrypted: true,
            vault: true,
            status: 'sending',
            _pendingAt: Date.now(),
          };
          this.messages.push(pendingMsg);
          this.markPending('group:' + this.currentGroup.id, pendingMsg);
          // Своё исходящее ПЕРСИСТИМ сразу (как Delta Chat пишет в msgs при
          // отправке): отображение НЕ зависит от Sent-копии в ящике, которую
          // пользователь может удалить. История = источник своих сообщений.
          this.saveCurrentHistory('group:' + this.currentGroup.id);
          try {
            const res = await api.sendGroupMessage(this.currentGroup.id, content);
            // Частичный фейл (SMTP одного из участников): статус 'failed'
            // (красный) — сообщение остаётся в чате и НЕ исчезает через
            // 10 минут (mergePending уважает failed-записи). Полный успех —
            // «отправлено» (до «доставлено» ждём квитанции получателей).
            if (res && res.failed && res.failed.length) {
              pendingMsg.status = 'failed';
              pendingMsg.failedTo = res.failed;
              console.error('Group message not delivered to:', res.failed.join(', '));
            } else {
              pendingMsg.status = 'sent';
            }
          } catch (e) {
            pendingMsg.status = 'failed';
            pendingMsg.failedTo = [e && e.message || String(e)];
            console.error('Failed to send group message:', e);
          }
          // Персистим обновлённый статус в pendingOutgoing (иначе поллинг
          // подмешивал бы запись со старым 'sending'). И в историю — иначе
          // showHistoryFirst после перезапуска покажет 'sending' (20.08:
          // у групп нет самокопии письма, которая заменила бы pending).
          const bucket = this.pendingOutgoing['group:' + this.currentGroup.id];
          if (bucket && bucket[pendingMsg.id]) {
            bucket[pendingMsg.id] = pendingMsg;
            this.pendingOutgoing = { ...this.pendingOutgoing, ['group:' + this.currentGroup.id]: bucket };
          }
          this.saveCurrentHistory('group:' + this.currentGroup.id);
        } else {
          // Regular chat message
          if (this.cryptoReady && this.peerKeys[this.activeChat]) {
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat]);
            // Encrypt as a vault message (AAD="VAULT") so the peer can recognize
            // and authenticate it as ours.
            content = await crypto.encryptVault(envelope);
          }
          // Оптимистично показываем своё сообщение сразу: SMTP Gmail отвечает
          // медленно (до минуты), ждать отправку в UI не нужно. Запись
          // регистрируется в pendingOutgoing: поллинг подмешивает её обратно,
          // пока письмо не сделает круг через ящик (mergePending).
          const pendingMsg = {
            id: envelopeId || ('local-' + Date.now()),
            content: payload,
            from: 'me',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ts: Date.now(),
            encrypted: true,
            vault: true,
            status: 'sending',
            _pendingAt: Date.now(),
          };
          this.messages.push(pendingMsg);
          this.markPending(this.activeChat, pendingMsg);
          // Своё исходящее ПЕРСИСТИМ сразу (как Delta Chat пишет в msgs при
          // отправке): отображение НЕ зависит от Sent-копии в ящике, которую
          // пользователь может удалить. История = источник своих сообщений.
          this.saveCurrentHistory(this.activeChat);
          try {
            await api.sendMessage(this.activeChat, content);
            // SMTP принял письмо — «отправлено» (до «доставлено» ждём круг
            // через ящик: его подтвердит поллинг).
            pendingMsg.status = 'sent';
          } catch (e) {
            // ФИКС 20.08: при фейле отправки помечаем 'failed' (красный) и
            // персистим — раньше статус навсегда оставался 'sending',
            // а через 10 минут запись молча исчезала.
            pendingMsg.status = 'failed';
            pendingMsg.failedTo = [e && e.message || String(e)];
            console.error('Failed to send message:', e);
          }
          const bucket = this.pendingOutgoing[this.activeChat];
          if (bucket && bucket[pendingMsg.id]) {
            bucket[pendingMsg.id] = pendingMsg;
            this.pendingOutgoing = { ...this.pendingOutgoing, [this.activeChat]: bucket };
          }
          // Персистим финальный статус в историю (иначе после перезапуска
          // запись со старым 'sending' горела красным — 20.08).
          this.saveCurrentHistory(this.activeChat);
        }

        // Своё сообщение — всегда прокручиваем вниз.
        this.scrollToBottom(true);
      } catch (error) {
        alert('Failed to send message: ' + error.message);
      } finally {
        this.sending = false;
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
    async addPeerKey(payload) {
      try {
        // QRCodePanel шлёт {publicKey, email} (email из QR v2); старый формат —
        // просто hex-строка (ручная вставка ключа без email).
        const publicKeyHex = typeof payload === 'string' ? payload : (payload && payload.publicKey) || '';
        const knownEmail = (typeof payload === 'object' && payload && payload.email) ? String(payload.email).trim().toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
          alert('Invalid public key format');
          return;
        }
        // QR v2 несёт email контакта — ручной ввод не нужен. Для голого ключа
        // (вставка hex) спрашиваем email: peerKeys индексируется по email.
        let email = knownEmail;
        if (!email || !email.includes('@')) {
          email = await prompt('Email контакта?');
        }
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
    // Per-folder UID-курсоры для инкрементального фетча. Хранятся в sqlite
    // (initLocalDb загружает их в cursorsCache при входе) — localStorage
    // больше не источник истины.
    imapCursorsKey(accountId) {
      return 'vault-imap-cursors-' + accountId;
    },
    loadCursors(accountId) {
      return this.cursorsCache || {};
    },
    saveCursors(accountId, cursors) {
      try {
        if (cursors && Object.keys(cursors).length) {
          this.cursorsCache = cursors;
          db.cursorsSave(accountId, JSON.stringify(cursors));
        }
      } catch (e) {
        console.error('saveCursors failed:', e);
      }
    },
    async loadEmails(silent = false) {
      if (!silent) {
        this.emailsLoading = true;
        this.emailError = '';
      }
      try {
        const accounts = await api.getEmailAccounts();
        // Не сбрасываем this.emails в начале: пока фетч идёт (или падает),
        // старый список остаётся в UI — клик по чату не видит пустоту.
        // ПЕРСИСТ (20.08): this.emails восстанавливается из sqlite при входе
        // (первый вызов в сессии) — иначе письма ниже курсоров терялись при
        // перезапуске и чаты без истории были пустыми (icemaksim).
        if (!silent && this.emails.length === 0) {
          try {
            const stored = await db.emailsLoad(accounts[0] ? accounts[0].id : (this.email || 'anon'));
            if (Array.isArray(stored) && stored.length) {
              this.emails = stored.map(e => ({
                uid: e.uid,
                id: e.uid,
                from: e.from,
                to: e.to,
                subject: e.subject,
                date: e.date,
                is_read: e.is_read,
                folder: e.folder,
                message_id: e.message_id || '',
              }));
            }
          } catch (e) {
            console.warn('loadEmails: sqlite restore failed:', e);
          }
        }
        const fetched = [];
        for (const account of accounts) {
          try {
            // Инкрементальный фетч (M1): только письма новее per-folder
            // UID-курсоров. Первый запуск (нет курсоров) — полный скан
            // последних писем + инициализация курсоров. Раньше каждые 30с
            // пересканировались последние 50-100 писем каждой папки — это
            // и лишний трафик, и триггер троттлинга Gmail.
            // ВАЖНО (20.08): больше НЕ делаем полный скан при входе —
            // курсоры в sqlite надёжны, история в sqlite — источник чатов.
            // Принудительный полный скан с пустыми курсорами ломал INBOX
            // на больших ящиках (icemaksim: 15624 писем, UID SEARCH ALL
            // падал с «Unable to parse status response» в imap 2.4.1).
            const cursors = this.loadCursors(account.id);
            const res = await api.fetchEmailsIncremental(account.id, cursors);
            fetched.push(...(res.messages || []));
            this.saveCursors(account.id, res.cursors);
          } catch (e) {
            console.error('Failed to fetch emails for account:', e);
            if (!silent) this.emailError = 'fetch: ' + (e && e.message || e);
            // Re-throw "Not connected" so mounted() can ask for the password again
            if (String(e && e.message || e).toLowerCase().includes('not connected')) {
              throw e;
            }
          }
        }
        // Мержим новые письма со старым списком (полный рескан больше не
        // делается — старые остаются в памяти, новые добавляются сверху).
        // Дедуп по uid+папка; cap 2000 — старые конверты уходят (история
        // чатов вскоре будет в IndexedDB, для инвайтов/аватаров хватает).
        const merged = [...this.emails];
        const seen = new Set(merged.map(m => m.uid + '|' + (m.folder || 'INBOX')));
        for (const m of fetched) {
          const k = m.uid + '|' + (m.folder || 'INBOX');
          if (!seen.has(k)) { seen.add(k); merged.push(m); }
        }
        merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        if (merged.length > 2000) merged.length = 2000;
        this.emails = merged;
        // ПЕРСИСТ (20.08): envelope cache в sqlite — при перезапуске письма
        // восстанавливаются без полного IMAP-скана (курсоры согласованы).
        try {
          const acc = accounts[0] ? accounts[0].id : (this.email || 'anon');
          db.emailsSave(acc, JSON.stringify(this.emails.map(m => ({
            uid: String(m.uid ?? m.id ?? ''),
            folder: m.folder || 'INBOX',
            from: m.from || '',
            to: m.to || '',
            subject: m.subject || '',
            date: m.date || '',
            is_read: !!m.is_read,
            message_id: m.message_id || '',
          }))));
        } catch (e) {
          console.warn('loadEmails: sqlite save failed:', e);
        }
        console.log(`[Emails] loaded ${this.emails.length} messages (${fetched.length} new)`);
        // Непрочитанные + PUSH-уведомления (22.08): каждый fetched-батч
        // классифицируем (счётчики непрочитанных — всегда; уведомления —
        // только при silent=true, НЕ при первом скане после входа, и только
        // для свежих писем — иначе уведомляли бы обо всей истории ящика и
        // о догоняющих старых письмах).
        if (fetched.length) await this.processIncoming(fetched, { notify: silent });
        // При пустом ящике НЕ показываем красную подсказку — пустой список
        // и есть норма (пользователь, 21.08: никаких «INBOX пуст» в UI).
        // После поллинга разбираем инвайты/подтверждения групп (попап согласия).
        await this.processInvites();
        // Аватары групп: meta-письма (VaultGroupMeta) разбираем здесь же, а не
        // только при открытии группы — иначе участник, не открывавший группу,
        // новый аватар админа не увидит никогда.
        await this.syncGroupAvatarsFromMeta();
        // Квитанции «доставлено» (20.08): шлём {delivered:1} сразу при
        // получении писем поллингом — отправитель видит зелёную точку через
        // ~30с, а не когда получатель откроет чат (раньше delivered-квитанцию
        // никто не слал — статус висел жёлтым до открытия чата).
        await this.sendDeliveredReceipts(fetched);
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
    // ── Непрочитанные + PUSH-уведомления (принцип поллинга, 22.08) ─────────
    // processIncoming классифицирует КАЖДЫЙ fetched-батч (поллинг или вход):
    // расшифровывает тела, отличает настоящие сообщения от квитанций/
    // инвайтов/meta (parseEnvelope), ведёт счётчики непрочитанных и
    // (при notify=true) шлёт системные уведомления. Контент НЕ показываем
    // (зашифровано + zero-metadata) — только имя отправителя/группы.
    async processIncoming(fetched, { notify = false } = {}) {
      if (!fetched || !fetched.length || !this.cryptoReady) return;
      const myEmail = (this.email || '').toLowerCase();
      const pool = fetched.slice(0, 50);
      // Тела: добираем недостающие батчем по папкам (как sendDeliveredReceipts).
      const byFolder = {};
      for (const m of pool) {
        const f = m.folder || 'INBOX';
        (byFolder[f] = byFolder[f] || []).push(m);
      }
      for (const [folder, msgs] of Object.entries(byFolder)) {
        const missing = msgs.filter(m => this.emailBodyCache[`${folder}:${m.uid || m.id}`] === undefined);
        if (!missing.length) continue;
        try {
          const bodies = await api.fetchEmailBodies(folder, missing.map(m => m.uid || m.id));
          for (const m of missing) {
            const b = bodies ? bodies[String(m.uid || m.id)] : undefined;
            if (b) this.cacheBody(`${folder}:${m.uid || m.id}`, b);
          }
        } catch (e) { /* тела не обязательны — классификация тихо пропустит */ }
      }
      for (const m of pool) {
        const from = this.senderEmail(m.from);
        // Пропускаем исходящие (от себя) и пустые from.
        if (!from || from === myEmail) continue;
        const body = this.emailBodyCache[`${m.folder || 'INBOX'}:${m.uid || m.id}`] || '';
        if (!body || !crypto.isEncrypted(body)) continue;
        let chatKey = null; // email (1:1) или 'group:<id>'
        let title = '';
        // 1:1 — расшифровка пир-ключом.
        if (this.peerKeys[from]) {
          try {
            crypto.setPeerPublicKey(this.peerKeys[from]);
            const env = this.parseEnvelope(await crypto.decryptVault(body));
            if (env) {
              chatKey = from;
              const lp = this.localProfileOf(from);
              const contact = this.contacts.find(c => c.email === from);
              title = (lp && lp.name) || (contact && contact.name) || from;
            }
          } catch (e) { /* не наше письмо */ }
        }
        // Группы — ключом группы, где отправитель участник (1:1-ключ не пройдёт).
        if (!chatKey) {
          for (const g of this.groups) {
            const members = (g.members || []).map(x => String(x.email || '').toLowerCase());
            if (!members.includes(from)) continue;
            let gk = this.groupKeys[g.id];
            if (!gk && this.cryptoReady) {
              try {
                const kd = await api.getMyGroupKey(g.id);
                if (kd && kd.group_key) { this.groupKeys[g.id] = kd.group_key; gk = kd.group_key; }
              } catch (e) { /* ключ недоступен */ }
            }
            if (!gk) continue;
            try {
              const env = this.parseEnvelope(await crypto.decryptWithGroupKey(body, gk));
              if (env) { chatKey = 'group:' + g.id; title = g.name || ''; break; }
            } catch (e) { /* не из этой группы */ }
          }
        }
        // Квитанции/инвайты/meta/legacy — не сообщения, не считаем и не шлём.
        if (!chatKey) continue;
        const fresh = Date.now() - new Date(m.date || 0).getTime() < 15 * 60 * 1000;
        // Счётчик непрочитанных: всегда, кроме видимого сейчас чата.
        if (!this.chatVisible(chatKey)) {
          this.unreadCounts[chatKey] = (this.unreadCounts[chatKey] || 0) + 1;
          await this.saveUnreadCounts();
        }
        // Уведомление: только тихий поллинг, только свежие письма (старые
        // задержанные/догоняющие письма спамом не считаем) и только когда
        // чат НЕ виден (на mobile activeChat может хранить прошлый чат, пока
        // пользователь на списке контактов — иначе уведомление теряется).
        if (notify && fresh && !this.chatVisible(chatKey)) {
          notifyNewMessage({
            title,
            body: this.t('notif_new_message') || 'New message',
            id: m.uid + '|' + (m.folder || 'INBOX'),
          });
        }
      }
    },
    // Виден ли чат сейчас: на mobile чат скрыт, когда пользователь на списке
    // контактов (mobileChatOpen=false), хотя activeChat ещё хранит прошлый чат.
    chatVisible(chatKey) {
      if (chatKey.indexOf('group:') === 0) {
        return this.activeChatType === 'group' && this.activeChat === chatKey;
      }
      return this.activeChatType === 'chat' && this.activeChat === chatKey &&
        (!this.isMobile || this.mobileChatOpen);
    },
    unreadOf(chatKey) {
      return this.unreadCounts[chatKey] || 0;
    },
    async loadUnreadCounts() {
      try {
        const raw = await db.kvGet(this.email || 'anon', 'unread-counts');
        this.unreadCounts = raw ? JSON.parse(raw) : {};
      } catch (e) { this.unreadCounts = {}; }
    },
    async saveUnreadCounts() {
      try {
        await db.kvSet(this.email || 'anon', 'unread-counts', JSON.stringify(this.unreadCounts));
      } catch (e) { /* kv недоступен — счётчики живут в памяти до перезапуска */ }
    },
    async resetUnread(chatKey) {
      if ((this.unreadCounts[chatKey] || 0) > 0) {
        this.unreadCounts[chatKey] = 0;
        await this.saveUnreadCounts();
      }
    },
    startPolling(intervalMs = 30000) {
      if (this.pollTimer) return;
      this.pollTimer = setInterval(async () => {
        // Анти-наложение (20.08): setInterval запускает новый тик каждые 30с,
        // НЕ дожидаясь завершения предыдущего. Если IMAP завис (троттлинг
        // Gmail), предыдущий тик держит Rust-lock клиента до 35с — следующий
        // стартует поверх, lock занят почти всегда, и открытие чата падает с
        // «Timed out waiting for email client lock» (чаты пустые). Пропускаем
        // тик, пока предыдущий ещё выполняется.
        if (!this.isLoggedIn || this._pollingActive) return;
        this._pollingActive = true;
        try {
          // Пересборка групп в НАЧАЛЕ тика: участники групп попадают в список
          // контактов (модель Delta Chat — группа тоже источник контактов).
          try { await this.loadGroups(); } catch (e) { /* тихо */ }
          // Тихий поллинг: не трогает спиннер/ошибки почты, но разбирает
          // инвайты (попап согласия) и обновляет список писем.
          await this.loadEmails(true);
          // Новые письма могли прийти в любой момент — перерисовываем
          // открытый чат, чтобы не приходилось переоткрывать его вручную.
          if (this.activeChat === '__notes__') {
            // Заметки для себя — локальные, поллинг их НЕ трогает (иначе
            // перезаписал бы пустым списком из IMAP).
          } else if (this.activeChat && this.activeChatType === 'chat') {
            await this.loadMessages(this.activeChat);
            // Не выдёргиваем из чтения истории: прокручиваем только если
            // пользователь уже у низа чата.
            this.scrollToBottom(false);
          } else if (this.activeChatType === 'group' && this.currentGroup) {
            // Группы тоже обновляем поллингом: новые сообщения и реакции
            // (VaultGroupReact) иначе не подхватывались до переоткрытия чата.
            await this.loadGroupMessages(this.currentGroup.id);
            this.scrollToBottom(false);
          }
        } catch (e) {
          // "Not connected" — сессия IMAP умерла; пробуем тихо восстановить её
          // из сохранённых (зашифрованных на устройстве) учётных данных —
          // без релога и остановки поллинга.
          if (String(e && e.message || e).toLowerCase().includes('not connected')) {
            try {
              const ok = await api.restoreSession();
              if (!ok) this.stopPolling();
            } catch (_) {
              this.stopPolling();
            }
          } else {
            console.error('Polling loadEmails failed:', e);
          }
        } finally {
          this._pollingActive = false;
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
    async sendAudioMessage(audioData) {
      // Заметки для себя: голосовое хранится ЛОКАЛЬНО (localStorage), без
      // шифрования и почты — так же, как текст заметок.
      if (this.activeChat === '__notes__') {
        const name = `voice-${Date.now()}.webm`;
        const msg = {
          id: 'note-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
          content: `🎙️ [Voice ${audioData.duration}s — ${Math.round(audioData.size / 1024)}KB]`,
          from: 'me',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          encrypted: false,
          vault: false,
          status: 'sent',
          _notes: true,
          attachment: {
            name,
            type: audioData.mimeType || 'audio/webm',
            size: audioData.size,
            data: audioData.base64,
            isImage: false,
            isAudio: true,
          },
        };
        const list = this.loadNotes();
        list.push(msg);
        if (!this.saveNotes(list)) {
          list.pop();
          this.messages = [...list];
          alert('Локальное хранилище заметок переполнено — голосовое не сохранено. Удалите часть заметок/вложений.');
          this.showAudioRecorder = false;
          return;
        }
        this.messages = [...list];
        this.showAudioRecorder = false;
        this.scrollToBottom(true);
        return;
      }
      // Голосовое = вложение audio/webm, зашифрованное как обычное сообщение
      // (конверт {vault:1,...,text:<JSON вложения>} + encryptVault, AAD="VAULT").
      const name = `voice-${Date.now()}.webm`;
      const attachmentPayload = JSON.stringify({
        vault_attachment: true,
        name,
        type: audioData.mimeType || 'audio/webm',
        size: audioData.size,
        data: audioData.base64,
      });

      // Конверт строим ДО оптимистичного показа: его id — ключ слияния с
      // реальным письмом (иначе поллинг не смог бы заменить предпросмотр,
      // и голосовое «появлялось и исчезало»).
      let wire = attachmentPayload;
      let envelopeId = '';
      if (this.activeChatType === 'group' && this.currentGroup) {
        const groupKey = this.groupKeys[this.currentGroup.id];
        if (groupKey) {
          const envelope = await this.buildEnvelope(attachmentPayload);
          try { envelopeId = JSON.parse(envelope).id; } catch (e) { /* ignore */ }
          wire = await crypto.encryptWithGroupKey(envelope, groupKey);
        }
      } else if (this.cryptoReady && this.peerKeys[this.activeChat]) {
        crypto.setPeerPublicKey(this.peerKeys[this.activeChat]);
        const envelope = await this.buildEnvelope(attachmentPayload);
        try { envelopeId = JSON.parse(envelope).id; } catch (e) { /* ignore */ }
        wire = await crypto.encryptVault(envelope);
      }

      // Оптимистичный предпросмотр у отправителя.
      const msg = {
        id: envelopeId || ('local-' + Date.now()),
        content: `🎙️ [Voice ${audioData.duration}s — ${Math.round(audioData.size / 1024)}KB]`,
        from: 'me',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ts: Date.now(),
        encrypted: this.cryptoReady,
        status: 'sending',
        _pendingAt: Date.now(),
        attachment: {
          name,
          type: audioData.mimeType || 'audio/webm',
          size: audioData.size,
          data: audioData.base64,
          isImage: false,
          isAudio: true,
        },
      };
      this.messages.push(msg);
      const chatKey = this.activeChatType === 'group' && this.currentGroup
        ? 'group:' + this.currentGroup.id
        : this.activeChat;
      this.markPending(chatKey, msg);
      this.showAudioRecorder = false;
      this.scrollToBottom(true);

      if (this.activeChat) {
        try {
          if (this.activeChatType === 'group' && this.currentGroup) {
            await api.sendGroupMessage(this.currentGroup.id, wire);
          } else {
            await api.sendMessage(this.activeChat, wire, audioData.mimeType || 'audio/webm');
          }
          msg.status = 'sent';
        } catch (err) {
          console.error('Failed to send audio:', err);
          msg.status = 'failed';
          alert('Failed to send voice message: ' + (err && err.message || err));
        }
        // Персистим финальный статус в историю (иначе после перезапуска
        // запись со старым 'sending' горела красным — 20.08).
        this.saveCurrentHistory(chatKey);
      }
    },
    // File attachments
    async handleFileSelect(event) {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      for (const file of files) {
        try {
          // Для заметок почтовый лимит провайдера неважен (файл никуда не
          // отправляется), но localStorage ограничен (~5МБ) — не даём выбрать
          // заведомо непомещающийся файл.
          if (this.activeChat === '__notes__' && file.size > 3 * 1024 * 1024) {
            alert(`Файл «${file.name}» — ${(file.size / 1024 / 1024).toFixed(1)} МБ. В «Заметки для себя» вложения хранятся локально (лимит ~5 МБ на весь чат), файлы больше 3 МБ не прикрепляются.`);
            continue;
          }
          // Лимит вложений провайдера (Gmail 25MB, Zoho 25MB, ...): письмо с
          // base64-телом ~на 33% больше файла, поэтому сравниваем с 70% от
          // лимита — предупреждаем ДО отправки, пока провайдер не отклонил.
          const limitMb = getAttachmentLimitMb(this.email);
          const limitBytes = Math.floor(limitMb * 1024 * 1024 * 0.7);
          if (file.size > limitBytes) {
            alert(
              (this.t('file_too_large') || 'Файл не пройдёт через почту: лимит вложений вашего провайдера') +
              ` ~${limitMb} МБ, а «${file.name}» — ${(file.size / 1024 / 1024).toFixed(1)} МБ.` +
              (this.t('file_too_large_hint') || ' Файл не отправлен.')
            );
            continue; // пропускаем файл, остальные отправляем
          }
          const reader = new FileReader();
          reader.onload = async (e) => {
            const base64 = e.target.result.split(',')[1];
            const isImage = file.type.startsWith('image/');
            const isAudio = file.type.startsWith('audio/');
            const isText = !isImage && !isAudio && this.isTextMime(file.type, file.name);
            let textContent = '';
            if (isText) {
              try {
                textContent = atob(base64);
                try { textContent = decodeURIComponent(escape(textContent)); } catch { /* уже utf-8 */ }
              } catch { textContent = ''; }
              if (textContent.length > 8000) textContent = textContent.slice(0, 8000) + '\n…';
            }

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

            // Заметки для себя: файл хранится ЛОКАЛЬНО (localStorage), без
            // шифрования и почты — так же, как текст заметок.
            if (this.activeChat === '__notes__') {
              const noteMsg = {
                id: 'note-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                content: displayContent,
                from: 'me',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                encrypted: false,
                vault: false,
                status: 'sent',
                _notes: true,
                attachment: {
                  name: file.name,
                  type: file.type,
                  size: file.size,
                  data: base64,
                  isImage: isImage,
                  isAudio: isAudio,
                  isText: isText,
                  textContent: textContent,
                },
              };
              const noteList = this.loadNotes();
              noteList.push(noteMsg);
              if (!this.saveNotes(noteList)) {
                noteList.pop();
                this.messages = [...noteList];
                alert('Локальное хранилище заметок переполнено — файл не сохранён.');
                return;
              }
              this.messages = [...noteList];
              this.scrollToBottom(true);
              return;
            }

            // Отправка: вложение — это конверт {vault:1,...,text:<JSON вложения>},
            // зашифрованный как обычное сообщение (AAD="VAULT"). БЕЗ шифрования
            // получатель не сможет расшифровать (AAD не сойдётся) и письмо
            // молча отбросится. Конверт строим ДО предпросмотра: его id — ключ
            // слияния с реальным письмом (иначе поллинг не заменит предпросмотр,
            // и файл «появится и исчезнет» у отправителя).
            let wire = attachmentPayload;
            let envelopeId = '';
            if (this.activeChatType === 'group' && this.currentGroup) {
              const groupKey = this.groupKeys[this.currentGroup.id];
              if (groupKey) {
                const envelope = await this.buildEnvelope(attachmentPayload);
                try { envelopeId = JSON.parse(envelope).id; } catch (e) { /* ignore */ }
                wire = await crypto.encryptWithGroupKey(envelope, groupKey);
              }
            } else if (this.cryptoReady && this.peerKeys[this.activeChat]) {
              crypto.setPeerPublicKey(this.peerKeys[this.activeChat]);
              const envelope = await this.buildEnvelope(attachmentPayload);
              try { envelopeId = JSON.parse(envelope).id; } catch (e) { /* ignore */ }
              wire = await crypto.encryptVault(envelope);
            }

            // Create preview message
            const msg = {
              id: envelopeId || ('local-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5)),
              content: displayContent,
              from: 'me',
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              ts: Date.now(),
              encrypted: this.cryptoReady,
              status: 'sending',
              _pendingAt: Date.now(),
              attachment: {
                name: file.name,
                type: file.type,
                size: file.size,
                data: base64,
                isImage: isImage,
                isAudio: isAudio,
                isText: isText,
                textContent: textContent,
              },
            };
            this.messages.push(msg);
            const chatKey = this.activeChatType === 'group' && this.currentGroup
              ? 'group:' + this.currentGroup.id
              : this.activeChat;
            this.markPending(chatKey, msg);
            this.scrollToBottom(true);

            if (this.activeChat) {
              try {
                if (this.activeChatType === 'group' && this.currentGroup) {
                  await api.sendGroupMessage(this.currentGroup.id, wire);
                } else {
                  await api.sendMessage(this.activeChat, wire, file.type);
                }
                msg.status = 'sent';
              } catch (err) {
                console.error('Failed to send attachment:', err);
                msg.status = 'failed';
              }
              // Персистим финальный статус в историю (иначе после перезапуска
              // запись со старым 'sending' горела красным — 20.08).
              this.saveCurrentHistory(chatKey);
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
    // --- Персистентность реакций ---
    // localStorage "vault-reactions-<email>": {chatKey: {msg_id: [{emoji, user}]}}.
    // Поллинг перерисовывает сообщения из почты — без хранилища реакции
    // исчезали через 30 сек даже у отправителя.
    reactionsStorageKey() {
      return 'vault-reactions-' + (this.email || 'anon');
    },
    loadStoredReactions() {
      try {
        return JSON.parse(localStorage.getItem(this.reactionsStorageKey()) || '{}');
      } catch (e) {
        return {};
      }
    },
    saveStoredReactions(data) {
      try {
        localStorage.setItem(this.reactionsStorageKey(), JSON.stringify(data));
      } catch (e) {
        console.error('Failed to save reactions:', e);
      }
    },
    // Мерж сохранённых реакций + реакций из писем (wireReactions: msg_id ->
    // [{emoji, user, action}]). Результат пишется в хранилище и в msg.reactions.
    // Отправитель письма — мы сами: sender_id это сырой заголовок From
    // («Имя <email>» или просто email). userId — рудимент серверной эпохи,
    // в serverless он всегда null, поэтому сравниваем по своему email
    // (тот же приём, что isOut в 1-на-1 пути loadMessages).
    isOwnSender(senderId) {
      if (!senderId || !this.email) return false;
      return String(senderId).toLowerCase().includes(this.email.toLowerCase());
    },
    // Нормализация сырого заголовка From («Имя <email>») до чистого email.
    // avatarOf/nameOf ищут профили по email — без этого аватар/имя
    // отправителя в группе не рендерились («аватарки не добавились»).
    senderEmail(raw) {
      if (!raw) return '';
      const m = String(raw).match(/<([^>]+)>/);
      return (m ? m[1] : raw).trim().toLowerCase();
    },
    applyReactions(list, chatKey, wireReactions) {
      const stored = this.loadStoredReactions();
      const chatReactions = stored[chatKey] || {};
      // Применяем реакции из писем (add/remove) к хранилищу.
      if (wireReactions && Object.keys(wireReactions).length) {
        for (const [msgId, reactions] of Object.entries(wireReactions)) {
          const cur = chatReactions[msgId] || [];
          for (const r of reactions) {
            const idx = cur.findIndex(x => x.emoji === r.emoji && x.user === r.user);
            if (r.action === 'remove') {
              if (idx >= 0) cur.splice(idx, 1);
            } else if (idx < 0) {
              cur.push({ emoji: r.emoji, user: r.user });
            }
          }
          if (cur.length) chatReactions[msgId] = cur;
          else delete chatReactions[msgId];
        }
        stored[chatKey] = chatReactions;
        this.saveStoredReactions(stored);
      }
      // Проставляем на сообщения (массив эмодзи для рендера).
      for (const msg of list) {
        const rs = chatReactions[msg.id];
        msg.reactions = rs ? [...new Set(rs.map(r => r.emoji))] : [];
      }
    },
    // Применяем правки из писем (wireEdits: msg_id -> [{text, action, date}]).
    // Паттерн applyReactions: мерж писем в localStorage-хранилище
    // (vault-edits-<email>), иначе поллинг «откатывал» правку, пока
    // edit-письмо в пути. Последняя по дате правка авторитетна:
    // delete → msg.deleted, edit → msg.content = новый текст + msg.edited.
    editsStorageKey() {
      return 'vault-edits-' + (this.email || 'anon');
    },
    loadStoredEdits() {
      try {
        return JSON.parse(localStorage.getItem(this.editsStorageKey()) || '{}');
      } catch (e) {
        return {};
      }
    },
    saveStoredEdits(data) {
      try {
        localStorage.setItem(this.editsStorageKey(), JSON.stringify(data));
      } catch (e) {
        console.error('Failed to save edits:', e);
      }
    },
    // --- Квитанции чтения («просмотрено») ---
    // Получатель при открытии чата шлёт отправителю квитанцию {read:1,
    // msg_ids:[...]} (1-на-1: encryptVault с пустой темой; группа:
    // encryptWithGroupKey письмами VaultGroupRead: <id>). Храним уже отосланные
    // msg_id по каждому чату, чтобы не слать повторно при каждом поллинге.
    readsSentStorageKey() {
      return 'vault-reads-sent-' + (this.email || 'anon');
    },
    loadSentReads() {
      try {
        return JSON.parse(localStorage.getItem(this.readsSentStorageKey()) || '{}');
      } catch (e) {
        return {};
      }
    },
    saveSentReads(data) {
      try {
        localStorage.setItem(this.readsSentStorageKey(), JSON.stringify(data));
      } catch (e) {
        console.error('Failed to save read receipts:', e);
      }
    },
    // Отправить квитанцию «просмотрено» по входящим сообщениям текущего чата.
    // Вызывается после рендера сообщений (открытие чата и поллинг).
    async sendReadReceipts(incomingIds) {
      if (!incomingIds || !incomingIds.length) return;
      const sent = this.loadSentReads();
      const chatKey = this.activeChatType === 'group' && this.currentGroup
        ? 'group:' + this.currentGroup.id
        : this.activeChat;
      const sentIds = sent[chatKey] || [];
      const fresh = incomingIds.filter(id => id && sentIds.indexOf(id) < 0);
      if (!fresh.length) return;
      const payload = JSON.stringify({ read: 1, msg_ids: fresh });
      // ФИКС 20.08 (дубли квитанций): помечаем id как отправленные ДО SMTP —
      // иначе при медленном SMTP (30-60с) следующий поллинг (30с) считает
      // fresh заново и уходит вторая копия квитанции (в ящиках лежали дубли
      // {read:1} с одинаковыми msg_ids — «письма отправляются циклично»).
      // При фейле SMTP откатываем метку — поллинг попробует ещё раз.
      sent[chatKey] = sentIds.concat(fresh);
      this.saveSentReads(sent);
      (async () => {
        try {
          if (this.activeChatType === 'group' && this.currentGroup) {
            const groupKey = this.groupKeys[this.currentGroup.id];
            if (!groupKey) return;
            const content = await crypto.encryptWithGroupKey(payload, groupKey);
            await api.sendGroupRead(this.currentGroup.id, content);
          } else if (this.activeChat && this.peerKeys[this.activeChat]) {
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat]);
            const content = await crypto.encryptVault(payload);
            await api.sendReadReceipt(this.activeChat, content);
          }
        } catch (e) {
          console.error('Failed to send read receipts:', e);
          // SMTP упал — снимаем метку, чтобы квитанция повторилась позже.
          sent[chatKey] = sentIds;
          this.saveSentReads(sent);
        }
      })();
    },
    // Квитанции «доставлено» по новым входящим (поллинг): как только письмо
    // получено и расшифровано как vault-сообщение — отправителю уходит
    // {delivered:1, msg_ids:[...]} (stealth, пустая тема; тот же wire-формат,
    // что у read-квитанций — отправитель уже умеет их разбирать, App.vue
    // wireAcks). Раньше delivered-квитанцию никто не слал: отправитель видел
    // жёлтую точку, пока получатель не откроет чат (тогда уходила read).
    // Групповые письма здесь не обрабатываются (шифр групповым ключом —
    // decryptVault с пир-ключом не пройдёт); для групп статусы — как прежде.
    async sendDeliveredReceipts(fetched) {
      if (!this.isLoggedIn || !this.cryptoReady || !fetched || !fetched.length) return;
      const myEmail = (this.email || '').toLowerCase();
      if (!myEmail) return;
      // Дедуп в sqlite kv_store (НЕ localStorage — он может переполниться;
      // 20.08: localStorage запрещён как источник данных Vault).
      const acc = this.email || 'anon';
      let sentMap = {};
      try {
        const raw = await db.kvGet(acc, 'delivered-sent');
        if (raw) sentMap = JSON.parse(raw);
      } catch (e) { sentMap = {}; }
      // Кандидаты: входящие от известных пиров (есть ключ — можно расшифровать).
      const candidates = fetched.filter(m => {
        const sender = this.senderEmail(m.from);
        if (!sender || sender.includes(myEmail)) return false;
        return !!this.peerKeys[sender];
      });
      if (!candidates.length) return;
      const byFolder = {};
      for (const m of candidates.slice(0, 30)) {
        const f = m.folder || 'INBOX';
        (byFolder[f] = byFolder[f] || []).push(m);
      }
      const acks = {}; // sender -> [msg_id]
      for (const [folder, msgs] of Object.entries(byFolder)) {
        const missing = msgs.filter(m => this.emailBodyCache[`${folder}:${m.uid || m.id}`] === undefined);
        if (missing.length) {
          try {
            const bodies = await api.fetchEmailBodies(folder, missing.map(m => m.uid || m.id));
            for (const m of missing) {
              const b = bodies ? bodies[String(m.uid || m.id)] : undefined;
              if (b) this.cacheBody(`${folder}:${m.uid || m.id}`, b);
            }
          } catch (e) { continue; }
        }
        for (const m of msgs) {
          const body = this.emailBodyCache[`${folder}:${m.uid || m.id}`] || '';
          if (!body || !crypto.isEncrypted(body)) continue;
          const sender = this.senderEmail(m.from);
          try {
            crypto.setPeerPublicKey(this.peerKeys[sender]);
            const text = await crypto.decryptVault(body);
            const env = this.parseEnvelope(text);
            // Только настоящие сообщения (envelope с id): квитанции/правки/
            // реакции/legacy — не сообщения, на них квитанция не положена.
            if (!env || !env.id) continue;
            if (sentMap[env.id]) continue;
            (acks[sender] = acks[sender] || []).push(env.id);
            sentMap[env.id] = Date.now();
          } catch (e) { /* не vault-письмо или чужой ключ — пропускаем */ }
        }
      }
      if (!Object.keys(acks).length) return;
      for (const [sender, ids] of Object.entries(acks)) {
        try {
          crypto.setPeerPublicKey(this.peerKeys[sender]);
          const content = await crypto.encryptVault(JSON.stringify({ delivered: 1, msg_ids: ids }));
          await api.sendReadReceipt(sender, content);
        } catch (e) {
          console.error('sendDeliveredReceipts failed for ' + sender + ':', e);
          // SMTP упал — снимаем метки, чтобы квитанция повторилась позже.
          for (const id of ids) delete sentMap[id];
        }
      }
      // Разрастание карты: держим не более 500 самых свежих записей.
      const entries = Object.entries(sentMap);
      if (entries.length > 500) {
        entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
        sentMap = Object.fromEntries(entries.slice(0, 500));
      }
      db.kvSet(acc, 'delivered-sent', JSON.stringify(sentMap)).catch(() => {});
    },
    // Локальная (оптимистичная) запись правки — до доставки письма.
    recordLocalEdit(chatKey, msgId, text, action) {
      const stored = this.loadStoredEdits();
      const chatEdits = stored[chatKey] || {};
      const cur = chatEdits[msgId] || [];
      cur.push({ text: text || '', action, date: Date.now(), sender: this.email });
      chatEdits[msgId] = cur;
      stored[chatKey] = chatEdits;
      this.saveStoredEdits(stored);
    },
    // Tombstones удалённых сообщений: msg_id удалённых НАВСЕГДА. Письмо-
    // оригинал может вернуться из IMAP (Sent/INBOX/спам) — без пометки
    // поллинг «воскресил» бы удалённое. Хранится в sqlite (Delta Chat-style),
    // с in-memory кэшем для синхронной фильтрации (filterDeleted).
    // См. initLocalDb() — загрузка при входе.
    tombstonesCache: [],
    midTombstonesCache: [],
    // IMAP-курсоры: in-memory кэш + sqlite персист.
    cursorsCache: {},
    // Инициализация локальной БД: загрузить tombstones и курсоры из sqlite.
    async initLocalDb() {
      const accEmail = this.email || 'anon';  // tombstones/body-cache: account = email
      const accLocal = 'local';               // cursors/emails: account = 'local' (getEmailAccounts → id='local')
      try {
        const tombs = await db.tombstonesLoad(accEmail);
        this.tombstonesCache = tombs.filter(t => t[0]).map(t => t[0]);
        this.midTombstonesCache = tombs.filter(t => t[1]).map(t => t[1]);
      } catch (e) {
        console.warn('initLocalDb tombstones failed:', e);
      }
      try {
        this.cursorsCache = await db.cursorsLoad(accLocal);
      } catch (e) {
        console.warn('initLocalDb cursors failed:', e);
      }
    },
    tombstonesKey() {
      return 'vault-tombstones-' + (this.email || 'anon');
    },
    loadTombstones() {
      return this.tombstonesCache || [];
    },
    addTombstone(msgId) {
      if (!msgId) return;
      const list = this.tombstonesCache;
      if (!list.includes(msgId)) {
        list.push(msgId);
        // sqlite persist (async, fire-and-forget)
        db.tombstoneAdd(this.email || 'anon', msgId, '');
      }
    },
    isTombstoned(msgId) {
      if (!msgId) return false;
      return (this.tombstonesCache || []).includes(msgId);
    },
    // Message-ID tombstones (DC-аналог rfc724_mid): письмо, чей Message-ID
    // когда-либо был удалён, НЕ ВОСКРЕСАЕТ даже при переезде между папками
    // или повторной доставке с новым UID. В отличие от msg_id-tombstones
    // (которые привязаны к uid-папки), mid-tombstones работают ГЛОБАЛЬНО:
    // письмо, вернувшееся из All Mail любого провайдера, будет отфильтровано.
    midTombstonesKey() {
      return 'vault-mid-tombstones-' + (this.email || 'anon');
    },
    loadMidTombstones() {
      return this.midTombstonesCache || [];
    },
    addMidTombstone(mid) {
      if (!mid) return;
      const list = this.midTombstonesCache;
      if (!list.includes(mid)) {
        list.push(mid);
        db.tombstoneAdd(this.email || 'anon', '', mid);
      }
    },
    isMidTombstoned(mid) {
      if (!mid) return false;
      return (this.midTombstonesCache || []).includes(mid);
    },
    applyEdits(list, chatKey, wireEdits) {
      const stored = this.loadStoredEdits();
      const chatEdits = stored[chatKey] || {};
      // Мерж правок из писем в хранилище. Дедупликация по
      // дате+тексту+действию+отправителю (один и тот же edit-конверт
      // доходит в нескольких копиях — Sent отправителя + INBOX получателя).
      if (wireEdits && Object.keys(wireEdits).length) {
        for (const [msgId, edits] of Object.entries(wireEdits)) {
          const cur = chatEdits[msgId] || [];
          for (const e of edits) {
            const dup = cur.some(x => x.text === e.text && x.action === e.action
              && String(x.date || 0) === String(e.date || 0) && (x.sender || '') === (e.sender || ''));
            if (!dup) cur.push(e);
          }
          chatEdits[msgId] = cur;
        }
        stored[chatKey] = chatEdits;
        this.saveStoredEdits(stored);
      }
      // Проставляем на сообщения. Проверка отправителя (аналог Delta Chat
      // «Bad sender»): edit/delete применяются только от АВТОРА оригинала;
      // чужие правки игнорируются. Старые правки без sender — применяем
      // (обратная совместимость).
      for (const msg of list) {
        const edits = chatEdits[msg.id];
        if (!edits || !edits.length) continue;
        const mine = edits.filter(e => {
          if (!e.sender) return true;
          if (msg.sender_id) return e.sender === msg.sender_id;
          // 1:1 без sender_id: моё сообщение правит только мой email,
          // чужое — только не мой (в 1:1 другой участник один).
          if (msg.from === 'me') return e.sender === this.email;
          return e.sender !== this.email;
        });
        if (!mine.length) continue;
        const latest = mine.reduce((a, b) => (new Date(b.date || 0) >= new Date(a.date || 0) ? b : a));
        if (latest.action === 'delete') {
          // Навсегда: tombstone + скрытие (фильтр в mergeHistory/mergePending).
          this.addTombstone(msg.id);
          this.addMidTombstone(msg.mid);
          msg.deleted = true;
          msg.content = '';
        } else if (latest.text) {
          msg.content = latest.text;
          msg.edited = true;
        }
      }
    },
    // Отправить реакцию письмом (транспорт E2E). Ошибки — не критичны.
    sendReactionEmail(msgId, emoji, action) {
      const payload = JSON.stringify({ react: 1, msg_id: msgId, emoji, action });
      (async () => {
        try {
          if (this.activeChatType === 'group' && this.currentGroup) {
            const groupKey = this.groupKeys[this.currentGroup.id];
            if (!groupKey) return;
            const content = await crypto.encryptWithGroupKey(payload, groupKey);
            await api.sendGroupReact(this.currentGroup.id, content);
          } else if (this.activeChat && this.peerKeys[this.activeChat]) {
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat]);
            const content = await crypto.encryptVault(payload);
            await api.sendReaction(this.activeChat, content);
          }
        } catch (e) {
          console.error('Failed to send reaction email:', e);
        }
      })();
    },
    toggleReactionPicker(msgId) {
      // Если пользователь выделял текст (копирование) — клик не должен
      // открывать пикер реакций.
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && String(sel).length > 0) return;
      } catch (e) { /* ignore */ }
      this.reactionPickerMsgId = this.reactionPickerMsgId === msgId ? null : msgId
    },
    addReaction(msgId, emoji) {
      const msg = this.messages.find(m => m.id === msgId)
      if (!msg) return
      if (!msg.reactions) msg.reactions = []
      if (!msg.reactions.includes(emoji)) {
        msg.reactions.push(emoji)
      }
      // Персистентность: сохранить сразу (переживёт поллинг).
      const chatKey = this.activeChatType === 'group' ? this.activeChat : this.activeChat;
      const stored = this.loadStoredReactions();
      const chatReactions = stored[chatKey] || {};
      const cur = chatReactions[msgId] || [];
      if (!cur.some(r => r.emoji === emoji && r.user === this.email)) {
        cur.push({ emoji, user: this.email });
      }
      chatReactions[msgId] = cur;
      stored[chatKey] = chatReactions;
      this.saveStoredReactions(stored);
      // Транспорт: отправить реакцию собеседнику/группе.
      this.sendReactionEmail(msgId, emoji, 'add');
      this.reactionPickerMsgId = null
    },
    toggleReaction(msgId, emoji) {
      const msg = this.messages.find(m => m.id === msgId)
      if (!msg || !msg.reactions) return
      const idx = msg.reactions.indexOf(emoji)
      if (idx >= 0) {
        msg.reactions.splice(idx, 1)
      }
      // Убрать из хранилища и уведомить собеседника.
      const chatKey = this.activeChat;
      const stored = this.loadStoredReactions();
      const chatReactions = stored[chatKey] || {};
      const cur = chatReactions[msgId] || [];
      const ri = cur.findIndex(r => r.emoji === emoji && r.user === this.email);
      if (ri >= 0) {
        cur.splice(ri, 1);
        if (cur.length) chatReactions[msgId] = cur;
        else delete chatReactions[msgId];
        stored[chatKey] = chatReactions;
        this.saveStoredReactions(stored);
        this.sendReactionEmail(msgId, emoji, 'remove');
      }
    },
    // --- Копирование сообщений ---
    openMessageMenu(event, msg) {
      this.messageMenu = { x: event.clientX, y: event.clientY, msg };
    },
    // Клик по логотипу в шапке → сайт приложения (когда появится, M4).
    // Пока APP_SITE_URL пустой — клик ничего не делает.
    openAppSite() {
      if (!APP_SITE_URL) return;
      try {
        openExternal(APP_SITE_URL);
      } catch (e) {
        window.open(APP_SITE_URL, '_blank');
      }
    },
    // Копирование с fallback для WebKitGTK (clipboard API может быть
    // недоступен без фокуса — тогда через временный textarea).
    async copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          alert(this.t('copied') || 'Скопировано');
          return;
        }
      } catch (e) { /* fallback ниже */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert(this.t('copied') || 'Скопировано');
      } catch (e) {
        alert(this.t('copy_failed') || 'Не удалось скопировать');
      }
    },
    copyMessageText(msg) {
      if (!msg) return;
      this.copyText(this.replyBody(msg.content || ''));
    },
    copyMessageAll(msg) {
      if (!msg) return;
      this.copyText(msg.content || '');
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
        // Выбранная эмодзи-иконка — сохраняется в kv_store (показывается, пока
        // админ не загрузит полноценный аватар).
        if (this.newGroupIcon) {
          await db.kvSet('anon', 'group-icon:' + group.id, this.newGroupIcon);
          this.groupIconMap[group.id] = this.newGroupIcon;
        }
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
    removeMember(email) {
      if (!this.currentGroup) return;
      // Защита от обхода UI: удаление участников — только у админов.
      if (!this.isGroupAdmin) return;
      const member = this.currentGroup.members.find(m => m.email === email);
      if (!member) return;
      // Создатель неприкосновенен — может только выйти сам; себя через
      // «Покинуть группу», а не удалением.
      if (email === this.currentGroup.created_by) {
        alert(this.t('cannot_remove_creator') || 'Создателя группы нельзя удалить');
        return;
      }
      api.removeGroupMember(this.currentGroup.id, email)
        .then(() => this.refreshGroupMembers())
        .catch(e => console.error('removeMember failed:', e));
    },
    async changeMemberRole(email, role) {
      if (!this.currentGroup) return;
      // Смена ролей — только у админов (участники всем пользуются в чате,
      // но ролями и составом не управляют).
      if (!this.isGroupAdmin) return;
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
      this.addMemberSelected = [];
      this.showAddMemberPopup = true;
    },
    toggleAddMember(email) {
      const i = this.addMemberSelected.indexOf(email);
      if (i >= 0) this.addMemberSelected.splice(i, 1);
      else this.addMemberSelected.push(email);
    },
    addManualEmail() {
      // Ввод email вручную: добавляем в выборку, отправка — кнопкой «Пригласить».
      const email = (this.addMemberQuery || '').trim();
      if (!email || !email.includes('@')) return;
      if ((this.currentGroup?.members || []).some(m => m.email === email)) {
        alert(this.t('already_in_group') || 'Этот участник уже в группе');
        return;
      }
      if (!this.addMemberSelected.includes(email)) this.addMemberSelected.push(email);
      this.addMemberQuery = '';
    },
    async inviteSelectedMembers() {
      // Попап закрываем СРАЗУ — отправка идёт в фоне, итог сообщаем alert'ом.
      // Раньше попап висел 30-60 с (медленный SMTP) и было непонятно,
      // отправлено приглашение или нет.
      const emails = [...this.addMemberSelected];
      if (!this.currentGroup || !emails.length) return;
      this.showAddMemberPopup = false;
      this.addMemberSelected = [];
      this.addMemberQuery = '';
      const sent = [];
      const failed = [];
      for (const email of emails) {
        try {
          // Уже участник (мог добавиться, пока попап был открыт) — пропускаем.
          if ((this.currentGroup.members || []).some(m => m.email === email)) continue;
          // Ключ группы шифруем на публичном ключе ПОЛУЧАТЕЛЯ (ECDH X25519).
          // Без ключа собеседника безопасный инвайт невозможен — как в Session:
          // в группу добавляют только установленные контакты.
          const peerPub = this.peerKeys[email] || null;
          if (!peerPub) {
            failed.push(email + ' — ' + (this.t('add_member_no_key') || 'нет ключа: сначала добавьте контакт (🔗)'));
            continue;
          }
          const groupKeys = await api.getGroupKeys(this.currentGroup.id);
          if (!groupKeys.length) throw new Error('No group key');
          const enc = await crypto.encryptGroupKeyForUser(groupKeys[0], peerPub);
          await api.inviteGroupMember(this.currentGroup.id, email, enc, this.publicKey);
          // Помечаем локально как «приглашён» в списке участников (появится после accept).
          const members = this.currentGroup.members || [];
          if (!members.some(m => m.email === email)) {
            members.push({ email, role: 'Member', invited: true });
          }
          sent.push(email);
        } catch (e) {
          failed.push(email + ' — ' + e.message);
        }
      }
      const parts = [];
      if (sent.length) parts.push((this.t('invite_sent') || 'Приглашение отправлено') + ': ' + sent.join(', '));
      if (failed.length) parts.push((this.t('add_member_failed') || 'Не удалось отправить') + ':\n' + failed.join('\n'));
      alert(parts.join('\n\n') || (this.t('add_member_nothing') || 'Приглашения не отправлены'));
    },
    // --- Инвайты группы + запросы контактов 1-на-1: попапы согласия ---
    async processInvites() {
      // Сброс кэша handshake-писем (fetchAllHandshake): каждый поллинг
      // перечитывает письма заново — иначе новые инвайты/удаления не видны.
      api._handshakeCache = null;
      // Одноразовый sweep (v0.1.9): помечаем ВСЕ старые непокрытые handshake-письма,
      // чтобы «призрачные» инвайты/accept'ы не всплывали после удаления списков.
      try { await api.sweepStaleHandshake(); } catch (e) { /* ignore */ }
      // Обрабатываем accept-письма (добавление принявших участников).
      try {
        const accepts = await api.fetchPendingAccepts();
        if (accepts.length) {
          await this.loadGroups();
          if (this.currentGroup) {
            await this.loadGroupMessages(this.currentGroup.id);
            await this.refreshGroupMembers();
          }
        }
      } catch (e) {
        console.error('processInvites: accepts failed:', e);
      }
      // Контакты 1-на-1 (модель Delta Chat): accept-письма → добавляем ключи
      // ТОЛЬКО от отправителей, которых МЫ пригласили (invited-senders в api.js).
      // Удаление контакта — строго локальное (deleteContact): никаких писем-
      // уведомлений, никаких замков, никаких повторных отправок. Старые письма
      // удалённого контакта помечаются tombstone по uid и не воскрешают его.
      try {
        const contactAccepts = await api.fetchPendingContactAccepts();
        if (contactAccepts.length) {
          // fetchPendingContactAccepts пишет ключи на диск (save_peer_key),
          // но НЕ в this.peerKeys — перечитываем с диска, иначе selectChat
          // не найдёт ключ и предложит «добавить контакт».
          await this.loadStoredPeerKeys();
          await this.loadContacts();
          await this.loadGroups();
        }
      } catch (e) {
        console.error('processInvites: contact accepts failed:', e);
      }
      // Собираем непрочитанные инвайты для попапа согласия.
      try {
        const invites = await api.fetchPendingInvites();
        // Вырезаем инвайты, которые уже обрабатываются (accept в полёте —
        // письмо ещё в ящике, а groups_import мог ещё не завершиться).
        const fresh = invites.filter(
          inv => !this.handledInviteKeys.includes(`${inv.group_id}|${inv.uid}`)
        );
        if (fresh.length) {
          // Пока попап показан, очередью управляют accept/decline (splice) —
          // перезапись от поллинга сбивала invitePopupIndex посреди разбора.
          if (!this.showInvitePopup) {
            this.pendingInvites = fresh;
            this.invitePopupIndex = 0;
            this.showInvitePopup = true;
          }
        } else if (!this.showInvitePopup) {
          this.pendingInvites = [];
        }
      } catch (e) {
        console.error('processInvites: invites failed:', e);
      }
      // Запросы контактов 1-на-1 — попап «Принять/Отклонить».
      try {
        const contacts = await api.fetchPendingContactInvites();
        const fresh = contacts.filter(
          c => !this.handledContactKeys.includes(`${c.sender}|${c.uid}`)
        );
        if (fresh.length) {
          if (!this.showContactPopup) {
            this.pendingContacts = fresh;
            // Групповой попап имеет приоритет; контактный покажем следом.
            if (!this.showInvitePopup) {
              this.contactPopupIndex = 0;
              this.showContactPopup = true;
            }
          }
        } else if (!this.showContactPopup) {
          this.pendingContacts = [];
        }
      } catch (e) {
        console.error('processInvites: contact invites failed:', e);
      }
      try {
        this.loadProfiles();
      } catch (e) {
        console.error('processInvites: loadProfiles failed:', e);
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
      const key = `${inv.group_id}|${inv.uid}`;
      if (!this.handledInviteKeys.includes(key)) this.handledInviteKeys.push(key);
      // Попап закрываем СРАЗУ — медленный SMTP (accept-письмо) не должен
      // висеть в UI. Поллинг инвайт повторно не покажет (handledInviteKeys).
      this.pendingInvites.splice(this.invitePopupIndex, 1);
      this.showInvitePopup = false;
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
        // Аватар группы из инвайта — сохраняем в kv_store (как у админа).
        if (inv.group_avatar) {
          await db.kvSet('anon', 'group-avatar:' + inv.group_id, inv.group_avatar);
          this.groupAvatars[inv.group_id] = inv.group_avatar;
        }
        await this.loadGroups();
        if (this.currentGroup?.id === inv.group_id) {
          await this.loadGroupMessages(inv.group_id);
        }
      } catch (e) {
        alert('Failed to accept invite: ' + e.message);
        // Не приняли — возвращаем инвайт в очередь для повторной попытки.
        const i = this.handledInviteKeys.indexOf(key);
        if (i >= 0) this.handledInviteKeys.splice(i, 1);
        this.pendingInvites.push(inv);
      }
      this.showNextInvite();
    },
    async declineInvite(inv) {
      const key = `${inv.group_id}|${inv.uid}`;
      if (!this.handledInviteKeys.includes(key)) this.handledInviteKeys.push(key);
      this.pendingInvites.splice(this.invitePopupIndex, 1);
      this.showInvitePopup = false;
      try {
        await api.declineGroupInvite(inv.group_id, inv.uid, inv.sender);
      } catch (e) {
        // ignore
      }
      this.showNextInvite();
    },
    showNextInvite() {
      clearTimeout(this._nextInviteTimer);
      if (this.pendingInvites.length > 0) {
        if (this.invitePopupIndex >= this.pendingInvites.length) this.invitePopupIndex = 0;
        // Небольшая задержка: попап должен заметно исчезнуть после
        // принять/отклонить, а не «сменить содержимое» без закрытия.
        this._nextInviteTimer = setTimeout(() => {
          if (this.pendingInvites.length && !this.showInvitePopup) {
            this.showInvitePopup = true;
          }
        }, 1200);
      } else {
        this.showInvitePopup = false;
        // Групповой попап закрыт — показываем накопившиеся запросы контактов.
        if (this.pendingContacts.length) {
          this._nextInviteTimer = setTimeout(() => {
            if (this.pendingContacts.length && !this.showContactPopup) {
              this.showContactPopup = true;
            }
          }, 1200);
        }
      }
    },
    // --- Контакты 1-на-1: принять/отклонить запрос (Session-модель) ---
    async acceptContactInvite(c) {
      const key = `${c.sender}|${c.uid}`;
      if (!this.handledContactKeys.includes(key)) this.handledContactKeys.push(key);
      // Попап закрываем СРАЗУ — accept-письмо идёт через медленный SMTP.
      this.pendingContacts.splice(this.contactPopupIndex, 1);
      try {
        await crypto.savePeerKey(c.sender, c.public_key, c.sender_name || null);
        // Вечная пометка «инвайт обработан» — иначе после удаления контакта
        // старое письмо-инвайт снова покажет попап приглашения.
        await api.markAcceptedContact(key);
        // Ключ ОБЯЗАТЕЛЬНО в память — иначе контакт виден в списке (строится
        // с диска), но selectChat не найдёт ключ и предложит «добавить контакт».
        this.peerKeys[c.sender] = c.public_key;
        this.peerKeysLoaded[c.sender] = true;
        await api.addContact(c.sender);
        api.saveProfile(c.sender, c.sender_name, c.sender_avatar);
        this.loadProfiles();
        // Отвечаем своим публичным ключом — у пригласившего появится наш контакт.
        await api.sendContactAccept(c.sender, this.publicKey);
        await this.loadContacts();
      } catch (e) {
        alert('Failed to accept contact: ' + e.message);
        // Не приняли — возвращаем запрос в очередь для повторной попытки.
        const i = this.handledContactKeys.indexOf(key);
        if (i >= 0) this.handledContactKeys.splice(i, 1);
        this.pendingContacts.push(c);
      }
      this.showNextContact();
    },
    async declineContactInvite(c) {
      const key = `${c.sender}|${c.uid}`;
      if (!this.handledContactKeys.includes(key)) this.handledContactKeys.push(key);
      this.pendingContacts.splice(this.contactPopupIndex, 1);
      try {
        // Помечаем отклонённым в sqlite kv_store (localStorage не источник).
        await api.markDeclinedContact(key);
      } catch (e) { /* ignore */ }
      this.showNextContact();
    },
    showNextContact() {
      clearTimeout(this._nextContactTimer);
      if (this.pendingContacts.length > 0) {
        if (this.contactPopupIndex >= this.pendingContacts.length) this.contactPopupIndex = 0;
        // Задержка: попап должен заметно исчезнуть, а не «сменить содержимое».
        this._nextContactTimer = setTimeout(() => {
          if (this.pendingContacts.length && !this.showContactPopup) {
            this.showContactPopup = true;
          }
        }, 1200);
      } else {
        this.showContactPopup = false;
      }
    },
    async inviteContactById(email) {
      const id = (email || '').trim();
      if (!id) return;
      // Уже в контактах — не шлём повторный запрос (защита от дублей).
      if (this.peerKeys[id] || this.peerKeys[id.toLowerCase()]) {
        alert(this.t('already_in_contacts') || 'Этот контакт уже в вашем списке');
        return;
      }
      try {
        await api.sendContactInvite(id, this.publicKey);
        alert((this.t('invite_sent') || 'Приглашение отправлено') + ': ' + id);
      } catch (e) {
        alert('Failed to send invite: ' + e.message);
      }
    },
    async deleteContact(email) {
      if (!(await confirm(this.t('contact_delete_confirm') || 'Удалить контакт? Его ключ шифрования будет удалён.'))) return;
      try {
        // МОДЕЛЬ DELTA CHAT (22.08): удаление СТРОГО ЛОКАЛЬНОЕ — никаких писем
        // второй стороне (Contact::delete в deltachat-core тоже локальный).
        await crypto.removePeerKey(email);
        // Старые handshake-письма от удалённого контакта (invite/accept)
        // помечаем обработанными по uid — не воскрешат контакт. НОВЫЕ
        // приглашения от него после удаления доходят (uid не помечен) —
        // повторное добавление тривиально, как Contact::create в DC.
        await api.markContactHandshakeDone(email);
        // Если мы приглашали этого отправителя — снимаем, чтобы его старое
        // accept-письмо не авто-добавило контакт заново.
        await api.removeInvitedSender(email);
        // Чистим и in-memory stubs api.js — иначе контакт «не удаляется»
        // до перезапуска (getContacts() мержит stubs с диском).
        await api.removeContact(email);
        delete this.peerKeys[email];
        delete this.peerKeysLoaded[email];
        if (this.activeChat === email) {
          this.activeChat = null;
          this.activeChatType = 'chat';
        }
        await this.loadContacts();
      } catch (e) {
        alert('Failed to delete contact: ' + e.message);
      }
    },
    // --- Профили (имя/аватар отправителей в групповых чатах) ---
    profileOf(email) {
      return this.profiles[email] || null;
    },
    // Локальные переопределения (per-account): пользователь сам решает, как
    // называть контакт и какой аватар ему ставить. Приоритет выше, чем у
    // синхронизированного профиля собеседника.
    localProfileOf(email) {
      return this.localProfiles[email] || null;
    },
    nameOf(email) {
      const lp = this.localProfileOf(email);
      if (lp && lp.name) return lp.name;
      const p = this.profileOf(email);
      return (p && p.name) || email;
    },
    avatarOf(email) {
      const lp = this.localProfileOf(email);
      if (lp && lp.avatar) return lp.avatar;
      const p = this.profileOf(email);
      return (p && p.avatar) || '';
    },
    loadLocalProfiles() {
      try {
        // SQLite kv_store (20.08 — localStorage запрещён как источник истины).
        db.kvGet(this.email || 'anon', 'local-profiles').then(v => {
          if (v) this.localProfiles = JSON.parse(v);
        }).catch(() => {});
        this.localProfiles = this.localProfiles || {};
      } catch (e) {
        this.localProfiles = {};
      }
    },
    saveLocalProfiles() {
      try {
        db.kvSet(this.email || 'anon', 'local-profiles', JSON.stringify(this.localProfiles)).catch(() => {});
      } catch (e) {
        console.error('Failed to save local profiles:', e);
      }
    },
    // Модалка редактирования контакта (локальные имя/аватар).
    openContactEdit(email) {
      if (!email) return;
      this.editingContact = email;
      const lp = this.localProfileOf(email);
      this.editContactName = (lp && lp.name) || '';
      this.editContactAvatar = (lp && lp.avatar) || '';
      this.showContactEdit = true;
    },
    async handleContactAvatarSelect(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        // Сжимаем до 64×64, как и свои аватары (localStorage не резиновый).
        this.editContactAvatar = await this.shrinkAvatar(e.target.result);
      };
      reader.readAsDataURL(file);
      event.target.value = '';
    },
    saveContactEdit() {
      const email = this.editingContact;
      if (!email) return;
      const name = this.editContactName.trim();
      const avatar = this.editContactAvatar || '';
      if (!name && !avatar) {
        // Пусто = сброс к реальным имени/аватару собеседника.
        delete this.localProfiles[email];
      } else {
        this.localProfiles[email] = { name, avatar };
      }
      this.saveLocalProfiles();
      // Обновляем отображение в списке контактов (contact.name берётся из
      // peer-key label — подменяем на локальное имя, если задано).
      const c = this.contacts.find(x => x.email === email);
      if (c) c.name = name || this.nameOf(email);
      this.showContactEdit = false;
      this.editingContact = null;
    },
    resetContactEdit() {
      if (this.editingContact) {
        delete this.localProfiles[this.editingContact];
        this.saveLocalProfiles();
        const c = this.contacts.find(x => x.email === this.editingContact);
        if (c) c.name = this.nameOf(this.editingContact);
      }
      this.showContactEdit = false;
      this.editingContact = null;
    },
    async loadProfiles() {
      try {
        this.profiles = await api.getProfilesAll();
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
.remember-label { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; color: var(--text-secondary, #8b949e); font-size: 13px; cursor: pointer; user-select: none; }
.remember-label input { width: auto; margin: 0; cursor: pointer; }
.server-toggle { display: flex; align-items: center; gap: 6px; background: none; border: none; color: var(--text-secondary, #8b949e); font-size: 13px; cursor: pointer; padding: 6px 0; margin: 4px 0; width: 100%; text-align: left; }
.server-toggle:hover { color: var(--text-primary, #e6edf3); }
.server-toggle-arrow { margin-left: auto; }
.server-settings { background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border, #30363d); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.server-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.server-row label { width: 44px; font-size: 12px; color: var(--text-secondary, #8b949e); flex-shrink: 0; }
.server-row input { flex: 1; margin: 0; padding: 6px 8px; font-size: 13px; }
.server-row .server-port { flex: 0 0 64px; }
.server-row select.server-provider { flex: 1; margin: 0; padding: 6px 8px; font-size: 13px; background: var(--bg-secondary, #161b22); color: var(--text-primary, #e6edf3); border: 1px solid var(--border, #30363d); border-radius: 6px; }
.server-hint { margin: 0; font-size: 11px; color: var(--text-secondary, #8b949e); }
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
  /* Android edge-to-edge: контент рисуется под статус-бар. Добавляем
     safe-area-inset-top, чтобы иконки не залезали под него и не прилипали.
     На десктопе inset = 0 — правило ничего не меняет. */
  padding-top: calc(20px + var(--safe-top, 0px));
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
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  object-fit: cover;
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
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-actions button:hover {
  background: var(--bg-hover);
}

.header-actions .group-create-btn {
  padding: 8px;
}

.group-create-icon {
  display: block;
  filter: drop-shadow(0 0 4px rgba(139, 92, 246, 0.5));
  transition: filter var(--transition-fast), transform 0.15s;
}

.header-actions .group-create-btn:hover .group-create-icon {
  transform: scale(1.1);
  filter: drop-shadow(0 0 6px rgba(139, 92, 246, 0.8));
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

/* Contact edit modal (локальные имя/аватар контакта) */
.contact-edit-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 380px;
}
.contact-edit-email {
  font-size: 13px;
  color: var(--text-secondary, #888);
  word-break: break-all;
  margin: 0;
}
.contact-edit-name-input {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-secondary, #1e1e2e);
  border: 1px solid var(--border-subtle, #333);
  border-radius: var(--radius-md, 8px);
  color: var(--text-primary, #eee);
  font-size: 14px;
  outline: none;
}
.contact-edit-name-input:focus {
  border-color: var(--accent-primary, #6366f1);
}
.contact-edit-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}
.contact-edit-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  margin-top: 4px;
}
.contact-edit-footer-right {
  display: flex;
  gap: 8px;
}
.contact-edit-btn {
  padding: 9px 18px;
  border-radius: var(--radius-md, 8px);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.15s;
}
.contact-edit-btn--primary {
  background: var(--accent-primary, #6366f1);
  color: white;
}
.contact-edit-btn--primary:hover {
  background: var(--accent-hover, #5558e6);
}
.contact-edit-btn--ghost {
  background: transparent;
  color: var(--text-secondary, #999);
  border: 1px solid var(--border-subtle, #333);
}
.contact-edit-btn--ghost:hover {
  color: var(--text-primary, #eee);
  border-color: var(--text-secondary, #666);
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
  min-height: 0;
  overflow-y: auto;
  /* Android: последний контакт не прятался под системной навигацией */
  padding-bottom: var(--safe-bottom, 0px);
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

/* Бейдж непрочитанных сообщений на контакте/группе — оранжевый кружок
   с белой цифрой. Появляется только когда есть >0. */
.unread-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--accent-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  display: inline-block;
  flex-shrink: 0;
}

/* Бейдж «нет ключа» — контакт виден (напр. из участников группы), но для
   чата 1-на-1 нужно сначала обменяться ключами (🔗). */
.contact-no-key {
  font-size: 12px;
  opacity: 0.7;
  cursor: help;
}

/* Удаление контакта — появляется при наведении на контакт */
.contact-delete {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  opacity: 0;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
}

.contact-item:hover .contact-delete {
  opacity: 0.55;
}

.contact-item:hover .contact-delete:hover {
  opacity: 1;
  background: rgba(220, 60, 60, 0.18);
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
  display: flex;
  align-items: center;
  gap: 6px;
}

.groups-header-icon {
  display: block;
  flex-shrink: 0;
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

/* Загруженный аватар группы (изображение вместо буквы/иконки) */
.group-avatar-img {
  object-fit: cover;
  background: var(--bg-secondary);
}

/* Заметки для себя: пункт сайдбара и аватар-эмодзи в чате */
.notes-self-avatar {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
}

.notes-self-avatar-lg {
  width: 40px;
  height: 40px;
  font-size: 18px;
}

.notes-self-icon {
  display: block;
  filter: drop-shadow(0 0 4px rgba(139, 92, 246, 0.4));
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
  position: relative;
  /* min-width/min-height: 0 — без них flex-ребёнок не сжимается меньше
     контента: список сообщений выпирает и выталкивает поле ввода за экран. */
  min-width: 0;
  min-height: 0;
}

.chat-header {
  flex-shrink: 0;
  padding: 16px 24px;
  /* Android edge-to-edge: на узких экранах чат занимает всю ширину и шапка
     оказывается под статус-баром — отступ через safe-area-inset-top. */
  padding-top: calc(16px + var(--safe-top, 0px));
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
  /* flex:1 + min-width:0 — без них имя чата не сжимается и выталкивает
     кнопки действий за экран (узкие экраны android). */
  flex: 1;
  min-width: 0;
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

/* Аватар + email мелким шрифтом под ним (email убран из центра шапки,
   чтобы длинные адреса не прижимались к кнопкам действий). */
.chat-avatar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  max-width: 96px;
}

.chat-avatar-email {
  font-size: 10px;
  line-height: 1.2;
  color: var(--text-muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-header-info h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-status {
  font-size: 12px;
  color: var(--text-muted);
}

.chat-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
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
  /* Ключевой фикс прокрутки: flex-элемент с overflow:auto обязан иметь
     min-height: 0, иначе он растягивается на высоту контента и скролл
     (в т.ч. колесиком мыши) не появляется. */
  min-height: 0;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative; /* offsetTop элементов считается от этого контейнера */
}

/* Закреплённое сообщение группы (баннер поверх списка) */
.pinned-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.35);
  border-radius: 10px;
  cursor: pointer;
  flex-shrink: 0;
  font-size: 13px;
}
.pinned-banner-icon { flex-shrink: 0; }

/* Reply-иконка в баре ответа/редактирования */
.reply-bar-ic { flex-shrink: 0; }
.pinned-banner-text {
  flex: 1;
  color: var(--text-primary, #f1f5f9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pinned-banner-unpin {
  background: transparent;
  border: none;
  color: var(--text-muted, #64748b);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 6px;
}
.pinned-banner-unpin:hover { background: rgba(255,255,255,0.1); color: var(--text-primary, #f1f5f9); }

/* Подсветка позиции при перетаскивании заметок */
.drag-over-before { box-shadow: 0 -2px 0 0 var(--accent-primary, #6366f1); }
.drag-over-after { box-shadow: 0 2px 0 0 var(--accent-primary, #6366f1); }

/* Стрелка «вниз к последним сообщениям» */
.jump-to-bottom {
  position: absolute;
  bottom: 96px;
  right: 24px;
  z-index: 5;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: var(--accent-primary, #6366f1);
  color: #fff;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}
.jump-to-bottom:hover { filter: brightness(1.12); }

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
  /* Текст сообщений можно выделять и копировать (WebKitGTK требует
     явного разрешения). */
  user-select: text;
  cursor: text;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.message.own .message-content {
  background: linear-gradient(135deg, var(--accent-primary), #4f46e5);
  border-bottom-left-radius: var(--radius-lg);
  border-bottom-right-radius: 4px;
}

/* Reply (quote a message, like other messengers) */
.reply-quote {
  color: var(--text-primary, #e2e8f0);
  background: rgba(99, 102, 241, 0.10);
  border-left: 3px solid var(--accent-primary, #6366f1);
  border-radius: 0 8px 8px 0;
  padding: 6px 10px;
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

/* Copy button (visible on hover) — рядом с reply-btn */
.copy-btn {
  position: absolute;
  top: 12px;
  right: 42px;
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

.message:hover .copy-btn {
  opacity: 1;
}

.copy-btn:hover {
  background: var(--bg-hover, #1e1e4a);
  color: var(--text-primary, #f1f5f9);
}

/* Edit button (visible on hover) — только свои сообщения */
.pin-btn {
  position: absolute;
  top: 12px;
  right: 76px;
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: var(--radius-sm, 6px);
  color: var(--text-secondary, #94a3b8);
  cursor: pointer;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
  font-size: 13px;
}
.message:hover .pin-btn {
  opacity: 1;
}
.pin-btn:hover {
  background: var(--bg-hover, #1e1e4a);
  color: var(--text-primary, #f1f5f9);
}

.edit-btn {
  position: absolute;
  top: 12px;
  right: 110px;
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

.message:hover .edit-btn {
  opacity: 1;
}

.edit-btn:hover {
  background: var(--bg-hover, #1e1e4a);
  color: var(--text-primary, #f1f5f9);
}

/* Delete button (visible on hover) — только свои сообщения */
.delete-btn {
  position: absolute;
  top: 12px;
  right: 144px;
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

.message:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

/* Удалённое сообщение — плейсхолдер */
.message-deleted {
  color: var(--text-secondary, #94a3b8);
  font-style: italic;
  font-size: 13px;
  opacity: 0.7;
}

/* Touch-устройства (Android): hover нет, а абсолютно позиционированные
   кнопки (reply/copy/pin/edit/delete) ВИСЯТ поверх текста сообщения и
   закрывают его. Поэтому на touch они полностью скрыты — все действия
   доступны через long-press контекстное меню сообщения (message-menu). */
@media (hover: none) and (pointer: coarse) {
  .reply-btn,
  .copy-btn,
  .pin-btn,
  .edit-btn,
  .delete-btn {
    display: none;
  }
}

/* Бейдж «отредактировано» */
.message-edited-badge {
  color: var(--text-secondary, #94a3b8);
  font-size: 11px;
  margin-left: 4px;
  opacity: 0.7;
}

/* Edit bar — подсветка при редактировании */
.edit-bar {
  border-top: 1px solid var(--accent-primary, #6366f1);
}

/* Контекстное меню сообщения (правый клик) */
.message-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
}

.message-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-hover, rgba(255,255,255,0.1));
  border-radius: var(--radius-md, 10px);
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.5));
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.message-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 6px);
  color: var(--text-primary, #f1f5f9);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.message-menu button:hover {
  background: var(--bg-hover, #1e1e4a);
}

/* Reply quote bar above the message input */
.reply-bar {
  flex-shrink: 0;
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
  cursor: pointer;
}

/* Инлайн-показ текстовых вложений (txt/md/json/csv/код) */
.attachment-text {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 0;
  max-width: 480px;
  max-height: 320px;
  overflow: auto;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.attachment-dl-btn {
  display: inline-block;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-primary, #fff);
}

.attachment-audio {
  width: 260px;
  max-width: 100%;
  height: 36px;
}

/* Image viewer (полноэкранный просмотр вложения-изображения) */
.image-viewer-overlay {
  display: flex;
  align-items: center;
  justify-content: center;
}

.image-viewer {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.image-viewer-img {
  max-width: 90vw;
  max-height: 78vh;
  object-fit: contain;
  border-radius: 8px;
}

.image-viewer-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.image-viewer-name {
  color: inherit;
  opacity: 0.8;
  font-size: 13px;
}

/* Members count (кликабельный счётчик участников в шапке группы) */
.members-count {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.members-count-icon {
  display: block;
  flex-shrink: 0;
  filter: drop-shadow(0 0 3px rgba(139, 92, 246, 0.4));
}

/* Members list (модалка со списком участников группы) */
.member-list {
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  overflow-y: auto;
}

.member-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}

.member-item__info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.member-item__email {
  font-size: 13px;
}

.member-item__role {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  opacity: 0.8;
}

.member-invited-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.18);
  color: var(--accent-primary, #818cf8);
  white-space: nowrap;
}

.role--admin {
  background: rgba(255, 152, 0, 0.25);
  color: #ff9800;
}

.role--moderator {
  background: rgba(33, 150, 243, 0.25);
  color: #2196f3;
}

.role--member {
  background: rgba(158, 158, 158, 0.25);
  color: #9e9e9e;
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

/* Статус исходящего — маленький цветной кружок:
   красный = отправка, жёлтый = отправлено,
   зелёный = доставлено, синий = просмотрено */
.message-status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.message-status-dot.sending { background: #ef4444; }
.message-status-dot.failed { background: #ef4444; }
.message-status-dot.sent { background: #eab308; }
.message-status-dot.delivered { background: #22c55e; }
.message-status-dot.read { background: #3b82f6; }

/* Typing indicator */
.typing-indicator {
  flex-shrink: 0;
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
  /* Сообщения не должны сжиматься по высоте внутри flex-колонки .messages —
     иначе при длинной переписке они сплющиваются вместо прокрутки. */
  flex-shrink: 0;
}

/* Chat search bar */
.chat-search-bar {
  flex-shrink: 0;
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

.export-btn {
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-action-icon {
  display: block;
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
  /* Закреплена внизу чата при любой длине переписки (как в других
     мессенджерах): не сжимается и не уходит за экран. */
  flex-shrink: 0;
  padding: 16px 24px;
  /* Android: не уходить под системную навигацию (виртуальные кнопки/жесты) */
  padding-bottom: calc(16px + var(--safe-bottom, 0px));
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
   Responsive: мобильная навигация (Telegram/Delta Chat паттерн)
   ═══════════════════════════════════════════════════════════════ */
/* 19.08: @media (max-width:768px) скрывал .main-area display:none, и ВСЕ
   модалки (QR add-contact, settings, invite popups) рендерились ВНУТРИ
   .main-area → «add contact/settings not responding» (модалка открывалась
   невидимой). Это лечится НЕ возвратом display:none на main-area, а
   переносом оверлеев в корень app-container (сделано 21.08: showKeyManager,
   showQRCode, showSettings, все popup'ы — теперь вне .main-area).
   На мобильном (<768px): показывается ОДНА панель за раз через классы
   .mobile-hidden (sidebar скрыт при открытом чате, main-area скрыт при
   закрытом). В ландшафте/на десктопе — обе панели как раньше. */
.mobile-hidden {
  display: none !important;
}

@media (max-width: 767px) {
  .sidebar {
    width: 100%;
  }
  .main-area {
    width: 100%;
  }
  /* Шапка чата на узком экране: все кнопки обязаны умещаться.
     Текстовые подписи групповых кнопок скрываются (иконка + title
     остаются), отступы уменьшаются, имя чата обрезается многоточием. */
  .chat-header {
    padding: 10px 12px;
    /* safe-area сохраняется и в узкоэкранном режиме (иначе шапка чата
       залезает под статус-бар Android). */
    padding-top: calc(10px + var(--safe-top, 0px));
    gap: 6px;
  }
  .chat-header-info {
    gap: 10px;
  }
  .chat-header-info h3 {
    font-size: 15px;
  }
  .chat-status {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chat-actions {
    gap: 2px;
  }
  .chat-actions button {
    padding: 6px;
  }
  .chat-actions button.chat-action-btn {
    padding: 6px 8px;
    border: none;
  }
  .chat-action-label {
    display: none;
  }
}

/* Кнопка «назад» в шапке чата (только мобильный режим). */
.chat-back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-full, 999px);
  color: var(--text-secondary, #94a3b8);
  cursor: pointer;
}
.chat-back-btn:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #e2e8f0);
}

/* Попапы инвайтов/контактов/добавления участника используют modal-settings,
   но им нужны внутренние отступы (у самого modal-settings их нет — туда
   вставляется SettingsPage, который сам занимает всё пространство). */
.invite-popup-panel {
  padding: 20px 24px 24px;
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
.add-member-contact.selected {
  background: var(--bg-hover, #1e1e4a);
  outline: 1px solid var(--accent-primary, #6366f1);
}
.add-member-checkbox {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border: 1.5px solid var(--border-color, #444);
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  background: transparent;
}
.add-member-checkbox.checked {
  background: var(--accent-primary, #6366f1);
  border-color: var(--accent-primary, #6366f1);
}
.add-member-selected-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.add-member-chip {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 12px;
  background: var(--bg-hover, #1e1e4a);
  color: var(--text-primary, #fff);
  cursor: pointer;
}
.add-member-chip:hover {
  opacity: 0.8;
}
.add-member-invite-btn {
  width: 100%;
  margin-top: 12px;
}

/* ── Sender line in group messages ── */
.message-sender {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  padding-left: 4px;
}
.message-sender-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted, #aaa);
}
</style>
