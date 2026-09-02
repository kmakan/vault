<template>
  <div class="app-container">
    <!-- Duress-замок (t_b185e3e2): поверх всего UI до ввода кода -->
    <LockScreen
      v-if="duressLocked"
      @unlock="onLockUnlock"
      @duress="onLockDuress"
      @panic="onLockPanic"
    />
    <!-- Диагностика duress-замка: показывается ТОЛЬКО при сбое (в норме не видна).
         Формулировки с 'err'/'error'/'prefs err' означают разрыв JNI-моста. -->
    <div v-if="duressDiag && /err|error|panic|fail/i.test(duressDiag)" style="position:fixed;left:8px;bottom:6px;z-index:10000;font-size:11px;color:#f87171;pointer-events:none;background:rgba(11,15,23,.7);padding:2px 8px;border-radius:6px">[duress] {{ duressDiag }}</div>
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
            <Icon name="settings" :size="14" /> {{ t('server_settings') || 'Настройки сервера' }}
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

          <!-- Восстановление аккаунта (Key Recovery, 25.08): для тех, кто уже
               пользовался Vault и потерял ключи (новое устройство/переустановка).
               Раскрывается по клику — не мешает новому пользователю. -->
          <button type="button" class="server-toggle" @click="showRecovery = !showRecovery">
            <Icon name="shield" :size="14" /> {{ t('recovery_toggle') }}
            <span class="server-toggle-arrow">{{ showRecovery ? '▾' : '▸' }}</span>
          </button>
          <div v-if="showRecovery" class="server-settings recovery-login">
            <p class="server-hint">{{ t('recovery_hint') }}</p>
            <textarea
              v-model="recoveryWordsInput"
              class="recovery-input"
              :placeholder="t('recovery_words_ph')"
              rows="2"
            ></textarea>
            <div class="recovery-file-row">
              <label class="btn-secondary recovery-file-label">
                {{ t('recovery_file_label') }}
                <input type="file" accept=".json,application/json" style="display:none" @change="onRecoveryFilePicked" />
              </label>
              <span v-if="recoveryFileName" class="recovery-filename">{{ recoveryFileName }}</span>
              <span v-else class="recovery-filename muted">{{ t('recovery_file_optional') }}</span>
            </div>
            <button type="button" class="btn-primary" :disabled="loginLoading || !recoveryWordsInput.trim()" @click="loginWithRecovery">
              {{ loginLoading ? '...' : t('recovery_btn') }}
            </button>
          </div>

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

        <!-- Заметки для себя: локальный чат с собой.
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
          @contextmenu="openChatMenu({ type: 'contact', email: contact.email }, $event)"
        >
          <UserAvatar :email="contact.email" :avatarUrl="avatarOf(contact.email)" :size="36" />
          <div class="contact-info">
            <div class="contact-name">{{ nameOf(contact.email) }}</div>
            <div class="contact-email">{{ contact.email }}</div>
          </div>
          <div class="contact-status">
            <span v-if="unreadOf(contact.email)" class="unread-badge">{{ unreadOf(contact.email) }}</span>
            <Icon v-if="isMuted(contact.email.toLowerCase())" name="bell-off" :size="14" cls="chat-mute-icon" :title="t('chat_muted') || 'Без звука'" />
            <span v-if="!peerKeys[contact.email]" class="contact-no-key" :title="t('contact_no_key_hint') || 'Нет ключа собеседника — обменяйтесь ключами через 🔗 (по id участника или QR)'">🔓</span>
            <span v-if="isRecentlySeen(contact.email)" class="status-dot online" title="Недавно видели"></span>
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
            v-for="group in filteredGroups" 
            :key="group.id"
            :class="['contact-item', { active: activeChat === `group:${group.id}` }]"
            @click="selectGroup(group)"
            @contextmenu="openChatMenu({ type: 'group', id: group.id }, $event)"
          >
            <img v-if="groupAvatars[group.id]" :src="groupAvatars[group.id]" class="group-avatar group-avatar-img" :alt="group.name" />
            <div v-else class="group-avatar">
              {{ groupIconMap[group.id] || group.name.charAt(0).toUpperCase() }}
            </div>
            <div class="contact-info">
              <div class="contact-name">{{ group.name }}</div>
              <div class="contact-email">{{ (group.members || []).length }} {{ membersLabel((group.members || []).length) }}</div>
            </div>
            <div class="contact-status">
              <span v-if="unreadOf('group:' + group.id)" class="unread-badge">{{ unreadOf('group:' + group.id) }}</span>
              <Icon v-if="isMuted('group:' + group.id)" name="bell-off" :size="14" cls="chat-mute-icon" :title="t('chat_muted') || 'Без звука'" />
            </div>
          </div>
        </div>
        <!-- N5: переключатель архива (виден, когда есть архивные чаты) -->
        <!-- v-if: показываем и когда showArchived=true, даже если архив
             опустел — иначе после «из архива» последнего чата переключатель
             исчезал и выйти из режима архива было нельзя (баг 28.08) -->
        <div v-if="hasArchivedChats || showArchived" class="archive-toggle" @click="showArchived = !showArchived">
          <Icon :name="showArchived ? 'eye-off' : 'archive'" :size="14" />
          <span>{{ showArchived ? (t('chat_hide_archive') || 'Скрыть архив') : (t('chat_show_archive') || 'Показать архив') }}</span>
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
              <button class="chat-avatar-btn" :title="'Профиль ' + (nameOf(activeChat) || activeChat)" @click="openContactCard(activeChat)">
                <UserAvatar :email="activeChat" :avatarUrl="avatarOf(activeChat)" :size="40" />
              </button>
              <div class="chat-avatar-col">
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
                  {{ peerKeys[activeChat] ? '🔒' : '⚠️' }}<span class="chat-enc-text">{{ peerKeys[activeChat] ? ' Encrypted' : ' No key' }}</span>
                </template>
              </div>
            </div>
          </div>
          <div class="chat-actions">
            <template v-if="activeChatType === 'group'">
              <button v-if="isGroupAdmin" class="chat-action-btn" @click="openAddMemberPopup" :title="t('add_member') || 'Добавить участника'"><Icon name="user-plus" :size="17" /><span class="chat-action-label">{{ t('add_member') || 'Добавить участника' }}</span></button>
              <button class="chat-action-btn" :title="t('group_refresh') || 'Перечитать группу (полный скан)'" @click="refreshGroupFull"><Icon name="refresh" :size="17" /></button>
              <button class="chat-action-btn" @click="showGroupSettings = !showGroupSettings" :title="t('group_settings') || 'Настройки группы'"><Icon name="settings" :size="17" /><span class="chat-action-label">{{ t('group_settings') || 'Настройки' }}</span></button>
            </template>
            <template v-else-if="activeChat && activeChat !== '__notes__'">
              <!-- Замок-индикатор был убран по просьбе пользователя (25.08). -->
              <button v-if="expCalls && peerKeys[activeChat]" class="chat-action-btn" @click="startCall" :title="t('call_start') || 'Позвонить'"><Icon name="phone" :size="17" /></button>
              <button class="chat-action-btn" @click="openContactEdit(activeChat)" :title="t('contact_edit') || 'Локальные имя и аватар контакта'"><Icon name="pencil" :size="17" /></button>
            </template>
            <!-- Исчезающие сообщения (25.08): таймер для этого чата.
                 Единый стиль с chat-action-btn; состояние — цвет иконки
                 (серый выкл / янтарный вкл) и заливка кнопки. -->
            <div v-if="activeChat && activeChat !== '__notes__'" class="ephemeral-menu">
              <button class="chat-action-btn ephemeral-btn" :class="{ 'ephemeral-on': currentEphemeralTtl > 0 }"
                :title="'Исчезающие сообщения' + (currentEphemeralTtl ? ': вкл (' + ephemeralLabel(currentEphemeralTtl) + '), новые сообщения будут исчезать' : ' — выключены')"
                @click="showEphemeralMenu = !showEphemeralMenu">
                <Icon name="lock" :size="17" :color="currentEphemeralTtl > 0 ? '#f59e0b' : '#8b949e'" />
              </button>
              <div v-if="showEphemeralMenu" class="export-menu ephemeral-dropdown">
                <button v-for="opt in ephemeralOptions" :key="opt.v"
                  :class="{ active: currentEphemeralTtl === opt.v }"
                  @click="applyEphemeral(opt.v)">
                  {{ opt.label }}
                </button>
              </div>
            </div>
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
            :class="['message', { own: msg.from === 'me', 'call-event': !!msg.callEvent, 'drag-over-before': dragOverNoteId === msg.id && dragOverPos === 'before', 'drag-over-after': dragOverNoteId === msg.id && dragOverPos === 'after' }]"
            :draggable="activeChat === '__notes__'"
            @dragstart="onNoteDragStart($event, msg)"
            @dragover="onNoteDragOver($event, msg)"
            @dragleave="onNoteDragLeave($event, msg)"
            @drop="onNoteDrop($event, msg)"
            @dragend="draggedNoteId = null; dragOverNoteId = null; dragOverPos = null"
            @click.stop="toggleReactionPicker(msg.id)"
            @contextmenu.prevent="openMessageMenu($event, msg)"
          >
            <!-- Звонки (27.08): «пилюля» пропущенного/завершённого вызова —
                 центрированная, в стиле Telegram. Текст только через t(). -->
            <div v-if="msg.callEvent" class="call-pill" :class="'call-pill--' + msg.callEvent.kind">
              <Icon :name="callPillIcon(msg)" :size="13" color="currentColor" />
              <span class="call-pill-label">{{ callEventLabel(msg) }}</span>
              <span class="call-pill-time">{{ msg.time }}</span>
              <button v-if="canCallBack(msg)" class="call-back-btn" :title="t('call_back')" @click.stop="callBack()">
                <Icon name="phone" :size="12" color="currentColor" />{{ t('call_back') }}
              </button>
            </div>
            <template v-else>
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
              <span v-html="linkify(replyBody(msg.content))" @click="onMessageTextClick"></span>
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
            </template>
          </div>
        </div>

        <!-- Стрелка «вниз к последним сообщениям» (длинные чаты) — поверх чата,
             вне scroll-контейнера, чтобы не уезжала вместе с контентом -->
        <button v-if="showJumpToBottom" class="jump-to-bottom" :title="t('jump_to_bottom') || 'К последним сообщениям'" @click="jumpToBottom"><Icon name="arrow-down" :size="18" /></button>

        <!-- Контекстное меню сообщения (правый клик / долгое нажатие):
           reply/copy/pin/edit/delete. На touch hover-кнопки скрыты
           (см. media (hover: none)), всё доступно отсюда. -->
        <div v-if="messageMenu" class="message-menu-overlay" @click="messageMenu = null" @contextmenu.prevent="messageMenu = null">
          <div class="message-menu" :style="{ left: messageMenu.x + 'px', top: messageMenu.y + 'px' }" @click.stop>
            <button v-if="!messageMenu.msg.callEvent" @click="setReply(messageMenu.msg); messageMenu = null"><Icon name="reply" :size="14" /> {{ t('chat_reply_to') || 'Ответить' }}</button>
            <button v-if="!messageMenu.msg.callEvent" @click="copyMessageText(messageMenu.msg); messageMenu = null"><Icon name="copy" :size="14" /> {{ t('copy_text') || 'Копировать текст' }}</button>
            <button v-if="!messageMenu.msg.callEvent" @click="copyMessageAll(messageMenu.msg); messageMenu = null"><Icon name="copy" :size="14" /> {{ t('copy_all') || 'Копировать всё' }}</button>
            <button v-if="!messageMenu.msg.callEvent && activeChatType === 'group' && isGroupAdmin" @click="pinGroupMessage(messageMenu.msg); messageMenu = null"><Icon name="pin" :size="14" /> {{ t('pin_message') || 'Закрепить' }}</button>
            <button v-if="messageMenu.msg.from === 'me' && !messageMenu.msg.deleted" @click="startEditMessage(messageMenu.msg); messageMenu = null"><Icon name="pencil" :size="14" /> {{ t('edit_message') || 'Редактировать' }}</button>
            <button v-if="messageMenu.msg.from === 'me' && !messageMenu.msg.deleted" @click="deleteMessage(messageMenu.msg); messageMenu = null"><Icon name="trash" :size="14" /> {{ t('delete_message') || 'Удалить' }}</button>
            <!-- «Удалить у меня» (31.08): любые сообщения (свои, чужие) и пилюли звонков;
                 только своё устройство, у собеседника остаётся. -->
            <button @click="deleteMessageForMe(messageMenu.msg); messageMenu = null"><Icon name="trash" :size="14" /> {{ t('delete_for_me') || 'Удалить у меня' }}</button>
            <!-- Телефоны/ссылки из текста: по кнопке на каждый (может быть несколько) -->
            <template v-if="messageMenu.phones && messageMenu.phones.length">
              <div class="message-menu-sep"></div>
              <button v-for="(p, pi) in messageMenu.phones" :key="'ph' + pi" @click="copyText(p); messageMenu = null"><Icon name="phone" :size="14" /> {{ p }}</button>
            </template>
            <template v-if="messageMenu.urls && messageMenu.urls.length">
              <div class="message-menu-sep"></div>
              <button v-for="(u, ui) in messageMenu.urls" :key="'ur' + ui" @click="openExternal(u).catch(() => {}); messageMenu = null"><Icon name="link" :size="14" /> {{ u.length > 40 ? u.slice(0, 40) + '…' : u }}</button>
            </template>
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
        <KeyManager @close="showKeyManager = false" @keys-changed="onKeysChanged" @recovery-created="onRecoveryCreated" />
      </div>
    
      <div v-if="showQRCode" class="qr-code-overlay">
        <QRCodePanel 
          :publicKey="publicKey" 
          :myEmail="email" 
          :myFingerprint="fingerprint"
          @close="showQRCode = false"
          @key-scanned="addPeerKey"
          @invite-by-id="inviteContactById"
        />
      </div>

      <!-- ЗВОНОК (M3, feature/calls): сигнализация call_* конвертами.
           Медиа (webrtc-rs) — Фаза 2; сейчас состояние + таймер + 🔒. -->
      <CallOverlay
        v-if="callState !== 'idle' && currentCall"
        :state="callState"
        :peer="currentCall.peer"
        :peer-name="callPeerName"
        :avatar-url="avatarOf(currentCall.peer)"
        :muted="callMuted"
        :speaker="callSpeaker"
        :media-connected="callMediaConnected"
        :elapsed="callElapsedLabel"
        :texts="callTexts"
        @accept="acceptCall"
        @reject="rejectCall"
        @cancel="cancelCall"
        @end="endCall"
        @toggle-mute="toggleMute"
        @toggle-speaker="toggleSpeaker"
      />

      <!-- CIPHER TOOL -->
      <CipherTool v-if="showCipher" :peerKeys="peerKeys" :contacts="contacts" @close="showCipher = false" @open-keys="showCipher = false; showKeyManager = true" />

      <!-- SETTINGS MODAL -->
      <div v-if="showSettings" class="modal-overlay" @click.self="showSettings = false">
        <div class="modal-settings">
          <button class="modal-close-x" @click="showSettings = false"><Icon name="x" :size="20" /></button>
          <SettingsPage :email="email" :userAvatarUrl="userAvatarUrl" :displayName="displayName" :bio="myBio" @avatar-update="onAvatarUpdate" @icon-changed="onAppIconChanged" @logout="handleLogout" @name-update="onNameUpdate" @change-email="openChangeEmail" @bio-save="onBioSave" @profile-save="onProfileSave" @experiments-calls="onExperimentsCalls" @autoclean-change="runAutoclean" />
        </div>
      </div>

      <!-- CHANGE EMAIL MODAL (24.08): смена почты без потери контактов/групп.
           Поля как при входе: email + пароль (+ серверы при необходимости).
           Ключи E2E не трогаются — контакты узнают новый адрес по тому же
           fingerprint (см. broadcastProfile + fingerprint-матчинг). -->
      <div v-if="showChangeEmail" class="modal-overlay" @click.self="showChangeEmail = false">
        <div class="modal-settings change-email-panel">
          <button class="modal-close-x" @click="showChangeEmail = false"><Icon name="x" :size="20" /></button>
          <h3 class="invite-popup-title"><Icon name="mail" :size="18" /> {{ t('settings_change_email') || 'Сменить почту' }}</h3>
          <p class="change-email-hint">Контакты и группы останутся: ключи E2E не привязаны к адресу. После смены отправьте сообщение или профиль — собеседники узнают новый адрес автоматически.</p>
          <form @submit.prevent="changeEmail">
            <input v-model="newEmail" type="email" placeholder="Новый email" required class="change-email-input" />
            <input v-model="newPassword" type="password" placeholder="Пароль приложения / от внешних устройств" required class="change-email-input" />
            <div class="change-email-row">
              <button type="button" class="server-toggle" @click="showChangeEmailServers = !showChangeEmailServers"><Icon name="settings" :size="14" /> {{ t('server_settings') || 'Настройки сервера' }}</button>
            </div>
            <div v-if="showChangeEmailServers" class="server-settings">
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
            </div>
            <div v-if="changeEmailError" class="login-error">{{ changeEmailError }}</div>
            <div class="change-email-actions">
              <button type="button" @click="showChangeEmail = false" class="btn btn-ghost">Отмена</button>
              <button type="submit" :disabled="changeEmailLoading" class="btn btn-primary">{{ changeEmailLoading ? 'Подключение…' : 'Сменить почту' }}</button>
            </div>
          </form>
        </div>
      </div>

      <!-- INVITE POPUP (приглашение в группу с согласием) -->
      <div v-if="showInvitePopup && pendingInvites.length" class="modal-overlay" @click.self="showInvitePopup = false">
        <div class="modal-settings invite-popup-panel">
          <button class="modal-close-x" @click="showInvitePopup = false"><Icon name="x" :size="20" /></button>
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
          <button class="modal-close-x" @click="showContactPopup = false"><Icon name="x" :size="20" /></button>
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
          <button class="modal-close-x" @click="showAddMemberPopup = false"><Icon name="x" :size="20" /></button>
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
          <button class="modal-close-x" @click="showAvatarUpload = false"><Icon name="x" :size="20" /></button>
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
      <!-- Карточка контакта (25.08): тап по аватару в шапке чата -->
      <div v-if="showContactCard && contactCardEmail" class="modal-overlay" @click.self="showContactCard = false">
        <div class="modal-content contact-card-panel">
          <button class="modal-close-x" @click="showContactCard = false"><Icon name="x" :size="20" /></button>
          <div class="contact-card-head">
            <UserAvatar :email="contactCardEmail" :avatarUrl="avatarOf(contactCardEmail)" :size="72" />
            <div class="contact-card-id">
              <h3>{{ nameOf(contactCardEmail) }}</h3>
              <p class="contact-card-email">{{ contactCardEmail }}</p>
            </div>
          </div>
          <div v-if="contactCardBio" class="contact-bio-view">«{{ contactCardBio }}»</div>
          <p v-else class="contact-bio-empty">{{ contactCardEmail === email ? 'Добавьте статус в Настройки → Профиль' : 'Контакт ещё не добавил статус «О себе»' }}</p>
          <div class="contact-card-footer">
            <span class="contact-card-seen" :class="{ online: isRecentlySeen(contactCardEmail) }">
              {{ isRecentlySeen(contactCardEmail) ? 'Недавно видели' : 'Не в сети' }}
            </span>
            <button class="btn btn-primary btn-sm" @click="startEditFromCard">Изменить локально</button>
          </div>
        </div>
      </div>
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
            @rename-group="onGroupRename"
            @clone="cloneGroup"
          />
        </div>
      </div>




    <!-- Image viewer (полноэкранный просмотр вложения-изображения) -->
    <div v-if="viewingImage" class="modal-overlay image-viewer-overlay" @click.self="closeImageViewer">
      <div class="image-viewer">
        <button class="modal-close-x" @click="closeImageViewer"><Icon name="x" :size="20" /></button>
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
        <button class="modal-close-x" @click="showMembersList = false"><Icon name="x" :size="20" /></button>
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
          <button class="modal-close-x" @click="showCreateGroup = false"><Icon name="x" :size="20" /></button>
        </div>
        <div class="modal-body">
          <label>{{ t('group_name') || 'Group Name' }}</label>
          <input
            v-model="newGroupName"
            :placeholder="(t('group_name') || 'Group Name') + '...'"
            class="modal-input"
            @keyup.enter="createGroupAndClose"
          />
          <label>Аватар группы</label>
          <div class="new-group-avatar-row">
            <div class="new-group-avatar" @click="$refs.groupAvatarInput.click()">
              <img v-if="newGroupAvatar" :src="newGroupAvatar" alt="" />
              <div v-else class="new-group-avatar__placeholder"><Icon name="camera" :size="22" /></div>
            </div>
            <span class="new-group-avatar__hint">Нажмите, чтобы загрузить фото</span>
            <input ref="groupAvatarInput" type="file" accept="image/png,image/jpeg,image/webp" style="display:none" @change="onNewGroupAvatarSelected" />
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
    <!-- N5: контекстное меню чата (долгое нажатие / правый клик).
         Корневой уровень (28.08): раньше лежал в .main-area, который на
         мобильном скрыт при экране списка — меню открывалось «за экраном». -->
    <div v-if="chatMenu.show" class="message-menu-overlay" @click="closeChatMenu" @contextmenu.prevent="closeChatMenu">
      <div class="message-menu chat-menu" :style="{ left: chatMenu.x + 'px', top: chatMenu.y + 'px' }" @click.stop>
        <button @click="toggleArchive()">
          <Icon name="archive" :size="14" />
          {{ chatFlagOf(flagKey(chatMenu.target)).archived ? (t('chat_unarchive') || 'Из архива') : (t('chat_archive') || 'В архив') }}
        </button>
        <button @click="toggleMute()">
          <Icon :name="isMuted(flagKey(chatMenu.target)) ? 'bell' : 'bell-off'" :size="14" />
          {{ isMuted(flagKey(chatMenu.target)) ? (t('chat_unmute') || 'Со звуком') : (t('chat_mute') || 'Без звука') }}
        </button>
      </div>
    </div>
    <!-- Тост-уведомление (Key Recovery и пр.) -->
    <transition name="fade">
      <div v-if="toastMessage" class="app-toast">{{ toastMessage }}</div>
    </transition>
  </div>
</template>

<script>
import { invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import api, { db } from './api.js';
import crypto from './crypto.js';
import { initNotifications, notifyNewMessage } from './notify.js';
// ws.js удалён (16.08): WebSocket к backend (localhost:9443) мёртв — backend
// убран в serverless-архитектуре. Typing-индикатор вернётся с транспортом на M3.
import { useI18n } from './i18n.js';
import SettingsPage from './components/SettingsPage.vue';
import CallOverlay from './components/CallOverlay.vue';
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
import LockScreen from './components/LockScreen.vue';

// Сайт приложения (лендинг, веха M4). Пока сайта нет — пустая строка:
// когда появится, подставить адрес (vault-msg.ru / vault-msg.tech),
// и клик по логотипу в шапке откроет его во внешнем браузере.
const APP_SITE_URL = '';

export default {
  name: 'ChatApp',
  components: {
    LockScreen,
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
    QRCodePanel,
    CallOverlay
  },
  setup() {
    const { t, setLocale, availableLocales, currentLocale } = useI18n();
    return { t, setLocale, availableLocales, currentLocale };
  },
  data() {
    return {
      currentView: 'chats',
      // Мобильная навигация (Telegram/почтовый мессенджер паттерн): на узком экране
      // видна ОДНА панель — список чатов ИЛИ открытый чат на весь экран.
      // mobileChatOpen=true — показан чат (main-area), кнопка «назад» в шапке.
      mobileChatOpen: false,
      // Счётчики непрочитанных по чатам (email | 'group:<id>' → число).
      // Хранятся в sqlite kv_store (НЕ localStorage — он запрещён как
      // источник данных Vault); сбрасываются при открытии чата.
      unreadCounts: {},
      // N5 (28.08, паритет Delta Chat): флаги чатов email|'group:<id>' →
      // { archived, muted }. Архив скрыт из основного списка (переключатель
      // «Показать архив»), mute — без звука/без пуш-уведомления (счётчик
      // непрочитанных остаётся). Персист в sqlite kv 'chat-flags'.
      chatFlags: {},
      showArchived: false,
      // Контекстное меню чата (долгое нажатие / правый клик в списке).
      chatMenu: { show: false, target: null },
      // Идемпотентность счётчиков: uid|folder уже обработанных писем
      // (персист в kv 'unread-seen') — каждое письмо считается один раз.
      processedUnreadIds: new Set(),
      // ── Звонки (M3, feature/calls): сигнализация конвертами call_* ──
      // callState: idle | outgoing_ringing | incoming_ringing | active
      callState: 'idle',
      currentCall: null,
      lastCallId: null,   // { call_id, peer }
      callMuted: false,
      callSpeaker: false,
      // Реально ли пошёл звук (событие call-media-connected из Rust, 27.08).
      // До этого оверлей показывает «Соединение…» вместо таймера.
      callMediaConnected: false,
      callClockSec: 0,
      callClockTimer: null,
      callRingTimer: null,
      callResendTimer: null,
      // IMAP IDLE-цикл (Фаза 1.5): активность/флаг остановки.
      _idleActive: false,
      _idleStop: false,
      // ЗВУКИ ЗВОНКА (27.08, редизайн): WAV-ассеты. Desktop — cpal в Rust
      // (media_sound_play), Android — HTML5 Audio (элемент держим здесь).
      callSoundEl: null,
      // Настройки рингтонов (27.08, Настройки → Звонки): имена WAV-вариантов
      // без префикса ring_ и суффикса .wav. Загружаются из kv_store.
      callRingtoneIncoming: 'incoming',
      callRingtoneOutgoing: 'outgoing',
      // Момент начала текущего звонка — для авто-сброса «зомби» (звонка,
      // зависшего в ringing дольше разумного; см. handleCallSignal).
      callStartedAt: 0,
      // Ширина окна — для определения мобильного режима (<768px).
      windowWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
      windowHeight: typeof window !== 'undefined' ? window.innerHeight : 800,
      appIconId: 'letter',
      // Смена почты (24.08): форма как при входе, ключи не трогаются.
      showChangeEmail: false,
      showChangeEmailServers: false,
      newEmail: '',
      newPassword: '',
      changeEmailLoading: false,
      changeEmailError: '',
      contacts: [],
      contactAliases: {},
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
      // PQ (30.08): ML-KEM ek контактов {email: b64}
      peerPqKeys: {},
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
      // Аватар новой группы (dataUrl) — как в аккаунте: фото вместо эмодзи-иконок.
      newGroupAvatar: '',
      // Тост-уведомление внизу экрана (Key Recovery и пр.)
      toastMessage: '',
      toastTimer: null,
      // Исчезающие сообщения (25.08): активные таймеры удаления
      // { msgKey: timeoutId }, msgKey = chatId + ':' + msgId
      ephemeralTimers: {},
      ephemeralTick: 0,
      showEphemeralMenu: false,
      currentEphemeralTtl: 0,
      myBio: '',
      // Зелёная точка (25.08): email → ts последней активности контакта
      // (входящее письмо/квитанция). Не онлайн-статус: «видели за 10 мин».
      lastSeenMap: {},
      // Экспериментальные функции (25.08): флаг звонков
      expCalls: false,
      ephemeralOptions: [
        { v: 0, label: 'Выкл' },
        { v: 300, label: '5 мин' },
        { v: 3600, label: '1 час' },
        { v: 86400, label: '1 день' },
        { v: 604800, label: '1 неделя' },
      ],
      // Восстановление аккаунта на экране входа (Key Recovery)
      showRecovery: false,
      recoveryWordsInput: '',
      recoveryFileJson: '',
      recoveryFileName: '',
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
      showContactCard: false,
      contactCardEmail: '',
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
    // Статус «О себе» редактируемого контакта (из profile-конверта)
    editingContactBio() {
      if (!this.editingContact) return '';
      const p = this.profiles[this.editingContact];
      return (p && p.bio) || '';
    },
    // Мобильный режим: узкий экран ПО ЛЮБОЙ стороне (28.08). Раньше был
    // только порог по ширине (<768) — телефон в ландшафте (800×360 CSS-px)
    // попадал в десктопную двухпанельную раскладку: сайдбар 320px + пустая
    // чёрная правая часть. Как в Telegram: телефон остаётся однопанельным
    // при повороте. Порог по высоте (<480) ниже любого реального
    // десктопного окна, но типичная высота телефона в ландшафте.
    isMobile() {
      return this.windowWidth < 768 || this.windowHeight < 480;
    },
    // На Android WebView userAgent содержит 'Android' — надёжнее, чем ширина.
    isAndroid() {
      return /android/i.test(navigator.userAgent || '');
    },
    // Карточка контакта (тап по аватару в шапке)
    contactCardBio() {
      if (!this.contactCardEmail) return '';
      const p = this.profiles[this.contactCardEmail];
      return (p && p.bio) || '';
    },
    appIconUrl() {
      return `/icons/vault-${this.appIconId}.svg`;
    },
    emailInitials() {
      if (!this.email) return '?';
      return this.email.split('@')[0].substring(0, 2).toUpperCase();
    },
    filteredContacts() {
      // N5: архивные чаты скрыты из основного списка (показываются только
      // при showArchived). Поиск работает по видимому подмножеству.
      let list = this.contacts.filter(c =>
        !!(this.chatFlags[c.email.toLowerCase()] || {}).archived === this.showArchived);
      if (!this.searchQuery) return list;
      const q = this.searchQuery.toLowerCase();
      return list.filter(c => {
        return c.email.toLowerCase().includes(q) || this.nameOf(c.email).toLowerCase().includes(q);
      });
    },
    filteredGroups() {
      return this.groups.filter(g =>
        !!(this.chatFlags['group:' + g.id] || {}).archived === this.showArchived);
    },
    hasArchivedChats() {
      return Object.values(this.chatFlags).some(f => f && f.archived);
    },
    // ── Звонки (M3): строки и таймер для оверлея ──
    callTexts() {
      return {
        incoming: this.t('call_incoming') || 'Входящий звонок…',
        outgoing: this.t('call_outgoing') || 'Вызов…',
        accept: this.t('call_accept') || 'Принять',
        reject: this.t('call_reject') || 'Отклонить',
        cancel: this.t('call_cancel') || 'Отменить',
        end: this.t('call_end') || 'Завершить',
        accepted: this.t('call_accepted') || 'Соединено',
        connecting: this.t('call_connecting') || 'Соединение…',
        mute: this.t('call_mute') || 'Выключить микрофон',
        unmute: this.t('call_unmute') || 'Включить микрофон',
        speaker: this.t('call_speaker') || 'Динамик',
        acceptHint: this.t('call_accept_hint') || '',
        rejectHint: this.t('call_reject_hint') || '',
        noMedia: this.t('call_no_media') || '',
      };
    },
    callElapsedLabel() {
      const s = this.callClockSec;
      return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    },
    callPeerName() {
      const c = this.currentCall;
      if (!c) return '';
      // nameOf() — единый резолвер имени (localProfile → свежий профиль →
      // email). Раньше здесь был contact.name — сырое поле из БД контактов,
      // оно НЕ обновляется при смене профиля собеседником, и оверлей звонка
      // показывал устаревшее имя, хотя список контактов — новое.
      return this.nameOf(c.peer);
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
      // Единый резолвер (27.08): свежий профиль из писем важнее кэша
      // contacts[].name (label peer-ключа устаревает — шапка показывала
      // старое имя, хотя в списке контактов уже новое). Fallback на label,
      // если профиля с именем нет.
      const n = this.nameOf(this.activeChat);
      if (n && n !== this.activeChat) return n;
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
    // Duress-замок: включён ли (до авторизации)
    this.checkDuressLock();
    applyTheme(loadSavedTheme())
    applyFont(loadSavedFont())
    // НАТИВНЫЕ КНОПКИ УВЕДОМЛЕНИЯ ЗВОНКА (0.1.91, простая схема юзера):
    // Kotlin (CallActionReceiver) дергает window.__vaultAcceptCall() /
    // __vaultRejectCall() через живой keep-alive WebView. JS-машина сама
    // делает acceptCall/rejectCall: call_accept/reject уходит почтой,
    // экран звонка открывается штатно — БЕЗ второго свайпа.
    try {
      window.__vaultAcceptCall = () => {
        console.log('[call] native ACCEPT tapped');
        this.acceptCall();
      };
      window.__vaultRejectCall = () => {
        console.log('[call] native REJECT tapped');
        this.rejectCall();
      };
    } catch (e) { /* не критично */ }
    // Событие «медиа подключено» из Rust (27.08): ICE/DTLS установлены и
    // Раньше таймер шёл с момента accept, а SDP шёл по почте до 54с —
    // пользователь видел «минуту тишины» при работающем таймере.
    this._unlistenMediaConnected = tauriListen('call-media-connected', (ev) => {
      const cid = ev && ev.payload && ev.payload.callId;
      if (cid && this.currentCall && this.currentCall.call_id === cid) {
        this.callMediaConnected = true;
        // Медиа установлено — ретрансляция accept/answer больше не нужна.
        this.stopSignalResend();
        // «Можно говорить» (28.08): яркий сигнал в момент РЕАЛЬНОГО
        // соединения медиа — играет у ОБОИХ абонентов (событие приходит
        // на каждой стороне при ICE Connected + старте пайплайна).
        this.playCallSound('connected', false);
        // Таймер разговора — с момента реального звука, не с момента accept.
        this.startCallClock();
      }
    }).catch(e => console.warn('[call] listen media-connected failed:', e));
    // МГНОВЕННЫЙ HANGUP (28.08): собеседник положил трубку — «hangup»
    // пришёл по WebRTC DataChannel за миллисекунды (не ждём call_end
    // по email 30-60с). Завершаем локально.
    this._unlistenRemoteHangup = tauriListen('call-remote-hangup', (ev) => {
      const cid = ev && ev.payload && ev.payload.callId;
      console.log('[call] DC remote hangup received, call_id=' + cid);
      if (cid && this.currentCall && this.currentCall.call_id === cid) {
        this.hangup('remote');
      }
    }).catch(e => console.warn('[call] listen remote-hangup failed:', e));
    // СОСТОЯНИЕ ICE (28.08): единственный надёжный сигнал о разрыве, когда
    // DataChannel уже мёртв и email call_end не дошёл (корень бага «экран
    // с красной кнопкой не закрывается»). disconnected → grace 10с (сеть
    // может восстановиться), потом hangup; failed/closed → hangup сразу.
    this._unlistenConnState = tauriListen('call-connection-state', (ev) => {
      const p = ev && ev.payload;
      const cid = p && p.callId;
      const st = p && p.state;
      if (!cid || !this.currentCall || this.currentCall.call_id !== cid) return;
      console.log('[call] connection state:', st);
      if (st === 'connected') {
        if (this._connLostTimer) { clearTimeout(this._connLostTimer); this._connLostTimer = null; }
      } else if (st === 'disconnected') {
        if (!this._connLostTimer) {
          this._connLostTimer = setTimeout(() => {
            this._connLostTimer = null;
            if (this.currentCall && this.currentCall.call_id === cid) {
              console.log('[call] ICE disconnected grace expired — hanging up');
              this.hangup('remote');
            }
          }, 10000);
        }
      } else if (st === 'failed' || st === 'closed') {
        if (this._connLostTimer) { clearTimeout(this._connLostTimer); this._connLostTimer = null; }
        this.hangup('remote');
      }
    }).catch(e => console.warn('[call] listen connection-state failed:', e));
    // Rust IDLE-монитор (t_64e7241a): «mail-changed» приходит из tokio-таска,
    // НЕ от JS-цикла — доставка писем/звонков живёт даже при замершем WebView.
    // Обработка идемпотентна к JS-поллингу: дедуп по uid|folder + processedUnreadIds.
    this._unlistenMailChanged = tauriListen('mail-changed', async (ev) => {
      const p = ev && ev.payload;
      if (!p) return;
      if (p.cursors) { try { this.saveCursors(this.email, p.cursors); } catch (e) { /* kv */ } }
      const msgs = p.messages || [];
      if (!msgs.length) return;
      // ДИАГНОСТИКА (29.08): видно ли вообще, что монитор что-то принёс.
      console.log('[idle-monitor] mail-changed msgs=' + msgs.length);
      const merged = [...this.emails];
      const seen = new Set(merged.map(m => m.uid + '|' + (m.folder || 'INBOX')));
      for (const m of msgs) {
        const k = m.uid + '|' + (m.folder || 'INBOX');
        if (!seen.has(k)) { seen.add(k); merged.push(m); }
      }
      merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      if (merged.length > 2000) merged.length = 2000;
      this.emails = merged;
      await this.processIncoming(msgs, { notify: true });
    }).catch(e => console.warn('[idle-monitor] listen failed:', e));
    // Настройки рингтонов (27.08, Настройки → Звонки) — из kv_store.
    try {
      const ri = await db.kvGet('anon', 'call-ringtone-incoming');
      const ro = await db.kvGet('anon', 'call-ringtone-outgoing');
      if (ri) this.callRingtoneIncoming = ri;
      if (ro) this.callRingtoneOutgoing = ro;
    } catch (e) { /* тихо — дефолтные рингтоны */ }
    // Мобильная навигация: следим за шириной окна (поворот телефона),
    // чтобы переключать одну-панель-за-раз.
    this.onWindowResize = () => {
      this.windowWidth = window.innerWidth;
      this.windowHeight = window.innerHeight;
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
          this.myBio = await this.getBio(); // статус «О себе» (Key: profile-конверт)
          this.expCalls = (await db.kvGet('anon', 'exp-calls')) === '1';
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
          this.loadChatFlags(); // N5: архив/mute чатов из sqlite kv_store
          this.runAutoclean(); // N6: плановая автоочистка при входе
          this.startPolling()
          this.idleLoop(); // постоянный IMAP IDLE — быстрая доставка звонков (~1с)
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
    // Слушатели Tauri-событий звонка (27-28.08).
    if (this._unlistenMediaConnected) { this._unlistenMediaConnected(); this._unlistenMediaConnected = null; }
    if (this._unlistenRemoteHangup) { this._unlistenRemoteHangup(); this._unlistenRemoteHangup = null; }
    if (this._unlistenConnState) { this._unlistenConnState(); this._unlistenConnState = null; }
    if (this._connLostTimer) { clearTimeout(this._connLostTimer); this._connLostTimer = null; }
  },
  methods: {
    // ── Звуки звонка (27.08, редизайн): WAV-ассеты вместо осциллятора ──
    // Desktop: cpal в Rust (media_sound_play) — слышно при свёрнутом окне,
    // не зависит от autoplay WebKitGTK. Android: HTML5 Audio из
    // /sounds/*.wav (cpal там паникует; WebView разрешает autoplay —
    // wry ставит mediaPlaybackRequiresUserGesture=false).
    //
    // КРИТИЧНО (27.08, корень бага «call_accept не ушёл»): эти функции
    // ДОЛЖНЫ быть в methods, НЕ в computed. В computed Vue 3 превращает
    // их в геттеры: this.playCallSound(...) вызывает тело БЕЗ аргументов,
    // и this.isAndroid() бросает TypeError (computed возвращает false,
    // false() — не функция). Синхронный бросок рвал acceptCall ДО
    // отправки call_accept, incoming_ringing — ДО рингтона и таймера,
    // startCall — ДО гудков и ретрансляции. Плюс: функция НИКОГДА не
    // должна бросать — звук вторичен, сигнализация звонка важнее.
    playCallSound(name, looped) {
      try {
        // Настройки звонков (27.08): пользователь мог выбрать другой рингтон
        // (Настройки → Звонки). Маппим incoming/outgoing на выбранный вариант.
        const ringIn = this.callRingtoneIncoming || 'incoming';
        const ringOut = this.callRingtoneOutgoing || 'outgoing';
        if (name === 'incoming') name = ringIn;
        else if (name === 'outgoing') name = ringOut;
        if (this.isAndroid) {
          this.stopCallSound();
          const el = new Audio('/sounds/ring_' + name + '.wav');
          el.loop = !!looped;
          el.volume = 0.85;
          el.play().catch(e => console.warn('[call] sound play failed:', e));
          this.callSoundEl = el;
          // Одноразовые звуки: освобождаем элемент по окончании.
          if (!looped) {
            el.onended = () => { if (this.callSoundEl === el) this.callSoundEl = null; };
          }
        } else {
          api.mediaSoundPlay(name, !!looped).catch(e => console.warn('[call] sound play failed:', e));
        }
      } catch (e) {
        // Звук не критичен — глотаем, чтобы не рвать state machine звонка.
        console.warn('[call] sound failed:', e && e.message || e);
      }
    },
    stopCallSound() {
      try {
        if (this.callSoundEl) {
          try { this.callSoundEl.pause(); } catch (_) {}
          this.callSoundEl = null;
        }
        if (!this.isAndroid) {
          api.mediaSoundStop().catch(() => {});
        }
      } catch (e) {
        console.warn('[call] sound stop failed:', e && e.message || e);
      }
    },
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
        // Сбрасываем перед загрузкой: удалённые в Rust ключи должны
        // пропасть из памяти (реактивно, 26.08).
        this.peerKeys = {};
        this.peerKeysLoaded = {};
        // PQ (30.08): ek ML-KEM-768 контактов (b64). Параллельная Map —
        // peerKeys остаётся X25519-строками (30+ использований не трогаем).
        this.peerPqKeys = {};
        const stored = await crypto.loadPeerKeys();
        for (const pk of stored) {
          this.peerKeys[pk.email] = pk.public_key;
          this.peerKeysLoaded[pk.email] = true;
          if (pk.pq_public_key) this.peerPqKeys[pk.email] = pk.pq_public_key;
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
        this.loadChatFlags(); // N5: архив/mute чатов из sqlite kv_store
        this.runAutoclean(); // N6: плановая автоочистка при входе
        this.loadLocalProfiles(); // локальные имена/аватары контактов (per-account)
        await this.loadBodyCache(); // персистентный кэш тел — мгновенное открытие чатов
        await this.loadContacts();
        await this.loadGroups();
        // Скорость входа: UI сразу, фетч почты в фоне (не блокирует вход).
        this.startPolling()
        this.idleLoop(); // постоянный IMAP IDLE — быстрая доставка звонков (~1с)
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
    // --- Смена почты (24.08) ---
    // Ключи E2E (keypair.json) не привязаны к email: меняем только транспорт.
    // Контакты/группы остаются в peer_keys.json/kv_store. Новый адрес уходит
    // контактам broadcast-письмом с тем же fingerprint — они обновят адрес
    // без новых приглашений (fingerprint-матчинг в processIncoming).
    openChangeEmail() {
      this.newEmail = '';
      this.newPassword = '';
      this.changeEmailError = '';
      this.showChangeEmailServers = false;
      this.showChangeEmail = true;
    },
    async changeEmail() {
      this.changeEmailLoading = true;
      this.changeEmailError = '';
      const oldEmail = this.email;
      try {
        const config = {};
        if (this.imapServer.trim()) config.imap_server = this.imapServer.trim();
        if (this.imapPort.trim()) config.imap_port = parseInt(this.imapPort.trim(), 10);
        if (this.smtpServer.trim()) config.smtp_server = this.smtpServer.trim();
        if (this.smtpPort.trim()) config.smtp_port = parseInt(this.smtpPort.trim(), 10);
        // Входим на новый ящик (сохраняем креды для автовхода). Ключ E2E не
        // перегенерируется — api.login только подключает почту.
        await api.login(this.newEmail.trim(), this.newPassword, { remember: true, config });
        this.stopPolling();
        // Переключаем сессию на новый email, не сбрасывая ключи/контакты/группы.
        this.email = this.newEmail.trim();
        this.password = this.newPassword;
        this.userId = this.email;
        this.isLoggedIn = true;
        this.connected = true;
        // Кэш имени привязан к аккаунту (namespace = email) — сбрасываем.
        api._displayName = undefined;
        // Смена почты (24.08): переносим локальные данные (история чатов,
        // счётчики, пометки) из namespace старого адреса в новый — иначе
        // переписка «исчезает» после смены (vault_msg@mail.ru → bk.ru).
        await this.migrateAccountData(oldEmail, this.email);
        await this.initLocalDb(); // курсоры/томбстоуны нового аккаунта
        await this.loadContacts(); // peer_keys общие — контакты остаются
        await this.loadGroups();
        this.startPolling();
        this.idleLoop();
        this.loadEmails().catch(() => {});
        // Сообщаем контактам новый адрес: broadcast-письмо несёт name/avatar
        // и key (тот же fingerprint) — получатели обновят адрес контакта.
        try { await this.broadcastProfile(); } catch (e) { console.error('[change-email] broadcast failed:', e); }
        console.log('[identity] email changed:', oldEmail, '→', this.email);
        this.showChangeEmail = false;
        this.showSettings = false;
        this.loadUnreadCounts();
      } catch (error) {
        this.changeEmailError = (error && error.message) || String(error);
      } finally {
        this.changeEmailLoading = false;
      }
    },
    async loadContacts() {
      try {
        const all = await api.getContacts();
        // Контакты — общий peer-key store на машину; себя не показываем.
        let list = (all || []).filter(c => c.email !== this.email);
        // Смена почты (24.08): один ключ может быть привязан к НЕСКОЛЬКИМ
        // адресам (старый + новый). Показываем только ПОСЛЕДНИЙ адрес —
        // старый становится псевдонимом (история чата переносится на новый).
        // Алиасы запоминаем для переноса истории (chat-cache).
        const byKey = new Map(); // key -> {contact, added_at}
        const aliasOf = {};      // newEmail -> [oldEmails]
        for (const c of list) {
          const k = c.public_key;
          if (!k) { byKey.set(c.email, { contact: c, added_at: c.added_at || '' }); continue; }
          const prev = byKey.get(k);
          if (!prev) { byKey.set(k, { contact: c, added_at: c.added_at || '' }); continue; }
          // Тот же ключ — выбираем более новый адрес (по added_at), старый — алиас.
          if ((c.added_at || '') >= (prev.added_at || '')) {
            (aliasOf[c.email] = aliasOf[c.email] || []).push(prev.contact.email);
            byKey.set(k, { contact: c, added_at: c.added_at || '' });
          } else {
            (aliasOf[prev.contact.email] = aliasOf[prev.contact.email] || []).push(c.email);
          }
        }
        list = [...byKey.values()].map(x => x.contact);
        this.contactAliases = aliasOf;
        this.contacts = list;
      } catch (error) {
        // /api/contacts may not exist yet
        this.contacts = [];
      }
    },
    // Смена почты (24.08): перенос всех локальных данных аккаунта из старого
    // namespace в новый (история чатов, счётчики, пометки, курсоры).
    async migrateAccountData(oldEmail, newEmail) {
      try {
        if (!oldEmail || !newEmail || oldEmail === newEmail) return;
        // Все строки kv: [account, key, value] — переносим принадлежащие
        // старому аккаунту (префиксные ключи истории/пометок).
        const all = await invoke('db_kv_get_all');
        if (!all || !all.length) return;
        let moved = 0;
        for (const [acc, k, v] of all) {
          if (acc !== oldEmail) continue;
          const relevant = k.startsWith('chat-cache:') || k.startsWith('unread-') ||
            k.startsWith('accepted-') || k.startsWith('declined-') ||
            k.startsWith('invited-') || k.startsWith('tombstone') ||
            k.startsWith('cursor-') || k.startsWith('processed-');
          if (!relevant) continue;
          const exists = await db.kvGet(newEmail, k);
          if (!exists) { await db.kvSet(newEmail, k, v); moved++; }
        }
        console.log('[identity] account data migrated:', oldEmail, '→', newEmail, 'moved', moved);
      } catch (e) {
        console.warn('[identity] migrateAccountData failed:', e);
      }
    },
    // Все адреса, привязанные к тому же ключу, что и email (алиасы).
    // Контакт мог сменить почту — старый и новый адреса имеют одинаковый ключ.
    // Используется в loadMessages (фильтр писем) и isOut (определение отправителя).
    aliasesOf(email) {
      const key = this.peerKeys[email || ''] || this.peerKeys[String(email || '').toLowerCase()];
      if (!key) return [String(email || '').toLowerCase()];
      const out = new Set([String(email || '').toLowerCase()]);
      for (const [k, v] of Object.entries(this.peerKeys)) {
        if (v === key) out.add(String(k).toLowerCase());
      }
      return [...out];
    },
    // Канонический адрес: какой контакт показывается для этого ключа
    // (после дедупликации в loadContacts). Если email — алиас, возвращаем
    // показываемый адрес (самый новый по added_at).
    canonicalOf(email) {
      const key = this.peerKeys[email || ''] || this.peerKeys[String(email || '').toLowerCase()];
      if (!key) return email;
      const shown = this.contacts.find(c => c.public_key === key);
      return shown ? shown.email : email;
    },
    // Смена почты (24.08): переносим историю чата со старого адреса на новый.
    // Вызывается при fingerprint-матчинге у ПОЛУЧАТЕЛЯ (поллинг/loadMessages).
    async migrateChatHistory(oldEmail, newEmail) {
      try {
        const ns = this.email || 'anon';
        const oldKey = 'chat-cache:' + oldEmail;
        const newKey = 'chat-cache:' + newEmail;
        const oldCache = await db.kvGet(ns, oldKey);
        if (oldCache) {
          const existing = await db.kvGet(ns, newKey);
          if (!existing) {
            await db.kvSet(ns, newKey, oldCache);
            console.log('[identity] chat history migrated:', oldEmail, '→', newEmail);
          }
        }
      } catch (e) {
        console.warn('[identity] migrateChatHistory failed:', e);
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
            // Модель почтовый мессенджер: удаление контакта НЕ трогает группы —
            // участник остаётся полноценным контактом в списке.
            seen.add(m.email);
            this.contacts.push({ id: m.email, email: m.email, name: m.email, online: false });
          }
        }
      } catch (error) {
        console.error('Failed to load groups:', error);
      }
    },
    setPeerKey(email, key, pq = null) {
      this.peerKeys[email] = key;
      // PQ (30.08): pq может прийти из конверта (env.pq) — сохраняем в
      // peerPqKeys и в peer_keys.json; null не трогает существующий.
      if (pq) this.peerPqKeys[email] = pq;
      crypto.setPeerPublicKey(key, this.peerPqKeys && this.peerPqKeys[email]);
      crypto.savePeerKey(email, key, null, pq || undefined).catch(err => {
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
      // TTL исчезающих для 1-на-1 — из kv (как selectGroup для групп): иначе
      // currentEphemeralTtl остаётся от ПРЕДЫДУЩЕГО чата, иконка замка врёт,
      // а старый fallback применял чужой TTL к сообщениям (баг 25.08).
      this.currentEphemeralTtl = await this.ephemeralTtlOf(email);
      this.currentView = 'chats';
      this.resetUnread(email); // чат открыт — сбрасываем счётчик непрочитанных
      this.openMobileChat();
      if (this.peerKeys[email]) {
        crypto.setPeerPublicKey(this.peerKeys[email], this.peerPqKeys && this.peerPqKeys[email]);
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
          // Пилюли звонков (27.08): без этого поля из кэша пропадают
          // «Пропущенный звонок» и т.п.
          callEvent: m.callEvent || undefined,
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
      hist = this.normalizeStaleSending(hist);
      // Сигнальные call_*-конверты (25.08): старые сборки сохраняли их в
      // историю как сырой JSON — не рендерим нигде.
      if (hist && hist.length) {
        hist = hist.filter(m => {
          const c = (m && m.content) || '';
          return !(typeof c === 'string' && c.indexOf('"type":"call_') !== -1);
        });
      }
      return hist;
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
      let hist = await this.loadLocalHistory(chatKey); // let: фильтр call_* ниже
      if (!hist || !hist.length) return list;
      // Звонки (25.08): сигнальные call_*-конверты, попавшие в историю
      // старыми сборками (до фильтра в loadMessages), не рендерим — они
      // «застревали» в чате как сырой JSON и не удалялись.
      hist = hist.filter(m => {
        const c = (m && m.content) || '';
        return !(typeof c === 'string' && (c.indexOf('"type":"call_') !== -1 || c.indexOf('"type": "call_') !== -1));
      });
      const ids = new Set();
      for (const m of hist) if (m && m.id) ids.add(m.id);
      // Исчезающие (25.08): старые записи истории могли быть сохранены БЕЗ
      // ttl/expireAt (до включения фичи или до фикса парсинга). Письмо то же —
      // обновляем таймер из свежераспарсенного env.
      for (const h of hist) {
        if (!h || !h.id) continue;
        const fresh = list.find((x) => x && x.id === h.id && x.expireAt);
        if (fresh && !h.expireAt) {
          h.ttl = fresh.ttl;
          h.expireAt = fresh.expireAt;
        }
      }
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
      this.showEphemeralMenu = false;
      this.currentEphemeralTtl = await this.ephemeralTtlOf('group:' + group.id);
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
    async buildEnvelope(text, ttl = 0) {
      const dn = this.displayName || (await api.getDisplayName()) || '';
      // Не слать email как имя: получатель считает name==email «нет имени»
      // (см. nameOf) — иначе он перезаписывает настоящее имя почтой.
      const name = dn && dn !== this.email ? dn : '';
      // Актуальный аватар из kv (как в broadcastProfile) — this.profiles
      // в памяти может отставать; иначе сообщение уходит со СТАРЫМ аватаром
      // и получатель перезаписывает новый (чехарда, 25.08).
      let avatar = (this.profiles[this.email] || {}).avatar || '';
      try {
        const kvProfiles = JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
        const kp = kvProfiles[String(this.email).toLowerCase()];
        if (kp && kp.avatar) avatar = kp.avatar;
      } catch (e) { /* ignore */ }
      const rawLen = avatar.length;
      avatar = await this.shrinkAvatar(avatar);
      const env = {
        vault: 1,
        id: this.newMessageId(),
        text: text,
        name: name,
        avatar: avatar,
        key: crypto.publicKey || '',
        ts: Date.now(),
      };
      // PQ (30.08): свой ML-KEM ek — получатель сохранит контакт и сможет
      // ответить гибридом (конверт несёт оба публичных ключа).
      if (crypto.pqEk) env.pq = crypto.pqEk;
      // Исчезающие сообщения (25.08): ttl в секундах от момента ПРОСМОТРА
      // получателем. 0 = обычное сообщение. Получатель ставит локальный
      // таймер удаления после показа (expireEphemeral).
      if (ttl && Number(ttl) > 0) env.ttl = Number(ttl);
      return JSON.stringify(env);
    },
    // Распарсить расшифрованный конверт. null = старый формат (простой текст).
    parseEnvelope(decrypted) {
      if (!decrypted || typeof decrypted !== 'string') return null;
      try {
        const obj = JSON.parse(decrypted);
        if (obj && obj.vault === 1 && typeof obj.text === 'string') {
          return { id: obj.id || '', text: obj.text, name: obj.name || '', avatar: obj.avatar || '', type: obj.type || '', ts: obj.ts || 0, key: obj.key || '', pq: typeof obj.pq === 'string' ? obj.pq : '', ttl: Number(obj.ttl) || 0, bio: typeof obj.bio === 'string' ? obj.bio : undefined };
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
    // «Удалить у меня» (31.08, паритет DC): убрать сообщение ТОЛЬКО со своего
    // устройства — свои и ЧУЖИЕ сообщения, а также пилюли звонков. У
    // собеседника остаётся. Механизм тот же tombstone (msg.id + Message-ID),
    // что у «удалить у всех»/ephemeral: mergeHistory/mergePending/поллинг
    // отфильтруют его навсегда, воскрешение из письма/All Mail невозможно.
    // Никаких писем не отправляется.
    async deleteMessageForMe(msg) {
      if (!msg || !msg.id) return;
      const chatKey = this.activeChatType === 'group' && this.currentGroup
        ? 'group:' + this.currentGroup.id
        : this.activeChat;
      if (!chatKey || chatKey === '__notes__') return;
      this.addTombstone(msg.id);
      this.addMidTombstone(msg.mid);
      const idx = this.messages.indexOf(msg);
      if (idx !== -1) this.messages.splice(idx, 1);
      this.saveCurrentHistory(chatKey);
      // chat-cache тоже обновляем: loadChatCache не фильтрует tombstones,
      // иначе при мгновенном открытии чата сообщение мигало бы из кэша.
      this.saveChatCache(chatKey, this.messages);
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
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat], this.peerPqKeys && this.peerPqKeys[this.activeChat]);
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
          // Звонки (M3): вычищаем call_* конверты, попавшие в историю как
          // сырые сообщения (баг до фильтра в loadMessages) — сигналы не
          // рендерятся ни в истории, ни в чате.
          this.messages = hist.filter(m => {
            const c = (m && m.content) || '';
            return !(typeof c === 'string' && (c.indexOf('"type":"call_') !== -1 || c.indexOf('"type":"profile"') !== -1));
          });
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
      // Смена почты (24.08): контакт мог сменить адрес — ищем письма по
      // ВСЕМ адресам с его ключом (алиасы), иначе история старого адреса
      // не видна в чате нового (vault_msg@mail.ru → bk.ru).
      const aliases = this.aliasesOf(email);
      const relatedAll = this.emails
        .filter(m => {
          const f = (m.from || '').toLowerCase();
          const t = (m.to || '').toLowerCase();
          return aliases.some(a => f.includes(a) || t.includes(a));
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
        crypto.setPeerPublicKey(this.peerKeys[email], this.peerPqKeys && this.peerPqKeys[email]);
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
          const isOut = aliases.some(a => (m.from || '').toLowerCase().includes(a));
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
              // Звонки (M3): call_* конверты — сигналы, НЕ сообщения. В истории
              // чата не рендерятся (как реакции/квитанции). Живая обработка —
              // в processIncoming (handleCallSignal); здесь просто пропуск.
              const callSig = this.parseCallSignal(text);
              if (callSig) return null; // не сообщение
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
              // Исчезающие (25.08): фикс области видимости — env объявлена здесь
              // (внутри try), а return ниже был ВНЕ неё → ReferenceError молча
              // ловился catch'ем и сообщение шло без ttl. Выносим в msgTtl.
              var msgTtl = 0;
              var msgExpireAt = 0;
              if (env && env.ttl) {
                const _mailTs = new Date(m.date || Date.now()).getTime() || Date.now();
                msgTtl = env.ttl;
                msgExpireAt = _mailTs + env.ttl * 1000;
              }
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
                // ЭХО-ЗАЩИТА (25.08): письмо с МОИМ ключом — от меня самого
                // (старый адрес после смены почты / копия в свой ящик). Не
                // матчим как «смену почты», не сохраняем профиль — иначе
                // свой же аватар перезаписывается старым из своего письма.
                if (env.key && crypto.publicKey && env.key === crypto.publicKey) {
                  return null;
                }
                // FINGERPRINT-МАТЧИНГ (24.08, смена почты): конверт несёт
                // публичный ключ отправителя. Если этот ключ уже известен
                // под ДРУГИМ email — собеседник сменил почту: привязываем
                // новый email к тому же контакту (копируем ключ), не требуя
                // нового приглашения. Как у почтовый мессенджер (contacts по fingerprint).
                if (env.key && !isOut) {
                  const senderNorm = String(sender).toLowerCase();
                  const knownByKey = Object.entries(this.peerKeys).find(
                    ([k, v]) => v === env.key && String(k).toLowerCase() !== senderNorm
                  );
                  if (knownByKey) {
                    const [oldEmail] = knownByKey;
                    console.log('[identity] fingerprint match:', oldEmail, '→', sender, '— смена почты');
                    // Переносим историю чата со старого адреса на новый.
                    await this.migrateChatHistory(oldEmail, sender);
                    // Копируем профиль старого адреса на новый (имя/аватар).
                    const oldProf = this.profiles[oldEmail];
                    if (oldProf) api.saveProfile(sender, oldProf.name, oldProf.avatar, env.ts || 0);
                    // Регистрируем ключ под новым email (peer_keys.json).
                    this.setPeerKey(sender, env.key, env.pq || null);
                  } else if (!this.peerKeys[sender] && env.key !== crypto.publicKey) {
                    // Незнакомый ключ с нового адреса: сохраняем как есть —
                    // контакт появится после обмена ключами (инвайт/QR).
                    this.setPeerKey(sender, env.key, env.pq || null);
                  }
                }
                if (env.name || env.avatar) {
                  // ts письма (отправки) — чтобы отставшее письмо не
                  // перезаписывало более свежий профиль (см. saveProfile).
                  api.saveProfile(sender, env.name, env.avatar, env.ts || 0, typeof env.bio === 'string' ? env.bio : undefined);
                }
                // Профильное письмо (type:'profile'): name/avatar уже
                // сохранены выше — как сообщение НЕ рендерим (системное).
                if (env.type === 'profile') {
                  return null;
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
              ttl: msgTtl,
              expireAt: msgExpireAt,
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
        for (const m of merged) if (m.expireAt) this.scheduleEphemeral(m, chat);
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
        const incoming = this.messages.filter(m => m.from === 'them' && m.id && !m.callEvent).map(m => m.id);
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
          crypto.setPeerPublicKey(this.peerKeys[email], this.peerPqKeys && this.peerPqKeys[email]);
          const decrypted = await Promise.all(
            raw.map(async (msg) => {
              // SOS (duress): не пишется в чат — только уведомление.
              {
                const envCheck = msg.content && crypto.isEncrypted(msg.content)
                  ? this.parseEnvelope(await crypto.decryptVault(msg.content).catch(() => null)) : null;
                if (envCheck && envCheck.type === 'sos') {
                  this.showToast('🚨 ' + (envCheck.name || this.activeChat) + ': ' + envCheck.text, 8000);
                  return null; // Promise.all: null отфильтруется ниже
                }
              }
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
                  if (env && env.type === 'sos') {
                    // SOS (duress): НЕ пишется в чат — только уведомление
                    // (Android пушнул монитор; desktop показывает тост здесь).
                    this.showToast('🚨 ' + (env.name || this.activeChat) + ': ' + env.text, 8000);
                    return null; // map-колбэк: null отфильтруется ниже
                  }
                  if (env) {
                    // Зелёная точка: письмо от контакта = активность сейчас
                    if (!this.isOwnSender(msg.sender_id)) {
                      this.noteSeen(this.activeChat, new Date(msg.created_at).getTime());
                    }
                    const parsed = this.parseMessageContent(env.text);
                    // Исчезающие: отсчёт у получателя — от момента доставки
                    // (created_at письма). Точный «от просмотра» потребовал бы
                    // read-receipt-синхронизации; доставка — честный компромисс.
                    // 25.08 фикс: у писем IMAP нет created_at — есть date.
                    // new Date(undefined) давал NaN и таймер не взводился.
                    const mailTs = new Date(msg.created_at || msg.date || Date.now()).getTime() || Date.now();
                    const expireAt = env.ttl ? mailTs + env.ttl * 1000 : 0;
                    return { ...base, id: env.id || base.id, content: parsed.text, attachment: parsed.attachment, encrypted: true, ttl: env.ttl || 0, expireAt };
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
          for (const m of this.messages) if (m.expireAt) this.scheduleEphemeral(m, this.activeChat);
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
          }).filter(Boolean).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        }
      } catch (error) {
        console.error('Failed to load messages:', error);
        if (!stale()) this.messages = [];
      }
    },
    // Полный рескан группы (0.1.106): письма, «застрявшие за курсором» из-за
    // разового сбоя (session desync / DNS / троттлинг), инкрементальный фетч
    // больше не вернёт. Кнопка в шапке группы делает полный IMAP-скан папок
    // (INBOX+Junk) и восстанавливает пропущенные сообщения.
    async refreshGroupFull() {
      if (!this.currentGroup) return;
      await this.loadGroupMessages(this.currentGroup.id, true);
      this.scrollToBottom(false);
    },
    async loadGroupMessages(groupId, forceRescan = false) {
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
        const raw = await api.getGroupMessages(groupId, this.emails, !!forceRescan);
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
                api.saveProfile(msg.sender_id, env.name, env.avatar, env.ts || 0);
              }
              plaintext = env.text; // содержимое конверта
            }
            const { text, attachment } = this.parseMessageContent(plaintext);
            if (env && !this.isOwnSender(msg.sender_id)) {
              this.noteSeen(msg.sender_id, new Date(msg.created_at).getTime());
            }
            const gMailTs = new Date(msg.created_at || msg.date || Date.now()).getTime() || Date.now();
            const gExpireAt = env && env.ttl ? gMailTs + env.ttl * 1000 : 0;
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
              ttl: (env && env.ttl) || 0,
              expireAt: gExpireAt,
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
          for (const m of this.messages) if (m.expireAt) this.scheduleEphemeral(m, chat);
          this.saveChatCache(chat, this.messages);
          // Локальная история (IndexedDB) — полный архив группы.
          this.saveCurrentHistory(chat);
          // Открыли группу — шлём участникам квитанции «просмотрено» по входящим.
          const incoming = this.messages.filter(m => m.from === 'them' && m.id && !m.callEvent).map(m => m.id);
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
            if (obj && obj.meta === 1 && (obj.avatar || obj.name)) {
              // Аватар группы — отдельный kv (как раньше).
              if (obj.avatar && (await db.kvGet('anon', 'group-avatar:' + g.id)) !== obj.avatar) {
                await db.kvSet('anon', 'group-avatar:' + g.id, obj.avatar);
                this.groupAvatars[g.id] = obj.avatar;
              }
              // Имя группы (переименование, 25.08): применяем если пришло.
              if (obj.name && g.name !== obj.name) {
                try {
                  await invoke('groups_rename', { groupId: g.id, newName: obj.name });
                  g.name = obj.name;
                  console.log('[group] name applied:', g.id, '→', obj.name);
                } catch (e) { /* локально не обновилось — не критично */ }
              }
              metaFound = true;
              alreadyApplied.add(appliedSig);
              await db.kvSet('anon', appliedKey, [...alreadyApplied].join(','));
              break; // meta найден — хватит
            }
          } catch (e) { /* не meta или битое — не критично */ }
        }
      }
    },
    async onAvatarUpdate(dataUrl) {
      this.userAvatarUrl = dataUrl
      // Локально: память + kv (переживёт перезапуск). НЕ шлём письмо —
      // контакты узнают ТОЛЬКО по «Сохранить» (единое письмо имя+аватар+статус).
      // ts = Date.now() — СВОЁ действие (иначе guard tsNum=0 блокирует запись
      // в kv и аватар исчезает после перезапуска; баг 25.08, Android).
      if (!this.profiles[this.email]) this.profiles[this.email] = {};
      this.profiles[this.email].avatar = dataUrl || '';
      await api.saveProfile(this.email, this.displayName || this.email, dataUrl || '', Date.now());
    },
    async onNameUpdate(name) {
      // Только локально; контакты узнают по «Сохранить» (единое письмо).
      this.displayName = name || this.email || '';
    },
    // Профиль (имя/аватар) всем контактам с ключом: stealth-письмо
    // {vault:1, type:'profile', name, avatar}. Получатель сохраняет профиль
    // и не рендерит как сообщение (см. processIncoming).
    async broadcastProfile() {
      const peers = Object.keys(this.peerKeys || {});
      if (!peers.length) return;
      const name = this.displayName || this.email || '';
      // Актуальный аватар: kv (после onAvatarUpdate/saveProfile) в приоритете,
      // this.profiles в памяти мог устареть (гонка loadProfiles ↔ редактирование).
      let avatar = (this.profiles[this.email] || {}).avatar || '';
      try {
        const kvProfiles = JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
        const kp = kvProfiles[String(this.email).toLowerCase()];
        if (kp && kp.avatar) avatar = kp.avatar;
      } catch (e) { /* ignore */ }
      const bio = await this.getBio();
      const body = {
        vault: 1,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
        type: 'profile',
        text: '',
        name,
        avatar,
        bio: (bio || '').slice(0, 200),
        key: crypto.publicKey || '',
        ts: Date.now(),
      };
      // Шифруем для КАЖДОГО получателя его ключом (25.08). Без этого
      // encryptVault использует глобальный peerPublicKey (последний открытый
      // чат) — письмо расшифровывает только один из всех контактов, остальные
      // получают «AAD auth failed». Это была причина нестабильности: «с третьего
      // раза сработало» — потому что последний открытый чат менялся случайно.
      for (const peer of peers) {
        const peerKey = this.peerKeys[peer];
        if (!peerKey) continue;
        crypto.setPeerPublicKey(peerKey, this.peerPqKeys && this.peerPqKeys[peer]);
        const content = await crypto.encryptVault(JSON.stringify(body));
        try { await api.sendReadReceipt(peer, content); } catch (e) { /* тихо */ }
      }
      console.log('[profile] broadcast to', peers.length, 'contacts');
    },
    // Выбор аватара в диалоге «Новая группа»: центр-кроп 128×128 JPEG
    // (те же параметры, что у аватара группы в GroupSettings).
    onNewGroupAvatarSelected(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) {
        alert('Файл слишком большой (макс 500KB)');
        e.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 128;
          canvas.height = 128;
          const ctx = canvas.getContext('2d');
          const size = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, 128, 128);
          this.newGroupAvatar = canvas.toDataURL('image/jpeg', 0.8);
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    },
    // Файл резервной копии выбран — держим его в памяти до нажатия «Восстановить».
    async onRecoveryFilePicked(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this.recoveryFileJson = await file.text();
      this.recoveryFileName = file.name;
    },
    // Восстановление: логин обязателен (доступ к ящику для эскроу-письма),
    // слова — обязательны; файл — опционален. Порядок:
    // 1) логин; 2) если файл → расшифровать словами и импорт;
    // 3) иначе поиск эскроу-письма в ящике и расшифровка словами;
    // 4) initCrypto подхватит восстановленную пару.
    async loginWithRecovery() {
      this.loginLoading = true;
      this.loginError = '';
      try {
        const words = this.recoveryWordsInput.trim();
        if (!(await crypto.recoveryValidateMnemonic(words))) {
          throw new Error('Неверный ключ восстановления: нужно 12 слов из списка');
        }
        const config = {};
        if (this.imapServer.trim()) config.imap_server = this.imapServer.trim();
        if (this.imapPort.trim()) config.imap_port = parseInt(this.imapPort.trim(), 10);
        if (this.smtpServer.trim()) config.smtp_server = this.smtpServer.trim();
        if (this.smtpPort.trim()) config.smtp_port = parseInt(this.smtpPort.trim(), 10);
        const data = await api.login(this.email, this.password, { remember: this.rememberMe, config });
        this.userId = data.user_id;

        let restored = false;
        if (this.recoveryFileJson.trim()) {
          // Файл «Резервной копии» — открытый export_backup() (без слов).
          try {
            JSON.parse(this.recoveryFileJson);
            await invoke('import_backup', { jsonData: this.recoveryFileJson });
            restored = true;
          } catch (fileErr) {
            console.warn('backup file import failed:', fileErr);
          }
        }
        if (!restored) {
          // Основной путь: эскроу-письмо в ящике + 12 слов.
          restored = await this.recoverFromEscrow(words);
        }
        if (!restored) {
          throw new Error('Эскроу-письмо не найдено в ящике или слова не подходят');
        }

        this.isLoggedIn = true;
        initNotifications().catch(() => {});
        await this.initLocalDb();
        this.loadUnreadCounts();
        this.loadLocalProfiles();
        await this.loadBodyCache();
        await this.loadContacts();
        await this.loadGroups();
        this.startPolling();
        this.idleLoop();
        this.loadEmails().catch(() => {});
        this.showToast(t('recovery_ok'));
      } catch (error) {
        this.loginError = error.message || String(error);
      } finally {
        this.loginLoading = false;
      }
    },
    // --- Зелёная точка (25.08, по модели Delta Chat) ---
    // Отмечаем активность контакта: входящее письмо от него.
    noteSeen(email, ts) {
      if (!email || typeof email !== 'string' || !email.includes('@')) return;
      const t = Number(ts) || Date.now();
      if ((this.lastSeenMap[email] || 0) < t) {
        this.lastSeenMap = { ...this.lastSeenMap, [email]: t };
      }
    },
    isRecentlySeen(email) {
      const t = this.lastSeenMap[email];
      if (!t) return false;
      return Date.now() - t < 10 * 60 * 1000; // 10 минут
    },

    // --- Качество медиа (25.08): 'high' (по умолч.) / 'low' / 'original' ---
    async mediaQuality() {
      try { return (await db.kvGet('anon', 'media-quality')) || 'high'; } catch { return 'high'; }
    },
    // Центр-масштаб до maxSide по большей стороне, JPEG q. Возвращает dataURL.
    compressImage(dataUrl, maxSide, quality) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const side = Math.max(img.width, img.height);
          if (side <= maxSide) { resolve(null); return; } // сжатие не нужно
          const scale = maxSide / side;
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = dataUrl;
      });
    },

    // --- Статус «О себе» (25.08): свой bio в kv_store, уходит в profile-конверте ---
    async getBio() {
      try { return (await db.kvGet(this.email || 'anon', 'bio')) || ''; } catch { return ''; }
    },
    async onExperimentsCalls(on) {
      this.expCalls = !!on;
      try { await db.kvSet('anon', 'exp-calls', on ? '1' : '0'); } catch (e) {}
    },
    async onBioSave(text) {
      await this.setBio(text);
      this.showToast('Профиль сохранён — статус уйдёт контактам');
    },
    async setBio(text) {
      const v = String(text || '').slice(0, 200);
      await db.kvSet(this.email || 'anon', 'bio', v);
      this.myBio = v;
      return v;
    },
    // «Сохранить профиль» (25.08): ОДНО письмо с именем+аватаром+статусом и
    // одним ts. Раньше каждый emit слал отдельное письмо с разными ts —
    // на приёме более позднее письмо с неполным набором перетирало _ts и
    // блокировало/возвращало старые значения (чехарда имени/аватара).
    async onProfileSave() {
      try {
        await this.broadcastProfile();
        this.showToast(t('settings_profile_saved') || 'Профиль сохранён — контакты обновят его');
      } catch (e) {
        console.error('[profile] broadcast on save failed:', e);
        this.showToast(t('settings_profile_saved') || 'Профиль сохранён');
      }
    },

    // --- Исчезающие сообщения (25.08, по модели Delta Chat) ---
    // TTL хранится per-chat в kv_store ('ephemeral:<chatId>'), уходит в
    // конверте (env.ttl, секунды). У получателя таймер стартует при ПОКАЗЕ
    // сообщения; у отправителя — сразу после отправки.
    ephemeralLabel(sec) {
      const opt = this.ephemeralOptions.find((o) => o.v === Number(sec));
      return opt ? opt.label : sec + ' c';
    },
    async applyEphemeral(seconds) {
      this.showEphemeralMenu = false;
      const chatId = this.activeChatType === 'group' && this.currentGroup
        ? 'group:' + this.currentGroup.id
        : this.activeChat;
      if (!chatId || chatId === '__notes__') return;
      try {
        await this.setEphemeralTtl(chatId, seconds);
        console.log('[ephemeral] set ttl=' + seconds + ' for ' + chatId);
      } catch (e) {
        console.error('[ephemeral] save failed:', e);
      }
      this.currentEphemeralTtl = Number(seconds) || 0;
      this.showToast(
        seconds > 0
          ? 'Исчезающие сообщения: ' + this.ephemeralLabel(seconds) + ' (новые сообщения в этом чате)'
          : 'Исчезающие сообщения выключены',
      );
    },
    async ephemeralTtlOf(chatId) {
      try {
        const v = await db.kvGet('anon', 'ephemeral:' + chatId);
        return Number(v) || 0;
      } catch { return 0; }
    },
    async setEphemeralTtl(chatId, seconds) {
      await db.kvSet('anon', 'ephemeral:' + chatId, String(seconds || 0));
      this.ephemeralTick += 1; // перерисовать индикатор в шапке
    },
    scheduleEphemeral(msg, chatId) {
      if (!msg || !msg.expireAt) return;
      const key = chatId + ':' + msg.id;
      if (this.ephemeralTimers[key]) return;
      console.log('[ephemeral] arm timer id=' + msg.id + ' chat=' + chatId + ' in ' + Math.round((msg.expireAt - Date.now()) / 1000) + 's');
      // Истёкшие пока приложение было закрыто: удаляем сразу.
      if (Date.now() >= msg.expireAt) {
        this.expireEphemeral(chatId, msg.id, msg.mid);
        return;
      }
      this.ephemeralTimers[key] = setTimeout(() => {
        this.expireEphemeral(chatId, msg.id, msg.mid);
        delete this.ephemeralTimers[key];
      }, msg.expireAt - Date.now());
    },
    expireEphemeral(chatId, msgId, mid) {
      // Тот же механизм, что «Удалить у всех» (deleteMessage): tombstone
      // персистентен → сообщение не воскреснет из истории/письма после
      // перезапуска или поллинга.
      this.addTombstone(msgId);
      if (mid) this.addMidTombstone(mid);
      const idx = this.messages.findIndex((m) => m.id === msgId);
      if (idx !== -1) this.messages.splice(idx, 1);
      this.saveCurrentHistory(chatId);
    },

    // --- Key Recovery (25.08) ---
    // Минимальный тост: сообщение внизу, автоскрытие (по умолчанию 5с).
    // ── Duress-замок (t_b185e3e2) ────────────────────────────────────────
    // При старте: если замок включён — показываем LockScreen вместо UI.
    async checkDuressLock() {
      // Android (0.1.117): замок переехал на НАТИВНЫЙ LockActivity (Kotlin,
      // паттерн банковских приложений: onPause→замок). JS-замок здесь больше
      // не показываем — двойной запрос кода. Desktop оставляем JS-вариант.
      if (/android/i.test(navigator.userAgent)) {
        this.duressLocked = false;
        // Диагностика prefs нативного замка: enabled/hashLen/unlocked.
        // Если после «Сохранить» enabled=false — prefs не пишутся (JNI-мост).
        console.log('[duress] android branch: reading native prefs…');
        this.duressDiag = 'native: читаем prefs…';
        try {
          const dbg = await invoke('android_duress_prefs_debug');
          console.log('[duress] android prefs debug:', dbg);
          this.duressDiag = 'native lock: ' + dbg;
        } catch (e) {
          console.warn('[duress] android prefs debug FAILED:', e);
          this.duressDiag = 'native lock: prefs debug err ' + (e && e.message || e);
        }
        return;
      }
      try {
        const cfg = await invoke('duress_get_config');
        const enabled = !!(cfg && cfg.lock_enabled && cfg.lock_hash);
        this.duressLocked = enabled;
        console.log('[duress] lock check: enabled=', cfg && cfg.lock_enabled,
          ', hash=', !!(cfg && cfg.lock_hash), '→ locked=', enabled);
        // ДИАГНОСТИКА НА ЭКРАНЕ (0.1.116): замок настроен, но не показан?
        // Так пользователь без adb увидит, что вернул Rust. Врем. мера —
        // убрать после стабилизации.
        this.duressDiag = `enabled=${cfg && cfg.lock_enabled}, hashLen=${(cfg && cfg.lock_hash || '').length}, locked=${enabled}`;
      } catch (e) {
        console.warn('[duress] check failed:', e);
        this.duressDiag = 'check error: ' + (e && e.message || e);
      }
      // Android (0.1.115): «выход» из приложения НЕ убивает процесс — FGS и
      // keep-alive WebView живут, mounted НЕ выполняется при повторном открытии,
      // замок не показывался. Ловим возврат из фона: если замок включён и в этой
      // сессии ещё не разблокирован (duressUnlockedThisSession false) — показать.
      if (!this._duressVisibilityBound) {
        this._duressVisibilityBound = true;
        const relock = async () => {
          if (this.duressUnlockedThisSession) return;
          try {
            const cfg = await invoke('duress_get_config');
            if (cfg && cfg.lock_enabled && cfg.lock_hash) {
              this.duressLocked = true;
              console.log('[duress] relock on resume → locked=true');
            }
          } catch (e) { /* ignore */ }
        };
        document.addEventListener('visibilitychange', () => {
          // Уход из видимости (сворачивание, скрытие в трей, переключение
          // окна) = конец «доверенного периода»: флаг сессии снимаем, чтобы
          // relock при возврате ПОКАЗАЛ замок. Банковский паттерн: замок
          // должен появляться после КАЖДОГО ухода, а не только после смерти
          // процесса (иначе минимизация не блокирует).
          if (document.visibilityState === 'hidden') {
            this.duressUnlockedThisSession = false;
          } else {
            relock();
          }
        });
        window.addEventListener('focus', relock);
        // Desktop close-to-tray (0.1.118): Rust эмитит событие ПЕРЕД скрытием
        // окна в трей. Здесь сбрасываем флаг «разблокирован в этой сессии» и
        // сразу поднимаем замок: при возврате из трея LockScreen уже на экране
        // (WebView скрытого окна может не слать visibilitychange).
        (async () => {
          const { listen } = await import('@tauri-apps/api/event');
          await listen('vault://window-hidden', () => {
            this.duressUnlockedThisSession = false;
            invoke('duress_get_config').then((cfg) => {
              if (cfg && cfg.lock_enabled && cfg.lock_hash) {
                this.duressLocked = true;
                console.log('[duress] tray-hide → armed lock for next show');
              }
            }).catch(() => {});
          });
        })();
      }
      // Повтор через секунду: restoreSession/монтирование UI может перерисовать
      // поздно; дублирующая проверка гарантирует замок при уже сохранённом конфиге.
      setTimeout(async () => {
        try {
          const cfg = await invoke('duress_get_config');
          if (cfg && cfg.lock_enabled && cfg.lock_hash && !this.isLoggedIn === false) {
            // уже залогинен — замок всё равно показываем (замок = при запуске)
          }
          if (cfg && cfg.lock_enabled && cfg.lock_hash) {
            this.duressLocked = true;
            console.log('[duress] lock re-check → locked=true');
          }
        } catch (e) { /* ignore */ }
      }, 1200);
    },
    onLockUnlock() {
      this.duressLocked = false;
      this.duressUnlockedThisSession = true; // до ухода в фон замок не ре-армить
    },
    // Duress-PIN: открываем приложение КАК ОБЫЧНО (не выдаём), но после
    // монтирования тихо отправляем SOS-письмо выбранным контактам.
    async onLockDuress() {
      this.duressLocked = false;
      this.duressPending = true;
      this.$nextTick(() => this.sendDuressSos());
    },
    // Panic-PIN: Rust уже стёр данные — выходим на login (локально пусто).
    async onLockPanic() {
      this.duressLocked = false;
      try {
        await api.logout();
      } catch (e) { /* ignore */ }
      this.isLoggedIn = false;
      this.email = null;
      this.showToast(this.t('panic_done') || 'Данные стёрты', 4000);
    },
    // SOS: скрытое письмо выбранным контактам. НЕ сохраняется в чат получателя:
    // тип sos обрабатывается получателем отдельно (push), в историю не пишется.
    async sendDuressSos() {
      try {
        const cfg = await invoke('duress_get_config');
        if (!cfg || !cfg.sos_enabled_rcpts) { /* compat */ }
        const rcpts = (cfg.sos_recipients || []).filter(Boolean);
        if (!rcpts.length) return;
        // Гео: если включено — получаем координаты через плагин geolocation (этап 3);
        // сейчас — без гео (текст без координат), фича дополняется на этапе 3.
        let coords = '';
        try {
          const pos = await invoke('plugin:geolocation|get_current_position');
          coords = `, мои координаты: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
        } catch (e) { /* гео недоступно/не включено — без координат */ }
        const text = (cfg.sos_text || this.t('sos_default') || 'Телефон не у меня{coords}')
          .replace('{coords}', coords);
        for (const rcpt of rcpts) {
          try {
            const content = await crypto.encryptVault(JSON.stringify({
              vault: 1, id: 'sos-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
              type: 'sos', text, name: this.displayName || '', ts: Date.now(),
            }));
            await api.sendEmail('local', { to: rcpt, subject: '', body: content });
          } catch (e) {
            console.warn('[duress] SOS to', rcpt, 'failed:', e);
          }
        }
        console.log('[duress] SOS sent to', rcpts.length, 'recipients');
      } catch (e) {
        console.warn('[duress] sendSos failed:', e);
      } finally {
        this.duressPending = false;
      }
    },
    showToast(message, ms = 5000) {
      this.toastMessage = message;
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toastMessage = ''; }, ms);
    },
    // Отправка эскроу-письма СЕБЕ после создания ключа восстановления.
    async onRecoveryCreated({ mnemonic }) {
      console.log('[recovery] onRecoveryCreated, words len =', mnemonic ? mnemonic.split(/\s+/).length : 0);
      try {
        const wrappedJson = await crypto.recoveryWrapBackup(mnemonic);
        const body = await crypto.recoveryBuildEscrowEmail(wrappedJson);
        console.log('[recovery] escrow body =', body.slice(0, 120));
        const res = await api.sendEmail(this.email, {
          to: this.email,
          subject: '',
          body,
        });
        console.log('[recovery] sendEmail res =', JSON.stringify(res));
        if (res && res.ok === false) throw new Error('SMTP refused');
        // Провайдеры кладут служебные письма в Спам, а Gmail удаляет спам
        // через ~30 дней — тогда эскроу пропадёт. Сразу объясняем пользователю.
        this.showToast(
          'Ключ сохранён в ящик. ПРОВЕРЬТЕ СПАМ: если письмо от Vault попало туда — переложите его во «Входящие», иначе оно будет удалено',
          10000,
        );
        // Фоново определяем фактическую папку письма и предупреждаем точечно.
        this.locateEscrow(wrappedJson);
      } catch (e) {
        console.error('escrow send failed:', e);
        this.showToast('Не удалось отправить эскроу-письмо: ' + (e.message || e));
      }
    },
    // Ищем только что отправленное эскроу-письмо (совпадение salt+nonce+wrapped)
    // и сообщаем, где оно лежит. IMAP-доставка не мгновенна — до 4 попыток.
    async locateEscrow(wrappedJson, attempt = 0) {
      if (attempt >= 4) return;
      await new Promise((r) => setTimeout(r, 5000));
      try {
        let local = null;
        try { local = JSON.parse(wrappedJson); } catch { return; }
        const msgs = await api.fetchEmails(this.email);
        const candidates = msgs.filter((m) => !(m.subject || '').trim()).slice(0, 80);
        const byFolder = {};
        for (const m of candidates) (byFolder[m.folder] = byFolder[m.folder] || []).push(m);
        for (const [folder, list] of Object.entries(byFolder)) {
          const bodies = await invoke('email_fetch_bodies', {
            uids: list.map((m) => String(m.uid)),
            folder,
          }).catch(() => []);
          for (const [, body] of bodies || []) {
            const w = await crypto.recoveryParseEscrowEmail(body);
            if (!w) continue;
            let p = null;
            try { p = JSON.parse(w); } catch { continue; }
            if (p && p.salt === local.salt && p.nonce === local.nonce && p.wrapped === local.wrapped) {
              if (folder !== 'INBOX') {
                // Вариант A (25.08): автоматически копируем письмо во INBOX,
                // чтобы провайдер не удалил его из спама. Если не вышло —
                // просим пользователя переложить вручную. В любом случае
                // предупреждаем, что письмо удалять нельзя.
                try {
                  await invoke('email_copy_to_inbox', { uid: String(m.uid), folder });
                  this.showToast(t('recovery_moved_toast'), 12000);
                } catch (e) {
                  console.warn('escrow copy to inbox failed:', e);
                  this.showToast('⚠️ ' + t('recovery_spam_folder') + folder + t('recovery_spam_move'), 15000);
                }
              } else {
                this.showToast(t('recovery_keep'), 8000);
              }
              return;
            }
          }
        }
      } catch (e) {
        console.warn('escrow locate failed:', e);
      }
      this.locateEscrow(wrappedJson, attempt + 1);
    },
    // Поиск эскроу-письма в последних письмах + восстановление по словам.
    // Вызывается ПОСЛЕ логина ДО initCrypto() — иначе создастся новая пара.
    async recoverFromEscrow(mnemonic) {
      console.log('[recovery] step 1: validate mnemonic');
      if (!(await crypto.recoveryValidateMnemonic(mnemonic))) {
        throw new Error('Неверный формат ключа (нужно 12 слов)');
      }
      console.log('[recovery] step 2: fetch emails');
      const msgs = await api.fetchEmails(this.email);
      console.log('[recovery] step 3: got', msgs.length, 'msgs, filtering empty subject');
      const candidates = msgs.filter((m) => !(m.subject || '').trim()).slice(0, 80);
      console.log('[recovery] step 4: candidates', candidates.length, 'byFolder');
      const byFolder = {};
      for (const m of candidates) (byFolder[m.folder] = byFolder[m.folder] || []).push(m);
      for (const [folder, list] of Object.entries(byFolder)) {
        console.log('[recovery] step 5: fetch bodies from', folder, list.length, 'msgs');
        const uids = list.map((m) => m.uid);
        let bodies = [];
        try {
          bodies = await invoke('email_fetch_bodies', { uids: uids.map(String), folder });
        } catch (e) {
          console.warn('[recovery] fetch_bodies failed:', e);
          continue;
        }
        console.log('[recovery] step 6: got', bodies.length, 'bodies, parsing');
        for (const [, body] of bodies || []) {
          const wrappedJson = await crypto.recoveryParseEscrowEmail(body);
          if (!wrappedJson) {
            console.log('[recovery]   parseEscrowEmail returned null');
            continue;
          }
          console.log('[recovery] step 7: unwrapping…');
          const backupJson = await crypto.recoveryUnwrapBackup(wrappedJson, mnemonic);
          console.log('[recovery] step 8: import_backup');
          await invoke('import_backup', { jsonData: backupJson });
          return true;
        }
      }
      console.log('[recovery] no escrow found');
      return false;
    },

    // Аватар группы обновил админ (GroupSettings): сохраняем локально и
    // рассылаем участникам meta-письмо (шифр групповым ключом) — как реакции.
    // Переименование группы (25.08): создатель/админ меняет имя. Обновляем
    // локально + рассылаем meta-письмо {meta:1, name} участникам — они
    // применяют при syncGroupMeta (как аватар).
    async onGroupRename({ groupId, name }) {
      const g = this.groups.find(x => x.id === groupId);
      if (g) g.name = name;
      if (this.currentGroup && this.currentGroup.id === groupId) this.currentGroup.name = name;
      try {
        const groupKey = this.groupKeys[groupId];
        if (!groupKey) return;
        const content = await crypto.encryptWithGroupKey(JSON.stringify({ meta: 1, name, ts: Date.now() }), groupKey);
        await api.sendGroupMeta(groupId, content);
        console.log('[group] renamed', groupId, '→', name);
      } catch (e) {
        console.warn('[group] rename broadcast failed:', e);
      }
    },
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
        // ttl — исчезающие сообщения для этого чата (0 = выкл).
        // kv — ЕДИНСТВЕННЫЙ источник ttl при отправке. Fallback на
        // currentEphemeralTtl (UI-переменную) УБРАН: он применял чужой TTL,
        // когда selectChat не загрузил его для 1-на-1 — сообщение-ответ
        // уходило исчезающим без включения пользователем (баг 25.08).
        const ttl = await this.ephemeralTtlOf(chatId);
        if (ttl) console.log('[sendMessage] ephemeral ttl=' + ttl + ' chat=' + chatId);
        const envelope = await this.buildEnvelope(payload, ttl);
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
          // Своё исходящее ПЕРСИСТИМ сразу (как почтовый мессенджер пишет в msgs при
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
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat], this.peerPqKeys && this.peerPqKeys[this.activeChat]);
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
            ttl: ttl || 0,
            expireAt: ttl ? Date.now() + ttl * 1000 : 0,
          };
          this.messages.push(pendingMsg);
          this.markPending(this.activeChat, pendingMsg);
          if (ttl) this.scheduleEphemeral(pendingMsg, this.activeChat);
          // Своё исходящее ПЕРСИСТИМ сразу (как почтовый мессенджер пишет в msgs при
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
        // ВЗАИМНОСТЬ (26.08): после QR-сканирования/вставки ключа отправляем
        // приглашение обратно — иначе у собеседника контакт не появится
        // (мы сохранили его ключ, а он наш — нет). Как в Delta Chat.
        if (normalized !== String(this.email || '').toLowerCase()) {
          try {
            await api.sendContactInvite(normalized, this.publicKey);
            console.log('[contact] mutual invite sent to', normalized);
          } catch (e) {
            console.warn('[contact] mutual invite failed:', e);
          }
        }
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
    //
    // ИДЕМПОТЕНТНОСТЬ (22.08): каждое письмо учитывается ровно ОДИН раз —
    // processedUnreadIds (персист в kv 'unread-seen') хранит uid|folder уже
    // обработанных сообщений. Без этого любой повторный фетч (сбой IMAP,
    // сброс/коллизия курсоров, полный скан после перезапуска) инкрементил
    // счётчик снова — бейдж рос 1→2→3 и возвращался после открытия чата.
    // Быстрый фетч для звонков (22.08): отдельный IMAP-клиент в Rust — не
    // конкурирует за lock основного клиента. Используется ИЗ IDLE-цикла:
    // входящий call_request доходит, даже когда обычный поллинг пропускается
    // из-за занятого lock (троттлинг Gmail / долгие UI-фетчи).
    async loadEmailsFast(silent = true) {
      try {
        const accounts = await api.getEmailAccounts();
        const fetched = [];
        for (const account of accounts) {
          try {
            const cursors = this.loadCursors(account.id);
            const res = await api.fetchEmailsIncrementalFast(account.id, cursors);
            fetched.push(...(res.messages || []));
            this.saveCursors(account.id, res.cursors);
          } catch (e) {
            console.warn('[calls] fast fetch failed:', e);
          }
        }
        if (!fetched.length) return;
        const merged = [...this.emails];
        const seen = new Set(merged.map(m => m.uid + '|' + (m.folder || 'INBOX')));
        for (const m of fetched) {
          const k = m.uid + '|' + (m.folder || 'INBOX');
          if (!seen.has(k)) { seen.add(k); merged.push(m); }
        }
        merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        if (merged.length > 2000) merged.length = 2000;
        this.emails = merged;
        console.log(`[Emails] fast loaded ${this.emails.length} messages (${fetched.length} new)`);
        // Разбор сигналов звонков и уведомлений (как обычный loadEmails).
        await this.processIncoming(fetched, { notify: silent });
      } catch (e) {
        console.warn('[calls] fast load failed:', e);
      }
    },
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
            crypto.setPeerPublicKey(this.peerKeys[from], this.peerPqKeys && this.peerPqKeys[from]);
            const plain = await crypto.decryptVault(body);
            // Звонки (M3): call_* конверты — сигналы, НЕ сообщения (не в
            // бейджи, не в уведомления) — уходят в state machine звонка.
            const callSig = this.parseCallSignal(plain);
            if (callSig) {
              this.handleCallSignal(callSig, from).catch(e => console.warn('[call] signal failed:', e));
              continue;
            }
            const env = this.parseEnvelope(plain);
            if (env) {
              // ЭХО-ЗАЩИТА (25.08): письмо с МОИМ ключом — это я сам
              // (старый адрес после смены почты / копия в свой ящик).
              // Не профиль, не сообщение, не «смена почты» — иначе свой же
              // аватар перезаписывается старым из собственного письма.
              if (env.key && crypto.publicKey && env.key === crypto.publicKey) {
                this.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX'));
                continue;
              }
              // Смена почты (24.08): письмо могло прийти со старого адреса
              // контакта (алиаса) — чат ведём по каноническому (показываемому).
              chatKey = this.canonicalOf(from) || from;
              // Имя для заголовка: локальное переопределение пользователя →
              // свежее из профиля письма (env.name) → nameOf(). НЕ contact.name —
              // это устаревшее поле БД контактов.
              {
                const lpn = this.localProfileOf(from);
                title = (lpn && lpn.name) || env.name || this.nameOf(from);
              }
              // Профиль отправителя (25.08): имя/аватар/«О себе» — сохраняем
              // СРАЗУ при поллинге, не дожидаясь открытия чата.
              if (env.type === 'profile' || env.name || env.avatar || typeof env.bio === 'string') {
                api.saveProfile(from, env.name, env.avatar, env.ts || 0,
                  typeof env.bio === 'string' ? env.bio : undefined);
                if (env.type === 'profile') { this.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX')); continue; }
              }
            }
          } catch (e) { /* не наше письмо */ }
        } else if (crypto.isEncrypted(body)) {
          // Смена почты (24.08): отправитель сменил адрес, но ключ тот же.
          // Ключ под НОВЫМ email ещё не зарегистрирован — ищем его среди
          // известных peerKeys (fingerprint-матчинг) и привязываем новый адрес.
          try {
            let matched = null;
            for (const [knownEmail, knownKey] of Object.entries(this.peerKeys)) {
              if (String(knownEmail).toLowerCase() === from) continue;
              crypto.setPeerPublicKey(knownKey);
              try {
                const plain = await crypto.decryptVault(body);
                const env = this.parseEnvelope(plain);
                // Эхо-защита: письмо с моим ключом — от меня (старый адрес),
                // НЕ «смена почты» собеседника.
                if (env && env.key === knownKey && !(crypto.publicKey && env.key === crypto.publicKey)) {
                  matched = { knownEmail, plain, env }; break;
                }
              } catch (e) { /* не этим ключом */ }
            }
            if (matched) {
              console.log('[identity] fingerprint match:', matched.knownEmail, '→', from, '— смена почты (poll)');
              // Переносим историю чата со старого адреса на новый.
              await this.migrateChatHistory(matched.knownEmail, from);
              this.setPeerKey(from, matched.env.key, matched.env.pq || null);
              // Профиль со старого адреса переносим на новый.
              const oldProf = this.profiles[matched.knownEmail];
              if (oldProf) api.saveProfile(from, oldProf.name, oldProf.avatar, matched.env.ts || 0);
              if (matched.env.type === 'profile' || matched.env.name || matched.env.avatar || typeof matched.env.bio === 'string') {
                api.saveProfile(from, matched.env.name, matched.env.avatar, matched.env.ts || 0,
                  typeof matched.env.bio === 'string' ? matched.env.bio : undefined);
              }
              chatKey = this.canonicalOf(from) || from;
              const lp = this.localProfileOf(from);
              title = (lp && lp.name) || from;
              if (matched.env.type === 'profile') { this.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX')); continue; }
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
        // Дедуп: письмо уже учтено ранее (повторный фетч) — пропускаем,
        // иначе счётчик непрочитанных рос бы на каждом поллинге.
        const mid = m.uid + '|' + (m.folder || 'INBOX');
        // Дедуп по Message-ID (28.08, баг 0.1.78): одно и то же письмо
        // приходит с РАЗНЫМИ ключами uid|folder — копия из INBOX и копия из
        // [Gmail]/All Mail имеют разные uid → два уведомления на письмо
        // (монитор + JS-поллинг гонят параллельно). Message-ID глобален.
        const dk = m.message_id ? 'mid:' + m.message_id : mid;
        // ФИКС РЕГРЕССИИ (29.08, пуш при свёрнутом Vault): дедуп СЧЁТЧИКА
        // (processedUnreadIds) не имеет права блокировать УВЕДОМЛЕНИЕ.
        // В 2fa9103 здесь стоял `continue` — тихий поллинг (notify=false)
        // первым «съедал» письмо, заносил mid:<Message-ID> в персистный
        // дедуп, и последующее push-событие монитора (notify=true) молча
        // пропускалось: пуш не появлялся НИКОГДА. Теперь счётчик растёт
        // только для новых писем, а уведомление дедупится НЕЗАВИСИМО —
        // персист notifiedIds в notify.js (ключ dk = Message-ID).
        const counted = !(this.processedUnreadIds.has(mid) || this.processedUnreadIds.has(dk));
        if (counted) {
          this.processedUnreadIds.add(mid);
          this.processedUnreadIds.add(dk);
          if (this.processedUnreadIds.size > 600) {
            // Держим хвост: выкидываем старые (Set в порядке вставки).
            for (const old of this.processedUnreadIds) {
              this.processedUnreadIds.delete(old);
              if (this.processedUnreadIds.size <= 500) break;
            }
          }
          await this.saveUnreadSeen();
        }
        const fresh = Date.now() - new Date(m.date || 0).getTime() < 15 * 60 * 1000;
        // Счётчик непрочитанных: для новых писем, кроме видимого сейчас чата.
        if (counted && !this.chatVisible(chatKey)) {
          this.unreadCounts[chatKey] = (this.unreadCounts[chatKey] || 0) + 1;
          await this.saveUnreadCounts();
        }
        // Уведомление: только тихий поллинг, только свежие письма (старые
        // задержанные/догоняющие письма спамом не считаем) и только когда
        // чат НЕ виден (на mobile activeChat может хранить прошлый чат, пока
        // пользователь на списке контактов — иначе уведомление теряется).
        if (notify && fresh && !this.chatVisible(chatKey) && !this.isMuted(chatKey)) {
          // ДИАГНОСТИКА (29.08): пуш должен был быть.
          console.log('[notify] FIRE mid=' + (m.message_id || '?').slice(0, 20) + ' chat=' + chatKey);
          notifyNewMessage({
            title,
            body: this.t('notif_new_message') || 'New message',
            // Дедуп уведомления — по ГЛОБАЛЬНОМУ Message-ID (dk), а не
            // uid|folder: копия в INBOX и [Gmail]/All Mail не дадут два
            // пуша, при этом повторная доставка того же письма монитору
            // после тихого поллинга пуш НЕ отменит (см. фикс регрессии).
            id: dk,
          });
        } else if (notify) {
          console.log('[notify] SKIP fresh=' + fresh + ' visible=' + this.chatVisible(chatKey) + ' muted=' + this.isMuted(chatKey) + ' age=' + Math.round((Date.now() - new Date(m.date || 0).getTime()) / 1000) + 's');
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
        const seenRaw = await db.kvGet(this.email || 'anon', 'unread-seen');
        this.processedUnreadIds = new Set(seenRaw ? JSON.parse(seenRaw) : []);
      } catch (e) { this.unreadCounts = {}; this.processedUnreadIds = new Set(); }
    },
    async saveUnreadSeen() {
      try {
        await db.kvSet(this.email || 'anon', 'unread-seen', JSON.stringify(Array.from(this.processedUnreadIds)));
      } catch (e) { /* kv недоступен — дедуп живёт в памяти до перезапуска */ }
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
    // ── N5: архив + mute per-chat (паритет Delta Chat) ─────────────────────
    async loadChatFlags() {
      try {
        const raw = await db.kvGet(this.email || 'anon', 'chat-flags');
        this.chatFlags = raw ? JSON.parse(raw) : {};
      } catch (e) { this.chatFlags = {}; }
    },
    async saveChatFlags() {
      try {
        await db.kvSet(this.email || 'anon', 'chat-flags', JSON.stringify(this.chatFlags));
      } catch (e) { /* kv недоступен — флаги живут в памяти до перезапуска */ }
    },
    flagKey(target) {
      return target.type === 'group' ? 'group:' + target.id : target.email.toLowerCase();
    },
    chatFlagOf(key) {
      return this.chatFlags[key] || {};
    },
    isMuted(key) {
      // Ключи chatFlags — lowercased (flagKey); chatKey из processIncoming
      // может прийти в каноническом регистре контакта — нормализуем.
      return !!this.chatFlagOf(String(key || '').toLowerCase()).muted;
    },
    // ── N6: автоочистка («удалять сообщения с устройства», модель DC) ──
    // Период хранит SettingsPage (kv 'autoclean-period'); здесь — запуск:
    // 1) SQL-purge конвертов/тел/чат-кэшей старше cutoff (db_autoclean_purge);
    // 2) синхронизация памяти: this.emails и emailBodyCache без старых;
    // 3) повтор при каждом входе (mounted) — не только по клику в настройках.
    async runAutoclean(period) {
      const p = period || (await db.kvGet('anon', 'autoclean-period')) || 'off';
      if (p === 'off' || !this.isLoggedIn) return;
      const days = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 }[p];
      if (!days) return;
      const cutoff = Date.now() - days * 86400000;
      try {
        const acc = this.email || 'anon';
        // Даты считаем ЗДЕСЬ: колонка date — сырой заголовок Date (RFC 2822),
        // в SQL new Date() недоступен. Письма без даты не трогаем.
        const stale = this.emails.filter(m => m.date && new Date(m.date).getTime() < cutoff);
        if (!stale.length) return;
        const keys = stale.map(m => (m.folder || 'INBOX') + ':' + String(m.uid ?? m.id ?? ''))
          .filter(k => !k.endsWith(':'));
        const purged = await db.autocleanPurge(acc, JSON.stringify(keys));
        // Память зеркалим тем же списком.
        const staleSet = new Set(keys);
        this.emails = this.emails.filter(m =>
          !staleSet.has((m.folder || 'INBOX') + ':' + String(m.uid ?? m.id ?? '')));
        for (const k of keys) delete this.emailBodyCache[k];
        this.bodyCacheOrder = this.bodyCacheOrder.filter(k => staleSet.has(k) === false);
        this.persistBodyCache();
        console.info('[autoclean] purged', purged, 'bodies /', keys.length, 'msgs, period', p);
      } catch (e) {
        console.warn('[autoclean] failed:', e);
      }
    },
    openChatMenu(target, e) {
      e.preventDefault();
      e.stopPropagation();
      // 28.08: меню позиционируется по точке долгого нажатия.
      const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 200));
      let y = Math.max(8, Math.min(e.clientY, window.innerHeight - 130));
      // На Android WebView долгое нажатие часто присылает contextmenu с
      // clientX/Y=0 — берём координаты элемента, иначе меню липнет к верху
      // экрана и прячется под статус-бар.
      if (!e.clientX && !e.clientY && e.target && e.target.getBoundingClientRect) {
        const r = e.target.closest('.contact-item') || e.target;
        const rr = r.getBoundingClientRect();
        y = Math.max(8, Math.min(rr.bottom + 4, window.innerHeight - 130));
      }
      this.chatMenu = { show: true, target, x, y };
    },
    closeChatMenu() {
      this.chatMenu = { show: false, target: null };
    },
    async toggleArchive() {
      const key = this.flagKey(this.chatMenu.target);
      const f = { ...(this.chatFlags[key] || {}) };
      f.archived = !f.archived;
      if (!f.archived && !f.muted) delete this.chatFlags[key];
      else this.chatFlags[key] = f;
      this.closeChatMenu();
      await this.saveChatFlags();
    },
    async toggleMute() {
      const key = this.flagKey(this.chatMenu.target);
      const f = { ...(this.chatFlags[key] || {}) };
      f.muted = !f.muted;
      if (!f.archived && !f.muted) delete this.chatFlags[key];
      else this.chatFlags[key] = f;
      this.closeChatMenu();
      await this.saveChatFlags();
    },
    // ── Дедуп звонков (persist kv 'call-seen') ──────────────────────────────
    // call_id обработанного звонка (request/accept/end/reject). После
    // перезапуска не даёт старым конвертам снова дёргать state machine.
    async isCallSeen(callId) {
      try {
        const raw = await db.kvGet(this.email || 'anon', 'call-seen');
        const set = raw ? new Set(JSON.parse(raw)) : new Set();
        return set.has(callId);
      } catch (e) { return false; }
    },
    async rememberCallSeen(callId) {
      try {
        const raw = await db.kvGet(this.email || 'anon', 'call-seen');
        const set = raw ? new Set(JSON.parse(raw)) : new Set();
        set.add(callId);
        // Храним последние 100 call_id (старые не нужны)
        if (set.size > 100) {
          const arr = Array.from(set);
          arr.splice(0, arr.length - 100);
          await db.kvSet(this.email || 'anon', 'call-seen', JSON.stringify(arr));
        } else {
          await db.kvSet(this.email || 'anon', 'call-seen', JSON.stringify(Array.from(set)));
        }
      } catch (e) { /* тихо */ }
    },
    // ── Звонки (M3, feature/calls) — Фаза 1: сигнализация конвертами call_* ──
    // Распознавание сигнального конверта: {vault:1, type:'call_*', call_id,...}.
    // Такие письма НЕ рендерятся сообщениями (как квитанции) — уходят в
    // state machine звонка. Медиа (webrtc-rs) подключается в Фазе 2.
    parseCallSignal(decrypted) {
      if (!decrypted || typeof decrypted !== 'string') return null;
      try {
        const obj = JSON.parse(decrypted);
        if (obj && obj.vault === 1 && typeof obj.type === 'string'
            && obj.type.indexOf('call_') === 0 && obj.call_id) {
          return obj;
        }
      } catch (e) { /* не сигнал */ }
      return null;
    },
    // Отправка сигнала звонка (stealth-письмо с пустой темой — как квитанции).
    async sendCallEnvelope(peer, payload) {
      const body = {
        vault: 1,
        id: payload.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)),
        type: payload.type,
        call_id: payload.call_id,
        ts: Date.now(),
        ...(payload.sdp ? { sdp: payload.sdp } : {}),
        ...(payload.role ? { role: payload.role } : {}),
        // PQ (30.08): kemct звонящего едет в call_request; принимающий
        // собирает гибридный media_key декапсуляцией. sender_ek — чтобы
        // contact сохранялся и для ответного гибрида.
        ...(payload.kemct ? { kemct: payload.kemct } : {}),
        ...(payload.sender_ek ? { sender_ek: payload.sender_ek } : {}),
      };
      const content = await crypto.encryptVault(JSON.stringify(body));
      // Ретрай ×3 (23.08): Gmail-троттлинг рвёт SMTP в момент звонка
      // («media accept failed» = sendEmail упал, answer потерян навсегда).
      // Сигнал звонка критичен — повторяем с паузой.
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          await api.sendReadReceipt(peer, content); // stealth: пустая тема
          if (i > 0) console.log('[call] envelope sent on retry', i);
          return;
        } catch (e) {
          lastErr = e;
          console.warn(`[call] envelope send attempt ${i + 1}/3 failed:`, e && e.message || e);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      throw lastErr;
    },
    // Входящий сигнал → state machine. MVP: один звонок одновременно.
    async handleCallSignal(sig, from) {
      const { call_id, type } = sig;
      if (!call_id || !from) return;
      console.log('[call] signal', type, call_id, 'from', from, 'state=' + this.callState,
        'current=' + (this.currentCall ? this.currentCall.call_id : 'null'));
      // ЗАЩИТА ОТ УСТАРЕВШИХ КОНВЕРТОВ (22.08): после перезапуска приложение
      // заново сканирует Спам, и старые call_* письма (прошлых сессий) снова
      // попадают в processIncoming. Без этой защиты «зомби-звонок» вешал
      // state machine в incoming_ringing, и НОВЫЙ звонок, пришедший в это
      // время, молча отбрасывался (callState !== 'idle') — вызовы пропадали.
      // Звонок живёт ≤45с (ring-таймер) + запас на доставку почты и на вход
      // в аккаунт после перезапуска окна (пользователь мог перезапустить
      // окно, и icemaksim залогинился позже звонка) — конверты старше 10
      // минут неактуальны — игнорируем (и запоминаем call_id).
      if (sig.ts && Date.now() - sig.ts > 600000) {
        console.log('[call] stale envelope ignored', call_id, type, 'age_ms=' + (Date.now() - sig.ts));
        const alreadySeen = await this.isCallSeen(call_id);
        await this.rememberCallSeen(call_id);
        // Пропущенные вызовы (27.08): звонок пришёл, пока нас не было
        // (офлайн/перезапуск) — записываем «Пропущенный звонок» в историю
        // чата. Только при ПЕРВОМ появлении call_id (alreadySeen=false) —
        // иначе повторный фетч Спада после рестарта плодил дубли пилюль.
        if (type === 'call_request' && !alreadySeen) {
          await this.recordCallEvent(from, 'missed', sig.ts, 0, call_id);
        }
        return;
      }
      // ДЕДУП (22.08) + ПОВТОРНЫЙ ПОКАЗ (29.08): call_id уже показанного звонка
      // из повторного фетча гасится — НО только если звонок ещё «жив» в системе
      // (not cancelled). Ретрансляция call_request (каждые 15с) того же call_id
      // после ЛОКАЛЬНОГО отклонения обязана СНОВА поднять экран звонка? НЕТ:
      // юзер уже решил судьбу звонка — гасим. А вот РЕТРАНСЛЯЦИИ ДО отклонения
      // дедупятся через currentCall check (4800) — они безопасны.
      // Зомби-гвард (0.1.85): терминальные cancel/end/reject запоминаются —
      // request, приехавший ПОЗЖЕ своего cancel, гасится здесь.
      if (type === 'call_request' && !(this.currentCall && this.currentCall.call_id === call_id)) {
        if (await this.isCallSeen(call_id)) return;
        await this.rememberCallSeen(call_id);
      }
      // Чужой звонок во время активного — отвечаем занято (call_reject).
      if (this.callState !== 'idle' && this.currentCall
          && this.currentCall.call_id !== call_id && type === 'call_request') {
        await this.sendCallEnvelope(from, { type: 'call_reject', call_id });
        // Пропущенные вызовы (27.08): мы говорили по другому звонку —
        // фиксируем пропущенный в истории чата с этим собеседником.
        await this.recordCallEvent(from, 'missed', sig.ts, 0, call_id);
        return;
      }
      switch (type) {
        case 'call_request':
          // РЕТРАНСЛЯЦИЯ (27.08): звонящий повторяет call_request каждые 15с
          // (письма теряются в транзите). Если тот же call_id УЖЕ звонит у
          // нас — это дубль: игнорируем. РАНЬШЕ дубль попадал в «forcing
          // reset» ниже → hangup('preempt') → повторный SET incoming_ringing:
          // рингтон перезапускался, а драг-жест свайпа сбрасывался посреди
          // движения (пользователь видел «трубка вернулась в центр»).
          if (this.currentCall && this.currentCall.call_id === call_id) return;
          // ГАРАНТИЯ ПОКАЗА (22.08): НОВЫЙ call_request ВСЕГДА вытесняет любое
          // состояние, кроме реального разговора (active) — даже если state
          // machine зависла в ringing от старого конверта без currentCall.
          if (this.callState !== 'idle' && this.callState !== 'active') {
            console.warn('[call] forcing reset before new request (state=' + this.callState + ')');
            await this.hangup('preempt');
          }
          if (this.callState !== 'idle') return;
          // OFFER В call_request (28.08): звонящий создаёт offer ДО набора —
          // он едет в первом письме. Сохраняем: при accept сразу создадим
          // answer (1 hop вместо 2). Если sdp нет (старая версия/fallback) —
          // acceptCall создаст offer сам (старая схема).
          this.currentCall = {
            call_id, peer: from, offerSdp: sig.sdp || null,
            // PQ (30.08): kemct звонящего — в mediaAcceptIncoming при accept.
            kemct: sig.kemct || null, senderEk: sig.sender_ek || null,
          };
          this.lastCallId = call_id;
          this.callState = 'incoming_ringing';
          this.callMuted = false;
          this.callStartedAt = Date.now();
          console.log('[call] incoming_ringing SET for', call_id, 'from', from);
          // Звук входящего (27.08, редизайн): WAV-рингтон «кристальный чайм».
          // Desktop — cpal в Rust (слышен при свёрнутом окне).
          // Android (28.08): рингтон играет НАТИВНЫЙ MediaPlayer в сервисе
          // (запускается в mediaShowIncomingCall) — HTML5 Audio в WebView
          // глохнет в фоне и играл ОДИН раз. Поэтому HTML5-луп входящего
          // на Android пропускаем, чтобы не было двойного звука.
          if (!this.isAndroid) {
            this.playCallSound('incoming', true);
          }
          // Full-screen уведомление (28.08): Android — системный звонок
          // поверх локскрина (рингтон+вибрация канала уведомлений).
          // Desktop — no-op. Снимается в hangup().
          api.mediaShowIncomingCall(this.callPeerName || from);
          this.startFastPolling();
          // Таймер гудка 180с (27.08): было 90с, но call_accept/answer по
          // почте могут идти дольше (SMTP+доставка+IMAP), звонок «сгорал» до
          // того, как собеседник успевал ответить.
          this.callRingTimer = setTimeout(() => this.cancelCall('timeout'), 180000);
          break;
        case 'call_accept':
          if (this.currentCall && this.currentCall.call_id === call_id
              && this.callState === 'outgoing_ringing') {
            // Собеседник принял — таймер отмены больше не нужен.
            clearTimeout(this.callRingTimer);
            this.callRingTimer = null;
            if (this.callResendTimer) {
              clearInterval(this.callResendTimer);
              this.callResendTimer = null;
            }
            // Гудки исходящего → чайм соединения (27.08). stop не нужен:
            // play сам останавливает предыдущий звук (Rust/HTML5).
            this.playCallSound('connect', false);
            this.callState = 'active';
            // Таймер НЕ запускаем (27.08): ждём событие call-media-connected
            // из Rust (реальный звук). Предохранитель 120с — если событие
            // потерялось, показываем таймер хоть когда-нибудь.
            this.callMediaConnected = false;
            this.armMediaFallback();
            // OFFER В call_request (28.08): если мы создали offer при наборе
            // (hasLocalOffer) — sdp в call_accept это ANSWER: ставим remote,
            // DTLS-SRTP устанавливается. Fallback (старая схема): sdp это
            // offer принимающего — принимаем его и шлём answer.
            if (sig.sdp) {
              if (this.currentCall && this.currentCall.hasLocalOffer) {
                try {
                  await api.mediaSetRemote(call_id, sig.sdp);
                  console.log('[call] remote answer set — DTLS handshake should follow');
                } catch (e) {
                  console.error('[call] media set remote (answer) failed:', e && e.message || e);
                }
              } else {
                try {
                  const r = await api.mediaAcceptIncoming(call_id, sig.sdp, this.peerKeys[from] || '', sig.kemct || null);
                  console.log('[call] callee offer accepted, answer created,', (r.sdp || '').length, 'bytes');
                  const answerPayload = { type: 'call_sdp', call_id, sdp: r.sdp, role: 'answer' };
                  await this.sendCallEnvelope(from, answerPayload);
                  console.log('[call] answer sent OK — waiting for DTLS');
                  // Ретрансляция answer (27.08): если письмо потеряется,
                  // принимающий зависнет в «Соединение…». Повторяем каждые
                  // 10с до соединения медиа.
                  this.startSignalResend(from, answerPayload, call_id);
                } catch (e) {
                  console.error('[call] media accept failed:', e && e.message || e);
                }
              }
            }
          }
          break;
        case 'call_reject':
        case 'call_end':
        case 'call_cancel':
          // call_cancel — собеседник отменил/завершил звонок (или у него
          // сработал таймаут): кладём трубку автоматически.
          // Гонка (26.08): пользователь мог уже повесить трубку вручную
          // (state=idle) до того, как call_end дошёл — проверяем и по
          // lastCallId, чтобы не оставить трубку у собеседника.
          if (this.currentCall && this.currentCall.call_id === call_id) {
            // remote_reject (27.08) — отдельно от remote: звонящий увидит
            // «Вызов отклонён», а не «Нет ответа».
            this.hangup(type === 'call_reject' ? 'remote_reject' : 'remote');
          } else if (this.lastCallId === call_id && this.callState === 'idle') {
            console.log('[call] remote end after local hangup — ensuring cleanup');
            this.hangup('remote_late');
          }
          // ЗАПОМНИТЬ ТЕРМИНАЛЬНЫЙ call_id ВСЕГДА (29.08, «зомби-звонок»):
          // cancel/end/reject мог прийти РАНЬШЕ call_request в порядке
          // доставки (INBOX/All Mail/Спам — разные копии, порядок не
          // гарантирован). Без помни later call_request поднимал звонок,
          // которого уже нет (запомненные терминалы гасят его в guard
          // isCallSeen ниже). Свежие cancel не попадали в stale-ветку —
          // потому и не запоминались.
          await this.rememberCallSeen(call_id);
          if (this.lastCallId !== call_id) this.lastCallId = call_id;
          break;
        case 'call_sdp':
          // Фаза 2: SDP-обмен после call_accept. offer — сторона получателя
          // (создаёт answer и шлёт обратно), answer — сторона звонящего
          // (завершает handshake, DTLS-SRTP устанавливается).
          console.log('[call] sdp received', call_id, 'role=' + sig.role, 'state=' + this.callState);
          if (!this.currentCall || this.currentCall.call_id !== call_id
              || this.callState !== 'active') {
            console.warn('[call] sdp DROPPED by guard:', call_id, 'role=' + sig.role,
                'state=' + this.callState, 'current=' + (this.currentCall && this.currentCall.call_id));
            break;
          }
          if (sig.role === 'answer') {
            // Фаза 2.3 (схема: offer от принимающего): звонящий получает ANSWER от принимающего
            // и завершает handshake (DTLS-SRTP).
            try {
              await api.mediaSetRemote(call_id, sig.sdp);
              console.log('[call] remote answer set — DTLS handshake should follow');
            } catch (e) {
              console.error('[call] media set remote failed:', e);
            }
          }
          break;
        default:
          break;
      }
    },
    // Кнопка «Позвонить» в шапке чата (1:1, есть ключ собеседника).
    async startCall() {
      const peer = this.activeChat;
      if (!peer || peer === '__notes__' || this.activeChatType !== 'chat') return;
      if (this.callState !== 'idle' || !this.peerKeys[peer]) return;
      const call_id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      this.currentCall = { call_id, peer };
      this.lastCallId = call_id;
      this.callState = 'outgoing_ringing';
      this.callMuted = false;
      this.startFastPolling();
      // Таймер гудка: у ЗВОНЯЩЕГО 300с (27.08: было 180с — email round-trip
      // для call_accept может превысить 180с, и звонок сгорал до ответа;
      // окончательно решает call_reject/call_cancel от собеседника).
      this.callRingTimer = setTimeout(() => this.cancelCall('timeout'), 300000);
      // ВАЖНО (27.08): сигнал call_request отправляем ДО гудков. cpal-гудок
      // может зависнуть на enum аудио-устройств (глючный Bluetooth) и
      // заблокировать рантайм — если бы он стоял перед отправкой, сигнал не
      // уходил (наблюдали 27.08: call_request не долетал до Gmail, а
      // call_cancel при hangup проходил). Сначала сигнал, потом звук
      // (запустится на ~1с позже — некритично).
      //
      // OFFER В call_request (28.08, фикс «тишина ~30с»): классическая схема
      // WebRTC — offer звонящего едет в ПЕРВОМ письме. Раньше SDP делал 3
      // почтовых hops (call_request → accept+offer → answer), после свайпа
      // принять до звука проходило 2 hops (20-60с). Теперь после accept
      // остаётся 1 hop (answer) — звук на 15-30с раньше. Offer создаётся
      // ДО отправки (ICE gathering ~4с); если не получится — fallback на
      // старую схему (offer принимающего внутри call_accept).
      let offerSdp = null;
      try {
        const r = await api.mediaStartOutgoing(call_id, this.peerKeys[peer] || '', (this.peerPqKeys && this.peerPqKeys[peer]) || null);
        offerSdp = r.sdp;
        // PQ (30.08): kemct из SdpResult — поедет в call_request-конверте,
        // принимающий передаст в mediaAcceptIncoming для гибридного ключа.
        if (r.kemct) this._pendingKemct = r.kemct;
        if (r.sender_ek) this._pendingSenderEk = r.sender_ek;
        console.log('[call] offer created at dial time,', (offerSdp || '').length, 'bytes');
      } catch (e) {
        console.error('[call] offer at dial failed (fallback callee-offer):', e);
      }
      // Флаг для обработки call_accept (28.08): если offer создан здесь —
      // sdp в call_accept это ANSWER; иначе (fallback) — offer принимающего.
      this.currentCall.hasLocalOffer = !!offerSdp;
      try {
        // PQ (30.08): kemct/sender_ek из mediaStartOutgoing → в конверт.
        await this.sendCallEnvelope(peer, {
          type: 'call_request', call_id, sdp: offerSdp,
          kemct: this._pendingKemct || undefined,
          sender_ek: this._pendingSenderEk || undefined,
        });
        this._pendingKemct = null; this._pendingSenderEk = null;
      } catch (e) {
        console.error('call_request failed:', e);
        this.hangup('error');
        return;
      }
      // Гудки исходящего (27.08): тёплый мажорный ringback, цикл до
      // accept/cancel/timeout. Запускаем ПОСЛЕ успешной отправки сигнала.
      this.playCallSound('outgoing', true);
      // РЕТРАНСЛЯЦИЯ (27.08): email-сигнал может потеряться в транзите
      // (SMTP принял без ошибки, но письмо не дошло до Gmail — наблюдали
      // 27.08: call_request пропал, call_cancel через минуту дошёл).
      // Повторяем call_request каждые 15с пока гудки: приёмник дедупит по
      // call_id (isCallSeen), дубликаты безопасны. Останавливается в hangup.
      this.callResendTimer = setInterval(async () => {
        if (this.callState !== 'outgoing_ringing' || !this.currentCall
            || this.currentCall.call_id !== call_id) {
          clearInterval(this.callResendTimer);
          this.callResendTimer = null;
          return;
        }
        try {
          // Offer внутри (28.08) — ретрансляция несёт и его.
          // PQ (30.08): kemct/sender_ek из mediaStartOutgoing → в конверт.
        await this.sendCallEnvelope(peer, {
          type: 'call_request', call_id, sdp: offerSdp,
          kemct: this._pendingKemct || undefined,
          sender_ek: this._pendingSenderEk || undefined,
        });
        this._pendingKemct = null; this._pendingSenderEk = null;
          console.log('[call] call_request retransmitted', call_id);
        } catch (e) {
          console.warn('[call] call_request retransmit failed:', e && e.message || e);
        }
      }, 15000);
    },
    async acceptCall() {
      const c = this.currentCall;
      if (!c || this.callState !== 'incoming_ringing') return;
      // Ответили — рингтон и таймер отмены в сторону, чайм соединения (27.08).
      // stop не нужен: play сам останавливает предыдущий звук.
      clearTimeout(this.callRingTimer);
      this.callRingTimer = null;
      this.playCallSound('connect', false);
      // 30.08 «тишина после принятия»: короткий connect-бип не даёт понять,
      // что вызов жив. Гудим исходящим гудком (зацикленно) до media-connected
      // ('connected' звук) или до hangup — как в обычных мессенджерах.
      setTimeout(() => {
        if (this.callState === 'active' && !this.callMediaConnected) {
          this.playCallSound('outgoing', true);
        }
      }, 1200);
      this.callState = 'active';
      // Фаза 3 (30.08): сообщаем монитору-владельцу, что звонок принят —
      // иначе headless-таймаут поставит missed поверх принятого.
      api.reportCallState(c.call_id, 'accept');
      // Таймер НЕ запускаем (27.08): ждём событие call-media-connected
      // из Rust (реальный звук). Предохранитель 120с — см. armMediaFallback.
      this.callMediaConnected = false;
      this.armMediaFallback();
      // OFFER В call_request (28.08): если offer звонящего пришёл в первом
      // письме — сразу создаём ANSWER и шлём его внутри call_accept. После
      // свайпа принять до звука остаётся ОДИН почтовый hop (раньше два:
      // accept+offer → answer). Fallback (старая версия звонящего без
      // offer): создаём offer сами внутри call_accept.
      try {
        let acceptPayload;
        if (c.offerSdp) {
          const r = await api.mediaAcceptIncoming(c.call_id, c.offerSdp, this.peerKeys[c.peer] || '', c.kemct || null);
          console.log('[call] caller offer accepted, answer created,', (r.sdp || '').length, 'bytes, sending in call_accept');
          acceptPayload = { type: 'call_accept', call_id: c.call_id, sdp: r.sdp, role: 'answer' };
        } else {
          const r = await api.mediaStartOutgoing(c.call_id, this.peerKeys[c.peer] || '', (this.peerPqKeys && this.peerPqKeys[c.peer]) || null);
          console.log('[call] offer (callee fallback) created,', (r.sdp || '').length, 'bytes, sending in call_accept');
          acceptPayload = { type: 'call_accept', call_id: c.call_id, sdp: r.sdp };
        }
        await this.sendCallEnvelope(c.peer, acceptPayload);
        console.log('[call] call_accept + sdp sent OK');
        // Ретрансляция call_accept (27.08): письмо может потеряться —
        // тогда звонящий будет гудеть вечно. Повторяем каждые 10с, пока
        // медиа не соединится (stopSignalResend в media-connected/hangup).
        this.startSignalResend(c.peer, acceptPayload, c.call_id);
      } catch (e) {
        console.error('[call] media start (callee) failed:', e);
        // Медиа не поднялось, но звонок всё равно принимаем — сигнал важнее.
        // ДИАГНОСТИКА (26.08): показываем ошибку в UI — на Android иначе не
        // увидеть, почему webrtc-rs не поднимает медиа (logcat недоступен).
        this.showToast('⚠️ media start failed: ' + (e && e.message || e), 10000);
        try { await this.sendCallEnvelope(c.peer, { type: 'call_accept', call_id: c.call_id }); }
        catch (e2) { console.error('call_accept failed:', e2); }
      }
    },
    async rejectCall() {
      const c = this.currentCall;
      if (c) {
        // Повтор call_reject (27.08) — см. sendTerminalRepeat.
        this.sendTerminalRepeat(c.peer, 'call_reject', c.call_id);
        // Фаза 3 (30.08): решение монитору-владельцу (нет missed поверх).
        api.reportCallState(c.call_id, 'reject');
      }
      this.hangup('reject');
    },
    async endCall() {
      const c = this.currentCall;
      if (c && this.callState === 'active') {
        // МГНОВЕННЫЙ HANGUP (28.08): «hangup» по WebRTC DataChannel —
        // собеседник получает за миллисекунды. Раньше call_end шёл по
        // email 30-60с, и собеседник сидел с «активным» звонком.
        api.mediaSendHangup(c.call_id);
        // Email-сигнал остаётся как fallback (DC мог не открыться):
        // 3 попытки: сразу, +3с, +7с.
        this.sendTerminalRepeat(c.peer, 'call_end', c.call_id);
      }
      this.hangup('end');
    },
    // Локальный сброс состояния (после сигнала, отмены или таймаута).
    async hangup(reason) {
      const c = this.currentCall;
      const callId = c ? c.call_id : null;
      const wasActive = this.callState === 'active';
      const wasIncoming = this.callState === 'incoming_ringing';
      const wasOutgoing = this.callState === 'outgoing_ringing';
      console.log('[call] hangup', reason, 'call_id=' + callId, 'state=' + this.callState);
      // Снять full-screen уведомление входящего (28.08): любой исход
      // (принят/отклонён/таймаут/завершён) гасит системный звонок.
      api.mediaDismissIncomingCall();
      // Пропущенные вызовы (27.08): фиксируем исход звонка в истории чата
      // «пилюлей» (Пропущенный звонок / Нет ответа / Звонок завершён · 03:24).
      // fire-and-forget: hangup не ждёт sqlite.
      if (c && callId) {
        const dur = wasActive ? this.callClockSec : 0;
        let kind = null;
        if (wasActive) {
          kind = 'ended';
        } else if (wasIncoming) {
          if (reason === 'reject') kind = 'declined';
          else if (reason === 'timeout' || reason === 'remote'
              || reason === 'remote_late' || reason === 'preempt') kind = 'missed';
        } else if (wasOutgoing) {
          if (reason === 'timeout') kind = 'no_answer';
          else if (reason === 'remote_reject') kind = 'declined';
          // call_cancel от собеседника = у него сгорел таймер гудка → нет ответа.
          else if (reason === 'remote' || reason === 'remote_late') kind = 'no_answer';
          else if (reason === 'cancel') kind = 'canceled';
        }
        if (kind) this.recordCallEvent(c.peer, kind, Date.now(), dur, callId);
      }
      clearTimeout(this.callRingTimer);
      this.callRingTimer = null;
      // Ретрансляция call_request (27.08) — тоже останавливаем.
      if (this.callResendTimer) {
        clearInterval(this.callResendTimer);
        this.callResendTimer = null;
      }
      // Ретрансляция call_accept/answer (27.08).
      this.stopSignalResend();
      // Предохранитель «Соединение…» (27.08).
      clearTimeout(this._mediaFallbackTimer);
      // Grace-таймер ICE disconnected (28.08).
      if (this._connLostTimer) { clearTimeout(this._connLostTimer); this._connLostTimer = null; }
      this.stopCallClock();
      // Фаза 3 (30.08): сообщаем монитору-владельцу исход звонка, чтобы
      // headless-логика не ставила missed поверх реального решения.
      if (callId) {
        const st = (wasIncoming && (reason === 'reject' || reason === 'timeout'
          || reason === 'cancel' || reason === 'preempt')) ? 'rejected'
          : 'ended';
        api.reportCallState(callId, st);
      }
      this.callState = 'idle';
      this.currentCall = null;
      this.callMuted = false;
      this.callSpeaker = false;
      this.callMediaConnected = false;
      this.stopFastPolling();
      // Финальный звук (27.08): play сам останавливает предыдущий поток
      // (Rust/HTML5), поэтому отдельный stop перед play не вызываем —
      // только если звука не будет вовсе.
      if (wasActive) {
        this.playCallSound('end', false);
      } else if (wasIncoming && (reason === 'timeout' || reason === 'reject'
          || reason === 'cancel' || reason === 'remote' || reason === 'preempt')) {
        this.playCallSound('missed', false);
      } else if (wasOutgoing && (reason === 'remote' || reason === 'timeout')) {
        // Звонящий: собеседник отклонил/отменил или гудки сгорели — отбой.
        this.playCallSound('end', false);
      } else {
        this.stopCallSound();
      }
      // Фаза 2: закрываем медиа-канал (webrtc-rs PeerConnection).
      if (callId) {
        try { await api.mediaClose(callId); } catch (e) { /* ignore */ }
      }
    },
    // ── Пропущенные вызовы (27.08) ──
    // Исход звонка фиксируется «пилюлей» в истории чата (как в Telegram):
    // пропущенный/нет ответа/отклонён/завершён + время + кнопка «Перезвонить».
    // Пилюля — обычное сообщение с полем callEvent; персистится в sqlite
    // вместе с историей (saveCurrentHistory) и в chat-cache (slim-маппер
    // сохраняет callEvent). Текст рендерится через t() — язык из настроек.
    async recordCallEvent(peer, kind, ts, durationSec, callId) {
      if (!peer || !callId) return;
      const chatKey = this.canonicalOf(peer) || peer;
      const tsNum = Number(ts) || Date.now();
      const msg = {
        id: 'call-' + callId,
        content: '',
        from: 'them',
        time: new Date(tsNum).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ts: tsNum,
        encrypted: true,
        vault: true,
        callEvent: { kind, duration: Number(durationSec) || 0, call_id: callId },
      };
      // Дедуп: один call_id — одна пилюля (повторный фетч/ретрансляция).
      const exists = (this.messages || []).some(m => m && m.id === msg.id);
      if (!exists && this.activeChat === chatKey && this.activeChatType === 'chat') {
        this.messages.push(msg);
        this.messages.sort((a, b) => this.msgTs(a) - this.msgTs(b));
        this.saveCurrentHistory(chatKey);
        this.saveChatCache(chatKey, this.messages);
        this.scrollToBottom(true);
      } else if (!exists) {
        // Чат не открыт — дописываем пилюлю в сохранённую историю напрямую,
        // чтобы она появилась при следующем открытии чата.
        try {
          const hist = await loadHistory(this.email, chatKey);
          if (Array.isArray(hist) && !hist.some(m => m && m.id === msg.id)) {
            hist.push(msg);
            hist.sort((a, b) => this.msgTs(a) - this.msgTs(b));
            await saveHistory(this.email, chatKey, hist);
          }
        } catch (e) { /* sqlite недоступен — не критично */ }
      }
      // Бейдж непрочитанных: пропущенный входящий — как непрочитанное
      // сообщение, если чат сейчас не виден.
      if (kind === 'missed' && !this.chatVisible(chatKey)) {
        this.unreadCounts[chatKey] = (this.unreadCounts[chatKey] || 0) + 1;
        await this.saveUnreadCounts();
      }
    },
    callEventLabel(msg) {
      const ev = msg && msg.callEvent;
      if (!ev) return '';
      const key = {
        missed: 'call_missed',
        no_answer: 'call_no_answer',
        declined: 'call_declined',
        canceled: 'call_canceled',
        ended: 'call_ended',
      }[ev.kind] || 'call_missed';
      let label = this.t(key);
      if (ev.kind === 'ended' && ev.duration > 0) {
        const m = Math.floor(ev.duration / 60);
        const s = ev.duration % 60;
        label += ' · ' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }
      return label;
    },
    callPillIcon(msg) {
      const kind = msg && msg.callEvent && msg.callEvent.kind;
      if (kind === 'ended') return 'phone';
      return 'phone-off';
    },
    canCallBack(msg) {
      // Перезвонить можно, если звонок не активен и у собеседника есть ключ.
      return !!(msg && msg.callEvent && this.expCalls
          && this.callState === 'idle'
          && this.activeChatType === 'chat'
          && this.peerKeys[this.activeChat]);
    },
    callBack() {
      this.startCall();
    },
    async cancelCall(reason) {
      const c = this.currentCall;
      // ЗАЩИТА ОТ УСТАРЕВШЕГО ТАЙМЕРА (27.08): таймер гудка (ringing)
      // может сработать ПОЗЖЕ, чем call_accept дошёл по почте (SMTP с
      // Android + доставка + IMAP ≈ 90-180с). Если звонок уже active —
      // это устаревший тик: НЕ рвём живой звонок.
      if (reason === 'timeout' && this.callState === 'active') {
        console.warn('[call] stale ring timeout ignored — call is active');
        return;
      }
      // Отмена/таймаут — сообщаем собеседнику (call_cancel при ringing,
      // call_end при active), чтобы у него трубка легла сама.
      // ВАЖНО: fire-and-forget (НЕ await!) — между await-отправкой и
      // hangup есть окно гонки: обработка call_accept успевает сменить
      // state на active, и hangup рвёт живой звонок (27.08).
      // Повтор сигнала (27.08): 3 попытки — см. sendTerminalRepeat.
      if (c) {
        const type = this.callState === 'active' ? 'call_end' : 'call_cancel';
        this.sendTerminalRepeat(c.peer, type, c.call_id);
      }
      this.hangup(reason || 'cancel');
    },
    toggleMute() {
      this.callMuted = !this.callMuted;
      const c = this.currentCall;
      if (c) {
        api.mediaSetMuted(c.call_id, this.callMuted).catch((e) => console.error('[call] set muted failed:', e));
      }
    },
    // Динамик (27.08): Android — speakerphone (earpiece ↔ динамик);
    // desktop — no-op в Rust (вывод и так на динамики).
    toggleSpeaker() {
      this.callSpeaker = !this.callSpeaker;
      const c = this.currentCall;
      if (c) {
        api.mediaSetSpeaker(c.call_id, this.callSpeaker).catch((e) => console.error('[call] set speaker failed:', e));
      }
    },
    // РЕТРАНСЛЯЦИЯ КРИТИЧНЫХ СИГНАЛОВ (27.08): call_accept и SDP-answer
    // повторяются каждые 10с, пока медиа не соединится или звонок не
    // завершится. Email-письма теряются в транзите (наблюдали: call_accept
    // не дошёл до звонящего — тот гудел вечно, «у вызывающего не
    // сбрасывается»). Дубликаты безопасны: приёмник игнорирует их по
    // состоянию (call_accept — только в outgoing_ringing, call_sdp —
    // только в active с тем же call_id).
    startSignalResend(peer, payload, call_id) {
      this.stopSignalResend();
      this._signalResendTimer = setInterval(async () => {
        if (this.callState !== 'active' || !this.currentCall
            || this.currentCall.call_id !== call_id || this.callMediaConnected) {
          this.stopSignalResend();
          return;
        }
        try {
          await this.sendCallEnvelope(peer, payload);
          console.log('[call] signal retransmitted:', payload.type, call_id);
        } catch (e) {
          console.warn('[call] signal retransmit failed:', e && e.message || e);
        }
      }, 10000);
    },
    stopSignalResend() {
      if (this._signalResendTimer) {
        clearInterval(this._signalResendTimer);
        this._signalResendTimer = null;
      }
    },
    // Повтор терминального сигнала (call_end/call_cancel/call_reject):
    // если письмо потеряется, собеседник останется с поднятой трубкой
    // навсегда. Ещё 2 попытки через 3с и 7с (fire-and-forget). Дубликаты
    // у приёмника безопасны (ветка remote_late / guard по state).
    sendTerminalRepeat(peer, type, call_id) {
      this.sendCallEnvelope(peer, { type, call_id }).catch(() => {});
      setTimeout(() => { this.sendCallEnvelope(peer, { type, call_id }).catch(() => {}); }, 3000);
      setTimeout(() => { this.sendCallEnvelope(peer, { type, call_id }).catch(() => {}); }, 7000);
    },
    // Watchdog «Соединение…» (28.08): если через 90с после accept медиа
    // не соединилось (событие call-media-connected не пришло) — звонок не
    // состоялся: accept/answer потерялись в почте или собеседник уже ушёл.
    // Раньше предохранитель через 120с просто форсил таймер — и экран с
    // красной кнопкой висел вечно (жалоба 28.08). Теперь кладём трубку сами.
    armMediaFallback() {
      clearTimeout(this._mediaFallbackTimer);
      this._mediaFallbackTimer = setTimeout(() => {
        if (this.callState === 'active' && !this.callMediaConnected) {
          console.warn('[call] media not connected in 90s — auto hangup');
          this.showToast(this.t('call_connect_failed'), 4000);
          // Сообщаем собеседнику, чтобы у него тоже легла трубка
          // (он может висеть в таком же «Соединение…»).
          const c = this.currentCall;
          if (c) this.sendTerminalRepeat(c.peer, 'call_end', c.call_id);
          this.hangup('connect_timeout');
        }
      }, 90000);
    },
    startCallClock() {
      this.callClockSec = 0;
      clearInterval(this.callClockTimer);
      this.callClockTimer = setInterval(() => { this.callClockSec++; }, 1000);
    },
    stopCallClock() {
      clearInterval(this.callClockTimer);
      this.callClockTimer = null;
    },
    // Быстрый путь сигнализации (Фаза 1.5): IDLE-цикл теперь ПОСТОЯННЫЙ
    // (22.08) — дополнительно ничего делать не нужно, IDLE уже ловит
    // сигналы за ~1с. Оставляем как гарантию, что цикл запущен.
    startFastPolling() {
      this.idleLoop();
    },
    stopFastPolling() {
      // IDLE-цикл постоянный — не останавливаем (22.08).
    },
    // IMAP IDLE-цикл (Фаза 1.5 + 22.08): крутится ПОСТОЯННО, не только на
    // время звонка. Таймаут ожидания 2с; при событии «новое письмо» — сразу
    // инкрементальный фетч (разбирает call_* сигналы). Страховочный фетч
    // каждые ~10с: IDLE видит только INBOX, а сигнал мог упасть в Спам
    // (Gmail кладёт шифрописьма в Junk). БЕЗ этого входящий call_request
    // ждал бы поллинга 30с — получатель не успевал увидеть оверлей.
    async idleLoop() {
      if (this._idleActive || !this.isLoggedIn) return;
      this._idleActive = true;
      // Rust-монитор (t_64e7241a): запускаем параллельно с JS-циклом.
      // Идемпотентен на стороне Rust; курсоры берём из кэша активного
      // аккаунта, чтобы первый fetch не тянул старые письма.
      api.idleStart(this.loadCursors(this.email) || {}).catch(e =>
        console.warn('[idle-monitor] start failed:', e));
      let lastSafety = Date.now();
      let idleFailed = false;
      try {
        while (this.isLoggedIn && !this._idleStop) {
          let changed = false;
          try {
            const r = await api.idleWait(2000, 'INBOX');
            changed = !!(r && r.changed);
          } catch (e) {
            console.warn('[calls] IMAP IDLE недоступен, фолбэк на поллинг:', e && e.message || e);
            idleFailed = true;
            break;
          }
          const elapsed = Date.now() - lastSafety;
          // Gmail кладёт call_* письма в СПАМ, а IDLE-push приходит только от
          // INBOX: страховочный фетч JUNK делаем чаще (7с), чтобы answer/accept
          // из Спама не ждали 10с и не опаздывали к 90с-таймауту.
          if (changed || elapsed >= 7000) {
            lastSafety = Date.now();
            // Быстрый фетч для звонков (22.08): ОТДЕЛЬНЫЙ IMAP-клиент в Rust
            // (email_fetch_incremental_fast) — основной клиент может быть занят
            // зависшими операциями/троттлингом (lock busy → поллинг молча
            // пропускается, call_request невидим часами). Звонки доходят
            // всегда, независимо от состояния основного клиента.
            try { await this.loadEmailsFast(true); } catch (e) { /* тихо */ }
          }
        }
      } finally {
        this._idleActive = false;
        this._idleStop = false;
      }
      // Цикл вышел: звонок ещё идёт — ускоренный поллинг 3с как фолбэк
      // (hangup сам вернёт обычный 30с-поллинг).
      if (this.isLoggedIn && this.callState !== 'idle') this.startPolling(3000);
      // IDLE умер (провайдер/сеть): обычный поллинг продолжает работать;
      // пробуем вернуть IDLE через 60с (провайдер мог временно отключить).
      if (this.isLoggedIn && idleFailed) {
        setTimeout(() => { if (this.isLoggedIn) this.idleLoop(); }, 60000);
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
          // контактов (модель почтовый мессенджер — группа тоже источник контактов).
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
        crypto.setPeerPublicKey(this.peerKeys[this.activeChat], this.peerPqKeys && this.peerPqKeys[this.activeChat]);
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
            let base64 = e.target.result.split(',')[1];
            let fileName = file.name;
            let fileSize = file.size;
            let fileType = file.type;
            // Качество медиа (25.08): изображения сжимаются по настройке
            // «Качество отправляемых медиафайлов» (kv media-quality).
            // original = без сжатия; high = макс. сторона 1920; low = 1280.
            if (fileType.startsWith('image/') && fileType !== 'image/gif') {
              try {
                const quality = await this.mediaQuality();
                if (quality !== 'original') {
                  const maxSide = quality === 'low' ? 1280 : 1920;
                  const compressed = await this.compressImage(e.target.result, maxSide, 0.82);
                  if (compressed && compressed.length < e.target.result.length) {
                    base64 = compressed.split(',')[1];
                    fileType = 'image/jpeg';
                    if (!/\.jpe?g$/i.test(fileName)) fileName = fileName.replace(/\.\w+$/, '') + '.jpg';
                    fileSize = Math.floor(base64.length * 0.75);
                  }
                }
              } catch (err) { console.warn('image compress failed:', err); }
            }
            const isImage = fileType.startsWith('image/');
            const isAudio = fileType.startsWith('audio/');
            const isText = !isImage && !isAudio && this.isTextMime(fileType, fileName);
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
              name: fileName,
              type: fileType,
              size: fileSize,
              data: base64,
            });

            const displayContent = isImage
              ? `📎 ${fileName}`
              : `📎 ${fileName} (${(fileSize / 1024).toFixed(1)}KB)`;

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
              crypto.setPeerPublicKey(this.peerKeys[this.activeChat], this.peerPqKeys && this.peerPqKeys[this.activeChat]);
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
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat], this.peerPqKeys && this.peerPqKeys[this.activeChat]);
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
            crypto.setPeerPublicKey(this.peerKeys[sender], this.peerPqKeys && this.peerPqKeys[sender]);
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
          crypto.setPeerPublicKey(this.peerKeys[sender], this.peerPqKeys && this.peerPqKeys[sender]);
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
    // поллинг «воскресил» бы удалённое. Хранится в sqlite (почтовый мессенджер-style),
    // с in-memory кэшем для синхронной фильтрации (filterDeleted).
    // См. initLocalDb() — загрузка при входе.
    tombstonesCache: [],
    // Duress-замок (t_b185e3e2): LockScreen поверх UI; duressPending — тихий SOS.
    duressLocked: false,
    duressPending: false,
    duressUnlockedThisSession: false,
    duressDiag: '',
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
      // Проставляем на сообщения. Проверка отправителя (аналог почтовый мессенджер
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
            crypto.setPeerPublicKey(this.peerKeys[this.activeChat], this.peerPqKeys && this.peerPqKeys[this.activeChat]);
            const content = await crypto.encryptVault(payload);
            await api.sendReaction(this.activeChat, content);
          }
        } catch (e) {
          console.error('Failed to send reaction email:', e);
        }
      })();
    },
    toggleReactionPicker(msgId) {
      // Пилюли звонков (27.08) — не сообщения: реакции на них не нужны.
      const m = (this.messages || []).find(x => x && x.id === msgId);
      if (m && m.callEvent) return;
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
    linkify(text) {
      // Безопасная автолинковка: текст → экранированный HTML → ссылки/телефоны.
      // Телефоны заменяются через плейсхолдеры ДО URL, чтобы не пересекаться.
      const esc = String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      const phones = [];
      // Телефон: код (+7/8/международный до 3 цифр) опционален, разделители
      // (пробел/скобки/дефисы) — в любом количестве и любом месте между
      // группами: 8(999)123-45-67, +7 (999) 123 45 67, +380 67 123 45 67.
      const PHONE_RE = /(?<![\d])(?:\+?\d{1,3}[\s()-]*)?\(?\d{2,3}\)?[\s()-]*\d{3}[\s()-]*\d{2}[\s()-]*\d{2}/g;
      let tmp = esc.replace(PHONE_RE, (m) => { phones.push(m.trim()); return `\u0000P${phones.length - 1}\u0000`; });
      tmp = tmp.replace(/(https?:\/\/[^\s<"']+)/g, '<a href="$1" data-url="$1" class="msg-link">$1</a>');
      tmp = tmp.replace(/\u0000P(\d+)\u0000/g, (_, i) => `<a href="tel:${phones[+i]}" data-phone="${phones[+i]}" class="msg-link msg-phone">${phones[+i]}</a>`);
      return tmp;
    },
    onMessageTextClick(e) {
      const urlEl = e.target.closest('a[data-url]');
      if (urlEl) { e.preventDefault(); openExternal(urlEl.dataset.url).catch(() => {}); return; }
      const phoneEl = e.target.closest('a[data-phone]');
      if (phoneEl) { e.preventDefault(); this.copyText(phoneEl.dataset.phone); }
    },
    openMessageMenu(event, msg) {
      // Пилюли звонков (27.08) — не сообщения: обычные пункты (ответить,
      // копировать) не имеют смысла, но «Удалить у меня» нужно (31.08) —
      // меню открывается, шаблон прячет неприменимое по msg.callEvent.
      const content = msg.callEvent ? '' : (msg.content || '');
      const PHONE_RE = /(?<![\d])(?:\+?\d{1,3}[\s()-]*)?\(?\d{2,3}\)?[\s()-]*\d{3}[\s()-]*\d{2}[\s()-]*\d{2}/g;
      const phones = [...content.matchAll(PHONE_RE)]
        .map(m => m[0].trim())
        .filter((v, i, a) => a.indexOf(v) === i);
      const urls = [...content.matchAll(/https?:\/\/[^\s\]\)"']{2,}/g)]
        .map(m => m[0])
        .filter((v, i, a) => a.indexOf(v) === i);
      this.messageMenu = { x: event.clientX, y: event.clientY, msg, phones, urls };
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
        // Аватар группы (если загружен в диалоге создания): sqlite kv_store,
        // тот же ключ, что использует GroupSettings/рассылка meta-письма.
        if (this.newGroupAvatar) {
          await db.kvSet('anon', 'group-avatar:' + group.id, this.newGroupAvatar);
          this.groupAvatars[group.id] = this.newGroupAvatar;
        }
        this.groups.push(group);
        this.currentGroup = group;

        // Generate and store a group encryption key
        if (this.cryptoReady) {
          const groupKey = await crypto.generateGroupKey();
          this.groupKeys[group.id] = groupKey;
          // Аватар, заданный при создании, сразу уходит участникам (meta-письмо),
          // как если бы админ поменял его в настройках группы.
          if (this.newGroupAvatar) {
            try {
              const payload = JSON.stringify({ meta: 1, avatar: this.newGroupAvatar });
              const content = await crypto.encryptWithGroupKey(payload, groupKey);
              await api.sendGroupMeta(group.id, content);
            } catch (e) {
              console.warn('Group avatar broadcast failed:', e);
            }
          }
        }
        // Одноразовый аватар диалога больше не нужен.
        this.newGroupAvatar = '';

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
    // N7 (28.08, паритет Delta Chat): клон группы — новый чат с тем же
    // составом участников, но пустой историей (например, «Работа» →
    // «Работа — проект X»). Инвайты уходят автоматически: ключ новой
    // группы шифруется на публичный ключ каждого участника (тот же путь,
    // что inviteSelectedMembers). Только создатель оригинала.
    async cloneGroup() {
      const src = this.currentGroup;
      if (!src || src.created_by !== this.email) return;
      const base = (src.name || 'Группа').trim();
      const name = prompt(this.t('group_clone_prompt') || 'Имя новой группы (клон)', base + ' 2');
      if (!name || !name.trim()) return;
      this.showGroupSettings = false;
      try {
        const group = await api.createGroup(name.trim(), '');
        group.members = [{ email: this.email, role: 'Admin' }];
        group.blocked = [];
        // Аватар клона — как у оригинала (общий kv 'anon').
        const avatar = (await db.kvGet('anon', 'group-avatar:' + src.id)) || '';
        if (avatar) {
          await db.kvSet('anon', 'group-avatar:' + group.id, avatar);
          this.groupAvatars[group.id] = avatar;
        }
        this.groups.push(group);
        this.currentGroup = group;
        // Ключ группы: groups_create уже вернул group_key — кладём в память
        // (без этого шифрование инвайтов и отправка в клон невозможны).
        if (group.group_key) this.groupKeys[group.id] = group.group_key;
        // Инвайт всем участникам оригинала (кроме нас) — с проверкой ключа,
        // как в обычном добавлении: без peerKey безопасный инвайт невозможен.
        const invited = [];
        const skipped = [];
        for (const m of (src.members || [])) {
          const email = (m.email || '').toLowerCase();
          if (!email || email === (this.email || '').toLowerCase()) continue;
          const peerPub = this.peerKeys[m.email] || this.peerKeys[email] || null;
          if (!peerPub) { skipped.push(m.email); continue; }
          try {
            const enc = await crypto.encryptGroupKeyForUser(group.group_key, peerPub);
            await api.inviteGroupMember(group.id, m.email, enc, this.publicKey);
            group.members.push({ email: m.email, role: m.role || 'Member', invited: true });
            invited.push(m.email);
          } catch (e) {
            skipped.push(m.email);
          }
        }
        // Группы персистятся на Rust-стороне (groups_create уже сохранил);
        // локальный members-массив — только для отображения invited-статуса.
        const msg = (this.t('group_clone_done') || 'Клон создан') +
          (invited.length ? ': ' + this.t('group_clone_invited') + ' ' + invited.join(', ') : '') +
          (skipped.length ? '\n' + (this.t('group_clone_skipped') || 'пропущены (нет ключа)') + ': ' + skipped.join(', ') : '');
        alert(msg);
      } catch (e) {
        console.error('cloneGroup failed:', e);
        alert((this.t('group_clone_failed') || 'Не удалось создать клон') + ': ' + e.message);
      }
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
    // Один fingerprint у двух адресов? (смена почты: старый/новый в peer_keys
    // ссылаются на один публичный ключ — см. aliasesOf)
    emailSharesFingerprint(emailA, emailB) {
      const ka = this.peerKeys[emailA || ''] || this.peerKeys[String(emailA || '').toLowerCase()];
      const kb = this.peerKeys[emailB || ''] || this.peerKeys[String(emailB || '').toLowerCase()];
      return !!(ka && kb && ka === kb);
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
      const skipped = [];
      for (const email of emails) {
        try {
          // Уже участник ПОД ЭТИМ адресом — явный skip (не тихий continue:
          // «штатный» попап без отправки маскировал недоставленные инвайты).
          if ((this.currentGroup.members || []).some(m => m.email === email)) {
            skipped.push(email + ' — ' + (this.t('already_in_group') || 'уже в группе'));
            continue;
          }
          // Участник ПОД ДРУГИМ адресом с тем же fingerprint (смена почты):
          // мигрируем адрес в составе группы и шлём инвайт на новый адрес —
          // без этого после смены почты участник «залипал» под мёртвым адресом,
          // а повторный инвайт тихо скипался (баг 31.08, группа «Четыре»).
          const stale = (this.currentGroup.members || []).find(
            m => m.email !== email && this.emailSharesFingerprint(m.email, email));
          if (stale) {
            await invoke('groups_rename_member', {
              groupId: this.currentGroup.id, oldEmail: stale.email, newEmail: email,
            });
            stale.email = email;
            stale.key_shared = true;
          }
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
          failed.push(email + ' — ' + ((e && e.message) || e));
        }
      }
      // Состав группы перечитываем с диска: groups_rename_member правил
      // groups.json в Rust-стороне, локальный members мог разойтись.
      try { await this.loadGroups(); } catch (e) { /* не критично */ }
      const parts = [];
      if (sent.length) parts.push((this.t('invite_sent') || 'Приглашение отправлено') + ': ' + sent.join(', '));
      if (skipped.length) parts.push((this.t('invite_skipped') || 'Пропущены') + ':\n' + skipped.join('\n'));
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
      // Контакты 1-на-1 (модель почтовый мессенджер): accept-письма → добавляем ключи
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
        // PQ (30.08): pq-ключ приглашающего (если прислал) — контакт сразу
        // гибридный. pq отсутствует → legacy X25519-контакт.
        if (c.pq_public_key) this.peerPqKeys[c.sender] = c.pq_public_key;
        await crypto.savePeerKey(c.sender, c.public_key, c.sender_name || null, c.pq_public_key || undefined);
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
        // второй стороне (Contact::delete в почтовый мессенджер тоже локальный).
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
      // name == email — это НЕ имя, а fallback старых клиентов (они слали
      // email как name). Не показываем его как имя.
      if (p && p.name && p.name !== email) return p.name;
      // Регистр email может отличаться (заголовки From: «Имя <Mail@X>» vs
      // ключ в kv_store lowercase). Ищем по нижнему регистру.
      const e = String(email || '').toLowerCase();
      for (const [k, v] of Object.entries(this.profiles || {})) {
        if (String(k).toLowerCase() === e && v && v.name && v.name !== email) return v.name;
      }
      return email;
    },
    avatarOf(email) {
      const lp = this.localProfileOf(email);
      if (lp && lp.avatar) return lp.avatar;
      const p = this.profileOf(email);
      if (p && p.avatar) return p.avatar;
      const e = String(email || '').toLowerCase();
      for (const [k, v] of Object.entries(this.profiles || {})) {
        if (String(k).toLowerCase() === e && v && v.avatar) return v.avatar;
      }
      return '';
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
    // Карточка контакта: тап по аватару в шапке чата (25.08).
    async openContactCard(email) {
      if (!email || email === '__notes__') return;
      // Перечитываем профили из kv — иначе карточка покажет устаревшие
      // вью-данные (bio мог прийти поллингом, но this.profiles не обновился).
      await this.loadProfiles().catch(() => {});
      this.contactCardEmail = email;
      this.showContactCard = true;
    },
    // Из карточки → локальная правка имени/аватара (старый попап).
    startEditFromCard() {
      const email = this.contactCardEmail;
      this.showContactCard = false;
      this.openContactEdit(email);
    },
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
  background: linear-gradient(135deg, var(--accent-primary, #6366f1), #4f46e5);
  color: white; font-size: 14px; font-weight: 600;
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

/* Карточка контакта (25.08): тап по аватару в шапке */
.contact-card-panel {
  position: relative;
  width: min(360px, calc(100vw - 40px));
  padding: 24px;
}
.contact-card-head {
  display: flex; align-items: center; gap: 16px; margin-bottom: 14px;
}
.contact-card-id h3 { margin: 0 0 4px; font-size: 18px; }
.contact-card-email { margin: 0; color: var(--text-secondary, #9ca3af); font-size: 13px; }
.contact-card-footer {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 18px; gap: 10px;
}
.contact-card-seen {
  font-size: 12px; color: var(--text-muted, #6b7280);
  display: inline-flex; align-items: center; gap: 6px;
}
.contact-card-seen::before {
  content: ''; width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-muted, #6b7280); opacity: .5;
}
.contact-card-seen.online { color: #22c55e; }
.contact-card-seen.online::before { background: #22c55e; opacity: 1; }
.chat-avatar-btn {
  padding: 0; border: none; background: none; cursor: pointer;
  border-radius: 50%; flex-shrink: 0;
}
.chat-avatar-btn:hover { box-shadow: 0 0 0 2px rgba(245,158,11,.5); }

/* Статус «О себе» контакта (25.08) */
.contact-bio-view {
  margin: 8px 0 0;
  padding: 10px 14px;
  background: rgba(245, 158, 11, 0.07);
  border-left: 3px solid rgba(245, 158, 11, 0.55);
  border-radius: 6px;
  color: var(--text-primary, #e6edf3);
  font-size: 13px;
  font-style: italic;
  text-align: left;
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
  border: none; /* 25.08: без обводки — ровный ряд иконок (замечение пользователя) */
  background: transparent;
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
  /* Android WebView: долгое нажатие одновременно открывает НАШЕ меню
     (contextmenu) и запускает НАТИВНОЕ выделение слова. Ползунки
     выделения попадают на оверлей меню — всё исчезает. Отключаем
     нативное выделение на touch: копирование доступно через наше меню
     (copyMessageText/copyMessageAll). */
  .message-content,
  .message-sender,
  .chat-header-text,
  .message-menu button {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  /* Шапка чата: на узких экранах « Encrypted» не влезает рядом с кнопками
     (телефон/карандаш/поиск) — оставляем только 🔒. На десктопе слово
     показывается (места достаточно). */
  .chat-enc-text {
    display: none;
  }
}

.message-content .msg-link {
  color: var(--accent-primary, #6366f1);
  text-decoration: underline;
  cursor: pointer;
  word-break: break-all;
}
.message-content .msg-link:hover {
  text-decoration: none;
  opacity: 0.85;
}
.message-content .msg-phone {
  color: var(--accent-secondary, #8b5cf6);
  white-space: nowrap;
}
.message-menu-sep {
  height: 1px;
  background: var(--border-subtle, rgba(255,255,255,0.08));
  margin: 4px 8px;
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
  animation: fadeIn 0.12s ease;
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

/* N5: переключатель архива в списке чатов */
.archive-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 12px;
  padding: 8px 12px;
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-tertiary, #1e1e3a);
  color: var(--text-secondary, #94a3b8);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.archive-toggle:hover { background: var(--bg-hover, #26264f); color: var(--text-primary, #f1f5f9); }
/* N5: иконка mute у чата в списке */
.chat-mute-icon { color: var(--text-secondary, #64748b); flex-shrink: 0; }

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

/* ── Звонки (27.08): «пилюля» исхода звонка в истории чата ──
   Центрированная, полупрозрачная, в общей стилистике Vault (тёмные темы).
   Пропущенный/нет ответа/отклонён — красный акцент; завершён — нейтральный. */
.message.call-event {
  max-width: 100%;
  width: 100%;
  display: flex;
  justify-content: center;
  margin: 6px 0;
}
.call-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 14px;
  border-radius: 999px;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-secondary, #8b949e);
  background: var(--bg-secondary, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  box-shadow: var(--shadow-sm);
  user-select: none;
}
.call-pill--missed,
.call-pill--no_answer,
.call-pill--declined {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.25);
  background: rgba(248, 113, 113, 0.08);
}
.call-pill--canceled {
  color: var(--text-secondary, #8b949e);
}
.call-pill--ended {
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.22);
  background: rgba(74, 222, 128, 0.07);
}
.call-pill-label { font-weight: 500; }
.call-pill-time {
  opacity: 0.75;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.call-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  padding: 2px 9px;
  border: none;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, var(--accent-primary, #6366f1), #4f46e5);
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.1s ease;
}
.call-back-btn:hover { filter: brightness(1.12); }
.call-back-btn:active { transform: scale(0.96); }

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

/* ── Единая кнопка закрытия окон (25.08) ──
   Один стиль для ВСЕХ модалок: настройки, смена почты, инвайты, участники,
   просмотр фото, шифратор, ключи, QR. Крестик = Icon x (фирменный янтарный),
   круглая зона нажатия 40px (достаточно для тача), полупрозрачный фон при
   наведении. Стиль глобальный (не scoped) — применяется и внутри компонентов
   (CipherTool/KeyManager/QRCodePanel). Стрелка «←» остаётся ТОЛЬКО для
   внутренней навигации (раздел настроек → назад к списку), не для закрытия. */
.modal-close-x {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-full, 999px);
  color: var(--text-secondary, #94a3b8);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.modal-close-x:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #e2e8f0);
}
.modal-close-x:active {
  background: var(--bg-active, rgba(255, 255, 255, 0.1));
}

/* Смена почты — модалка (24.08) */
.change-email-panel { max-width: 480px; padding: 32px; }
.change-email-hint { color: var(--text-muted, #8b949e); font-size: 13px; line-height: 1.5; margin-bottom: 16px; }
.change-email-input {
  width: 100%; padding: 10px 12px; background: var(--bg-primary, #0d1117); border: 1px solid var(--border-subtle, #30363d);
  border-radius: 6px; color: var(--text-primary, #e6edf3); font-size: 14px; box-sizing: border-box; margin-bottom: 8px;
}
.change-email-input:focus { border-color: var(--accent-primary, #58a6ff); outline: none; }
.change-email-row { margin-bottom: 8px; }
.change-email-panel .server-toggle { background: none; border: none; color: var(--accent-primary, #58a6ff); cursor: pointer; font-size: 13px; padding: 4px 0; }
.change-email-panel .server-settings { margin-top: 8px; padding: 12px; background: var(--bg-secondary, #161b22); border: 1px solid var(--border-subtle, #30363d); border-radius: 6px; }
.change-email-panel .server-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.change-email-panel .server-row label { color: var(--text-muted, #8b949e); font-size: 12px; min-width: 40px; }
.change-email-panel .server-row input { flex: 1; padding: 8px; background: var(--bg-primary, #0d1117); border: 1px solid var(--border-subtle, #30363d); border-radius: 4px; color: var(--text-primary, #e6edf3); font-size: 13px; }
.change-email-panel .server-port { max-width: 80px; }
.change-email-actions { display: flex; gap: 8px; margin-top: 16px; }
.change-email-panel .cancel-btn { padding: 8px 16px; background: var(--bg-tertiary, #21262d); color: var(--text-primary, #e6edf3); border: 1px solid var(--border-subtle, #30363d); border-radius: 6px; cursor: pointer; }
.change-email-panel .submit-btn { padding: 8px 16px; background: linear-gradient(135deg, var(--accent-primary, #6366f1), #4f46e5); color: white; border: none; border-radius: 6px; cursor: pointer; }
.change-email-panel .submit-btn:disabled { opacity: 0.5; }
.change-email-panel .login-error { color: #f85149; font-size: 13px; margin-top: 8px; }

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

/* Аватар в диалоге «Новая группа» (25.08): фото вместо эмодзи-иконок,
   единый стиль с аватаром аккаунта (круг, оверлей камеры при наведении). */
.new-group-avatar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0 4px;
}
.new-group-avatar {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  overflow: hidden;
  cursor: pointer;
  flex-shrink: 0;
  background: var(--bg-hover, rgba(255,255,255,0.06));
}
.new-group-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.new-group-avatar__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #64748b);
}
.new-group-avatar__hint {
  color: var(--text-muted, #64748b);
  font-size: 12px;
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

/* Единая система кнопок (24.08): базовый класс + модификаторы */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.15s ease;
  text-decoration: none;
  line-height: 1.2;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
.btn-lg { padding: 12px 24px; font-size: 16px; }
.btn-ghost {
  background: transparent;
  color: var(--text-secondary, #94a3b8);
  border: none;
  padding: 4px 8px;
}
.btn-ghost:hover { color: var(--text-primary, #f1f5f9); background: var(--bg-hover, rgba(255,255,255,0.05)); }
.btn-danger {
  padding: 8px 16px;
  background: rgba(248, 81, 73, 0.15);
  color: #f85149;
  border: 1px solid rgba(248, 81, 73, 0.35);
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s ease;
}
.btn-danger:hover { background: rgba(248, 81, 73, 0.25); }

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

/* Исчезающие сообщения (25.08): кнопка-таймер в шапке чата.
   Неактивный — как остальные (без обводки, серый замок).
   Активный — янтарный замок + янтарные обводка и заливка кнопки. */
.ephemeral-menu { position: relative; }
.chat-actions button.chat-action-btn.ephemeral-on {
  border: 1px solid rgba(245, 158, 11, 0.65);
  background: rgba(245, 158, 11, 0.12);
}
.export-menu.ephemeral-dropdown { min-width: 150px; }
.export-menu.ephemeral-dropdown button {
  display: block; width: 100%; text-align: left;
  padding: 9px 14px; background: none; border: none;
  color: var(--text-primary, #e6edf3); font-size: 13px; cursor: pointer;
}
.export-menu.ephemeral-dropdown button:hover { background: var(--bg-hover, rgba(255,255,255,0.06)); }
.export-menu.ephemeral-dropdown button.active { color: var(--accent-warn, #f59e0b); }

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
  background: var(--bg-primary, #0d1117);
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
   Responsive: мобильная навигация (Telegram/почтовый мессенджер паттерн)
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

@media (max-width: 767px), (max-height: 479px) {
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
  /* Android: email под аватаром не помещается и перекрывает элементы — скрыт. */
  .chat-avatar-email {
    display: none;
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

/* Модалка настроек на мобильном: на всю ширину и высоту, чтобы сайдбар
   с разделами был виден (не обрезался). */
@media (max-width: 767px), (max-height: 479px) {
  .modal-settings {
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
  }
}

/* Попапы инвайтов/контактов/добавления участника используют modal-settings,
   но им нужны внутренние отступы (у самого modal-settings их нет — туда
   вставляется SettingsPage, который сам занимает всё пространство). */
.invite-popup-panel {
  padding: 20px 24px 24px;
}

/* Android edge-to-edge (24.08): фуллскрин-модалки на мобильном начинаются от
   top:0 — стрелка «←» и заголовки уезжали под статус-бар. Отступ сверху через
   safe-area-inset-top (на десктопе inset=0, правило ничего не меняет).
   Правило стоит ПОСЛЕ .invite-popup-panel, чтобы перебить его padding-шортхэнд.
   box-sizing обязателен: глобального border-box нет, иначе padding раздует
   высоту модалки и контент выпадет за экран. */
@media (max-width: 767px), (max-height: 479px) {
  .modal-settings {
    box-sizing: border-box;
    padding-top: calc(16px + var(--safe-top, 0px));
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

/* Восстановление аккаунта на входе (Key Recovery, 25.08) */
.recovery-login { display: flex; flex-direction: column; gap: 8px; }
.recovery-input {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-primary, #0d1117);
  border: 1px solid var(--border-subtle, #30363d);
  border-radius: 8px;
  color: var(--text-primary, #e6edf3);
  font-family: ui-monospace, monospace;
  font-size: 13px;
  box-sizing: border-box;
  resize: vertical;
}
.recovery-file-row { display: flex; align-items: center; gap: 10px; }
.recovery-file-label {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; cursor: pointer;
}
.recovery-filename { font-size: 12px; color: var(--text-secondary, #9ca3af); }
.recovery-filename.muted { color: var(--text-muted, #64748b); }

/* Тост внизу экрана (25.08) */
.app-toast {
  position: fixed;
  left: 50%;
  bottom: calc(24px + var(--safe-bottom, 0px));
  transform: translateX(-50%);
  z-index: 3000;
  max-width: min(480px, calc(100vw - 32px));
  padding: 12px 18px;
  background: var(--bg-secondary, #161b22);
  color: var(--text-primary, #e6edf3);
  border: 1px solid var(--border-subtle, #30363d);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  font-size: 14px;
}
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
