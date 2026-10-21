<template>
  <div class="app-container">
    <!-- Duress-замок: поверх всего UI до ввода кода -->
    <LockScreen
      v-if="duressLocked"
      @unlock="onLockUnlock"
      @duress="onLockDuress"
      @panic="onLockPanic"
    />
    <!-- RESTORING SESSION (авто-вход: не показываем пустую форму логина) -->
    <div v-if="!isLoggedIn && restoringSession" class="login-screen">
      <div class="login-box">
        <h1><Icon name="lock" :size="26" gradient /> Vault</h1>
        <p class="login-hint">{{ t('restoring_session') || 'Подключение к почте…' }}</p>
      </div>
    </div>
    <!-- LOGIN SCREEN -->
    <div v-else-if="!isLoggedIn" class="login-screen">
      <div class="login-box">
        <h1><Icon name="lock" :size="26" gradient /> Vault</h1>
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

          <!-- Восстановление аккаунта: для тех, кто уже
               пользовался Vault и потерял ключи (новое устройство/переустановка).
               Раскрывается по клику — не мешает новому пользователю.
               -->
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
        <p class="login-hint">{{ t('login_hint') || 'Регистрация не нужна: у Vault нет сервера — приложение работает поверх вашей почты. Войдите под своим email, ключи создадутся автоматически. Добавляйте собеседников по id участника или QR-коду.' }}</p>
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
          <button :title="t('nav_channels') || 'Каналы'" @click="showChannelPanel = true"><Icon name="megaphone" :size="20" /></button>
          <button :title="t('nav_add_contact')" @click="showQRCode = true"><Icon name="link" :size="20" /></button>
          <button :title="t('nav_keys')" @click="showKeyManager = true"><Icon name="key" :size="20" /></button>
          <button :title="t('cipher_title')" @click="showCipher = true"><Icon name="shield" :size="20" /></button>
          <button @click="showSettings = true" :title="t('nav_settings') || 'Settings'"><Icon name="settings" :size="20" /></button>
        </div>
      </div>
      
      <ContactList
        :search="searchQuery"
        :contacts="filteredContacts"
        :groups="filteredGroups"
        :channels="channels"
        :channelAvatars="channelAvatars"
        :avatars="groupAvatars"
        :groupIconMap="groupIconMap"
        :folders="chatFoldersList"
        :activeFolder="activeFolder"
        :active="activeChat"
        :error="emailError"
        :empty="contacts.length === 0 && Object.keys(peerKeys).length === 0"
        :showArchived="showArchived"
        :hasArchived="hasArchivedChats"
        :peerKeys="peerKeys"
        :nameOf="nameOf"
        :avatarOf="avatarOf"
        :unreadOf="unreadOf"
        :isMuted="isMuted"
        :isRecentlySeen="isRecentlySeen"
        :isOnline="isOnline"
        :membersLabel="membersLabel"
        :channelUnread="id => channelUnread[id] || 0"
        @search="v => searchQuery = v"
        @select-chat="selectChat"
        @select-group="selectGroup"
        @select-channel="selectChannel"
        @select-notes="selectNotes"
        @menu="openChatMenu"
        @delete="deleteContact"
        @open-keys="showKeyManager = true"
        @open-qr="showQRCode = true"
        @archive-toggle="showArchived = !showArchived"
        @folder="f => activeFolder = f"
      />
    </div>
    
    <div class="main-area" :class="{ 'mobile-hidden': isMobile && !mobileChatOpen }">
      <!-- CHAT VIEW -->
      <div v-if="currentView !== 'email'" class="chat-area">
        <!-- Шапка чата: отдельный компонент (аватар/имя/статус/кнопки
             действий); активный чат, меню и таймеры живут в App -->
        <ChatHeader
          :chat="activeChat"
          :type="activeChatType"
          :name="activeChatName"
          :group="currentGroup"
          :channel="activeChatType === 'channel' ? currentChannel : null"
          :channelAvatar="currentChannel ? (channelAvatars[currentChannel.id] || '') : ''"
          :groupAvatar="currentGroup && groupAvatars[currentGroup.id]"
          :groupIcon="currentGroup && groupIconMap[currentGroup.id]"
          :isMobile="isMobile"
          :isAdmin="isGroupAdmin"
          :hasPeerKey="!!peerKeys[activeChat]"
          :relayEmailDelivery="relayDeliveryMode === 'email'"
          :expCalls="expCalls"
          :ephemeralTtl="currentEphemeralTtl"
          :ephemeralMenuOpen="showEphemeralMenu"
          :ephemeralOptions="ephemeralOptions"
          :starredOnly="showStarredOnly"
          :exportMenuOpen="showExportMenu"
          :nameOf="nameOf"
          :avatarOf="avatarOf"
          :membersLabel="membersLabel"
          :ephemeralLabel="ephemeralLabel"
          @back="closeMobileChat"
          @open-card="openContactCard"
          @members="showMembersList = true"
          @relay-explain="relayExplainDelivery"
          @add-member="openAddMemberPopup"
          @refresh-group="refreshGroupFull"
          @group-settings="showGroupSettings = !showGroupSettings"
          @channel-link="copyChannelLink"
          @call="startCall"
          @edit-contact="openContactEdit"
          @ephemeral-menu="showEphemeralMenu = !showEphemeralMenu"
          @ephemeral-apply="applyEphemeral"
          @toggle-starred="showStarredOnly = !showStarredOnly"
          @toggle-search="showChatSearch = !showChatSearch"
          @export-menu="showExportMenu = !showExportMenu"
          @export-json="exportAsJSON"
          @export-txt="exportAsTXT"
        />

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

        <!-- Ignore-баннер: чат открыт с заблокированным. Отправка заблокирована
             (E2E-модель: сервер доставляет всё, получатель решает, что показать).
             Разблок — здесь же или из контекстного меню чата в списке. -->
        <div v-if="activeChatIgnored" class="ignore-banner">
          <Icon name="ban" :size="14" />
          <span>{{ t('ignore_banner') || 'Заблокирован — новые сообщения скрыты' }}</span>
          <button class="ignore-banner-unblock" @click="unblockActiveChat()">{{ t('chat_unblock') || 'Разблокировать' }}</button>
        </div>

        <!-- Список сообщений: контейнер/пустые состояния/баннер закрепа —
             отдельный компонент; карточки сообщений — слотом (следующий
             шаг декомпозиции выделит их в MessageItem) -->
        <MessageList
          ref="messageList"
          :chat="activeChat"
          :type="activeChatType"
          :list="filteredMessages"
          :starredOnly="showStarredOnly"
          :pinnedId="pinnedMsgId"
          :pinnedPreview="pinnedPreview"
          :isAdmin="isGroupAdmin"
          @scroll="onMessagesScroll"
          @scroll-pinned="scrollPinnedToView"
          @unpin="unpinGroupMessage"
        >
          <MessageItem
            v-for="msg in filteredMessages"
            :key="msg.id"
            :msg="msg"
            :isGroup="activeChatType === 'group'"
            :isAdmin="isGroupAdmin"
            :notes="activeChat === '__notes__'"
            :dragOverId="dragOverNoteId"
            :dragOverPos="dragOverPos"
            :reactionPickerId="reactionPickerMsgId"
            :quickReactions="quickReactions"
            :nameOf="nameOf"
            :avatarOf="avatarOf"
            :senderOf="msgSenderEmail"
            :linkify="linkify"
            :replyBody="replyBody"
            :replyQuote="replyQuote"
            :hasReplyQuote="hasReplyQuote"
            :statusTitle="statusTitle"
            :isStarred="isStarred"
            :callPillIcon="callPillIcon"
            :callEventLabel="callEventLabel"
            :canCallBack="canCallBack"
            :pollLead="pollLead"
            :pollVotes="pollVotes"
            :pollOptionCount="pollOptionCount"
            :pollLeadLabel="pollLeadLabel"
            :isAndroidClient="isAndroidClient"
            :voicePlayingId="voicePlayingId"
            @context-menu="openMessageMenu"
            @toggle-reaction-picker="toggleReactionPicker"
            @toggle-reaction="toggleReaction"
            @add-reaction="addReaction"
            @note-drag-start="onNoteDragStart"
            @note-drag-over="onNoteDragOver"
            @note-drag-leave="onNoteDragLeave"
            @note-drop="onNoteDrop"
            @note-drag-end="draggedNoteId = null; dragOverNoteId = null; dragOverPos = null"
            @reply="setReply"
            @copy-text="copyMessageText"
            @pin="pinGroupMessage"
            @edit="startEditMessage"
            @delete="deleteMessage"
            @poll-vote="castPollVote"
            @open-image="openImageViewer"
            @download="downloadAttachmentFile"
            @dod-download="downloadDodAttachment"
            @text-click="onMessageTextClick"
            @call-back="callBack"
            @voice-play="toggleVoiceNote"
          />
        </MessageList>

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
            <!-- Избранное: пометить/снять у любого
                 сообщения (своего, чужого), кроме пилюль звонков.
                 -->
            <button v-if="!messageMenu.msg.callEvent" @click="toggleStar(messageMenu.msg); messageMenu = null"><Icon name="star" :size="14" /> {{ isStarred(messageMenu.msg) ? (t('unstar_message') || 'Убрать из избранного') : (t('star_message') || 'В избранное') }}</button>
            <button v-if="!messageMenu.msg.callEvent && activeChatType === 'group' && isGroupAdmin" @click="pinGroupMessage(messageMenu.msg); messageMenu = null"><Icon name="pin" :size="14" /> {{ t('pin_message') || 'Закрепить' }}</button>
            <button v-if="messageMenu.msg.from === 'me' && !messageMenu.msg.deleted" @click="startEditMessage(messageMenu.msg); messageMenu = null"><Icon name="pencil" :size="14" /> {{ t('edit_message') || 'Редактировать' }}</button>
            <button v-if="!messageMenu.msg.callEvent && !messageMenu.msg.deleted && !messageMenu.msg.poll" @click="startForward(messageMenu.msg); messageMenu = null"><Icon name="forward" :size="14" /> {{ t('forward_to') || 'Переслать' }}</button>
            <button v-if="messageMenu.msg.from === 'me' && !messageMenu.msg.deleted" @click="deleteMessage(messageMenu.msg); messageMenu = null"><Icon name="trash" :size="14" /> {{ t('delete_message') || 'Удалить' }}</button>
            <!-- «Удалить у меня»: любые сообщения (свои, чужие) и пилюли звонков
                 только своё устройство, у собеседника остаётся.
                 -->
            <button @click="deleteMessageForMe(messageMenu.msg); messageMenu = null"><Icon name="trash" :size="14" /> {{ t('delete_for_me') || 'Удалить у меня' }}</button>
            <!-- Ignore-лист: блок отправителя чужого сообщения (1:1 — адрес
                 чата, группа — сам участник). E2E: скрывает новые сообщения
                 этого человека у получателя; контент серверу не виден. -->
            <button v-if="!messageMenu.msg.callEvent && messageMenu.msg.from !== 'me'" @click="blockSenderOfMessage(messageMenu.msg); messageMenu = null">
              <Icon name="ban" :size="14" />
              {{ isIgnored(msgSenderEmail(messageMenu.msg) || (activeChatType === 'chat' ? activeChat : '')) ? (t('chat_unblock') || 'Разблокировать') : (t('chat_block') || 'Заблокировать') }}
            </button>
            <!-- §8.3 UGC (модерация RuStore): жалоба на контент — письмо
                 в поддержку (mailto, серверной жалоб-инфраструктуры нет). -->
            <button v-if="!messageMenu.msg.callEvent && messageMenu.msg.from !== 'me' && !messageMenu.msg.deleted" @click="reportMessageContent(messageMenu.msg); messageMenu = null">
              <Icon name="alert" :size="14" /> {{ t('settings_report_content') || 'Пожаловаться' }}
            </button>
            <!-- Телефоны/ссылки из текста: по кнопке на каждый (может быть несколько) -->
            <template v-if="messageMenu.phones && messageMenu.phones.length">
              <div class="message-menu-sep"></div>
              <button v-for="(p, pi) in messageMenu.phones" :key="'ph' + pi" @click="copyText(p); messageMenu = null"><Icon name="phone" :size="14" /> {{ p }}</button>
            </template>
            <template v-if="messageMenu.urls && messageMenu.urls.length">
              <div class="message-menu-sep"></div>
              <button v-for="(u, ui) in messageMenu.urls" :key="'ur' + ui" @click="openUrl(u); messageMenu = null"><Icon name="link" :size="14" /> {{ u.length > 40 ? u.slice(0, 40) + '…' : u }}</button>
            </template>
          </div>
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

        <div class="message-input" v-if="activeChat && (activeChatType !== 'channel' || (currentChannel && currentChannel.is_owner))">
        <div class="input-wrapper">
          <EmojiPicker
            :show="showEmojiPicker"
            @select="insertEmoji"
            @close="showEmojiPicker = false"
          />
          <input
            ref="messageInput"
            v-model="newMessage"
            @keyup.enter="sendMessage"
            :placeholder="(t('message_placeholder') || 'Type a message') + '...'"
            class="message-field"
          />
          <button class="emoji-btn" @click="showEmojiPicker = !showEmojiPicker" title="Emoji"><Icon name="smile" :size="19" /></button>
        </div>
        <!-- Отправка: ВСЕГДА видна в первом ряду -->
        <button class="send-btn-round" @click="sendMessage" :disabled="sending || !newMessage.trim()" :title="t('send') || 'Отправить'"><Icon name="send" :size="17" /></button>
        <input ref="fileInput" type="file" multiple style="display:none" @change="handleFileSelect" accept="image/*,.pdf,.doc,.docx,.txt,.zip" />
        <!-- Второй ряд: кнопки фич (файл, гео, голосование, голос) — с подписями -->
                <div class="feature-row">
          <button class="feature-btn" :title="t('attach_file') || 'Файл'" @click="$refs.fileInput && $refs.fileInput.click()">
            <Icon name="paperclip" :size="18" />
          </button>
          <button v-if="isAndroid" class="feature-btn" :title="t('geo_send') || 'Гео'" @click="sendGeoMessage">
            <Icon name="map-pin" :size="18" />
          </button>
          <button v-if="activeChatType === 'group'" class="feature-btn" :title="t('poll_create') || 'Опрос'" @click="pollDialog = !pollDialog">
            <Icon name="bar-chart" :size="18" />
          </button>
          <button class="feature-btn" :title="t('voice_message') || 'Голосовое'" @click="showAudioRecorder = !showAudioRecorder">
            <Icon name="mic" :size="18" />
          </button>
        </div>
      <!-- Голосование: создание — отдельный компонент (состояние формы внутри) -->
        <PollDialog
          :show="pollDialog"
          @close="pollDialog = false"
          @confirm="(q, opts) => sendPoll(q, opts)"
        />
        <!-- Пересылка: выбор чата — отдельный компонент (список целей
             считает features/forward.js, компонент только отображает) -->
        <ForwardDialog
          :show="!!forwardTo"
          :targets="forwardTargets"
          @close="forwardTo = null"
          @select="key => doForward(key)"
        />
        <!-- AudioRecorder: открыт новой mic-кнопкой в ряду (mic↔send) -->
        <AudioRecorder
          :show="showAudioRecorder"
          @send="sendAudioMessage"
          @close="showAudioRecorder = false"
        />
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
        ref="callOverlay"
        :state="callState"
        :peer="currentCall.peer"
        :peer-name="callPeerName"
        :avatar-url="avatarOf(currentCall.peer)"
        :muted="callMuted"
        :speaker="callSpeaker"
        :video-on="callVideoOn"
        :media-connected="callMediaConnected"
        :elapsed="callElapsedLabel"
        :texts="callTexts"
        @accept="acceptCall"
        @reject="rejectCall"
        @cancel="cancelCall"
        @end="endCall"
        @toggle-mute="toggleCallMute"
        @toggle-speaker="toggleSpeaker"
        @toggle-video="toggleCallVideo"
      />

      <!-- CIPHER TOOL -->
      <CipherTool v-if="showCipher" :peerKeys="peerKeys" :contacts="contacts" @close="showCipher = false" @open-keys="showCipher = false; showKeyManager = true" />

      <!-- SETTINGS MODAL -->
      <div v-if="showSettings" class="modal-overlay" @click.self="showSettings = false">
        <div class="modal-settings">
          <button class="modal-close-x" @click="showSettings = false"><Icon name="x" :size="20" /></button>
          <SettingsPage :email="email" :userAvatarUrl="userAvatarUrl" :displayName="displayName" :bio="myBio" @avatar-update="onAvatarUpdate" @icon-changed="onAppIconChanged" @logout="handleLogout" @name-update="onNameUpdate" @change-email="openChangeEmail" @bio-save="onBioSave" @profile-save="onProfileSave" @experiments-calls="onExperimentsCalls" @autoclean-change="runAutoclean" @eco-mode="onEcoMode" @relay-enabled="onRelayEnabled" @presence-enabled="onPresenceEnabled" />
        </div>
      </div>

      <!-- CHANGE EMAIL MODAL: смена почты без потери контактов/групп.
           Поля как при входе: email + пароль (+ серверы при необходимости).
           Ключи E2E не трогаются — контакты узнают новый адрес по тому же
           fingerprint (см. broadcastProfile + fingerprint-матчинг).
           -->
      <div v-if="showChangeEmail" class="modal-overlay" @click.self="showChangeEmail = false">
        <div class="modal-settings change-email-panel">
          <button class="modal-close-x" @click="showChangeEmail = false"><Icon name="x" :size="20" /></button>
          <h3 class="invite-popup-title"><Icon name="mail" :size="18" /> {{ t('settings_change_email') || 'Сменить почту' }}</h3>
          <p class="change-email-hint">{{ t('change_email_hint') }}</p>
          <form @submit.prevent="changeEmail">
            <input v-model="newEmail" type="email" :placeholder="t('change_email_new_ph')" required class="change-email-input" />
            <input v-model="newPassword" type="password" :placeholder="t('change_email_pass_ph')" required class="change-email-input" />
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
              <button type="button" @click="showChangeEmail = false" class="btn btn-ghost">{{ t('general_cancel') || 'Отмена' }}</button>
              <button type="submit" :disabled="changeEmailLoading" class="btn btn-primary">{{ changeEmailLoading ? t('change_email_connecting') : t('change_email_btn') }}</button>
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

      <!-- CONTACT REQUEST POPUP -->
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
              <Icon name="pencil" :size="14" /> {{ t('enter_email_manual') || 'Ввести email вручную' }}
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
          <h3>{{ t('profile_photo_title') }}</h3>
          <div class="avatar-preview-circle">
            <img v-if="userAvatarUrl" :src="userAvatarUrl" class="avatar-preview-img" />
            <span v-else class="avatar-initials avatar-preview-initials">{{ emailInitials }}</span>
          </div>
          <p class="avatar-hint">{{ t('profile_photo_hint') }}</p>
          <label class="avatar-upload-btn">
            <Icon name="camera" :size="14" /> {{ t('profile_photo_choose') }}
            <input type="file" accept="image/png,image/jpeg,image/svg+xml" @change="onAvatarFileSelect" hidden />
          </label>
        </div>
      </div>

      <!-- CONTACT EDIT MODAL: локальные имя/аватар контакта (видны только мне,
           реальные имя/аватар собеседника не меняются) -->
      <!-- Карточка контакта: тап по аватару в шапке чата -->
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
          <p v-else class="contact-bio-empty">{{ contactCardEmail === email ? t('contact_bio_self') : t('contact_bio_empty') }}</p>
          <div class="contact-card-footer">
            <span class="contact-card-seen" :class="{ online: isRecentlySeen(contactCardEmail) || isOnline(contactCardEmail) }">
              {{ (isRecentlySeen(contactCardEmail) || isOnline(contactCardEmail)) ? t('contact_seen_recently') : t('contact_offline') }}
            </span>
            <button class="btn btn-primary btn-sm" @click="startEditFromCard">{{ t('contact_edit_local') }}</button>
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
            :ignoredUsers="ignoredUsers"
            @close="showGroupSettings = false"
            @role-change="changeMemberRole"
            @remove="removeMember"
            @block="blockUser"
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
          <button class="btn btn-primary" @click="downloadAttachmentFile(viewingImage)"><Icon name="download" :size="14" /> {{ t('download') || 'Скачать' }}</button>
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
          <label>{{ t('group_avatar_label') }}</label>
          <div class="new-group-avatar-row">
            <div class="new-group-avatar" @click="$refs.groupAvatarInput.click()">
              <img v-if="newGroupAvatar" :src="newGroupAvatar" alt="" />
              <div v-else class="new-group-avatar__placeholder"><Icon name="camera" :size="22" /></div>
            </div>
            <span class="new-group-avatar__hint">{{ t('group_avatar_hint') }}</span>
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
    <!-- CREATE CHANNEL modal (M2): имя + описание, ссылка после создания -->
    <div v-if="showCreateChannel" class="modal-overlay" @click.self="showCreateChannel = false">
      <div class="modal-card">
        <div class="modal-header">
          <h3>{{ t('channel_create_title') || 'Новый канал' }}</h3>
          <button class="modal-close-x" @click="showCreateChannel = false"><Icon name="x" :size="20" /></button>
        </div>
        <div class="modal-body">
          <label>{{ t('channel_name') || 'Название канала' }}</label>
          <input v-model="newChannelName" :placeholder="(t('channel_name') || 'Название') + '...'" class="modal-input" @keyup.enter="createChannelAndClose" />
          <label>{{ t('channel_about') || 'Описание' }}</label>
          <input v-model="newChannelAbout" :placeholder="(t('channel_about') || 'Описание') + '...'" class="modal-input" />
          <p class="channel-modal-hint">{{ t('channel_create_hint') || 'Канал — широковещательный чат: вы публикуете посты, подписчики только читают и не видят друг друга.' }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showCreateChannel = false">{{ t('general_cancel') || 'Cancel' }}</button>
          <button class="btn-primary" @click="createChannelAndClose" :disabled="!newChannelName.trim() || postingChannel">
            {{ t('channel_create') || 'Создать канал' }}
          </button>
        </div>
      </div>
    </div>
    <!-- CHANNELS panel (M2): единая точка входа вместо двух кнопок в шапке
         (7 кнопок не влезали в 320px сайдбар и залезали за край). -->
    <div v-if="showChannelPanel" class="modal-overlay" @click.self="showChannelPanel = false">
      <div class="modal-card">
        <div class="modal-header">
          <h3>{{ t('nav_channels') || 'Каналы' }}</h3>
          <button class="modal-close-x" @click="showChannelPanel = false"><Icon name="x" :size="20" /></button>
        </div>
        <div class="modal-body">
          <div v-if="!channels.length" class="channels-panel-empty">{{ t('channel_panel_empty') || 'Пока нет каналов — создайте свой или подпишитесь по ссылке.' }}</div>
          <div v-for="ch in channels" :key="ch.id" class="channels-panel-row"
               @click="selectChannel(ch); showChannelPanel = false">
            <Icon name="megaphone" :size="16" />
            <span class="channels-panel-name">{{ ch.name }}</span>
            <span class="channels-panel-tag">{{ ch.is_owner ? (t('channel_owner_tag') || 'автор') : (t('channel_sub_tag') || 'подписка') }}</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showJoinChannel = true; showChannelPanel = false">{{ t('channel_join') || 'Присоединиться к каналу' }}</button>
          <button class="btn-primary" @click="showCreateChannel = true; showChannelPanel = false">{{ t('channel_create') || 'Создать канал' }}</button>
        </div>
      </div>
    </div>
    <!-- JOIN CHANNEL modal (M2): вставка vault://join-channel ссылки/QR -->
    <div v-if="showJoinChannel" class="modal-overlay" @click.self="showJoinChannel = false">
      <div class="modal-card">
        <div class="modal-header">
          <h3>{{ t('channel_join') || 'Присоединиться к каналу' }}</h3>
          <button class="modal-close-x" @click="showJoinChannel = false"><Icon name="x" :size="20" /></button>
        </div>
        <div class="modal-body">
          <label>{{ t('channel_link_label') || 'Ссылка канала (vault://join-channel…)' }}</label>
          <textarea v-model="joinChannelLink" rows="3" class="modal-input" placeholder="vault://join-channel?c=chn_…"></textarea>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showJoinChannel = false">{{ t('general_cancel') || 'Cancel' }}</button>
          <button class="btn-primary" @click="joinChannelAndClose" :disabled="!joinChannelLink.trim()">
            {{ t('channel_subscribe') || 'Подписаться' }}
          </button>
        </div>
      </div>
    </div>
    <!-- контекстное меню чата (долгое нажатие / правый клик).
         мобильном скрыт при экране списка — меню открывалось «за экраном».
         -->
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
        <!-- Ignore-лист (E2E-блокировка): только для 1:1-чатов. Группа —
             общий контент, блокировать там отдельного участника можно из
             меню его сообщения. -->
        <button v-if="chatMenu.target.type === 'contact'" @click="toggleIgnoreContact()">
          <Icon name="ban" :size="14" />
          {{ isIgnored(chatMenu.target.email) ? (t('chat_unblock') || 'Разблокировать') : (t('chat_block') || 'Заблокировать') }}
        </button>
        <!-- Канал (M2): ссылка подписки (владелец) + удаление подписки -->
        <button v-if="chatMenu.target.type === 'channel' && channelById(chatMenu.target.id)?.is_owner" @click="renameChannel(chatMenu.target.id)">
          <Icon name="pencil" :size="14" /> {{ t('group_rename') || 'Переименовать' }}
        </button>
        <button v-if="chatMenu.target.type === 'channel' && channelById(chatMenu.target.id)?.is_owner" @click="copyChannelLinkById(chatMenu.target.id)">
          <Icon name="link" :size="14" /> {{ t('channel_copy_link') || 'Ссылка для подписки' }}
        </button>
        <button v-if="chatMenu.target.type === 'channel'" @click="deleteChannelConfirmed()">
          <Icon name="trash" :size="14" /> {{ t('channel_delete') || 'Удалить канал' }}
        </button>
        <div class="message-menu-sep"></div>
        <div class="chat-menu-folder-label">{{ t('chat_folder') || 'Папка' }}</div>
        <button @click="setChatFolder('')">
          <Icon name="x" :size="14" /> {{ t('chat_folder_none') || 'Без папки' }}
        </button>
        <button v-for="f in chatFoldersList" :key="f" @click="setChatFolder(f)">
          <Icon name="folder" :size="14" /> {{ f }}
        </button>
        <button v-if="!folderDialogOpen" @click="folderDialogOpen = true; chatFolderNewName = ''">
          <Icon name="plus" :size="14" /> {{ t('chat_folder_new') || 'Новая папка…' }}
        </button>
        <template v-else>
          <input v-model="chatFolderNewName" class="duress-input" style="margin:4px 6px;width:calc(100% - 12px)"
                 :placeholder="t('chat_folder_name_ph') || 'Название'" @keyup.enter="createChatFolder()" />
          <button @click="createChatFolder()">
            <Icon name="check" :size="14" /> {{ t('chat_folder_add') || 'Создать' }}
          </button>
        </template>
      </div>
    </div>
    <!-- Тост-уведомление (Key Recovery и пр.) -->
    <transition name="fade">
      <div v-if="toastMessage" class="app-toast">{{ toastMessage }}</div>
    </transition>
  </div>
</template>

<script>
// M3: владелец состояния звонка (ADR-004, Этап C). callSession =
// reactive(createCallSession()): мутаторы пишут this.state.* через Vue Proxy,
// поэтому Vue видит изменения. calls.js мутирует состояние через ctx.X,
// а App.vue роутит это в computed-прокси → callSession.setX().
import { warmCallTable } from './call-state-rule.js';
import { useSession } from './features/call-session.js';
import { reactive } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import api, { db } from './api.js';
import { createChatStore } from './chat-store.js';
import { createGroupsStore } from './features/groups-store.js';
import { createSendingStore } from './features/sending-store.js';
import { createInvitesStore } from './features/invites-store.js';
import { sessionStore as sessionState, chatStore as chatState, uiStore, defaultUiState } from './features/session-store.js';
import { relayState } from './features/relay-idle.js';
import { connLostGuard } from './features/call-idle.js';
import { accountNamespace, ensureAccountNamespace, resetAccountNamespaceCache } from './identity.js';
import crypto from './crypto.js';
import { initNotifications, notifyNewMessage } from './notify.js';
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
import { exportChatJSON, exportChatTXT, downloadFile } from './chatExport.js';
import { saveHistory, loadHistory } from './history.js';
import { detectProvider, checkFileSize, formatBytes } from './providerLimits.js';
import { MAIL_PROVIDERS, CUSTOM_PROVIDER_ID, findProvider, detectProviderByEmail } from './mailProviders.js';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import LockScreen from './components/LockScreen.vue';
import PollDialog from './components/PollDialog.vue';
import ForwardDialog from './components/ForwardDialog.vue';
import FoldersBar from './components/FoldersBar.vue';
import ContactList from './components/ContactList.vue';
import ChatHeader from './components/ChatHeader.vue';
import MessageList from './components/MessageList.vue';
import MessageItem from './components/MessageItem.vue';
import * as relay from './relay-client.js';
import * as PollFeature from './features/poll.js';
// ADR-003 Этап 3: чистые функции формата/разбора сообщений и настройки чата
// вынесены из компонента. Ни одного this.* в них не было — они просто жили
// здесь, потому что компонент был единственным местом, где можно было писать JS.
import * as MsgFormat from './message-format.js';
import * as Clipboard from './clipboard.js';
import * as GroupMetaBroadcast from './features/group-meta-broadcast.js';
import * as LocalDbInit from './features/local-db-init.js';
import * as AvatarImage from './avatar-image.js';
import * as ReportContent from './features/report-content.js';
import * as PinWire from './features/group-pin-wire.js';
import * as Geo from './geo.js';
import * as Autoclean from './features/autoclean.js';
import * as EnvelopeRule from './envelope-rule.js';
import * as LogoutFeature from './features/logout.js';
import * as ContactsDelete from './features/contacts-delete.js';
import * as RecoveryEscrow from './features/recovery-escrow.js';
import * as RestoreFailure from './features/restore-failure.js';
import * as MsgStore from './message-store.js';
import * as ExtLinks from './external-links.js';
import * as Migrations from './migrations.js';
// ADR-004 A15: notes-store — единственный владелец заметок для себя.
import { createNotesStore } from './features/notes-store.js';
// ADR-004 J.3c: mailbox-store owner для emailsLoading/emailError.
import { contactsStore } from './features/contacts-store.js';
import { mailboxState } from './features/mailbox-store.js';
// ADR-004 J.6: identity-store owner для peerKeys/peerPqKeys/peerKeyInput/peerKeysLoaded.
import { identityStore } from './features/identity-store.js';
// ADR-004 J.5d: channels-store owner для channelPosts/channelUnread.
import { channelsStore } from './features/channels-store.js';
// ADR-004 J.7: messages-store owner для состояния ephemeral.
import { messagesStore } from './features/messages-store.js';
import * as GroupsMigrate from './features/groups-migrate.js';
import * as GroupsLoad from './features/groups-load.js';
import * as GroupsClone from './features/groups-clone.js';
import * as GroupsCreate from './features/groups-create.js';
import * as ForwardFeature from './features/forward.js';
import * as FoldersFeature from './features/folders.js';
// Фабрики состояния — из чистых модулей без импортов (их поднимает
// check-template.cjs, чтобы разрезолвить спреды в data()).
import { foldersStore } from './features/folders-store.js';
import { duressState } from './features/duress/state.js';
import { pollState } from './features/poll/state.js';
import { forwardState } from './features/forward/state.js';
import * as DraftsFeature from './features/drafts.js';
import * as DuressFeature from './features/duress.js';
import * as GroupAvatarsFeature from './features/group-avatars.js';
import * as IncomingFeature from './features/incoming.js';
import * as ReactionsFeature from './features/reactions.js';
import * as EditsFeature from './features/edits.js';
import * as NotesFeature from './features/notes.js';
import * as StarsFeature from './features/stars.js';
import * as KeysFeature from './features/keys.js';
import * as ChatUiFeature from './features/chat-ui.js';
import * as EphemeralFeature from './features/ephemeral.js';
import * as UnreadFeature from './features/unread.js';
import * as HistoryFeature from './features/history.js';
import * as ContactsFeature from './features/contacts.js';
import * as IgnoredUsersFeature from './features/ignored-users.js';
import * as BlockUserFeature from './features/block-user.js';
import * as LocalStoreFeature from './features/local-store.js';
import * as RelayFeature from './features/relay.js';
import * as CallsFeature from './features/calls.js';
import * as CallVideoFeature from './features/call-video.js';
// S5-2: приём решения кнопки уведомления (accept/reject), пока WebView
// не был готов — очередь применяется к следующему call_request.
import { setPendingNativeCallDecision } from './features/calls.js';
import * as ProfilesFeature from './features/profiles.js';
import * as PresenceFeature from './features/presence.js';
import * as ChannelsFeature from './features/channels.js';
import * as AttachmentsFeature from './features/attachments.js';
import * as EmailsFeature from './features/emails.js';
import * as GroupsFeature from './features/groups.js';
import * as MessagesFeature from './features/messages.js';
import * as MigrateFeature from './features/migrate.js';
import * as InvitesFeature from './features/invites.js';
import * as GroupMetaFeature from './features/group-meta.js';
import * as ReceiptsFeature from './features/receipts.js';
import * as MembersFeature from './features/members.js';
import * as SendFeature from './features/send.js';
import * as ChatFeature from './features/chat.js';
import * as BounceFeature from './features/bounce.js';
import * as RecoveryFeature from './features/recovery.js';
// Durable-маркер прерванного восстановления (fix/recovery-resilience):
// блокирует авто-вход/обычный логин/генерацию ключей, пока восстановление не
// закоммичено. Pure-модуль без импортов api/crypto.
import * as RecoverySession from './features/recovery-session.js';
// Черновики: очередь сериализации kv-RMW переехала в features/drafts.js.

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
    CallOverlay,
    PollDialog,
    ForwardDialog,
    FoldersBar,
    ContactList,
    ChatHeader,
    MessageList,
    MessageItem
  },
  setup() {
    const { t, setLocale, availableLocales, currentLocale } = useI18n();
    // ── ЖИВОЙ state владельцев (ADR-004, 18.10.2026) ──────────────────────
    // Владельцы (features/*-store.js) framework-agnostic: state — обычный
    // объект, reactive() наворачивает прокси в композиционном корне.
    // Но запись в state идёт ТРЕМЯ путями:
    //   1) метод через proxy      — this.sessionStore.login() (App.vue);
    //   2) метод через raw-импорт  — mailboxState.setEmails(v) (App.vue:1524),
    //      foldersStore.loadFromRaw(...) (features/folders.js);
    //   3) прямая запись в state   — relay.js: mailboxStore.state.emails = merged,
    //      relayState.state.relayFails = 0.
    // Пути 2 и 3 мутируют объект-ЦЕЛЬ мимо прокси: Vue о записи не узнаёт,
    // computed'ы App.vue остаются с закешированным значением, и интерфейс
    // «залипает» тихо. Подтверждено на гейте: вход выполнялся полностью
    // (sessionStore.state.isLoggedIn === true, пароль и ключ загружены),
    // а компонент читал isLoggedIn === false, email === '' и показывал экран
    // входа (0.1.224 → 0.1.225). Тем же классом был заморожен список писем:
    // computed emails читал mailboxState.state.emails (raw) и не обновлялся
    // после прихода новых.
    // Лечение: сам объект state делаем реактивным ОДИН раз здесь — тогда
    // любой из трёх путей доходит до Vue. Владельцы при этом мутируют state
    // через this.state (не через захваченный объект) — см. их методы.
    const liveState = (store) => {
      store.state = reactive(store.state);
      return store;
    };
    // Синглтоны, к state которых пишут/читают снаружи по raw-импорту.
    // messagesStore сюда не входит: у него timers (proxy над Timeout ломает
    // clearTimeout), а все его методы вызываются через proxy в App.vue.
    liveState(sessionState);
    liveState(mailboxState);
    liveState(chatState);
    liveState(relayState);
    liveState(contactsStore);
    liveState(foldersStore);
    liveState(channelsStore);
    liveState(identityStore);
    // Модуль-владелец переписки (ADR-004, Этап A1).
    // reactive() оборачивает стор: методы мутируют this.state через прокси,
    // поэтому Vue видит изменения. Без обёртки мутации шли бы мимо прокси
    // и интерфейс не обновлялся бы — тихо.
    const chat = reactive(createChatStore());
    // Модуль-владелец состояния групп (ADR-004, Этап A9). Аналогично чат-хранилищу:
    // groupKeys и groupAvatars больше не data()-свойства, а живут в владельце.
    //
    // ИМЯ: groupsStore, а НЕ groups. `groups` — это СПИСОК групп (data, шаблон
    // рендерит filteredGroups = this.groups.filter(...)). Первая версия отдавала
    // владельца под именем `groups`: setup-биндинг перекрывал data-поле, и первое
    // же `this.groups = r.groups` в loadGroups() затирало владельца массивом —
    // после этого this.groups.state и this.groups.mergeGroupKeys() падали
    // (TypeError) прямо в ветке авто-входа: вход не доходил до чатов (18.10).
    const groupsStore = reactive(createGroupsStore());
    // Модуль-владелец состояния отправки (ADR-004, Этап A10). Аналогично
    // чат- и групповым хранилищам: sending и pendingOutgoing больше не
    // data()-свойства, а живут во владельце. 14 писатц → ctx.setSending/
    // ctx.setPendingOutgoing/mergePendingOutgoing.
    const sendingStore = reactive(createSendingStore());
    // Модуль-владелец сессионного состояния (ADR-004, Этап A12).
    // isLoggedIn/emails больше не data()-свойства, а proxy на session-store.
    const sessionStore = reactive(sessionState);
    // Модуль-владелец relay-состояния (ADR-004, Этап A13).
    // ecoMode/relayEnabled/relayDeliveryMode → proxy на relay-store.
    // relay-состояние: singleton relayState (relay-idle.js), владелец для
    // relay.js state-machine. App.vue оборачивает reactive() для шаблона.
    const relayStore = reactive(relayState)
    const mailboxStore = reactive(mailboxState)
    // J.3a: singleton chatStore — state activeChat/currentGroup/activeChatType.
    const chatStore = reactive(chatState)
    // ADR-005 W2 партия 4: владелец очереди инвайтов/запросов контакта
    // (features/invites-store.js). Поля писали ДВА модуля (invites.js и
    // contacts.js) — у поля должен быть владелец (ADR-004). Per-app: один
    // экземпляр на окно, модулям передаётся в deps.
    const invitesStore = reactive(createInvitesStore());
    // J.7: messages-store (ephemeral state) — reactive wrapper для re-render в шапке.
    const messagesStoreReact = reactive(messagesStore);
    const callSession = useSession();
    // ADR-004 A15: notes-store — единственный владелец заметок для себя.
    // reactive не обёрнуто: заметки читаются по запросу, не рендерятся в реальном
    // времени. Методы load/save работают напрямую с localStorage через keyFor(email).
    const notes = createNotesStore();
    // J.3b: init uiStore (t/showToast).
    //
    // БЫЛО (регресс ADR-001, a3e82eb от 16.10): `computed(() => this?.showToast)`
    // + `watch(...)`. В `setup()` Options API `this` ВСЕГДА undefined (setup
    // вызывается до создания инстанса), поэтому watch регистрировал в uiStore
    // пустышку `() => {}`, и все `uiStore.toast(...)` из фич молча глотались;
    // `this.t` там же означал, что uiStore.tr() возвращал сам ключ
    // («download_complete» в тосте вместо текста). Нашлось на живой приёмке
    // 19.10 (t_e66389bd): скачивание вложения рапортовало успех беззвучно.
    //
    // ТЕПЕРЬ: обе функции замыкаются на setup-скоуп (t — из useI18n, стоит
    // стабильной функцией; текст берётся по текущей локали на каждый вызов),
    // тост пишется в reactive-сток, который читает computed `toastMessage`.
    const toastState = reactive({ message: '' });
    uiStore.setToastSink(toastState);
    // ── UI-состояние владельца uiStore: флаги модалок, поля форм, поиск ──
    //
    // ОБЯЗАТЕЛЬНО реактивное. Computed поверх ОБЫЧНОГО объекта не имеет
    // реактивных зависимостей, и Vue кэширует его значение НАВСЕГДА: флаг
    // `showSettings = true` не открывал настройки (то же — форма создания
    // группы, поиск чатов, инвайт-попап). Найдено 20.10.2026 пробой на живой
    // сборке (headless Chrome, настоящий dist/): флаг выставлялся, а
    // `.modal-overlay` в DOM не появлялся.
    //
    // Тот же класс уже был починен для тоста (setToastSink — reactive-объект
    // создаёт App.vue и отдаёт владельцу); для модалок и форм это забыли.
    // Приём тот же: модуль остаётся framework-agnostic (vue не импортируется),
    // реактивность приходит инъекцией.
    const uiState = reactive(defaultUiState());
    uiStore.setUiState(uiState);
    uiStore.setT(t);
    let toastTimer = null;
    uiStore.setShowToast((message, ms = 5000) => {
      toastState.message = message;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastState.message = ''; }, ms);
    });
    // J.5b: скролл-callback'и (this.scrollToBottom/onMessagesScroll/jumpToBottom
    // — методы App.vue, refs/DOM неизвестны модулю) — прокидываем через uiStore.
    uiStore.setScrollCallbacks({
      scrollToBottom: (v) => this?.scrollToBottom?.(v),
      onMessagesScroll: () => this?.onMessagesScroll?.(),
      jumpToBottom: () => this?.jumpToBottom?.(),
    });
    return { t, setLocale, availableLocales, currentLocale, chat, groupsStore, sendingStore, sessionStore, relayStore, mailboxStore, chatStore, messagesStore: messagesStoreReact, notes, callSession, uiStore, invitesStore };
  },
  data() {
    return {
      currentView: 'chats',
      // Мобильная навигация: на узком экране
      // видна ОДНА панель — список чатов ИЛИ открытый чат на весь экран.
      // mobileChatOpen=true — показан чат (main-area), кнопка «назад» в шапке.
      // mobileChatOpen — в uiStore (ADR-005 W3, партия 10).
      // Счётчики непрочитанных по чатам (email | 'group:<id>' → число).
      // Источник данных — chat-store (ADR-004 A11); сбрасываются при открытии чата.
      // флаги чатов email|'group:<id>' →
      // { archived, muted }. Архив скрыт из основного списка (переключатель
      // «Показать архив»), mute — без звука/без пуш-уведомления (счётчик
      // непрочитанных остаётся). Персист в sqlite kv 'chat-flags'.
      // J.7: владелец — foldersStore (ADR-004), читается через proxy.
      // ignoredUsers: J.7 — владелец contactsStore (ADR-004), читается через proxy.
      // Глобальный ignore-лист (E2E-честная блокировка): объект
      // { email: tsБлокировки }. Сообщения/звонки/уведомления от этих
      // отправителей скрываются у НАШЕГО получателя (сервер в serverless
      // блокировать не может — контент ему не виден). Новое НЕ попадает в
      // историю (после разблокировки не появляется), старое — остаётся.
      // Персист в sqlite kv 'ignored-users'.
      // showArchivedinj в uiStore.modalFlags (J.7):
      // Контекстное меню чата (долгое нажатие / правый клик в списке).
      // chatMenu/chatFolderNewName/folderDialogOpen — в uiStore
      // (ADR-005 W2, партия 14): folderDialogOpen и chatFolderNewName вообще
      // НЕ были объявлены в data() — присваивание из шаблона нереактивно,
      // и диалог «Новая папка» открывался только при СЛЕДУЮЩЕЙ перерисовке.
      // Избранное: помеченные сообщения чата.
      // chatKey → массив msg.id; персист в sqlite kv_store ('starred:<chatKey>').
      // Локально, как «Удалить у меня»: собеседнику не видно, по почте не
      // синхронизируется. showStarredOnly — режим «показать только избранные»
      // в шапке открытого чата (сам чат при открытии показывается как обычно).
      // starredMap — в uiStore (ADR-005 W3, партия 7).
      showStarredOnly: false,
      // Идемпотентность счётчиков: uid|folder уже обработанных писем
      // (персист в kv 'unread-seen') — каждое письмо считается один раз.
      processedUnreadIds: new Set(),
      // ── Звонки (M3, feature/calls): состояние вынесено в callSession (ADR-004 C).
      // calls.js и шаблон пишут this.X, а запись идёт через session.setX() → Vue Proxy.
      // callVideoOn/callStartedAt — proxy на call-session (J.4).
      // signal-resend: таймер/попытки вынесены в owner createCallResender
      // (call-resend.js) — ADR-004 I.2. calls.js импортирует singletonы
      // callResender/callRequestResender напрямую (как fastFetcher/connLostGuard),
      // поэтому data() больше не создаёт их.
      // IMAP IDLE state (idleActive/idleStop) — вынесено в relay-idle.js
      // singleton idleState (ADR-004 I.3); relay.js пишет через idleState напрямую.
      // ecoMode — теперь proxy на relay-store (ADR-004 A13).
      // Владелец IDLE — Rust-монитор (email_start_idle_monitor). Флаг
      // поднимается после успешного api.idleStart и сбрасывается в
      // stopPolling/эко: повторный idleLoop при поднятом мониторе обязан
      // быть no-op, иначе каждый сигнал звонка создавал бы новое TCP+TLS.
      // Rust-монитор IDLE: флаг callIdleMonitorUp теперь — состояние
      // call-session.js (callSession proxy). App.vue пишет через
      // this.callSession.setCallIdleMonitorUp(true/false).
      // Звонковые таймеры/звук/рингтоны — App-only timer ids
      // и rineload; callState/currentCall/etc. вынесены в callSession (ADR-004 C).
      // Момент начала текущего звонка — теперь callStartedAt в callSession.
      // Ширина окна — для определения мобильного режима (<768px).
      windowWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
      windowHeight: typeof window !== 'undefined' ? window.innerHeight : 800,
      appIconId: 'letter',
      // Смена почты: форма как при входе, ключи не трогаются.
      showChangeEmail: false,
      showChangeEmailServers: false,
      newEmail: '',
      newPassword: '',
      changeEmailLoading: false,
      changeEmailError: '',
      // ADR-004 J.5a: contacts/contactAliases владеются contactsStore; proxy через computed.
      // contactAliases при ошибке НЕ затирается (история чата привязана к каноническому email).

      // Анти-дубль отправки: SMTP медленный, повторный Enter/клик не должен
      // слать копию письма. Теперь во владельце sending-store (ADR-004, A10).
      // Анти-дубль ПОСЛЕ завершения отправки: если тот же текст ушёл в этот
      // чат секунды назад (двойной Enter с паузой), повторную отправку
      // игнорируем — иначе получатели видят «одно сообщение дважды».
      lastSend: null,
      // emailBodyCache — proxy на mailboxStore.state.emailBodyCache (J.3c).
      // bodyCacheOrder/bodyCacheSaveTimer — persist-таймеры body-cache (owner B2).
      // Кэш тел писем (folder:uid -> body) — поллинг перерисовывает чат,
      bodyCacheOrder: [],       // ключи кэша, старые первые (для trimming'а)
      bodyCacheSaveTimer: null, // debounce записи в localStorage
      // Download-on-demand: кэш скачанных data-писем (Message-ID -> base64)
      // на время сессии. Скачанные данные персистятся в истории сообщения
      // (saveCurrentHistory в fetchDodAttachment) — после перезапуска файл
      // уже в карточке, IMAP не тревожится.
      dodCache: {},
      // Фоновый плеер голосовых (t_c1c44344): id трека, играющего в
      // нативном MediaPlayer (Android). Пустая строка — ничего не играет.
      voicePlayingId: '',
      // Платформа (Android → нативный плейбек в фоне; desktop → <audio>).
      isAndroidClient: /Android/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : ''),
      // Токен загрузки: инкремент в selectChat/selectGroup. Медленный
      // loadMessages старого чата не должен перезаписать новый чат.
      loadSeq: 0,
      // ADR-005 W2 партия 3: контракт MessagesFeature.loadMessages — в
      // одноимённом делегаторе (ниже в methods), собран живьём на каждый вызов.
      // Контекстное меню сообщения (копирование)
      // messageMenu — в uiStore (ADR-005 W3, партия 10).
      // replyTo/reactionPickerMsgId — в uiStore (ADR-005 W3, партия 3).
      // Перетаскивание заметок (__notes__): ид заметки и цель drop.
      // draggedNoteId — в uiStore (ADR-005 W3, партия 6).
      // dragOverNoteId — в uiStore (ADR-005 W3, партия 6).
      // dragOverPos — в uiStore (ADR-005 W3, партия 6). // 'before' | 'after'
      // Закреплённое сообщение группы (админ): id + превью для баннера.
      pinnedMsgId: null,
      pinnedPreview: '',
      // Стрелка «вниз к последним сообщениям» в длинных чатах.
      // showJumpToBottominj в uiStore.modalFlags (J.7):
      // Сообщение, которое сейчас редактируется (только своё).
      // editingMessage — в uiStore (ADR-005 W3, партия 4).
      // showSettings/showMembersinj в uiStore.modalFlags (J.7):
      // showMembersinj в uiStore.modalFlags (J.7):
      // restoringSessioninj в session-store.state (J.3a).
      // email вынесен из data() в sessionStore (J.7, proxy ниже).
      // password вынесен из data() в sessionStore (J.7, proxy ниже).
      // rememberMe/imapServer/imapPort/smtpServer/smtpPort/mailProvider
      // inj в uiStore.formState (J.5b).
      // loginLoading/loginErrorinj в session-store.state (J.3a).
      // Настройки серверов почты в форме входа (провайдер может сменить
      // IMAP/SMTP — пользователь должен мочь исправить их вручную).
      // showServerSettingsinj в uiStore.modalFlags (J.7):
      // emailsLoading/emailErrorinj в mailbox-store.state (J.3c).
      // Оптимистичные исходящие, ещё не подтверждённые письмом из ящика:
      // chatKey → { msgId: msg }. Поллинг перестраивает messages из IMAP и
      // стирал ещё не доставленное сообщение (оно «появлялось и исчезало»);
      // теперь mergePending подмешивает их обратно, пока копия письма не
      // придёт из Sent/All Mail — тогда реальное письмо заменяет запись.
      // Теперь во владельце sending-store (ADR-004, A10).
      // cryptoReady — в identity-store (ADR-005 W3, партия 9).
      // publicKey — в identity-store (ADR-005 W3, партия 9).
      // fingerprint — в identity-store (ADR-005 W3, партия 9).
      // §1 company.md: индикатор канала доставки в шапке чата.
      // 'relay' (по умолчанию, не показываем) | 'email' (релей недоступен
      // или суточный лимит исчерпан — показываем конверт).
      // relayDeliveryMode — теперь proxy на relay-store (ADR-004 A13).
      // M2.4: релей включён (кэш relay-enabled kv; обновляется при логине
      // и из настроек). Раньше этот флаг забыли объявить в data() —
      // this.relayEnabled был undefined, автообмен токенами не работал:
      // конверты не несли tok и входящие tok не сохранялись (телефон
      // не знал токен собеседника → исходящие шли только почтой).
      // relayEnabled — теперь proxy на relay-store (ADR-004 A13).
      // relay-resilience: эко + мёртвый релей → автономный режим (служба+IDLE).
      ecoAutonomous: false,
      relayOfflineSince: null,
      // UI toggle flags (showKeyManager/showQRCode/showCipher) inj
      // uiStore.modalFlags (J.5b/J.7 proxy).
      // searchQueryinj в uiStore (J.5b).
      // Groups
      groups: [],
      // channels — proxy на mailboxStore.state.channels (J.3c).
      // channelAvatars/currentChannelinj в channels-store (J.7 proxy).
      // groupIconMapinj в groups-store (J.7 proxy).
      // UI (t_a14ac823): активный канал + модалки создания/подписки
      // UI toggle flags inj uiStore.modalFlags (J.5b): showChannelPanel/
      // showCreateChannel/showJoinChannel/postingChannel.
      // form-state inj uiStore.formState (J.5b): newChannelName/newChannelAbout/
      // joinChannelLink/newGroupName/newGroupAvatar.
      // groupKeys/groupAvatars УБРАНЫ из data() 18.10.2026: они и владелись
      // groups-store, и объявлялись здесь — data-поле перекрывало computed-прокси
      // (порядок разрешения this.*: setup → data → props → computed), поэтому
      // this.groupKeys в шаблоне/методах читал пустой объект, а записи уходили
      // в this.groupsStore.setGroupKey(...). Групповые ключи были не видны
      // приложению при полностью рабочем владельце. Присваиваний
      // this.groupKeys/this.groupAvatars в коде нет — удаление безопасно.

      // currentGroup/activeChatType — proxy на chat-store (J.3a).
      // Тост-уведомление внизу экрана inj uiStore (J.3b).
      // showEphemeralMenuinj в uiStore.modalFlags (J.7):
      // Исчезающие сообщения inj messages-store (J.7):
      // ephemeralTimers/ephemeralTick/currentEphemeralTtl — state в owner.
      // myBioinj в session-store (J.3a).
      // Зелёная точка: email → ts последней активности контакта
      // (входящее письмо/квитанция). Не онлайн-статус: «видели за 10 мин».
      // lastSeenMapinj в contacts-store (J.5a).
      // Экспериментальные функции: флаг звонков
      expCalls: false,
      ephemeralOptions: [
        { v: 0, label: 'Выкл' },
        { v: 300, label: '5 мин' },
        { v: 3600, label: '1 час' },
        { v: 86400, label: '1 день' },
        { v: 604800, label: '1 неделя' },
      ],
      // Восстановление аккаунта на экране входа (Key Recovery)
      // showRecoveryinj в uiStore.modalFlags (J.7):
      // recovery-form fields inj в uiStore.formState (J.5b).
      // Group Settings
      // showGroupSettingsinj в uiStore.modalFlags (J.7):
      // Invite popup (приглашение в группу с согласием)
      // pendingInvites/pendingContacts/handledInviteKeys/handledContactKeys —
      // в invites-store (ADR-005 W2 партия 4): proxy на владельца ниже.
      // showInvitePopupinj в uiStore.modalFlags (J.7):
      // invitePopupIndexinj в uiStore.formState (J.5b):
      // Add-member popup (выбор контактов, мульти-выбор)
      // showAddMemberPopupinj в uiStore.modalFlags (J.7):
      // add-member form inj в uiStore.formState (J.5b).
      // Список участников группы (модалка по клику на счётчик)
      // showMembersListinj в uiStore.modalFlags (J.7):
      // Полноэкранный просмотр изображения-вложения
      // viewingImage — в uiStore (ADR-005 W3, партия 7).
      // Profile cache (имя/аватар из настроек)
      profiles: {},
      // Emoji
      // showEmojiPickerinj в uiStore.modalFlags (J.7):
      // Reactions
      // reactionPickerMsgId — в uiStore (ADR-005 W3, партия 3).
      // quickReactionsinj в session-store.state (J.7):
      // Search in chat
      // chatSearchQueryinj в uiStore.formState (J.5b).
      // showChatSearchinj в uiStore.modalFlags (J.7):
      // Create group modal
      // showCreateGroupinj в uiStore.modalFlags (J.7):
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
      // showContactEdit/showContactCard/editingContact/contactCardEmail/
      // editContactName/editContactAvatar — в uiStore (formState + modalFlags),
      // ADR-005 W2 партия 8: карточка и правка контакта — UI-flow фичи, и его
      // состояние должно лежать у владельца форм/модалок, а не в data().
      // User identity
      userId: null,
      // Tombstones удалённых сообщений: msg_id удалённых НАВСЕГДА. Письмо-
      // оригинал может вернуться из IMAP (Sent/INBOX/спам) — без пометки
      // поллинг «воскресил» бы удалённое. Хранится в sqlite (почтовый мессенджер-style),
      // с in-memory кэшем для синхронной фильтрации (filterDeleted).
      // См. initLocalDb() — загрузка при входе.
      // (были ошибочно в methods — Vue 3 игнорирует не-функции там,
      //  поля становились нерактивными: кнопка «Опрос» и duress-замок не работали)
      tombstonesCache: [],
      // Duress-замок: состояние живёт в features/duress/state.js (ADR-001 Этап 1)
      ...duressState(),
      // Голосования: состояние (диалог создания + таймер) — features/poll/state.js,
      // агрегация голосов — методы poll*; форма внутри PollDialog.vue
      ...pollState(),
      // Пересылка: состояние (пересылаемое сообщение) — features/forward/state.js
      ...forwardState(),
      // Папки чатов: состояние — у владельца folders-store (ADR-004 J.7):
      // chatFlags/chatFoldersNames читаются компьютед-прокси, поля диалога
      // (folderDialogOpen/chatFolderNewName) — в uiStore (ADR-005 W2 п.14).
      //
      // СПРЕДА ТУТ БЫТЬ НЕ ДОЛЖНО (и раньше был — `...foldersState()`): в Vue
      // прокси читает setupState → data → props → ctx, поэтому поле в data()
      // ПЕРЕКРЫВАЕТ компьютед-прокси. Итог (найдено на устройстве 20.10):
      // компьютед на владельца был недостижим, модуль читал uiStore — пусто,
      // и папка создавалась БЕЗ ИМЕНИ. Класс ловит options-dup-gate.
      //
      // activeFolder — состояние компонента (выбранная папка в списке), его
      // владелец — сам список, а не фича.
      activeFolder: '',
      midTombstonesCache: [],
      // IMAP-курсоры: in-memory кэш + sqlite персист.
      cursorsCache: {},
    }
  },
  computed: {
    // ADR-004 J.5a: proxy на contactsStore (быв. this.contacts в data).
    contacts: {
      get() { return contactsStore.state.contacts; },
      set(v) { contactsStore.state.contacts = v; },
    },
    contactAliases: {
      get() { return contactsStore.state.contactAliases; },
      set(v) { contactsStore.state.contactAliases = v; },
    },
    // J.5a: lastSeenMap (green-dot presence) в contacts-store.state.
    lastSeenMap: {
      get() { return contactsStore.state.lastSeenMap; },
      set(v) { Object.assign(contactsStore.state.lastSeenMap, v || {}); },
    },
    // J.7: ignoredUsers — владелец contactsStore (ADR-004), читается через proxy.
    ignoredUsers: {
      get() { return contactsStore.state.ignoredUsers; },
      set(v) { contactsStore.state.ignoredUsers = v || {}; },
    },
    // emails-loadinginj в mailbox-store.state (J.3c):
    emailsLoading: { get() { return this.mailboxStore.state.emailsLoading; }, set(v) { this.mailboxStore.state.emailsLoading = v; } },
    emailError: { get() { return this.mailboxStore.state.emailError; }, set(v) { this.mailboxStore.state.emailError = v; } },
    // Прокси во владельца ephemeral state (ADR-004 J.7):
    ephemeralTimers: { get() { return this.messagesStore.state.ephemeralTimers; }, set(v) { Object.assign(this.messagesStore.state.ephemeralTimers, v || {}); } },
    ephemeralTick: { get() { return this.messagesStore.state.ephemeralTick; }, set(v) { this.messagesStore.state.ephemeralTick = v; } },
    currentEphemeralTtl: { get() { return this.messagesStore.state.currentEphemeralTtl; }, set(v) { this.messagesStore.setCurrentTtl(v); } },
    // Прокси во владельца переписки (ADR-004, Этап A1).
    // Все существующие this.messages = ... и this.messages в шаблоне продолжают
    // работать без изменений, но запись идёт через владельца.
    messages: {
      get() { return this.chat.state.messages; },
      set(v) { this.chat.set(v); },
    },
    // Прокси во владельца группового состояния (ADR-004, Этап A9).
    // groupKeys/groupAvatars больше не data()-свойства, а proxy на groups-store.
    // Прокси во владера флагов чатов (ADR-004 J.7):
    // chatFlags/chatFoldersNames больше не data()-свойства, а proxy на folders-store.
    // Геттер сохраняет обратную совместимость для чтения; запись — через API.
    chatFlags: {
      get() { return foldersStore.state.chatFlags; },
      set(v) { foldersStore.state.chatFlags = v || {}; },
    },
    chatFoldersNames: {
      get() { return foldersStore.state.chatFoldersNames; },
      set(v) { foldersStore.state.chatFoldersNames = v || []; },
    },
    // Геттер сохраняет обратную совместимость для чтения; запись — через API.
    groupKeys: {
      get() { return this.groupsStore.state.groupKeys; },
    },
    groupAvatars: {
      get() { return this.groupsStore.state.groupAvatars; },
    },
    // ADR-004 J.7: groupIconMap — пока что пустая карта (иконки групп не в MVP).
    // Прокся на groupAvatars: если понадобится иконка — добавим в groups-store.
    groupIconMap: {
      get() { return this.groupsStore.state.groupIcons || {}; },
    },
    // searchQueryinj в uiStore (J.5b).
    searchQuery: {
      get() { return uiStore.getSearchQuery(); },
      set(v) { uiStore.setSearchQuery(v); },
    },
    // form-stateinj в uiStore.formState (J.5b):
    newChannelName: {
      get() { return uiStore.getFormField('newChannelName'); },
      set(v) { uiStore.setFormField('newChannelName', v); },
    },
    newChannelAbout: {
      get() { return uiStore.getFormField('newChannelAbout'); },
      set(v) { uiStore.setFormField('newChannelAbout', v); },
    },
    joinChannelLink: {
      get() { return uiStore.getFormField('joinChannelLink'); },
      set(v) { uiStore.setFormField('joinChannelLink', v); },
    },
    newGroupName: {
      get() { return uiStore.getFormField('newGroupName'); },
      set(v) { uiStore.setFormField('newGroupName', v); },
    },
    newGroupAvatar: {
      get() { return uiStore.getFormField('newGroupAvatar'); },
      set(v) { uiStore.setFormField('newGroupAvatar', v); },
    },
    // form-stateinj в uiStore.formState (J.5b): recovery-form + add-member:
    recoveryWordsInput: { get() { return uiStore.getFormField('recoveryWordsInput'); }, set(v) { uiStore.setFormField('recoveryWordsInput', v); } },
    recoveryFileJson: { get() { return uiStore.getFormField('recoveryFileJson'); }, set(v) { uiStore.setFormField('recoveryFileJson', v); } },
    recoveryFileName: { get() { return uiStore.getFormField('recoveryFileName'); }, set(v) { uiStore.setFormField('recoveryFileName', v); } },
    addMemberQuery: { get() { return uiStore.getFormField('addMemberQuery'); }, set(v) { uiStore.setFormField('addMemberQuery', v); } },
    addMemberSelected: { get() { return uiStore.getFormField('addMemberSelected'); }, set(v) { uiStore.setFormField('addMemberSelected', v); } },
    invitePopupIndex: { get() { return uiStore.getFormField('invitePopupIndex'); }, set(v) { uiStore.setFormField('invitePopupIndex', v); } },
    contactPopupIndex: { get() { return uiStore.getFormField('contactPopupIndex'); }, set(v) { uiStore.setFormField('contactPopupIndex', v); } },
    chatSearchQuery: { get() { return uiStore.getFormField('chatSearchQuery'); }, set(v) { uiStore.setFormField('chatSearchQuery', v); } },
    // ADR-005 W2 (партия 8): UI-flow карточки/правки контакта — в uiStore.
    // Прокси те же по имени, поэтому шаблон не меняется.
    contactCardEmail: { get() { return uiStore.getFormField('contactCardEmail'); }, set(v) { uiStore.setFormField('contactCardEmail', v); } },
    editingContact: { get() { return uiStore.getFormField('editingContact'); }, set(v) { uiStore.setFormField('editingContact', v); } },
    editContactName: { get() { return uiStore.getFormField('editContactName'); }, set(v) { uiStore.setFormField('editContactName', v); } },
    editContactAvatar: { get() { return uiStore.getFormField('editContactAvatar'); }, set(v) { uiStore.setFormField('editContactAvatar', v); } },
    showContactCard: { get() { return uiStore.getModal('showContactCard'); }, set(v) { uiStore.setModal('showContactCard', v); } },
    showContactEdit: { get() { return uiStore.getModal('showContactEdit'); }, set(v) { uiStore.setModal('showContactEdit', v); } },
    // login/server-form fieldsinj в uiStore.formState (J.5b):
    rememberMe: { get() { return uiStore.getFormField('rememberMe'); }, set(v) { uiStore.setFormField('rememberMe', v); } },
    imapServer: { get() { return uiStore.getFormField('imapServer'); }, set(v) { uiStore.setFormField('imapServer', v); } },
    imapPort: { get() { return uiStore.getFormField('imapPort'); }, set(v) { uiStore.setFormField('imapPort', v); } },
    smtpServer: { get() { return uiStore.getFormField('smtpServer'); }, set(v) { uiStore.setFormField('smtpServer', v); } },
    smtpPort: { get() { return uiStore.getFormField('smtpPort'); }, set(v) { uiStore.setFormField('smtpPort', v); } },
    mailProvider: { get() { return uiStore.getFormField('mailProvider'); }, set(v) { uiStore.setFormField('mailProvider', v); } },
    // UI toggle flagsinj в uiStore.modalFlags (J.5b):
    showChannelPanel: { get() { return uiStore.getModal('showChannelPanel'); }, set(v) { uiStore.setModal('showChannelPanel', v); } },
    showCreateChannel: { get() { return uiStore.getModal('showCreateChannel'); }, set(v) { uiStore.setModal('showCreateChannel', v); } },
    showJoinChannel: { get() { return uiStore.getModal('showJoinChannel'); }, set(v) { uiStore.setModal('showJoinChannel', v); } },
    postingChannel: { get() { return uiStore.getModal('postingChannel'); }, set(v) { uiStore.setModal('postingChannel', v); } },
    showKeyManager: { get() { return uiStore.getModal('showKeyManager'); }, set(v) { uiStore.setModal('showKeyManager', v); } },
    showQRCode: { get() { return uiStore.getModal('showQRCode'); }, set(v) { uiStore.setModal('showQRCode', v); } },
    showCipher: { get() { return uiStore.getModal('showCipher'); }, set(v) { uiStore.setModal('showCipher', v); } },
    showEphemeralMenu: { get() { return uiStore.getModal('showEphemeralMenu'); }, set(v) { uiStore.setModal('showEphemeralMenu', v); } },
    // 9 UI toggle flagsinj в uiStore.modalFlags (J.7):
    showArchived: { get() { return uiStore.getModal('showArchived'); }, set(v) { uiStore.setModal('showArchived', v); } },
    showServerSettings: { get() { return uiStore.getModal('showServerSettings'); }, set(v) { uiStore.setModal('showServerSettings', v); } },
    showRecovery: { get() { return uiStore.getModal('showRecovery'); }, set(v) { uiStore.setModal('showRecovery', v); } },
    showGroupSettings: { get() { return uiStore.getModal('showGroupSettings'); }, set(v) { uiStore.setModal('showGroupSettings', v); } },
    showInvitePopup: { get() { return uiStore.getModal('showInvitePopup'); }, set(v) { uiStore.setModal('showInvitePopup', v); } },
    showContactPopup: { get() { return uiStore.getModal('showContactPopup'); }, set(v) { uiStore.setModal('showContactPopup', v); } },
    showAddMemberPopup: { get() { return uiStore.getModal('showAddMemberPopup'); }, set(v) { uiStore.setModal('showAddMemberPopup', v); } },
    showMembersList: { get() { return uiStore.getModal('showMembersList'); }, set(v) { uiStore.setModal('showMembersList', v); } },
    showCreateGroup: { get() { return uiStore.getModal('showCreateGroup'); }, set(v) { uiStore.setModal('showCreateGroup', v); } },
    showEmojiPicker: { get() { return uiStore.getModal('showEmojiPicker'); }, set(v) { uiStore.setModal('showEmojiPicker', v); } },
    showSettings: { get() { return uiStore.getModal('showSettings'); }, set(v) { uiStore.setModal('showSettings', v); } },
    showMembers: { get() { return uiStore.getModal('showMembers'); }, set(v) { uiStore.setModal('showMembers', v); } },
    showChatSearch: { get() { return uiStore.getModal('showChatSearch'); }, set(v) { uiStore.setModal('showChatSearch', v); } },
    showJumpToBottom: { get() { return uiStore.getModal('showJumpToBottom'); }, set(v) { uiStore.setModal('showJumpToBottom', v); } },
    // toast-stateinj в uiStore (J.3b):
    toastMessage: { get() { return uiStore.getToastMessage(); }, set(v) { uiStore.setToastMessage(v); } },
    toastTimer: { get() { return uiStore.getToastTimer(); }, set(v) { uiStore.setToastTimer(v); } },
    // Прокси во владельца состояния отправки (ADR-004, Этап A10).
    // sending/pendingOutgoing больше не data()-свойства, а proxy на sending-store.
    // Геттеры сохраняют обратную совместимость для чтения; запись — через API.
    sending: {
      get() { return this.sendingStore.state.sending; },
    },
    pendingOutgoing: {
      get() { return this.sendingStore.state.pendingOutgoing; },
    },
    // Прокси во владельца непрочитанных (ADR-004 Этап A11).
    // unreadCounts больше не data()-свойство, а proxy на chat-store.state.
    // bulk-load (set) и reset (set) идут через proxy setter → chat.setUnread.
    unreadCounts: {
      get() { return this.chat.state.unreadCounts; },
      set(v) { this.chat.setUnread(v); },
    },
    // Прокси во владельца звонка (ADR-004 J.4).
    callVideoOn: { get() { return this.callSession.state.callVideoOn; }, set(v) { this.callSession.state.callVideoOn = v; } },
    callStartedAt: { get() { return this.callSession.state.callStartedAt; }, set(v) { this.callSession.state.callStartedAt = v; } },
    // Прокси во владельца сессии (ADR-004 A12).
    isLoggedIn: {
      get() { return this.sessionStore.state.isLoggedIn; },
      set(v) { v ? this.sessionStore.login() : this.sessionStore.logout(); },
    },
    // Прокси во владельца mailbox (ADR-004 J.2b).
    // emails = загруженные сообщения (быв data this.emails); relay.js пишет
    // через mailboxStore.state.emails — App.vue читает тот же объект через proxy.
    emails: {
      get() { return mailboxState.state.emails; },
      set(v) { mailboxState.setEmails(v); },
    },
    // Прокси во владельца каналов (ADR-004 J.5d):
    // J.5d/J.7: channels-store owner для channelPosts/channelUnread/channelAvatars.
    channelPosts: {
      get() { return channelsStore.state.channelPosts; },
      set(v) { Object.assign(channelsStore.state.channelPosts, v || {}); },
    },
    channelUnread: {
      get() { return channelsStore.state.channelUnread; },
      set(chId, count) { channelsStore.setUnread(chId, count); },
    },
    channelAvatars: {
      get() { return channelsStore.state.channelAvatars; },
      set(v) { Object.assign(channelsStore.state.channelAvatars, v || {}); },
    },
    currentChannel: {
      get() { return channelsStore.state.currentChannel; },
    },
    // Прокси во владельца контактов (ADR-004 J.5a):
    // contacts/contactAliases вынесены inject data() в contacts-store.
    // presence.js/profiles.js читают через ctx.lastSeenMap (computed proxy).
    // ADR-005 W3 (партия 10): навигация по чату — у владельца форм.
    messageMenu: {
      get() { return uiStore.getFormField('messageMenu'); },
      set(v) { uiStore.setFormField('messageMenu', v); },
    },
    mobileChatOpen: {
      get() { return uiStore.getModal('mobileChatOpen'); },
      set(v) { uiStore.setModal('mobileChatOpen', v); },
    },
    // Контракт фичи навигации по чату (ADR-005 W3, партия 10).
    chatUiDeps() {
      return {
        isMobile: this.isMobile,
        setMobileChatOpen: (v) => { this.mobileChatOpen = v; },
        mobileChatOpen: () => this.mobileChatOpen,
        getMessageListEl: () => (this.$refs.messageList && this.$refs.messageList.container) || null,
        getMessageMenuEl: () => document.querySelector('.message-menu'),
        nextTick: (cb) => this.$nextTick(cb),
        nextTickAsync: () => this.$nextTick(),
        setShowJumpToBottom: (v) => { this.showJumpToBottom = v; },
        setChatMenu: (v) => { this.chatMenu = v; },
        setMessageMenu: (v) => { this.messageMenu = v; },
        getMenuState: (key) => (key === 'chatMenu' ? this.chatMenu : this.messageMenu),
        setMenuState: (key, v) => { if (key === 'chatMenu') this.chatMenu = v; else this.messageMenu = v; },
        copyText: (t) => this.copyText(t),
        activeChat: () => this.activeChat,
        activeChatType: () => this.activeChatType,
        alert: (m) => { alert(m); },
      };
    },
    // ADR-005 W3 (партия 9): своя крипто-пара и отпечаток — у владельца
    // идентичности (identity-store), раньше это были поля data().
    publicKey: {
      get() { return identityStore.state.publicKey; },
      set(v) { identityStore.setPublicKey(v); },
    },
    cryptoReady: {
      get() { return identityStore.state.cryptoReady; },
      set(v) { identityStore.setCryptoReady(v); },
    },
    fingerprint: {
      get() { return identityStore.state.fingerprint; },
      set(v) { identityStore.setFingerprint(v); },
    },
    // Контракт фичи ключей (ADR-005 W3, партия 9).
    keysDeps() {
      return {
        email: () => this.email,
        activeChat: () => this.activeChat,
        publicKey: () => this.publicKey,
        cryptoReady: () => this.cryptoReady,
        fingerprint: () => this.fingerprint,
        setPublicKey: (v) => { this.publicKey = v; },
        setCryptoReady: (v) => { this.cryptoReady = v; },
        setFingerprint: (v) => { this.fingerprint = v; },
        loadStoredPeerKeys: () => this.loadStoredPeerKeys(),
        openChatByKey: (k) => this.openChatByKey(k),
        isMobile: this.isMobile,
        setMobileChatOpen: (v) => { this.mobileChatOpen = v; },
        contacts: () => this.contacts,
        loadContacts: () => this.loadContacts(),
        setShowQRCode: (v) => { this.showQRCode = v; },
        alert: (msg) => { alert(msg); },
        prompt: (msg) => { return window.prompt(msg); },
      };
    },
    // Контракт фичи групп (ADR-005 W3, партия 11): создание, клонирование,
    // переименование. UI-эффекты — deps'ами (ADR-003 §5.1): компонент остаётся
    // источником состояния, но не владельцем ПОРЯДКА шагов.
    groupDeps() {
      return {
        cryptoReady: () => this.cryptoReady,
        email: () => this.email,
        peerKeys: () => this.peerKeys,
        publicKey: () => this.publicKey,
        groupKeys: () => this.groupKeys,
        // Применение созданной/клонированной группы — как было в App.vue.
        applyCreated: ({ group: g, avatar: av }) => {
          if (av) this.groupsStore.setGroupAvatar(g.id, av);
          this.groups.push(g);
          this.currentGroup = g;
          if (g.group_key) this.groupsStore.setGroupKey(g.id, g.group_key);
        },
        saveGroupKey: (id, key) => this.groupsStore.setGroupKey(id, key),
        resetDialog: () => {
          this.newGroupAvatar = '';
          this.showGroupSettings = true;
          this.newGroupName = '';
        },
        onError: (error) => {
          console.error('Failed to create group:', error);
          alert('Failed to create group: ' + error.message);
        },
        promptName: (def) => window.prompt(
          uiStore.tr('group_clone_prompt') || 'Имя новой группы (клон)', def),
        closeSettings: () => { this.showGroupSettings = false; },
        onDone: (invited, skipped) => {
          const msg = (uiStore.tr('group_clone_done') || 'Клон создан')
            + (invited.length ? ': ' + uiStore.tr('group_clone_invited') + ' ' + invited.join(', ') : '')
            + (skipped.length ? '\n' + (uiStore.tr('group_clone_skipped') || 'пропущены (нет ключа)') + ': ' + skipped.join(', ') : '');
          alert(msg);
        },
        onCloneError: (e) => {
          console.error('cloneGroup failed:', e);
          alert((uiStore.tr('group_clone_failed') || 'Не удалось создать клон') + ': ' + e.message);
        },
        applyLocalName: (groupId, name) => {
          const g = this.groups.find(x => x.id === groupId);
          if (g) g.name = name;
          if (this.currentGroup && this.currentGroup.id === groupId) this.currentGroup.name = name;
        },
        logSent: (groupId, name) => console.log('[group] renamed', groupId, '→', name),
        logNoKey: (groupId) => console.warn('[group] rename broadcast skipped, no group key:', groupId),
        logFailed: (groupId, error) => console.warn('[group] rename broadcast failed:', error),
      };
    },
    // Контракт удаления контакта (ADR-005 W3, партия 11).
    contactsDeleteDeps() {
      return {
        confirmDelete: () => confirm(uiStore.tr('contact_delete_confirm')
          || 'Удалить контакт? Его ключ шифрования будет удалён.'),
        removePeerKey: (email) => identityStore.removePeerKey(email),
        removalState: (email) => ContactsDelete.contactRemovalState(email, {
          activeChat: this.activeChat, activeChatType: this.activeChatType,
        }),
        applyRemovalState: (st) => {
          if (!st.closeChat) return;
          this.activeChat = null;
          this.activeChatType = st.activeChatType;
        },
        loadContacts: () => this.loadContacts(),
        onError: (e) => { alert('Failed to delete contact: ' + e.message); },
      };
    },
    // Прокси во владельца идентичности (ADR-004 J.6):
    // peerKeys/peerPqKeys/peerKeyInput/peerKeysLoaded вынесены из data() в
    // identity-store. calls.js/forward.js читают через ctx.peerKeys (computed).
    peerKeys: {
      get() { return identityStore.state.peerKeys; },
      set(v) { Object.assign(identityStore.state.peerKeys, v || {}); },
    },
    peerPqKeys: {
      get() { return identityStore.state.peerPqKeys; },
      set(v) { Object.assign(identityStore.state.peerPqKeys, v || {}); },
    },
    peerKeyInput: {
      get() { return identityStore.state.peerKeyInput; },
      set(v) { identityStore.setPeerKeyInput(v); },
    },
    peerKeysLoaded: {
      get() { return identityStore.state.peerKeysLoaded; },
      set(v) { identityStore.state.peerKeysLoaded = v || {}; },
    },
    // Прокси во владельца чата (ADR-004 J.3a).
    activeChat: { get() { return this.chatStore.state.activeChat; }, set(v) { this.chatStore.state.activeChat = v ?? null; } },
    currentGroup: { get() { return this.chatStore.state.currentGroup; }, set(v) { this.chatStore.state.currentGroup = v ?? null; } },
    // Прокси во владельца очереди инвайтов (ADR-005 W2 партия 4). Поля писали
    // ДВА модуля (invites.js и contacts.js) — теперь у них есть владелец.
    pendingInvites: { get() { return this.invitesStore.state.pendingInvites; }, set(v) { this.invitesStore.setPendingInvites(v); } },
    pendingContacts: { get() { return this.invitesStore.state.pendingContacts; }, set(v) { this.invitesStore.setPendingContacts(v); } },
    handledInviteKeys: { get() { return this.invitesStore.state.handledInviteKeys; }, set(v) { this.invitesStore.state.handledInviteKeys = v || []; } },
    handledContactKeys: { get() { return this.invitesStore.state.handledContactKeys; }, set(v) { this.invitesStore.state.handledContactKeys = v || []; } },
    // myBioinj в session-store (J.3a):
    myBio: { get() { return this.sessionStore.state.myBio; }, set(v) { this.sessionStore.setBio(v); } },
    // J.3a: auth state inj session-store.state:
    restoringSession: { get() { return this.sessionStore.state.restoringSession; }, set(v) { this.sessionStore.state.restoringSession = v; } },
    loginLoading: { get() { return this.sessionStore.state.loginLoading; }, set(v) { this.sessionStore.state.loginLoading = v; } },
    loginError: { get() { return this.sessionStore.state.loginError; }, set(v) { this.sessionStore.state.loginError = v; } },
    // J.7: account password вынесен из data() → sessionStore. recovery.js читает
    // ctx.password → теперь это proxy на sessionStore.state.password (owner).
    // v-model login form / changeEmail / handleLogout пишут через setter.
    // J.7: email вынесен из data() → proxy на sessionStore.currentEmail
    // (быв. this.email); recovery.js читает ctx.email → теперь proxy → sessionStore.
    email: { get() { return this.sessionStore.getCurrentEmail(); }, set(v) { this.sessionStore.setCurrentEmail(v); } },
    password: { get() { return this.sessionStore.getPassword(); }, set(v) { this.sessionStore.setPassword(v); } },
    // J.7: UI constants inj session-store.state:
    quickReactions: { get() { return this.sessionStore.state.quickReactions; } },
    activeChatType: {
      get() { return this.chatStore.state.activeChatType; },
      set(v) { this.chatStore.state.activeChatType = v; },
    },
    // Прокси во владельца mailbox (J.3c): channels + body cache.
    // this.mailboxStore, а не голый mailboxStore: имя приходит из return setup()
    // и в options-объекте видно только через this (иначе ReferenceError прямо в
    // ветке авто-входа — инцидент 18.10).
    channels: { get() { return this.mailboxStore.state.channels; }, set(v) { this.mailboxStore.state.channels = v || []; } },
    emailBodyCache: {
      get() { return this.mailboxStore.state.emailBodyCache; },
      set(v) { this.mailboxStore.state.emailBodyCache = v || {}; },
    },
    // Прокси во владельца relay-состояния (ADR-004 Этап A13).
    // ecoMode/relayEnabled/relayDeliveryMode → proxy на relay-store.
    ecoMode: {
      get() { return this.relayStore.state.ecoMode; },
      set(v) { this.relayStore.enableEco(v); },
    },
    relayEnabled: {
      get() { return this.relayStore.state.relayEnabled; },
      set(v) { this.relayStore.enableRelay(v); },
    },
    relayDeliveryMode: {
      get() { return this.relayStore.state.relayDeliveryMode; },
      set(v) { this.relayStore.setRelayMode(v); },
    },
    // Прокси черновику composer (ADR-004 Этап A14). newMessage больше не
    // data()-свойство, а proxy на chat-store.state.newMessage.
    newMessage: {
      get() { return this.chat.state.newMessage; },
      set(v) { this.chat.setDraft(v); },
    },
    // ── Прокси состоянию звонка (ADR-004 Этап C) ──
    // callState/currentCall/… больше не data()-свойства, а proxy на
    // callSession (reactive(createCallSession())). calls.js и шаблон пишут
    // this.X — запись идёт через session.setX() → Vue Proxy. Имена совпадают
    // с именами calls.js (ctx._pendingKemct т.д.) — refactor calls.js НЕ нужен.
    callState: {
      get() { return this.callSession.callState; },
      set(v) { this.callSession.setCallState(v); },
    },
    currentCall: {
      get() { return this.callSession.currentCall; },
      set(v) { this.callSession.setCurrentCall(v); },
    },
    lastCallId: {
      get() { return this.callSession.lastCallId; },
      set(v) { this.callSession.setLastCallId(v); },
    },
    callMuted: {
      get() { return this.callSession.callMuted; },
      set(v) { this.callSession.setMuted(v); },
    },
    callSpeaker: {
      get() { return this.callSession.callSpeaker; },
      set(v) { this.callSession.setSpeaker(v); },
    },
    callMediaConnected: {
      get() { return this.callSession.callMediaConnected; },
      set(v) { this.callSession.setCallMediaConnected(v); },
    },
    callClockSec: {
      get() { return this.callSession.callClockSec; },
      set(v) { this.callSession.setCallClockSec(v); },
    },
    callClockTimer: {
      get() { return this.callSession.callClockTimer; },
      set(v) { this.callSession.setCallClockTimer(v); },
    },
    callRingTimer: {
      get() { return this.callSession.callRingTimer; },
      set(v) { this.callSession.setCallRingTimer(v); },
    },
    callSoundEl: {
      get() { return this.callSession.callSoundEl; },
      set(v) { this.callSession.setSoundEl(v); },
    },
    callRingtoneIncoming: {
      get() { return this.callSession.callRingtoneIncoming; },
      set(v) { this.callSession.setRingtone('incoming', v); },
    },
    callRingtoneOutgoing: {
      get() { return this.callSession.callRingtoneOutgoing; },
      set(v) { this.callSession.setRingtone('outgoing', v); },
    },
    // legacy underscore-имена: calls.js пишет ctx._pendingKemct/_pendingSenderEk
    // (владелец скрывает internal — без underscore в session API).
    _pendingKemct: {
      get() { return this.callSession.pendingKemct; },
      set(v) { this.callSession.setPendingKemct(v); },
    },
    _pendingSenderEk: {
      get() { return this.callSession.pendingSenderEk; },
      set(v) { this.callSession.setPendingSenderEk(v); },
    },
    _connLostTimer: {
      get() { return this.callSession.connLostTimer; },
      set(v) { this.callSession.setConnLostTimer(v); },
    },
    _mediaFallbackTimer: {
      get() { return this.callSession.mediaFallbackTimer; },
      set(v) { this.callSession.setMediaFallbackTimer(v); },
    },
    // Доступ к владельцу состояния звонка для features/calls.js (ADR-004 D).
    // calls.js использует ctx.session.X / ctx.session.setX() вместо ctx.X.
    session: {
      get() { return this.callSession; },
    },
    // Пересылка: список чатов-целей (логика в features/forward.js).
    forwardTargets() {
      return ForwardFeature.forwardTargets({
        contacts: this.contacts, groups: this.groups,
        activeChat: this.activeChat, activeChatType: this.activeChatType,
        currentGroup: this.currentGroup, nameOf: this.nameOf, t: uiStore.tr,
      });
    },
    // Статус «О себе» редактируемого контакта (из profile-конверта)
    editingContactBio() {
      if (!this.editingContact) return '';
      const p = this.profiles[this.editingContact];
      return (p && p.bio) || '';
    },
    // Мобильный режим: узкий экран ПО ЛЮБОЙ стороне.
    // только порог по ширине (<768) — телефон в ландшафте (800×360 CSS-px)
    // попадал в десктопную двухпанельную раскладку: сайдбар 320px + пустая
    // чёрная правая часть.
    // при повороте. Порог по высоте (<480) ниже любого реального
    // десктопного окна, но типичная высота телефона в ландшафте.
    isMobile() {
      return this.windowWidth < 768 || this.windowHeight < 480;
    },
    // На Android WebView userAgent содержит 'Android' — надёжнее, чем ширина.
    isAndroid() {
      return /android/i.test(navigator.userAgent || '');
    },
    // Контракты мелких фич (ADR-005 W2, партия 13): состояние у владельцев,
    // эффекты — явным списком. Модули больше не получают компонент.
    migrateDeps() {
      return {
        migrateOwnProfile: (oldEmail, newEmail) => this.migrateOwnProfile(oldEmail, newEmail),
      };
    },
    presenceDeps() {
      return {
        cryptoReady: () => this.cryptoReady,
      };
    },
    groupAvatarsDeps() {
      return {
        groups: this.groupsStore,
        cryptoReady: () => this.cryptoReady,
      };
    },
    channelsDeps() {
      return {
        channelById: (id) => this.channelById(id),
        noteChannelPost: (id, ts, payload, from) => this.noteChannelPost(id, ts, payload, from),
        noteChannelHello: (id, from) => this.noteChannelHello(id, from),
      };
    },
    draftsDeps() {
      return {
        chat: this.chat,
      };
    },
    // ADR-005 W2 (партия 14): меню чата и диалог папок — у владельца форм.
    chatMenu: { get() { return uiStore.getFormField('chatMenu'); }, set(v) { uiStore.setFormField('chatMenu', v); } },
    chatFolderNewName: { get() { return uiStore.getFormField('chatFolderNewName'); }, set(v) { uiStore.setFormField('chatFolderNewName', v); } },
    folderDialogOpen: { get() { return uiStore.getModal('folderDialogOpen'); }, set(v) { uiStore.setModal('folderDialogOpen', v); } },
    // Контракт фичи папок (ADR-005 W2, партия 14): состояние меню/формы — у
    // uiStore, закрытие меню — эффект.
    foldersDeps() {
      return {
        closeChatMenu: () => this.closeChatMenu(),
      };
    },
    // Контракт ignore-листа (ADR-005 W3): хранение и правило — в фиче
    // features/ignored-users.js; компонент отдаёт владельцев и ключи.
    ignoredUsersDeps() {
      return {
        email: this.email,
        peerKeys: this.peerKeys,
        contactsStore,
        db,
        accountNamespace,
        // Чистые правила карты — из features/contacts.js: фича не знает про
        // фичу (ADR-004), поэтому зависимость идёт через контракт.
        isIgnored: ContactsFeature.isIgnored,
        addIgnored: ContactsFeature.addIgnored,
        removeIgnored: ContactsFeature.removeIgnored,
      };
    },
    // Контракт блокировки отправителя (ADR-005 W3): правила — в фиче
    // features/block-user.js; компонент отдаёт правила ignore-листа, что
    // открыто, и эффекты (тост, перерисовка, закрытие меню).
    blockUserDeps() {
      return {
        isIgnored: (email) => this.isIgnored(email),
        ignoreUser: (email) => this.ignoreUser(email),
        unignoreUser: (email) => this.unignoreUser(email),
        activeChat: () => this.activeChat,
        activeChatType: () => this.activeChatType,
        currentGroup: () => this.currentGroup,
        chatMenuTarget: () => (this.chatMenu.target && this.chatMenu.target.email) || '',
        msgSenderEmail: (msg) => this.msgSenderEmail(msg),
        loadMessages: (chat) => this.loadMessages(chat),
        toast: (msg) => uiStore.toast(msg),
        tr: (key) => uiStore.tr(key),
        closeChatMenu: () => this.closeChatMenu(),
      };
    },
    // Контракт локального хранилища (ADR-005 W3): курсоры и отметки
    // «прочитано» — в фиче features/local-store.js; владелец кэша курсоров
    // остаётся у компонента (это его состояние на время сессии).
    localStoreDeps() {
      return {
        email: this.email,
        getCursors: () => this.cursorsCache,
        setCursors: (c) => { this.cursorsCache = c; },
        db,
        storage: (typeof localStorage !== 'undefined') ? localStorage : null,
      };
    },
    // Контракт фичи meta-писем групп (ADR-005 W2, партия 14): список групп и
    // два эффекта (heal/reply) — deps; ключи и аватары — владелец groups-store.
    groupMetaDeps() {
      return {
        groups: this.groups,
        groupStore: this.groupsStore,
        cryptoReady: () => this.cryptoReady,
        healGroupAvatarFromMessage: (id, av) => this.healGroupAvatarFromMessage(id, av),
        replyGroupAvatarHeal: (id) => this.replyGroupAvatarHeal(id),
      };
    },
    // ADR-005 W3 (партия 4): правка сообщения — у владельца форм.
    editingMessage: {
      get() { return uiStore.getFormField('editingMessage'); },
      set(v) { uiStore.setFormField('editingMessage', v); },
    },
    // Контракт фичи непрочитанных (ADR-005 W3, партия 5): счётчики — у
    // владельца чата, дедуп-отметки — в состоянии компонента.
    unreadDeps() {
      return {
        email: () => this.email,
        unreadCounts: () => this.unreadCounts,
        setUnreadCounts: (v) => { this.unreadCounts = v; },
        processedUnreadIds: () => this.processedUnreadIds,
        setProcessedUnreadIds: (v) => { this.processedUnreadIds = v; },
        unreadOf: (k) => this.unreadOf(k),
        clearUnread: (k) => this.clearUnread(k),
      };
    },
    // ADR-005 W3 (партия 7): звёзды и просмотр картинки — у владельца форм.
    starredMap: {
      get() { return uiStore.getFormField('starredMap'); },
      set(v) { uiStore.setFormField('starredMap', v || {}); },
    },
    viewingImage: {
      get() { return uiStore.getFormField('viewingImage'); },
      set(v) { uiStore.setFormField('viewingImage', v); },
    },
    // Контракты фич голосований и пересылки (ADR-005 W3, партия 7): перенесены
    // из methods в computed — как ВСЕ остальные контракты (один стиль).
    pollDeps() {
      return {
        email: this.email, activeChat: this.activeChat,
        activeChatType: this.activeChatType, currentGroup: this.currentGroup,
        groupKeys: this.groupKeys, peerKeys: this.peerKeys, peerPqKeys: this.peerPqKeys,
        cryptoReady: this.cryptoReady, displayName: this.displayName,
        newMessageId: this.newMessageId, setSending: v => this.setSending(v),
        chat: this.chat, scrollToBottom: uiStore.scrollToBottom,
        saveCurrentHistory: k => this.saveCurrentHistory(k), t: uiStore.tr,
      };
    },
    forwardDeps() {
      return {
        forwardTo: this.forwardTo, displayName: this.displayName, email: this.email,
        nameOf: this.nameOf, activeChat: this.activeChat,
        activeChatType: this.activeChatType, currentGroup: this.currentGroup,
        groupKeys: this.groupKeys, peerKeys: this.peerKeys, peerPqKeys: this.peerPqKeys,
        ephemeralTtlOf: this.ephemeralTtlOf, buildEnvelope: this.buildEnvelope,
        setSending: v => this.setSending(v),
        setForwardTo: v => this.forwardTo = v,
        markPending: (k, m) => this.markPending(k, m),
        showToast: (m, d) => uiStore.toast(m, d), t: uiStore.tr,
      };
    },
    // Контракт фичи своего профиля (ADR-005 W3, партия 8): аватар, имя, био.
    profileDeps() {
      return {
        email: () => this.email,
        displayName: () => this.displayName,
        setDisplayName: (v) => { this.displayName = v; },
        profiles: () => this.profiles,
        setUserAvatarUrl: (v) => { this.userAvatarUrl = v; },
        setShowAvatarUpload: (v) => { this.showAvatarUpload = v; },
        setMyBio: (v) => { this.myBio = v; },
        alert: (msg) => { alert(msg); },
      };
    },
    // Контракт фичи звёзд (ADR-005 W3, партия 7).
    starsDeps() {
      return {
        email: () => this.email,
        currentChatKey: () => this.currentChatKey,
        starredMap: () => this.starredMap,
        setStarredMap: (v) => { this.starredMap = v; },
        starredSet: () => this.starredSet,
      };
    },
    // ADR-005 W3 (партия 6): перетаскивание заметок — у владельца форм.
    draggedNoteId: {
      get() { return uiStore.getFormField('draggedNoteId'); },
      set(v) { uiStore.setFormField('draggedNoteId', v); },
    },
    dragOverNoteId: {
      get() { return uiStore.getFormField('dragOverNoteId'); },
      set(v) { uiStore.setFormField('dragOverNoteId', v); },
    },
    dragOverPos: {
      get() { return uiStore.getFormField('dragOverPos'); },
      set(v) { uiStore.setFormField('dragOverPos', v); },
    },
    // Контракт фичи закрепления (ADR-005 W3, партия 6): хранилище — sqlite kv,
    // состояние баннера — в компоненте (deps), DOM — тоже через deps.
    pinsDeps() {
      return {
        readPinned: (id) => this.readPinned(id),
        setPinned: (msgId, preview) => { this.pinnedMsgId = msgId; this.pinnedPreview = preview; },
        isGroupAdmin: () => this.isGroupAdmin,
        currentGroup: () => this.currentGroup,
        groupKeys: this.groupKeys,
        pinnedMsgId: () => this.pinnedMsgId,
        pinGroupMessage: (msg) => this.pinGroupMessage(msg),
        getMessageListEl: () => (this.$refs.messageList && this.$refs.messageList.container) || null,
        jumpToBottom: () => this.jumpToBottom(),
      };
    },
    // Контракт фичи заметок (ADR-005 W3, партия 6).
    notesDeps() {
      return {
        chat: this.chat,
        loadNotes: () => this.loadNotes(),
        saveNotes: (list) => this.saveNotes(list),
        bumpLoadSeq: () => { this.loadSeq++; },
        openMobileChat: () => this.openMobileChat(),
        scrollToBottom: (v) => this.scrollToBottom(v),
        draggedNoteId: () => uiStore.getFormField('draggedNoteId'),
        setDraggedNoteId: (v) => { uiStore.setFormField('draggedNoteId', v); },
        dragOverNoteId: () => uiStore.getFormField('dragOverNoteId'),
        setDragOverNoteId: (v) => { uiStore.setFormField('dragOverNoteId', v); },
        dragOverPos: () => uiStore.getFormField('dragOverPos'),
        setDragOverPos: (v) => { uiStore.setFormField('dragOverPos', v); },
      };
    },
    // Контракт фичи эфемерных сообщений (ADR-005 W4): правило времени жизни —
    // в Rust (features/ephemeral.js зовёт мост), здесь только состояние UI.
    ephemeralDeps() {
      return {
        activeChat: () => this.activeChat,
        activeChatType: () => this.activeChatType,
        currentGroup: () => this.currentGroup,
        ephemeralOptions: () => this.ephemeralOptions,
        setCurrentEphemeralTtl: (v) => { this.currentEphemeralTtl = v; },
        messagesStore: this.messagesStore,
        chat: this.chat,
        addTombstone: (id) => this.addTombstone(id),
        addMidTombstone: (mid) => this.addMidTombstone(mid),
        saveCurrentHistory: (k) => this.saveCurrentHistory(k),
      };
    },
    // Контракт фичи правок/удаления (ADR-005 W3, партия 4).
    editsDeps() {
      return {
        email: () => this.email,
        activeChat: () => this.activeChat,
        activeChatType: () => this.activeChatType,
        currentGroup: () => this.currentGroup,
        chat: this.chat,
        notes: this.notes,
        addTombstone: (id) => this.addTombstone(id),
        addMidTombstone: (mid) => this.addMidTombstone(mid),
        recordLocalEdit: (k, id, t, a) => this.recordLocalEdit(k, id, t, a),
        sendEditEmail: (id, t, a) => this.sendEditEmail(id, t, a),
        saveCurrentHistory: (k) => this.saveCurrentHistory(k),
        saveChatCache: (k, list) => this.saveChatCache(k, list),
        editingMessage: () => uiStore.getFormField('editingMessage'),
        setEditingMessage: (v) => { uiStore.setFormField('editingMessage', v); },
        setReplyTo: (v) => { uiStore.setFormField('replyTo', v); },
        setNewMessage: (v) => { this.chat.setDraft(v); },
        focusInput: () => { const i = this.$refs.messageInput; if (i && i.focus) i.focus(); },
        nextTick: (cb) => this.$nextTick(cb),
        confirm: (msg) => window.confirm(msg),
      };
    },
    // Контракт отметки «видели» (ADR-005 W3, партия 4): карта — у владельца
    // контактов (contacts-store).
    presenceDeps() {
      return {
        lastSeenMap: () => this.lastSeenMap,
        setLastSeenMap: (v) => { this.lastSeenMap = v; },
      };
    },
    // ADR-005 W3 (партия 3): ответ на сообщение и пикер реакций — у
    // владельца форм.
    replyTo: {
      get() { return uiStore.getFormField('replyTo'); },
      set(v) { uiStore.setFormField('replyTo', v); },
    },
    reactionPickerMsgId: {
      get() { return uiStore.getFormField('reactionPickerMsgId'); },
      set(v) { uiStore.setFormField('reactionPickerMsgId', v); },
    },
    // Контракт фичи реакций (ADR-005 W3, партия 3): состояние пикера — у
    // владельца форм, per-app чат — владелец, письмо-сигнал — эффект.
    reactionsDeps() {
      return {
        email: () => this.email,
        chat: this.chat,
        activeChat: () => this.activeChat,
        reactionPickerMsgId: () => uiStore.getFormField('reactionPickerMsgId'),
        setReactionPickerMsgId: (v) => { uiStore.setFormField('reactionPickerMsgId', v); },
        sendReactionEmail: (m, e, a) => this.sendReactionEmail(m, e, a),
      };
    },
    // Контракт фичи каналов (ADR-005 W3, партия 2): per-app владелец чата,
    // DOM и ввод (confirm/prompt/clipboard) — через deps; состояние — у
    // владельцев (mailbox-store/channels-store/uiStore/chatStore).
    channelsDeps() {
      return {
        chat: this.chat,
        saveDraft: () => this.saveDraft(),
        cancelReply: () => this.cancelReply(),
        openMobileChat: () => this.openMobileChat(),
        setShowStarredOnly: (v) => { this.showStarredOnly = v; },
        bumpLoadSeq: () => { this.loadSeq++; },
        fingerprint: () => this.fingerprint,
        nextTick: () => this.$nextTick(),
        confirm: (msg) => window.confirm(msg),
        prompt: (msg, def) => window.prompt(msg, def),
        writeClipboard: (text) => navigator.clipboard.writeText(text),
        closeChatMenu: () => this.closeChatMenu(),
      };
    },
    // Контракт фичи видео звонка (ADR-005 W3, партия 1): DOM-эффекты,
    // которых не знает модуль, — через deps.
    callVideoDeps() {
      return {
        nextTick: () => this.$nextTick(),
        getRemoteCanvas: () => {
          const overlay = this.$refs.callOverlay;
          return overlay ? overlay.getRemoteVideoEl() : null;
        },
      };
    },
    // Контракт фичи участников (ADR-005 W2, партия 12): текущая группа —
    // владелец chatStore, форма «добавить участника» — владелец uiStore
    // (модуль берёт их сам), остальное — эффекты.
    membersDeps() {
      return {
        publicKey: () => this.publicKey,
        loadGroups: () => this.loadGroups(),
        loadChannels: () => this.loadChannels(),
        emailSharesFingerprint: (a, b) => this.emailSharesFingerprint(a, b),
      };
    },
    // Контракт фичи квитанций (ADR-005 W2, партия 11): состояние у
    // владельцев (identity-store/mailbox-store/session-store), разбор конверта
    // и адреса — чистые функции message-format.js. В deps остаётся одно:
    // cryptoReady (признак компонента).
    receiptsDeps() {
      return {
        cryptoReady: () => this.cryptoReady,
        // Квитанции «прочитано» (ADR-005 W3, партия 12).
        activeChatType: () => this.activeChatType,
        currentGroup: () => this.currentGroup,
        activeChat: () => this.activeChat,
        peerKeys: () => this.peerKeys,
        peerPqKeys: () => this.peerPqKeys,
        groupKeys: () => this.groupKeys,
        loadSentReads: () => this.loadSentReads(),
        saveSentReads: (v) => this.saveSentReads(v),
        encryptWithGroupKey: (payload, key) => crypto.encryptWithGroupKey(payload, key),
        setPeerPublicKey: (k, pq) => crypto.setPeerPublicKey(k, pq),
        encryptVault: (payload) => crypto.encryptVault(payload),
        sendGroupRead: (id, content) => api.sendGroupRead(id, content),
        sendReadReceipt: (email, content) => api.sendReadReceipt(email, content),
        onError: (e) => console.error('Failed to send read receipts:', e),
      };
    },
    // Контракт выхода из аккаунта (ADR-005 W3, партия 13). ШАГИ сброса
    // перечислены в features/logout.js — здесь только конкретные владельцы.
    logoutDeps() {
      return {
        stopPolling: () => this.stopPolling(),
        stopHeartbeats: () => PresenceFeature.stopHeartbeats(this.presenceDeps),
        logoutApi: () => api.logout(),
        resetLogin: () => { this.isLoggedIn = false; this.email = ''; this.password = ''; },
        resetIdentity: () => { this.userId = null; },
        resetGroups: () => {
          this.groups = [];
          this.clearGroupKeys();
          this.currentGroup = null;
        },
        resetContacts: () => { this.contacts = []; },
        resetChat: () => {
          this.activeChat = null;
          this.activeChatType = 'chat';
          this.chat.set([]);
          this.messagesStore.reset();
        },
        resetUnread: () => this.clearAllUnread(),
        resetMailbox: () => { this.emails = []; this.emailError = ''; },
        resetInvites: () => {
          this.pendingInvites = [];
          this.showInvitePopup = false;
          this.pendingContacts = [];
          this.showContactPopup = false;
        },
        resetUi: () => {
          this.showSettings = false;
          this.showGroupSettings = false;
          this.showAddMemberPopup = false;
        },
        resetProfile: () => {
          this.profiles = {};
          this.userAvatarUrl = '';
          this.displayName = '';
        },
      };
    },
    // Контракт входа по мнемонике восстановления (ADR-005 W3, партия 13).
    recoveryLoginDeps() {
      return {
        api, crypto, invoke, db, relay, initNotifications, t: uiStore.tr,
        // Записи состояния — через прокси компонента (sessionStore обёрнут
        // reactive): запись в сырой синглтон не перерисовала бы форму
        // (тот же класс, что с флагами модалок).
        setLoginLoading: (v) => { this.loginLoading = v; },
        setLoginError: (v) => { this.loginError = v; },
        markLoggedIn: () => { this.sessionStore.login(); },
        setUserId: (v) => { this.userId = v; },
        publicKey: () => this.publicKey,
        // Релей/эко — через прокси владельца relay-store.
        ecoMode: () => this.ecoMode,
        enableEco: (on) => this.enableEco(on),
        relayEnabled: () => this.relayEnabled,
        enableRelay: (on) => this.enableRelay(on),
        // Эффекты пост-логинового пути.
        initCrypto: (opts) => this.initCrypto(opts),
        initLocalDb: () => this.initLocalDb(),
        loadUnreadCounts: () => this.loadUnreadCounts(),
        loadLocalProfiles: () => this.loadLocalProfiles(),
        loadBodyCache: () => this.loadBodyCache(),
        loadContacts: () => this.loadContacts(),
        loadGroups: () => this.loadGroups(),
        loadChannels: () => this.loadChannels(),
        loadEmails: () => EmailsFeature.loadEmails(this.emailsDeps),
        startPolling: (ms) => this.startPolling(ms),
        startRelayTicker: () => this.startRelayTicker(),
        idleLoop: () => this.idleLoop(),
        logout: () => this.logout(),
        onEcoMode: (on, silent) => this.onEcoMode(on, silent),
        // Синхронизация эко с релеем — relay.js ещё ctx-модуль, поэтому его
        // зовёт компонент (модулю компонент не достаётся).
        syncEcoWithRelay: () => RelayFeature.syncEcoWithRelay(this, true),
      };
    },
    // Контракт автоочистки (ADR-005 W3, партия 12): зеркала памяти и период.
    autocleanDeps() {
      return {
        isLoggedIn: () => this.isLoggedIn,
        account: () => this.email,
        emails: () => this.emails,
        emailBodyCache: () => this.emailBodyCache,
        bodyCacheOrder: () => this.bodyCacheOrder,
        loadPeriod: () => db.kvGet('anon', 'autoclean-period'),
        applyMirrors: (applied) => {
          this.emails = applied.emails;
          this.emailBodyCache = applied.emailBodyCache;
          this.bodyCacheOrder = applied.bodyCacheOrder;
        },
        persistBodyCache: () => this.persistBodyCache(),
        logPurged: (bodies, msgs, period) => {
          console.info('[autoclean] purged', bodies, 'bodies /', msgs, 'msgs, period', period);
        },
        onError: (e) => console.warn('[autoclean] failed:', e),
      };
    },
    // Контракт поиска эскроу-письма (ADR-005 W3, партия 12). Провайдеры
    // кладут эскроу в спам, а Gmail удаляет спам через ~30 дней — поэтому
    // поиск повторяется, а найденное письмо копируется во «Входящие».
    recoveryEscrowDeps() {
      return {
        email: () => this.email,
        fetchEmails: (email) => api.fetchEmails(email),
        fetchBodies: (uids, folder) => invoke('email_fetch_bodies', { uids, folder }).catch(() => []),
        parseEscrowEmail: (body) => crypto.recoveryParseEscrowEmail(body),
        copyToInbox: (uid, folder) => invoke('email_copy_to_inbox', { uid, folder }),
        toast: (msg, ms) => uiStore.toast(msg, ms),
        t: (key) => uiStore.tr(key),
        warn: (...args) => console.warn(...args),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
    },
    // Контракт фичи писем (ADR-005 W2, партия 10): список писем и флаги
    // загрузки — у владельца mailbox-store (модуль берёт их сам), курсоры и
    // downstream-обработчики — эффекты.
    emailsDeps() {
      return {
        loadCursors: (id) => this.loadCursors(id),
        saveCursors: (id, cursors) => this.saveCursors(id, cursors),
        processIncoming: (fetched, opts) => this.processIncoming(fetched, opts),
        processInvites: () => this.processInvites(),
        syncGroupAvatarsFromMeta: () => this.syncGroupAvatarsFromMeta(),
        sendDeliveredReceipts: (fetched) => this.sendDeliveredReceipts(fetched),
      };
    },
    // Контракт фичи duress (ADR-005 W2, партия 9): состояние замка — узкие
    // доступы (спред ...duressState() копирует значения в data(), поэтому
    // модулю нужен геттер/сеттер, а не сам объект), ключи пиров и email модуль
    // берёт у владельцев сам.
    duressDeps() {
      return {
        isLocked: () => this.duressLocked,
        setLocked: (v) => { this.duressLocked = v; },
        isUnlockedThisSession: () => this.duressUnlockedThisSession,
        setUnlockedThisSession: (v) => { this.duressUnlockedThisSession = v; },
        setPending: (v) => { this.duressPending = v; },
        logout: () => this.logout(),
        displayName: () => this.displayName,
        nextTick: (cb) => this.$nextTick(cb),
      };
    },
    // Контракт фичи профилей (ADR-005 W2, партия 8): карта профилей и локальные
    // имена/аватары — состояние компонента (три узких доступа), остальное
    // состояние UI-flow лежит у uiStore, а владельцы (контакты, ключи, email)
    // модуль берёт сам.
    profilesDeps() {
      return {
        getProfiles: () => this.profiles,
        setProfiles: (v) => { this.profiles = v; },
        getLocalProfiles: () => this.localProfiles,
      };
    },
    // Контракт фичи звонков (ADR-005 W2, партия 7): состояние — у
    // владельцев (identity-store/chatStore/call-session — модуль берёт их сам),
    // здесь только ЭФФЕКТЫ и per-app чат-владелец. Живёт в computed, а не в
    // methods: это разводка (набор функций), а не логика — и методы с логикой
    // в App.vue считает ратчет.
    callsDeps() {
      return {
        chat: this.chat,
        // Переключатели звонка (W3 п.1): состояние — у владельца
        // call-session, а «переключатель» сам пишет в него.
        callMuted: () => this.callMuted,
        callSpeaker: () => this.callSpeaker,
        currentCall: () => this.currentCall,
        setMuted: (v) => { this.callMuted = v; },
        setSpeaker: (v) => { this.callSpeaker = v; },
        // Видео гасится в фиче вместе с завершением звонка (W3 п.1).
        stopVideo: () => this.stopCallVideo(),
        isIgnored: (e) => this.isIgnored(e),
        incUnread: (k) => this.incUnread(k),
        saveUnreadCounts: () => this.saveUnreadCounts(),
        saveChatCache: (k, l) => this.saveChatCache(k, l),
        saveCurrentHistory: (k) => this.saveCurrentHistory(k),
        chatVisible: (k) => this.chatVisible(k),
        canonicalOf: (e) => this.canonicalOf(e),
        msgTs: (m) => this.msgTs(m),
        idleLoop: () => this.idleLoop(),
        isAndroid: () => this.isAndroid,
        callPeerName: () => this.callPeerName,
      };
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
      // при showArchived). Поиск работает по видимому подмножеству.
      let list = this.contacts.filter(c =>
        !!(this.chatFlags[c.email.toLowerCase()] || {}).archived === this.showArchived);
      // Папка: активная папка показывает только чаты в ней.
      if (this.activeFolder) {
        list = list.filter(c => (this.chatFlags[c.email.toLowerCase()] || {}).folder === this.activeFolder);
      }
      if (!this.searchQuery) return list;
      const q = this.searchQuery.toLowerCase();
      return list.filter(c => {
        return c.email.toLowerCase().includes(q) || this.nameOf(c.email).toLowerCase().includes(q);
      });
    },
    filteredGroups() {
      let list = this.groups.filter(g =>
        !!(this.chatFlags['group:' + g.id] || {}).archived === this.showArchived);
      if (this.activeFolder) {
        list = list.filter(g => (this.chatFlags['group:' + g.id] || {}).folder === this.activeFolder);
      }
      return list;
    },
    hasArchivedChats() {
      return Object.values(this.chatFlags).some(f => f && f.archived);
    },
    // Папки чатов: список имён из kv (сортировка — features/folders.js).
    chatFoldersList() {
      return FoldersFeature.sortedFolderNames(this.chatFoldersNames);
    },
    // ── Звонки (M3): строки и таймер для оверлея ──
    callTexts() {
      return {
        incoming: uiStore.tr('call_incoming') || 'Входящий звонок…',
        outgoing: uiStore.tr('call_outgoing') || 'Вызов…',
        accept: uiStore.tr('call_accept') || 'Принять',
        reject: uiStore.tr('call_reject') || 'Отклонить',
        cancel: uiStore.tr('call_cancel') || 'Отменить',
        end: uiStore.tr('call_end') || 'Завершить',
        accepted: uiStore.tr('call_accepted') || 'Соединено',
        connecting: uiStore.tr('call_connecting') || 'Соединение…',
        mute: uiStore.tr('call_mute') || 'Выключить микрофон',
        unmute: uiStore.tr('call_unmute') || 'Включить микрофон',
        speaker: uiStore.tr('call_speaker') || 'Динамик',
        camera: uiStore.tr('call_camera') || 'Видео',
        acceptHint: uiStore.tr('call_accept_hint') || '',
        rejectHint: uiStore.tr('call_reject_hint') || '',
        noMedia: uiStore.tr('call_no_media') || '',
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
      // оно НЕ обновляется при смене профиля собеседником, и оверлей звонка
      return this.nameOf(c.peer);
    },
    filteredMessages() {
      let list = this.messages;
      // Режим «Избранное»: только помеченные сообщения текущего чата.
      if (this.showStarredOnly) {
        const set = this.starredSet;
        list = list.filter(m => set.has(m.id));
      }
      if (!this.chatSearchQuery) return list;
      const q = this.chatSearchQuery.toLowerCase();
      return list.filter(m =>
        m.content && m.content.toLowerCase().includes(q)
      );
    },
    starredSet() {
      const key = this.currentChatKey;
      return new Set((key && this.starredMap[key]) || []);
    },
    currentChatKey() {
      if (!this.activeChat) return '';
      return this.activeChatType === 'group' && this.currentGroup
        ? 'group:' + this.currentGroup.id
        : this.activeChat;
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
      if (this.activeChat === '__notes__') return uiStore.tr('notes_self') || 'Заметки для себя';
      if (this.activeChatType === 'group') return this.currentGroup?.name || this.activeChat;
      if (this.activeChatType === 'channel') return this.currentChannel?.name || this.activeChat;
      if (!this.activeChat) return '';
      // Локальное имя контакта (если задано) — выше реального.
      const lp = this.localProfileOf(this.activeChat);
      if (lp && lp.name) return lp.name;
      // Единый резолвер: свежий профиль из писем важнее кэша
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
    },
    // Заблокирован ли открытый сейчас 1:1-чат (баннер в chat-area).
    // ВАЖНО: это computed — в methods он резолвится в шаблоне как
    // функция-ссылка (truthy) и баннер висел всегда (баг 13.09).
    activeChatIgnored() {
      return this.activeChatType === 'chat'
        && !!this.activeChat && this.isIgnored(this.activeChat);
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
      // J.2: синхронизация форма-логина → sessionStore.currentEmail —
      // теперь через computed-proxy setter email(val) (J.7); здесь
      // setCurrentEmail избыточен (setter вызовит его при this.email = val).
    }
  },
  async mounted() {
    // Duress-замок: включён ли (до авторизации)
    this.checkDuressLock();
    // ТАБЛИЦА ОТВЕТОВ ЯДРА о состоянии звонка (ADR-005 R1 / W4): решения
    // «звонков нет?», «идёт разговор?» читаются в СИНХРОННЫХ местах (шаблон
    // компонента, fire-and-forget hangup), где await недопустим. Один вызов
    // на всё время работы приложения — ответ зависит только от состояния.
    warmCallTable();
    applyTheme(loadSavedTheme())
    applyFont(loadSavedFont())
    // НАТИВНЫЕ КНОПКИ УВЕДОМЛЕНИЯ ЗВОНКА
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
      // S5-2: кнопку уведомления нажали, пока живого WebView не было —
      // Kotlin отдаст решение сюда (очередь), как только страница готова.
      window.__vaultApplyPendingCallDecision = (action) => {
        setPendingNativeCallDecision(action);
      };
      // S6: приложение открыто РАДИ ВХОДЯЩЕГО ЗВОНКА (уведомление, локскрин,
      // автозапуск из сервиса). Kotlin отдаёт call_id — запоминаем, чтобы
      // сразу показать ЭКРАН ЗВОНКА этого вызова (сам экран поднимает штатный
      // путь обработки call_request из очереди реля).
      window.__vaultIncomingCall = (callId) => {
        console.log('[call] native incoming-call screen for ' + callId);
        window.__vaultPendingIncomingCall = callId || '';
      };
      // Фоновый плеер голосовых: нативный MediaPlayer (Kotlin) сигнализирует
      // завершение трека — кнопка возвращается в «play» (троттлинг JS-таймеров
      // в фоне не позволяет надёжно слушать duration JS-событиями).
      window.__vaultVoiceNoteDone = () => {
        this.voicePlayingId = '';
      };
      // M2.4: ntfy-пуш Click vault://open?chat=<email> → открыть чат.
      // (index.html уже определил __vaultOpenChat с очередью — не трогаем.)
      // Отложенные deep-link чаты дрейнятся в loadStoredPeerKeys()
      // (после загрузки ключей собеседников).
    } catch (e) { /* не критично */ }
    // Событие «медиа подключено» из Rust: ICE/DTLS установлены и
    // пользователь видел «минуту тишины» при работающем таймере.
    this._unlistenMediaConnected = tauriListen('call-media-connected', (ev) => {
      const cid = ev && ev.payload && ev.payload.callId;
      if (cid && this.currentCall && this.currentCall.call_id === cid) {
        this.callMediaConnected = true;
        // Медиа установлено — ретрансляция accept/answer больше не нужна.
        this.stopSignalResend();
        // «Можно говорить»: яркий сигнал в момент РЕАЛЬНОГО
        // соединения медиа — играет у ОБОИХ абонентов (событие приходит
        // на каждой стороне при ICE Connected + старте пайплайна).
        this.playCallSound('connected', false);
        // Таймер разговора — с момента реального звука, не с момента accept.
        this.startCallClock();
      }
    }).catch(e => console.warn('[call] listen media-connected failed:', e));
    // собеседник положил трубку — «hangup»
    // пришёл по WebRTC DataChannel за миллисекунды (не ждём call_end
    // по email 30-60с). Завершаем локально.
    this._unlistenRemoteHangup = tauriListen('call-remote-hangup', (ev) => {
      const cid = ev && ev.payload && ev.payload.callId;
      console.log('[call] DC remote hangup received, call_id=' + cid);
      if (cid && this.currentCall && this.currentCall.call_id === cid) {
        this.hangup('remote');
      }
    }).catch(e => console.warn('[call] listen remote-hangup failed:', e));
    // СОСТОЯНИЕ ICE: единственный надёжный сигнал о разрыве, когда
    // с красной кнопкой не закрывается»). disconnected → grace 10с (сеть
    // может восстановиться), потом hangup; failed/closed → hangup сразу.
    this._unlistenConnState = tauriListen('call-connection-state', (ev) => {
      const p = ev && ev.payload;
      const cid = p && p.callId;
      const st = p && p.state;
      if (!cid || !this.currentCall || this.currentCall.call_id !== cid) return;
      console.log('[call] connection state:', st);
      if (st === 'connected') {
        connLostGuard.clear();
        this._connLostTimer = null;
      } else if (st === 'disconnected') {
        if (!this._connLostTimer) {
          this._connLostTimer = connLostGuard.arm(() => {
            this._connLostTimer = null;
            if (this.currentCall && this.currentCall.call_id === cid) {
              console.log('[call] ICE disconnected grace expired — hanging up');
              this.hangup('remote');
            }
          });
        }
      } else if (st === 'failed' || st === 'closed') {
        connLostGuard.clear();
        this._connLostTimer = null;
        this.hangup('remote');
      }
    }).catch(e => console.warn('[call] listen connection-state failed:', e));
    // M3: remote-видео — Rust-reader шлёт base64 VP8-кадр.
    // Роутинг в features/video.js (декодер), как остальные 4 listener'а
    // звонков; кадры идут только текущему звонку.
    this._unlistenVideoFrame = tauriListen('call-video-frame', async (ev) => {
      const p = ev && ev.payload;
      const cid = p && p.callId;
      if (!cid || !this.currentCall || this.currentCall.call_id !== cid) return;
      // Auto-start: собеседник шлёт видео, а у нас оно выключено —
      // включаем приём (без камеры), иначе кадры летят впустую и
      // пользователь не видит, что звонок уже видео. Камера при этом
      // НЕ включается — только отображение remote-видео.
      if (!this.callVideoOn) {
        try { await this.startCallVideo(); } catch (e) { console.warn('[video] auto-start failed:', e); return; }
      }
      CallVideoFeature.decodeFrame(p);
    }).catch(e => console.warn('[video] listen frame failed:', e));
    // Rust IDLE-монитор: «mail-changed» приходит из tokio-таска
    // НЕ от JS-цикла — доставка писем/звонков живёт даже при замершем WebView.
    // Это единственный канал от IDLE (JS api.idleWait в цикле не крутится —
    // иначе на аккаунт висело бы два IDLE-соединения).
    // Обработка идемпотентна к JS-поллингу: дедуп по uid|folder + processedUnreadIds.
    this._unlistenMailChanged = tauriListen('mail-changed', async (ev) => {
      const p = ev && ev.payload;
      if (!p) return;
      if (p.cursors) { try { this.saveCursors(this.email, p.cursors); } catch (e) { /* kv */ } }
      const msgs = p.messages || [];
      if (!msgs.length) return;
      // видно ли вообще, что монитор что-то принёс.
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
    // Настройки рингтонов — из kv_store.
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
    // ── Прерванное восстановление (fix/recovery-resilience) ──
    // Durable-маркер 'vault-recovery-pending' значит «recovery-вход начат, но
    // ключ ещё не загружен и вход не закоммичен». Авто-вход по старому
    // persisted token/email здесь ЗАПРЕЩЁН: приложение могло закрыться между
    // логином и импортом ключа, и доверие durable-состоянию + генерация пары
    // создали бы НОВУЮ личность вместо восстановленной. Показываем форму
    // восстановления с переведённым сообщением; initCrypto/генерацию и
    // авто-вход не выполняем вовсе. Уже сохранённые credentials/токены НЕ
    // удаляем — пользователь должен иметь возможность просто войти.
    if (RecoverySession.isRecoveryPending()) {
      this.restoringSession = false;
      this.isLoggedIn = false;
      this.showRecovery = true;
      this.loginError = uiStore.tr('recovery_interrupted') || 'recovery_interrupted';
      return;
    }
    // Validate saved token. Условие — «есть token ИЛИ сохранённый аккаунт»:
    // token синтетический (serverless-<email>) и мог пропасть (сбой сохранения
    // localStorage, старый баг автологина), а сохранённые credentials на
    // устройстве при этом целы. Без второй половины условия вход после потери
    // token блокировался НАВСЕГДА — форма входа, хотя всё сохранено.
    if (api.token || localStorage.getItem('vault-email')) {
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
          // Крипто-ключ ОБЯЗАН быть загружен ДО isLoggedIn/поллинга
          // (fix/recovery-resilience). Почта восстановилась, но без ключа
          // чаты нечитаемы, а генерация новой пары здесь была бы подменой
          // личности. Если ключа нет — показываем форму входа/
          // восстановления. Credentials и старые токены НЕ удаляем: вход с
          // ключом (или восстановление) должен оставаться возможным.
          const keyReady = await this.initCrypto({ allowCreate: false });
          if (!keyReady) {
            this.isLoggedIn = false;
            this.showRecovery = true;
            this.loginError = uiStore.tr('recovery_missing_keys') || 'recovery_missing_keys';
            this.restoringSession = false;
            return;
          }
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
          this.ecoMode = (await db.kvGet('anon', 'eco-mode')) === '1';
          // M2.4: кэш relay-enabled для гейтов автообмена токенами
          // (env.tok в исходящих / сохранение входящих tok).
          try {
            const rs = await relay.getSettings(this.email);
            this.relayEnabled = rs.enabled;
            // M2.3-c: релей включён → eco активируется автоматически.
            // syncEcoWithRelay проверит здоровье релея и включит eco
            // (если пользователь явно его не выключал в настройках).
            if (this.relayEnabled) {
              await RelayFeature.syncEcoWithRelay(this, true).catch(() => {});
              // syncEcoWithRelay мог изменить ecoMode — перечитаем kv.
              this.ecoMode = (await db.kvGet('anon', 'eco-mode')) === '1';
            }
          } catch (e) { /* релей опционален */ }
          this.loadLocalProfiles(); // локальные имена/аватары контактов (per-account)
          await this.loadBodyCache(); 
          await api.getChats();
          await this.loadContacts();
          await this.loadGroups();
          try { await this.loadChannels(); } catch (e) { /* не критично */ }
          // Скорость входа: UI показывается СРАЗУ (история/кэши в памяти),
          // фетч почты идёт в фоне — вход не должен ждать IMAP.
          this.isLoggedIn = true;
          // Эко (M2.3-b ФИНАЛ): глушим сервис полностью — пуши несёт
          // ntfy-клиент. Активация после isLoggedIn (иначе ранний return).
          if (this.ecoMode) { this.onEcoMode(true, true).catch(() => {}); }
          initNotifications().catch(() => {}); // push-уведомления (не блокирует вход)
          this.loadUnreadCounts(); // счётчики непрочитанных из sqlite kv_store
          this.loadChatFlags(); // архив/mute чатов из sqlite kv_store
          this.loadIgnoredUsers(); // ignore-лист (E2E-блокировка) из sqlite kv_store
          this.runAutoclean(); // плановая автоочистка при входе
          this.startPolling()
          if (this.ecoMode) { this.startPolling(60000); this.startRelayTicker(); } // M2.3: эко — без IDLE, релей-тикер жив
          // Владелец IDLE — Rust-монитор (событие «mail-changed»), JS-цикла
          // api.idleWait больше нет: один IDLE на аккаунт, без второго
          // соединения в шторм. Резервный JS-цикл включается только если
          // монитор не поднялся.
          else this.idleLoop();
          // Presence (M2): heartbeat-таймер, если тумблер включён (kv,
          // per-account). Восстанавливается на входе, глушится на выходе.
          try { if (await PresenceFeature.isEnabled(this.email)) PresenceFeature.startHeartbeats(this.presenceDeps); } catch (e) { /* kv */ }
          // Не блокируем вход: письма догружаются асинхронно (поллинг уже
          // запущен — он подхватит). Ошибки IMAP не роняют вход.
          EmailsFeature.loadEmails(this.emailsDeps).catch(e => {
            if (String(e && e.message || e).toLowerCase().includes('not connected')) {
              this.showRestoreFailure();
            }
          });
        } catch (e) {
          // Восстановление прошло, но инициализация после него упала.
          // token НЕ стираем: он синтетический (serverless-<email>) и нужен,
          // чтобы следующий холодный старт снова попробовал авто-вход. Старое
          // поведение (api.token = null + removeItem) превращало одну ошибку в
          // вечный экран входа — человек видел «всё пропало» при целых данных
          // (инцидент 18.10). Ошибку логируем: иначе причина невидима.
          console.error('auto-login: post-restore init failed (token kept):', e);
          this.showRestoreFailure();
        } finally {
          this.restoringSession = false;
        }
      }
    }
    // Крипто-состояние при старте — ТОЛЬКО загрузка (allowCreate:false).
    // Генерация новой пары здесь недопустима: на чистом экране логина и при
    // отсутствии ключей это создало бы личность, которой у пользователя нет
    // (и затирало бы ожидание восстановления). Пара создаётся только после
    // явного обычного логина (см. login()).
    await this.initCrypto({ allowCreate: false })
  },
  beforeUnmount() {
    this.stopPolling()
    // Слушатели Tauri-событий звонка.
    if (this._unlistenMediaConnected) { this._unlistenMediaConnected(); this._unlistenMediaConnected = null; }
    if (this._unlistenRemoteHangup) { this._unlistenRemoteHangup(); this._unlistenRemoteHangup = null; }
    if (this._unlistenConnState) { this._unlistenConnState(); this._unlistenConnState = null; }
    if (this._unlistenVideoFrame) { this._unlistenVideoFrame(); this._unlistenVideoFrame = null; }
    if (this._connLostTimer) { clearTimeout(this._connLostTimer); this._connLostTimer = null; }
    // M3: видеотракт — камера и remote-декодер не должны пережить
    // размонтирование (иначе энкодер держит USB/камеру после закрытия UI).
    CallVideoFeature.stopVideoTracks();
  },
  methods: {
    // ── Голосования (poll) — логика в features/poll.js; обёртки держат
    // шаблонные биндинги явными (гейт check-template резолвит имена).
    parsePollEnvelope(env) { return PollFeature.parsePollEnvelope(env); },
    pollVotes(poll) { return PollFeature.pollVotes(poll); },
    pollOptionCount(poll, i) { return PollFeature.pollOptionCount(poll, i); },
    pollLead(poll) { return PollFeature.pollLead(poll); },
    pollLeadLabel(poll) { return PollFeature.pollLeadLabel(poll); },
    castPollVote(msg, option) { return PollFeature.castPollVote(this.pollDeps(), msg, option); },
    async sendPoll(question, options) { return PollFeature.sendPoll(this.pollDeps(), question, options); },
    applyPollVotes(list, wirePollVotes) { return PollFeature.applyPollVotes(list, wirePollVotes, this.email); },
    // ADR-001: явные deps для оркестраторов poll (без this целиком).

    // ── Реакции (логика в features/reactions.js) ──
    // ── Reactions (features/reactions.js → explicit deps) ──
    reactionsStorageKey() { return ReactionsFeature.reactionsStorageKey(this.email); },
    loadStoredReactions() { return ReactionsFeature.loadStoredReactions(this.email); },
    saveStoredReactions(data) { return ReactionsFeature.saveStoredReactions(this.email, data); },
    applyReactions(list, chatKey, wireReactions) { return ReactionsFeature.applyReactions({ email: this.email }, list, chatKey, wireReactions); },
    sendReactionEmail(msgId, emoji, action) {
      return ReactionsFeature.sendReactionEmail({
        activeChatType: this.activeChatType, currentGroup: this.currentGroup,
        groupKeys: this.groupKeys, peerKeys: this.peerKeys, peerPqKeys: this.peerPqKeys,
        activeChat: this.activeChat,
      }, msgId, emoji, action);
    },
    toggleReactionPicker(msgId) { return ReactionsFeature.toggleReactionPicker(this.reactionsDeps, msgId); },
    addReaction(msgId, emoji) { return ReactionsFeature.addReaction(this.reactionsDeps, msgId, emoji); },
    toggleReaction(msgId, emoji) {
      return ReactionsFeature.toggleReaction({
        email: this.email, chat: this.chat, activeChat: this.activeChat,
        sendReactionEmail: (m,e,a) => this.sendReactionEmail(m,e,a),
      }, msgId, emoji);
    },
    // ── Правки/удаления + tombstones (логика в features/edits.js) ──
    // ADR-001: функции принимают конкретные зависимости, а не this целиком.
    editsStorageKey() { return EditsFeature.editsStorageKey(this.email); },
    loadStoredEdits() { return EditsFeature.loadStoredEdits(this.email); },
    saveStoredEdits(data) { return EditsFeature.saveStoredEdits(this.email, data); },
    recordLocalEdit(chatKey, msgId, text, action) { return EditsFeature.recordLocalEdit(this.email, chatKey, msgId, text, action); },
    tombstonesKey() { return EditsFeature.tombstonesKey(this.email); },
    loadTombstones() { return EditsFeature.loadTombstones(this.tombstonesCache); },
    addTombstone(msgId) { return EditsFeature.addTombstone({ email: this.email, tombstonesCache: this.tombstonesCache }, msgId); },
    isTombstoned(msgId) { return EditsFeature.isTombstoned(this.tombstonesCache, msgId); },
    midTombstonesKey() { return EditsFeature.midTombstonesKey(this.email); },
    loadMidTombstones() { return EditsFeature.loadMidTombstones(this.midTombstonesCache); },
    addMidTombstone(mid) { return EditsFeature.addMidTombstone({ email: this.email, midTombstonesCache: this.midTombstonesCache }, mid); },
    isMidTombstoned(mid) { return EditsFeature.isMidTombstoned(this.midTombstonesCache, mid); },
    filterDeleted(list) { return EditsFeature.filterDeleted({ tombstonesCache: this.tombstonesCache, midTombstonesCache: this.midTombstonesCache }, list); },
    applyEdits(list, chatKey, wireEdits) { return EditsFeature.applyEdits({ email: this.email, tombstonesCache: this.tombstonesCache, midTombstonesCache: this.midTombstonesCache }, list, chatKey, wireEdits); },
    sendEditEmail(msgId, text, action) { return EditsFeature.sendEditEmail({ activeChat: this.activeChat, activeChatType: this.activeChatType, currentGroup: this.currentGroup, groupKeys: this.groupKeys, peerKeys: this.peerKeys, peerPqKeys: this.peerPqKeys, email: this.email }, msgId, text, action); },
    // ── История/кэши/оптимистичные исходящие (логика в features/history.js) ──
    // ── Local history / caches / pendingOutgoing (logic in features/history.js) ──
    // ADR-001: функции принимают конкретные зависимости, а не this целиком.
    bodyCacheKey() { return HistoryFeature.bodyCacheKey(this.email); },
    chatCacheKey(chat) { return HistoryFeature.chatCacheKey(this.email, chat); },
    loadBodyCache() {
      return HistoryFeature.loadBodyCache(this.email).then(({ bodies, order }) => {
        this.emailBodyCache = bodies;
        this.bodyCacheOrder = order;
      });
    },
    cacheBody(key, body) {
      HistoryFeature.cacheBody({ emailBodyCache: this.emailBodyCache, bodyCacheOrder: this.bodyCacheOrder }, key, body);
      if (this.bodyCacheSaveTimer) clearTimeout(this.bodyCacheSaveTimer);
      this.bodyCacheSaveTimer = setTimeout(() => this.persistBodyCache(), 2000);
    },
    persistBodyCache() { return HistoryFeature.persistBodyCache(this.email, this.emailBodyCache); },
    loadChatCache(chat) { return HistoryFeature.loadChatCache(this.email, chat); },
    saveChatCache(chat, list) { return HistoryFeature.saveChatCache(this.email, chat, list, this.msgTs); },
    markPending(chatKey, msg) { return HistoryFeature.markPending({ setPendingOutgoing: v => this.setPendingOutgoing(chatKey, v) }, chatKey, msg); },
    mergePending(chatKey, list) {
      return HistoryFeature.mergePending({
        pendingOutgoing: this.pendingOutgoing,
        isTombstoned: this.isTombstoned,
        msgTs: this.msgTs,
        mergePendingOutgoing: v => this.mergePendingOutgoing(chatKey, v),
        dropBucket: () => this.dropBucket(chatKey),
      }, chatKey, list);
    },
    loadLocalHistory(chatKey) { return HistoryFeature.loadLocalHistory(this.email, chatKey, this.msgTs); },
    normalizeStaleSending(hist) { return HistoryFeature.normalizeStaleSending(this.msgTs, hist); },
    mergeHistory(chatKey, list) {
      return HistoryFeature.mergeHistory({
        email: this.email, msgTs: this.msgTs, filterDeleted: this.filterDeleted,
      }, chatKey, list);
    },
    msgTs(m) { return HistoryFeature.msgTs(m); },
    showHistoryFirst(chatKey, isStale) {
      return HistoryFeature.showHistoryFirst({
        loadHistory: ck => this.loadLocalHistory(ck), chat: this.chat, msgTs: this.msgTs,
      }, chatKey, isStale);
    },
    saveCurrentHistory(chatKey) { return HistoryFeature.saveCurrentHistory(this.email, chatKey, this.chat); },
    // ── Релей/режимы приёма (логика в features/relay.js) ──
    relayConsume() { return RelayFeature.relayConsume(this); },
    loadEmailsFast(silent = true) { return RelayFeature.loadEmailsFast(this, silent); },
    startRelayTicker() { return RelayFeature.startRelayTicker(this); },
    enterRelayOfflineRescue() { return RelayFeature.enterRelayOfflineRescue(this); },
    idleLoop() { return RelayFeature.idleLoop(this); },
    stopFastFetchTimer() { return RelayFeature.stopFastFetchTimer(this); },
    startPolling(intervalMs = 30000) { return RelayFeature.startPolling(this, intervalMs); },
    stopPolling() { return RelayFeature.stopPolling(this); },
    onEcoMode(on, silent = false) { return RelayFeature.onEcoMode(this, on, silent); },
    onRelayEnabled(on) { return RelayFeature.onRelayEnabled(this, on); },
    onPresenceEnabled(on) { this.presenceSetEnabled(on); },
    // ── Звонки (логика в features/calls.js) ──
    // ADR-001: ниже передаются ЯВНЫЕ зависимости, а не `this`. Сигнатура
    // фичи — её контракт: она физически не может задеть поле, которого
    // в списке нет. Ниже — исключения, где зависимостей много и список
    // разумнее держать в features/ (см. ADR-001-заметку в calls.js).
    async isCallSeen(callId) { return CallsFeature.isCallSeen(this.email, callId); },
    async rememberCallSeen(callId) { return CallsFeature.rememberCallSeen(this.email, callId); },
    async parseCallSignal(decrypted) { return CallsFeature.parseCallSignal(decrypted); },
    async sendCallEnvelope(peer, payload, opts = {}) { return CallsFeature.sendCallEnvelope(this.callsDeps, peer, payload, opts); },
    async handleCallSignal(sig, from) { return CallsFeature.handleCallSignal(this.callsDeps, sig, from); },
    async onMailBounce(recipients, reason) { return CallsFeature.onMailBounce(this.callsDeps, recipients, reason); },
    async startCall() { return CallsFeature.startCall(this.callsDeps); },
    async acceptCall() { return CallsFeature.acceptCall(this.callsDeps); },
    async rejectCall() { return CallsFeature.rejectCall(this.callsDeps); },
    async endCall() { return CallsFeature.endCall(this.callsDeps); },
    async hangup(reason) { return CallsFeature.hangup(this.callsDeps, reason); },
    async cancelCall(reason) { return CallsFeature.cancelCall(this.callsDeps, reason); },
    async recordCallEvent(peer, kind, ts, durationSec, callId) { return CallsFeature.recordCallEvent(this.callsDeps, peer, kind, ts, durationSec, callId); },
    callEventLabel(msg) { return CallsFeature.callEventLabel(this.t, msg); },
    callPillIcon(msg) { return CallsFeature.callPillIcon(msg); },
    canCallBack(msg) { return CallsFeature.canCallBack({
      activeChat: this.activeChat, activeChatType: this.activeChatType,
      callState: this.callState, expCalls: this.expCalls, peerKeys: this.peerKeys,
    }, msg); },
    callBack() { return CallsFeature.callBack(this.callsDeps); },
    toggleCallMute() { return CallsFeature.toggleCallMute(this.callsDeps); },
    toggleSpeaker() { return CallsFeature.toggleSpeaker(this.callsDeps); },
    // M3: видео живёт в features/call-video.js — здесь только тонкая
    // точка сборки (reactive-флаг + вызов фичи), как у mute/speaker.
    toggleCallVideo() { return CallVideoFeature.toggleCallVideo(this.callVideoDeps); },
    async startCallVideo() { return CallVideoFeature.startCallVideo(this.callVideoDeps); },
    stopCallVideo() { return CallVideoFeature.stopCallVideo(this.callVideoDeps); },
    startSignalResend(peer, payload, call_id) { return CallsFeature.startSignalResend(this.callsDeps, peer, payload, call_id); },
    stopSignalResend() { return CallsFeature.stopSignalResend(this.callsDeps); },
    sendTerminalRepeat(peer, type, call_id) { return CallsFeature.sendTerminalRepeat(this.callsDeps, peer, type, call_id); },
    armMediaFallback() { return CallsFeature.armMediaFallback(this.callsDeps); },
    startCallClock() { return this.callSession.startCallClock(); },
    stopCallClock() { return this.callSession.stopCallClock(); },
    startFastPolling() { return CallsFeature.startFastPolling(() => this.idleLoop(), this.callSession.callIdleMonitorUp); },
    stopFastPolling() { return CallsFeature.stopFastPolling(); },
    playCallSound(name, looped) { return CallsFeature.playCallSound(this.callsDeps, name, looped); },
    stopCallSound() { return CallsFeature.stopCallSound(this.callsDeps); },
    // ── Профили контактов (логика в features/profiles.js) ──
    aliasesOf(email) { return ProfilesFeature.aliasesOf(this.peerKeys, email); },
    profileOf(email) { return ProfilesFeature.profileOf(this.profiles, email); },
    localProfileOf(email) { return ProfilesFeature.localProfileOf(this.localProfiles, email); },
    nameOf(email) { return ProfilesFeature.nameOf({ profiles: this.profiles, localProfiles: this.localProfiles, peerKeys: this.peerKeys }, email); },
    avatarOf(email) { return ProfilesFeature.avatarOf({ profiles: this.profiles, localProfiles: this.localProfiles, peerKeys: this.peerKeys }, email); },
    loadLocalProfiles() { return ProfilesFeature.loadLocalProfiles({ email: this.email, setLocalProfiles: (v) => { this.localProfiles = v; } }); },
    saveLocalProfiles() { return ProfilesFeature.saveLocalProfiles({ email: this.email, localProfiles: this.localProfiles }); },
    async loadProfiles() { return ProfilesFeature.loadProfiles({ setProfiles: (v) => { this.profiles = v; } }); },
    async getBio() { return ProfilesFeature.getBio({ email: this.email }); },
    async setBio(text) { return ProfilesFeature.setMyBio(this.profileDeps, text); },
    async onBioSave(text) { return ProfilesFeature.onBioSave({ email: this.email, showToast: (m) => uiStore.toast(m), t: uiStore.tr }, text); },
    async onProfileSave() { return ProfilesFeature.onProfileSave({ showToast: (m) => uiStore.toast(m), t: uiStore.tr, broadcastProfile: () => this.broadcastProfile() }); },
    async broadcastProfile() { return ProfilesFeature.broadcastProfile({ email: this.email, displayName: this.displayName, profiles: this.profiles, peerKeys: this.peerKeys, peerPqKeys: this.peerPqKeys }); },
    async openContactCard(email) { return ProfilesFeature.openContactCard(this.profilesDeps, email); },
    startEditFromCard() { return ProfilesFeature.startEditFromCard(this.profilesDeps); },
    openContactEdit(email) { return ProfilesFeature.openContactEdit(this.profilesDeps, email); },
    handleContactAvatarSelect(event) { return ProfilesFeature.handleContactAvatarSelect(this.profilesDeps, event); },
    saveContactEdit() { return ProfilesFeature.saveContactEdit(this.profilesDeps); },
    resetContactEdit() { return ProfilesFeature.resetContactEdit(this.profilesDeps); },
    async shrinkAvatar(dataUrl) { return ProfilesFeature.shrinkAvatar(dataUrl); },
    compressImage(dataUrl, maxSide, quality) { return ProfilesFeature.compressImage(dataUrl, maxSide, quality); },
    noteSeen(email, ts) { return ProfilesFeature.noteSeen(this.presenceDeps, email, ts); },
    isRecentlySeen(email) { return ProfilesFeature.isRecentlySeen(this.lastSeenMap, email); },
    // ── Presence (t_e858bdb9) — heartbeat-зелёная точка; логика в
    // features/presence.js. Тумблер живёт в настройках (Приватность).
    isOnline(email) { return PresenceFeature.isOnline(this.lastSeenMap, email); },
    presenceSetEnabled(on) {
      PresenceFeature.setEnabled(this.email, on, {
        startHeartbeats: () => PresenceFeature.startHeartbeats(this.presenceDeps),
        stopHeartbeats: () => PresenceFeature.stopHeartbeats(this.presenceDeps),
      }).catch(e =>
        console.warn('[presence] setEnabled failed:', e && e.message || e));
    },
    // ── Пересылка (forward) — логика в features/forward.js; обёртки держат
    // шаблонные биндинги явными (гейт check-template резолвит имена).
    startForward(msg) { return ForwardFeature.startForward({ setForwardTo: v => this.forwardTo = v }, msg); },
    doForward(key) { return ForwardFeature.doForward(this.forwardDeps(), key); },
    // ADR-001: явный депс для doForward (без this целиком).

    // ── Папки чатов (folders) — логика в features/folders.js; loadChatFlags
    // грузит единый kv-блоб (flags + folder names), архив/mute меняются
    // toggleArchive/toggleMute ниже (чат-меню) через общий saveChatFlags.
    async loadChatFlags() { return FoldersFeature.loadChatFlags(this.foldersDeps); },
    async saveChatFlags() { return FoldersFeature.saveChatFlags(this.foldersDeps); },
    flagKey(target) { return FoldersFeature.flagKey(target); },
    chatFlagOf(key) { return FoldersFeature.chatFlagOf(key); },
    async setChatFolder(name) { return FoldersFeature.setChatFolder(this.foldersDeps, name); },
    async createChatFolder() { return FoldersFeature.createChatFolder(this.foldersDeps); },
    // ── Ignore-лист (E2E-честная блокировка отправителя). Логика — здесь,
    // не в features/: точек интеграции мало, а data-инвариант (объект
    // email→ts) связан с тремя путями доставки (почта/релей/история).
    // Загрузка из sqlite kv 'ignored-users' (вызывается при входе рядом с
    // loadChatFlags). Повреждённый блоб — тихо пустой список.
    async loadIgnoredUsers() { return IgnoredUsersFeature.loadIgnoredUsers(this.ignoredUsersDeps); },
    async saveIgnoredUsers() { return IgnoredUsersFeature.saveIgnoredUsers(this.ignoredUsersDeps); },
    // Заблокирован ли отправитель для НАС (смена почты не помогает:
    // проверяем и сам email, и все алиасы того же peer-ключа).
    // ADR-001: контактовые утилиты вынесены в features/contacts.js (чистые fn).
    isIgnored(email) {
      return ContactsFeature.isIgnored(contactsStore.state.ignoredUsers, this.peerKeys, email);
    },
    // Заблокировать отправителя: с этого момента его новые сообщения,
    // звонки и уведомления скрыты у получателя. Возвращает false, если
    // email пустой или это наш собственный адрес.
    async ignoreUser(email) { return IgnoredUsersFeature.ignoreUser(this.ignoredUsersDeps, email); },
    // Снять блокировку: новые сообщения снова показываются. Прошлое (то,
    // что скрылось, пока блок был активен) не возвращается — его не было
    // в истории. Снимаем и сам адрес, и алиасы того же ключа.
    async unignoreUser(email) { return IgnoredUsersFeature.unignoreUser(this.ignoredUsersDeps, email); },
    // ── Черновики (drafts) — логика в features/drafts.js; очередь сериализации
    // kv-блоба (гонка save/restore) — на статике модуля, не компонента.
    draftRun(fn) { return DraftsFeature.draftRun(fn); },
    saveDraft() { return DraftsFeature.saveDraft(this.draftsDeps); },
    restoreDraft(chatKey) { return DraftsFeature.restoreDraft(this.draftsDeps, chatKey); },
    // ── Duress-замок — логика в features/duress.js; LockScreen-события
    // (unlock/duress/panic) приходят из шаблона в эти обёртки.
    async checkDuressLock() { return DuressFeature.checkDuressLock(this.duressDeps); },
    onLockUnlock() { return DuressFeature.onLockUnlock(this.duressDeps); },
    onLockDuress() { return DuressFeature.onLockDuress(this.duressDeps); },
    async onLockPanic() { return DuressFeature.onLockPanic(this.duressDeps); },
    async sendDuressSos() { return DuressFeature.sendDuressSos(this.duressDeps); },
    // §1: пояснение индикатора доставки человеческим языком.
    relayExplainDelivery() { return RelayFeature.relayExplainDelivery({ relayDeliveryMode: () => this.relayDeliveryMode }); },
    // Мобильная навигация: открыть чат на весь экран (портрет телефона).
    openMobileChat() { return ChatUiFeature.openMobileChat(this.chatUiDeps); },
    // Вернуться к списку чатов (кнопка «назад» в шапке чата).
    closeMobileChat() { return ChatUiFeature.closeMobileChat(this.chatUiDeps); },
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
    // ── Вложения (логика в features/attachments.js) — тонкие делегаты,
    // имена сохранены для шаблонных биндингов (гейт check-template). ──
    downloadAttachment(attachment) { return AttachmentsFeature.downloadAttachment(attachment); },
    async downloadAttachmentFile(attachment) { return AttachmentsFeature.downloadAttachmentFile(attachment); },
    // ADR-001: showToast обёрнут в стрелку — метод компонента теряет this,
//            если передать его ссылкой (внутри использует состояние).
async toggleVoiceNote(msg, attachment) {
      this.voicePlayingId = await AttachmentsFeature.toggleVoiceNote({
        isAndroidClient: this.isAndroidClient, voicePlayingId: this.voicePlayingId,
        showToast: (m, ms) => uiStore.toast(m, ms), t: uiStore.tr,
      }, msg, attachment);
    },
    // W2 (ADR-005 R3): внутри модуля нет ctx — состояние он берёт у владельцев
    // (chat/identity/mailbox/session stores), а здесь получает только ЭФФЕКТЫ.
    // forceUpdate нужен, потому что вложение — обычный объект внутри сообщения:
    // после мутации data/dodStatus рендер сам не обновится.
    async fetchDodAttachment(msg, attachment) { return AttachmentsFeature.fetchDodAttachment({ resolveChatKey: ChatFeature.resolveChatKey, groupKeys: this.groupKeys, dodCache: this.dodCache, forceUpdate: () => this.$forceUpdate(), saveCurrentHistory: (k) => this.saveCurrentHistory(k) }, msg, attachment); },
    async downloadDodAttachment(msg, attachment) { return AttachmentsFeature.downloadDodAttachment({ resolveChatKey: ChatFeature.resolveChatKey, groupKeys: this.groupKeys, dodCache: this.dodCache, forceUpdate: () => this.$forceUpdate(), saveCurrentHistory: (k) => this.saveCurrentHistory(k) }, msg, attachment); },
    // Было: AttachmentsFeature.openImageViewer(this, attachment) — обёртка без
// логики, удалена (ADR-001).
openImageViewer(attachment) { this.viewingImage = attachment; },
    // Открыть ссылку из меню сообщения внешним браузером (через tauri
    // opener-плагин; модульный импорт недоступен шаблону Options API,
    // поэтому тонкая обёртка-метод — шаблон зовёт openUrl).
    openUrl(url) { return ExtLinks.openUrl(url); },
    // Внешняя ссылка/mailto: Android — НАТИВНАЯ команда android_open_url
    // (плагин-opener на Android не доходил до системного обработчика),
    // desktop — plugin-shell open (xdg-open, mailto открывает почтовый
    // клиент). Тот же механизм, что openExternalLink в SettingsPage.
    async openExternalUrl(url) { return ExtLinks.openExternalUrl(url); },
    // §8.3 UGC (модерация RuStore): «Пожаловаться» из меню сообщения —
    // письмо на support@vault-msg.ru с предзаполненной темой и телом
    // (тип жалобы, email отправителя, время, id). Серверной жалоб-
    // инфраструктуры у Vault нет (serverless, email-транспорт) —
    // механизм mailto, как у «Сообщить об ошибке» в настройках.
    // ADR-003 Этап 3, партия 12: сборка текста жалобы — в features/report-content.js.
    // Диалог ввода и открытие ссылки остаются здесь: это UI, а текст письма
    // уходит с устройства и потому тоже контракт, а не черновик.
    async reportMessageContent(msg) {
      const type = await prompt(
        uiStore.tr('report_content_prompt') || 'Тип жалобы (спам / оскорбления / другое):',
        'спам');
      if (type === null) return; // отмена
      const sender = this.msgSenderEmail(msg)
        || (this.activeChatType === 'chat' ? this.activeChat : '')
        || '-';
      const tr = (k) => uiStore.tr(k);
      const lines = ReportContent.buildReportLines({ type, msg, sender }, tr);
      const url = ReportContent.buildReportMailto(
        uiStore.tr('report_content_subject') || 'Жалоба на контент — Vault', lines);
      await this.openExternalUrl(url);
    },
    closeImageViewer() { return uiStore.setFormField('viewingImage', null); },
    onAppIconChanged(id) {
      this.appIconId = id;
      // Persist so the chosen icon survives restarts and is reflected everywhere.
      localStorage.setItem('vault-icon', id);
      const favicon = document.querySelector("link[rel='icon']");
      if (favicon) favicon.href = `/icons/vault-${id}.svg`;
      // Update the native window icon (waybar/dock).
      api.setAppIcon(id).catch(() => { /* ignore window icon failures */ });
    },
    // Инициализация крипто-состояния. Возвращает true, если рабочий ключ
    // (загруженный ИЛИ созданный) на месте, и false, если ключа нет и создавать
    // нельзя (allowCreate:false) или инициализация упала.
    //
    // allowCreate (fix/recovery-resilience): false = «startup/load only» —
    // при отсутствии ключа на диске НЕ генерировать новую пару. Генерация
    // допустима ТОЛЬКО после явного обычного логина (allowCreate:true).
    // Причина: mounted() раньше вызывал initCrypto() безусловно — даже на
    // чистом экране логина и во время прерванного восстановления — и при
    // отсутствии ключей создавал НОВУЮ пару. Для восстановления это
    // катастрофа: новая пара затирает личность аккаунта, который должен был
    // быть восстановлен из эскроу/файла. Поэтому:
    //   • startup/auto-login path → allowCreate:false (только загрузка);
    //   • после import_backup в recovery → allowCreate:false (перезагрузка
    //     восстановленного ключа; нет ключа = ошибка recovery_missing_keys);
    //   • обычный логин → allowCreate:true (новому пользователю нужна пара).
    async initCrypto(opts) { return KeysFeature.initCrypto(this.keysDeps, opts); },
    async loadStoredPeerKeys() { return KeysFeature.loadStoredPeerKeys(this.keysDeps); },
    // Авто-вход не удался: показываем форму входа с понятным сообщением и
    // предзаполняем email + сохранённые серверы (провайдер мог сменить
    // IMAP/SMTP — пользователь может исправить их в «Настройках сервера»).
    showRestoreFailure() {
      this.email = api.email || this.email;
      // Раскладка причины отказа и сохранённой конфигурации — в
      // features/restore-failure.js (ADR-003 Этап 3, партия 16). Там же правило
      // про порты-строки и про то, что секцию настроек показывают только если
      // есть что показывать.
      const st = RestoreFailure.buildRestoreFailureState(
        api.lastRestoreError, api.savedConfig, (k) => uiStore.tr(k));
      this.loginError = st.loginError;
      this.imapServer = st.imapServer;
      this.imapPort = st.imapPort;
      this.smtpServer = st.smtpServer;
      this.smtpPort = st.smtpPort;
      this.showServerSettings = st.showServerSettings;
      this.mailProvider = st.mailProvider;
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
      // Обычный вход НЕ МОЖЕТ обойти прерванное восстановление
      // (fix/recovery-resilience): пока маркер 'vault-recovery-pending' стоит,
      // api.login + initCrypto({allowCreate:true}) создали бы НОВУЮ пару
      // вместо восстановленной и затирали бы личность аккаунта. Оставляем
      // пользователя на форме восстановления с переведённым сообщением.
      // Маркер снимает только успешный commitRecoveryLogin.
      this.loginLoading = true;
      this.loginError = '';
      try {
        if (RecoverySession.isRecoveryPending()) {
          this.showRecovery = true;
          this.loginError = uiStore.tr('recovery_interrupted') || 'recovery_interrupted';
          return;
        }
        // Пользовательские настройки серверов (если заполнены) — иначе
        // дефолты Gmail внутри emailConnect.
        const config = {};
        if (this.imapServer.trim()) config.imap_server = this.imapServer.trim();
        if (this.imapPort.trim()) config.imap_port = parseInt(this.imapPort.trim(), 10);
        if (this.smtpServer.trim()) config.smtp_server = this.smtpServer.trim();
        if (this.smtpPort.trim()) config.smtp_port = parseInt(this.smtpPort.trim(), 10);
        const data = await api.login(this.email, this.password, { remember: this.rememberMe, config });
        this.userId = data.user_id;
        // Новому пользователю нужна крипто-пара — здесь генерация РАЗРЕШЕНА
        // (явный обычный вход, а не старт/восстановление). Если не удалось ни
        // загрузить, ни создать ключ — входа нет (ошибка видна в finally).
        const cryptoReady = await this.initCrypto({ allowCreate: true });
        if (!cryptoReady) {
          this.isLoggedIn = false;
          this.loginError = uiStore.tr('recovery_missing_keys') || 'recovery_missing_keys';
          return;
        }
        this.isLoggedIn = true;
        initNotifications().catch(() => {}); // push-уведомления (не блокирует вход)
        // Namespace = fp:<fingerprint>. На ручном входе initCrypto из mounted
        // уже отработал, но мог сработать ДО появления this.email — тогда кэш
        // резолвера остался на legacy-емейле и миграция не запустилась бы.
        // Сбрасываем кэш и переносим накопленные email-строки один раз.
        resetAccountNamespaceCache();
        try { await ensureAccountNamespace(this.email); }
        catch (e) { console.warn('[identity] namespace bootstrap failed:', e); }
        await this.initLocalDb(); // sqlite: tombstones + курсоры для аккаунта
        this.loadUnreadCounts(); // счётчики непрочитанных из sqlite kv_store (после initLocalDb)
        this.loadChatFlags(); // архив/mute чатов из sqlite kv_store
        this.runAutoclean(); // плановая автоочистка при входе
        this.loadLocalProfiles(); // локальные имена/аватары контактов (per-account)
        // 0.1.180: релей/eco-инициализация при НОВОМ логине (зеркало
        // auto-login пути): релей ВКЛ по умолчанию (free-токен 100/день,
        // без промо-ключа) → eco активируется автоматически, foreground-
        // служба не поднимается (батарея). Явное '0' юзера уважаем.
        this.ecoMode = (await db.kvGet('anon', 'eco-mode')) === '1';
        try {
          const rs = await relay.getSettings(this.email);
          this.relayEnabled = rs.enabled;
          if (this.relayEnabled) {
            await RelayFeature.syncEcoWithRelay(this, true).catch(() => {});
            // syncEcoWithRelay мог изменить ecoMode — перечитаем kv.
            this.ecoMode = (await db.kvGet('anon', 'eco-mode')) === '1';
          }
        } catch (e) { /* релей опционален — не блокируем почтовый вход */ }
        await this.loadBodyCache(); 
        await this.loadContacts();
        await this.loadGroups();
          try { await this.loadChannels(); } catch (e) { /* не критично */ }
        // Скорость входа: UI сразу, фетч почты в фоне (не блокирует вход).
        if (this.ecoMode) { this.onEcoMode(true, true).catch(() => {}); } // eco: служба отключена, доставка через релей
        this.startPolling()
        if (this.ecoMode) { this.startPolling(60000); this.startRelayTicker(); } // M2.3: эко — без IDLE, релей-тикер жив
        else this.idleLoop(); // Rust-монитор IDLE — доставка звонков/писем
        EmailsFeature.loadEmails(this.emailsDeps).catch(e => {
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
      return LogoutFeature.logoutFlow(this.logoutDeps);
    },
    // --- Смена почты
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
        // счётчики, пометки) из namespace старого адреса в новый — иначе
        // переписка «исчезает» после смены адреса.
        await this.migrateAccountData(oldEmail, this.email);
        await this.migrateOwnGroups(oldEmail, this.email);
        // localStorage-хранилища (заметки/реакции/правки/томбстоуны) и свой
        // профиль в kv keyed по email — ошибка миграции не должна ломать
        // смену почты.
        try {
          await this.migrateLocalStores(oldEmail, this.email);
        } catch (e) {
          console.warn('[identity] local stores migrate failed:' + e);
        }
        await this.initLocalDb(); // курсоры/томбстоуны нового аккаунта
        await this.loadContacts(); // peer_keys общие — контакты остаются
        await this.loadGroups();
          try { await this.loadChannels(); } catch (e) { /* не критично */ }
        this.startPolling();
        this.idleLoop();
        EmailsFeature.loadEmails(this.emailsDeps).catch(() => {});
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
    // ADR-003 Этап 3: логика склейки адресов — в features/contacts-load.js.
    // contactAliases при ошибке НЕ затирается (там привязка истории чата):
    // ради этого функция возвращает null, а не пустой объект.
    async loadContacts() {
      // ADR-004 J.5a: proxy на contactsStore singleton owner.
      await contactsStore.loadContacts(this.email);
      this.contacts = contactsStore.state.contacts;
      this.contactAliases = contactsStore.state.contactAliases;
    },
    // Смена почты: перенос ВСЕХ локальных данных аккаунта из старого
    // namespace в новый. Раньше здесь копировалось подмножество kv-ключей по
    // префиксу (chat-cache/unread-/accepted-/…) — терялись черновики,
    // архив/mute чатов, дедуп звонков и relay-настройки, а таблицы
    // chat_history/body_cache/tombstones/imap_cursors не трогались вовсе
    // (2+ МБ истории просто оставались под старым адресом).
    // Теперь перенос делает Rust одной транзакцией по ВСЕМ таблицам с
    // колонкой account (db_account_migrate), а email → лишь транспорт:
    // identity = fingerprint публичного ключа.
    async migrateAccountData(oldEmail, newEmail) { return Migrations.migrateAccountData(oldEmail, newEmail); },
    // Смена СВОЕЙ почты: переименовать старый адрес в группах, где мы участник
    // или создатель. Без этого groups.json остаётся со старым адресом, и после
    // смены все группы исчезают из UI (фильтр loadGroups сравнивает по email).
    // Для ПИРОВ этот путь не нужен — у них он срабатывает автоматически при
    // входящем письме (tryMigrateGroupMember → groups_rename_member).
    async migrateOwnGroups(oldEmail, newEmail) { return Migrations.migrateOwnGroups(oldEmail, newEmail); },
    // Смена СВОЕЙ почты: переносим email-ключевые localStorage-хранилища
    // (заметки/квитанции чтения/реакции/правки/томбстоуны) со старого
    // адреса на новый. Ключи писались по raw this.email — регистр не
    // гарантирован, поэтому при пустом источнике пробуем lowercase-вариант.
    // Отсутствие источника — норма (не ошибка). Каждый префикс в своём
    // try/catch: повреждённый JSON одного хранилища не блокирует остальные;
    // битый JSON источника — просто удаляем источник, цель не трогаем.
    async migrateLocalStores(oldEmail, newEmail) { return MigrateFeature.migrateLocalStores(this.migrateDeps, oldEmail, newEmail); },
    // Смена СВОЕЙ почты: копируем свой профиль {name, avatar, bio, _ts,
    // local_name} в kv-профили (namespace 'anon', ключ 'profiles', ключи
    // lowercase — см. api.js saveProfile/getProfilesAll). Старый ключ НЕ
    // удаляем: аватар может лежать под старым адресом как алиас.
    // ADR-003 Этап 3: перенос профиля — в migrations.js. Модуль возвращает
    // ключ и профиль, шапку обновляем здесь: логика и отображение слипаться не должны.
    async migrateOwnProfile(oldEmail, newEmail) {
      const r = await Migrations.migrateOwnProfile(oldEmail, newEmail);
      if (!r) return;
      if (this.profiles && typeof this.profiles === 'object') this.profiles[r.key] = r.profile;
      this.userAvatarUrl = (r.profile || {}).avatar || this.userAvatarUrl;
    },
    // Все адреса, привязанные к тому же ключу, что и email (алиасы).
    // Контакт мог сменить почту — старый и новый адреса имеют одинаковый ключ.
    // Используется в loadMessages (фильтр писем) и isOut (определение отправителя).
    // Канонический адрес: какой контакт показывается для этого ключа
    // (после дедупликации в loadContacts). Если email — алиас, возвращаем
    // показываемый адрес (самый новый по added_at).
    canonicalOf(email) { return KeysFeature.canonicalOf(this.keysDeps, email); },
    // Смена почты: переносим историю чата со старого адреса на новый.
    // Вызывается при fingerprint-матчинге у ПОЛУЧАТЕЛЯ (поллинг/loadMessages).
    // ADR-003 Этап 3: переезд истории чата — в migrations.js. Ключ чата
    // принадлежит ПИРУ, поэтому account идёт через резолвер, а пир остаётся почтой.
    // ADR-003 §5.1: перенос по цепочке алиасов. Одиночный migrateChatHistory
    // остался в модуле и вызывается изнутри цепочки — он переносит один ключ,
    // и его полезность отдельная.
    async migrateChatHistoryChain(newEmail, myEmail, contactAliases) {
      return Migrations.migrateChatHistoryChain(newEmail, myEmail, contactAliases);
    },
    // ADR-003 Этап 3: сбор и применение разнесены (features/groups-load.js).
    // Присваивания идут ПОСЛЕ сбора, и groups применяется только если invoke
    // отработал: иначе поле осталось бы прежним, как и в оригинале.
    async loadGroups() {
      const r = await GroupsLoad.loadGroups({
        email: this.email,
        fingerprint: this.fingerprint,
        aliasesOf: this.aliasesOf,
        contacts: this.contacts,
        requestGroupAvatarHeal: this.requestGroupAvatarHeal,
      });
      if (r.groups) this.groups = r.groups;
      this.groupsStore.mergeGroupKeys(r.keys || {});
      this.groupsStore.mergeGroupAvatars(r.avatars || {});
      this.groupsStore.mergeGroupIcons(r.icons);
      for (const c of r.newContacts) this.contacts.push(c);
    },
    // M2: broadcast-каналы — хранение через tauri channels.rs (channels.json).
    channelPostsToMessages(ch) { return ChannelsFeature.channelPostsToMessages(ch); },
    async selectChannel(ch) { return ChannelsFeature.selectChannel(ch, this.channelsDeps); },
    async createChannelAndClose() { return ChannelsFeature.createChannelAndClose(this.channelsDeps); },
    async joinChannelAndClose() { return ChannelsFeature.joinChannelAndClose(this.channelsDeps); },
    copyChannelLink() { return ChannelsFeature.copyChannelLink(this.channelsDeps); },
    copyChannelLinkById(id) { return ChannelsFeature.copyChannelLinkById(this.channelsDeps, id); },
    // Отправка поста владельцем (composer → post-конверт). Тело шифруется
    // broadcast-ключом канала (тот же симметричный путь, что группы).
    async sendChannelPost() { return ChannelsFeature.publishChannelPost(this.channelsDeps); },
    async deleteChannelConfirmed() { return ChannelsFeature.deleteChannelConfirmed(this.channelsDeps); },
    async loadChannels() { return ChannelsFeature.syncChannels(this.channelsDeps); },
    // Владелец переименовывает канал: локальный патч + meta-конверт
    // подписчикам (name/about летят тем же транспортом, что посты).
    async renameChannel(id) { return ChannelsFeature.renameChannel(this.channelsDeps, id); },
    // Router helpers (features/incoming.js вызывает через ctx)
    channelById(id) { return ChannelsFeature.channelById(id); },
    // Новый пост канала: сохраняем в kv-лог (аналог истории, только локально),
    // инкремент непрочитанных.
    noteChannelPost(chId, ts, payload, senderEmail) { return ChannelsFeature.noteChannelPost(chId, ts, payload, senderEmail); },
    noteChannelHello(chId, senderEmail) { return ChannelsFeature.noteChannelHello(chId, senderEmail); },
    setPeerKey(email, key, pq = null) { return KeysFeature.setPeerKey(this.keysDeps, email, key, pq); },
    setPeerKeyFromInput() { return KeysFeature.setPeerKeyFromInput(this.keysDeps); },
    async selectChat(email) {
      // Vault chat requires a peer key — without it there is nothing (and nothing
      // encrypted) to show. Contacts without keys are already hidden from the list;
      // this is a hard guard on top.
      if (!this.peerKeys[email]) {
        // Не молчим: объясняем, что нужно обменяться ключами, и сразу открываем
        // панель 🔗 (QRCodePanel) — ввод id участника или сканирование QR.
        alert(uiStore.tr('chat_no_key') || 'Нет ключа собеседника — обменяйтесь ключами: нажмите кнопку «Добавить контакт» (кнопка со значком ссылки вверху) и введите id участника или отсканируйте QR-код.');
        this.showQRCode = true;
        return;
      }
      // Сбрасываем чат сразу — иначе при медленной загрузке нового чата
      // пользователь видит сообщения предыдущего (одни и те же во всех чатах).
      this.saveDraft(); // черновик прошлого чата — до сброса activeChat
      this.chat.set([]);
      this.newMessage = '';
      this.cancelReply();
      await this.restoreDraft(email);
      // показываем кэш прошлой сессии, пока идёт
      // загрузка из IMAP. Свежие данные перезапишут кэш по завершении.
      const cachedChat = await this.loadChatCache(email);
      if (cachedChat && cachedChat.length) {
        cachedChat.sort((a, b) => this.msgTs(a) - this.msgTs(b));
        this.chat.set(cachedChat);
      }
      // Токен загрузки: незавершённый loadMessages прошлого чата увидит
      // новый seq и не применит свои результаты.
      this.loadSeq++;
      this.activeChat = email;
      this.activeChatType = 'chat';
      this.showStarredOnly = false; // избранное — режим, сбрасывается при смене чата
      this.loadStarredFor(email);
      // TTL исчезающих для 1-на-1 — из kv (как selectGroup для групп): иначе
      // currentEphemeralTtl остаётся от ПРЕДЫДУЩЕГО чата, иконка замка врёт,
      // а старый fallback применял чужой TTL к сообщениям.
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
          await EmailsFeature.loadEmails(this.emailsDeps, true);
        } catch (e) { /* Not connected — тихий фолбэк */ }
      }
      await this.loadMessages(email);
      // при открытии чата — сразу к последнему
      // сообщению (вниз).
      this.scrollToBottom(true);
    },

    // M2.4: открыть чат по ключу (email) — из ntfy-пуша (vault://open?chat=).
    async openChatByKey(key) {
      const email = String(key || '').toLowerCase();
      if (!email) return;
      try {
        await this.selectChat(email);
        if (this.isMobile) this.mobileChatOpen = true;
        this.showSettings = false;
      } catch (e) { console.warn('[notify] openChatByKey failed:', e); }
    },
    // Прокрутка списка сообщений вниз. force=true — всегда (открытие чата,
    // своя отправка); force=false — только если пользователь уже у низа
    // (поллинг не должен выдёргивать из чтения истории).
    scrollToBottom(force = false) { return ChatUiFeature.scrollToBottom(this.chatUiDeps, force); },
    // Стрелка «вниз к последним сообщениям»: показываем, когда пользователь
    // ушёл от низа чата больше чем на 200px (поллинг/свои отправки его не
    // выдёргивают — только клик по стрелке).
    onMessagesScroll() { return ChatUiFeature.onMessagesScroll(this.chatUiDeps); },
    jumpToBottom() { return ChatUiFeature.jumpToBottom(this.chatUiDeps); },
    // --- Закрепление сообщения в группе (только админ) ---
    // Хранится в sqlite kv_store (pinned:<groupId>; последнее по дате — как
    // meta-аватар) + бродкастится письмом {pin:1, msg_id, action, preview}
    // под групповым ключом (stealth, пустая тема — единый проход
    // loadGroupMessages классифицирует по содержимому).
    async readPinned(groupId) { return MsgStore.readPinned(groupId); },
    async setPinnedState(groupId, pin) { return GroupsFeature.setPinnedState(this.pinsDeps, groupId, pin); },
    async applyPinFromWire(groupId, pin) { return GroupsFeature.applyPinFromWire(this.pinsDeps, groupId, pin); },
    async pinGroupMessage(msg) { return GroupsFeature.pinGroupMessage(this.pinsDeps, msg); },
    unpinGroupMessage() { return GroupsFeature.unpinGroupMessage(this.pinsDeps); },
    scrollPinnedToView() { return GroupsFeature.scrollPinnedToView(this.pinsDeps); },
    async selectGroup(group) {
      this.saveDraft(); // черновик прошлого чата
      this.chat.set([]);
      this.newMessage = '';
      this.cancelReply();
      await this.restoreDraft('group:' + group.id);
      const cachedGroup = await this.loadChatCache(`group:${group.id}`);
      if (cachedGroup && cachedGroup.length) {
        cachedGroup.sort((a, b) => this.msgTs(a) - this.msgTs(b));
        this.chat.set(cachedGroup);
      }
      this.loadSeq++;
      this.activeChat = `group:${group.id}`;
      this.activeChatType = 'group';
      this.showStarredOnly = false; // избранное — режим, сбрасывается при смене чата
      this.loadStarredFor('group:' + group.id);
      // Ленивое заполнение fingerprint участников: старые группы без
      // fingerprint — заполняем из peer_keys при открытии (один раз; Rust
      // сохраняет). Нужно для membership по ключу при смене почты.
      this.backfillGroupFingerprints(group);
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
            this.groupsStore.setGroupKey(group.id, keyData.group_key);
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
              this.groupsStore.setGroupKey(group.id, groupKeyHex);
            }
          }
        } catch (e) {
          console.warn('Could not load group key:', e);
        }
      }

      await this.loadGroupMessages(group.id, false);
      this.scrollToBottom(true);
    },
    // --- Заметки для себя
    // notes-store.js — ЕДИНСТВЕННОЕ место, знающее про хранилище (vault-notes-<email>).
    // Методы ниже — тонкие делегаты: они зовутся шаблоном и другими местами,
    // но сами ничего не знают о формате ключа и localStorage.
    notesStoreKey() {
      return this.notes.keyFor(this.email);
    },
    loadNotes() {
      return this.notes.load(this.email);
    },
    saveNotes(list) {
      return this.notes.save(this.email, list);
    },
    selectNotes() { return NotesFeature.selectNotes(this.notesDeps); },
    // --- Перетаскивание заметок (__notes__): ручной порядок ---
    onNoteDragStart(e, msg) { return NotesFeature.onNoteDragStart(this.notesDeps, e, msg); },
    onNoteDragOver(e, msg) { return NotesFeature.onNoteDragOver(this.notesDeps, e, msg); },
    onNoteDragLeave(e, msg) { return NotesFeature.onNoteDragLeave(this.notesDeps, e, msg); },
    onNoteDrop(e, msg) { return NotesFeature.onNoteDrop(this.notesDeps, e, msg); },
    // Parse message content — detect vault_attachment JSON and extract preview
    isTextMime(type, name) { return MsgFormat.isTextMime(type, name); },
    parseMessageContent(content) { return MsgFormat.parseMessageContent(content); },
    // --- Конверт сообщения (метаданные ВНУТРИ шифра) ---
    // Формат: {"vault":1,"id":"<uuid>","text":"...","name":"...","avatar":"dataURL"}
    // Всё под E2E — провайдер видит только base64. Обратная совместимость:
    // не-JSON или vault!==1 = старый формат (простой текст).
    newMessageId() { return MsgFormat.newMessageId(); },
    // Уменьшить аватар до 64x64 JPEG, если dataURL слишком большой (чтобы не
    // раздувать каждое письмо). НИКОГДА не возвращает '' для валидного аватара:
    // если сжатие не удалось/не помогло — отправляем оригинал (письмо стерпит
    // 200KB, а вот пустой аватар = собеседник никогда не увидит картинку).
    // Обернуть текст в конверт перед шифрованием.
    async buildEnvelope(text, ttl = 0) {
      const dn = this.displayName || (await api.getDisplayName()) || '';
      // Не слать email как имя: получатель считает name==email «нет имени»
      // (см. nameOf) — иначе он перезаписывает настоящее имя почтой.
      const name = dn && dn !== this.email ? dn : '';
      // Актуальный аватар из kv — this.profiles
      // в памяти может отставать; иначе сообщение уходит со СТАРЫМ аватаром
      // и получатель перезаписывает новый.
      let avatar = (this.profiles[this.email] || {}).avatar || '';
      try {
        const kvProfiles = JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
        const kp = kvProfiles[String(this.email).toLowerCase()];
        if (kp && kp.avatar) avatar = kp.avatar;
      } catch (e) { /* ignore */ }
      const rawLen = avatar.length;
      avatar = await this.shrinkAvatar(avatar);
      // Самовосстановление аватарки группы: конверт несёт gavatar — аватар
      // ТЕКУЩЕЙ группы (групповое сообщение шлётся только в активной группе).
      // Только для группового чата (иначе gavatar отсутствует). Пустой kv —
      // пустая строка (на приёме пусто игнорируется, guard там). Конверт
      // группы шифруется групповым ключом — это не раскрытие членства.
      let gavatar = '';
      if (this.activeChatType === 'group' && this.currentGroup) {
        try { gavatar = (await db.kvGet('anon', 'group-avatar:' + this.currentGroup.id)) || ''; }
        catch (e) { gavatar = ''; }
      }
      // PQ: свой ML-KEM ek — получатель сохранит контакт и сможет
      // ответить гибридом (конверт несёт оба публичных ключа).
      const pqEk = crypto.pqEk || null;
      // M2.4 АВТООБМЕН токенами: конверт несёт мой relay read-токен —
      // адрес моей очереди. Получатель молча сохранит его и сможет
      // слать мне мгновенные пуши. Пользователь ничего не вводит.
      // Гейт this.relayEnabled СНЯТ (как в calls.js sendCallEnvelope):
      // адрес нашей очереди нужен собеседнику независимо от нашего
      // переключателя — иначе выключенный релей у одного ломает обмен.
      let tok = null;
      try {
        const { relays, active } = await (await import('./relay-client.js')).getSettings(this.email);
        tok = ((relays[active] || relays[0]) || {}).myToken || null;
      } catch (e) { /* релей опционален */ }
      // ФОРМАТ КОНВЕРТА — В RUST (ADR-005 W4): какие поля входят и при каких
      // условиях, решает ядро (vault_client::vault::envelope). Здесь — только
      // данные. Пока сборка жила здесь, а разбор — в Rust (incoming::classify),
      // формат был описан в двух местах, и правка одной стороны ломала другую.
      // ttl — в секундах от момента ПРОСМОТРА получателем (0 = обычное
      // сообщение, получатель не ставит таймер удаления).
      const envelope = await EnvelopeRule.buildEnvelope({
        id: this.newMessageId(),
        text,
        name,
        avatar,
        gavatar: gavatar || null,
        key: crypto.publicKey || '',
        pqEk,
        tok,
        ttlSecs: Number(ttl) || 0,
        tsMs: Date.now(),
      });
      // Мост недоступен → конверта нет. Отправлять «null» нельзя: получатель
      // не разберёт и письмо исчезнет у обоих молча. Явная ошибка — её поймает
      // вызывающий и покажет тост.
      if (!envelope) throw new Error('envelope: Rust-сборка конверта недоступна');
      return envelope;
    },
    // Распарсить расшифрованный конверт. null = старый формат (простой текст).
    async parseEnvelope(decrypted) { return MsgFormat.parseEnvelope(decrypted); },
    // ── Гео-сообщение ──────────────────────────────────────────────
    // Текущая точка → текст с OSM-ссылкой (кликабельна у всех
    // получателей через linkify; никакой специфики конверта не нужно).
    // ADR-003 Этап 3, партия 13: получение координат и сборка текста — в geo.js.
    // Там же таймаут с защитой от двойного разрешения: без него поздний ответ
    // геолокации записал бы поле ввода ПОСЛЕ того, как показано «недоступна».
    async sendGeoMessage() {
      const coords = await Geo.resolveCurrentCoords();
      if (!coords) {
        uiStore.toast(uiStore.tr('geo_err') || 'Геолокация недоступна', 3000);
        return;
      }
      this.newMessage = Geo.buildGeoMessage(uiStore.tr('geo_im_here') || 'Я здесь:', coords);
      this.$nextTick(() => this.$refs.messageInput && this.$refs.messageInput.focus());
    },
    // ── Пересылка (forward) ────────────────────────────────────────
    // Переслать: пере-шифровка текста для выбранного чата с пометкой.
    // (логика в features/forward.js; обёртки см. в блоке poll-обёрток выше)
    // Split a message into its reply-quote portion (leading "> " lines) and body.
    splitReply(content) { return MsgFormat.splitReply(content); },
    hasReplyQuote(content) { return MsgFormat.hasReplyQuote(content); },
    replyQuote(content) { return MsgFormat.replyQuote(content); },
    replyBody(content) { return MsgFormat.replyBody(content); },
    // Short excerpt used for the reply bar and for the "> " quote prefix.
    replyPreview(msg) {
      return MsgFormat.replyPreview(msg && (msg.content || msg.text) || '');
    },
    // Подпись (tooltip) к цветному кружку статуса исходящего сообщения.
    statusTitle(msg) {
      return MsgFormat.statusTitle(msg, (k) => uiStore.tr(k));
    },
    setReply(msg) { return uiStore.setFormField('replyTo', msg); },
    cancelReply() { return uiStore.setFormField('replyTo', null); },
    // --- Редактирование/удаление сообщений (только свои) ---
    startEditMessage(msg) { return EditsFeature.startEditMessage(this.editsDeps, msg); },
    cancelEdit() { return EditsFeature.cancelEdit(this.editsDeps); },
    async deleteMessage(msg) { return EditsFeature.deleteMessage(this.editsDeps, msg); },
    // «Удалить у меня»: убрать сообщение ТОЛЬКО со своего
    // устройства — свои и ЧУЖИЕ сообщения, а также пилюли звонков. У
    // собеседника остаётся. Механизм тот же tombstone (msg.id + Message-ID),
    // что у «удалить у всех»/ephemeral: mergeHistory/mergePending/поллинг
    // отфильтруют его навсегда, воскрешение из письма/All Mail невозможно.
    // Никаких писем не отправляется.
    async deleteMessageForMe(msg) { return EditsFeature.deleteMessageForMe(this.editsDeps, msg); },
    // ── Избранное ────────────────────────────────
    // Пометка сообщений только локально (как «Удалить у меня»): собеседнику
    // не видно, по почте не синхронизируется. Персист в sqlite kv_store под
    // ключом 'starred:<chatKey>' — переживает перезапуск и рескан из писем,
    // т.к. фильтр идёт по msg.id при рендере (звёздочка + режим избранного).
    isStarred(msg) { return StarsFeature.isStarred(this.starsDeps, msg); },
    async toggleStar(msg) { return StarsFeature.toggleStar(this.starsDeps, msg); },
    async loadStarredFor(chatKey) { return StarsFeature.loadStarredFor(this.starsDeps, chatKey); },
    // ── Сообщения 1:1 (логика в features/messages.js) — тонкий делегат ──
    // ADR-005 W2 партия 3: вызов идёт через делегатор this.loadMessages(email)
    // (контракт модуля собирается там, модуль компонент не читает).
    // Полный рескан группы: письма, «застрявшие за курсором» из-за
    // разового сбоя (session desync / DNS / троттлинг), инкрементальный фетч
    // больше не вернёт. Кнопка в шапке группы делает полный IMAP-скан папок
    // (INBOX+Junk) и восстанавливает пропущенные сообщения.
    async refreshGroupFull() {
      if (!this.currentGroup) return;
      await this.loadGroupMessages(this.currentGroup.id, true);
      this.scrollToBottom(false);
    },
    // ── Групповые сообщения (логика в features/groups.js) — тонкий делегат ──
    // ADR-005 W2 партия 5: контракт модуля собирается здесь и ЖИВЬЁМ на
    // каждый вызов — модуль компонент не читает. Состояние — у владельцев
    // (chat/sending/groups — per-app экземпляры; activeChat и emails — у
    // chatStore/mailboxState), эффекты — явный список.
    async loadGroupMessages(groupId, forceRescan = false) {
      return GroupsFeature.loadGroupMessages({
        chat: this.chat,
        sending: this.sendingStore,
        groups: this.groupsStore,
        getLoadSeq: () => this.loadSeq,
        cryptoReady: this.cryptoReady,
        readPinned: (id) => this.readPinned(id),
        // Без точек с запятой внутри: тело делегата должно остаться ОДНИМ
        // return-выражением, иначе ратчет «методов с логикой в App.vue» считает
        // делегат логикой.
        setPinned: (msgId, preview) => Object.assign(this, { pinnedMsgId: msgId, pinnedPreview: preview }),
        showHistoryFirst: (chatKey, stale) => this.showHistoryFirst(chatKey, stale),
        isOwnSender: (id) => this.isOwnSender(id),
        isIgnored: (e) => this.isIgnored(e),
        applyPinFromWire: (id, wire) => this.applyPinFromWire(id, wire),
        replyGroupAvatarHeal: (id) => this.replyGroupAvatarHeal(id),
        healGroupAvatarFromMessage: (id, av) => this.healGroupAvatarFromMessage(id, av),
        parsePollEnvelope: (env) => this.parsePollEnvelope(env),
        loadProfiles: () => this.loadProfiles(),
        mergeHistory: (chatKey, list) => this.mergeHistory(chatKey, list),
        mergePending: (chatKey, list) => this.mergePending(chatKey, list),
        filterDeleted: (list) => this.filterDeleted(list),
        applyReactions: (list, chatKey, wire) => this.applyReactions(list, chatKey, wire),
        applyEdits: (list, chatKey, wire) => this.applyEdits(list, chatKey, wire),
        applyPollVotes: (list, wire) => this.applyPollVotes(list, wire),
        scheduleEphemeral: (m, chatKey) => this.scheduleEphemeral(m, chatKey),
        saveChatCache: (chatKey, list) => this.saveChatCache(chatKey, list),
        saveCurrentHistory: (chatKey) => this.saveCurrentHistory(chatKey),
        sendReadReceipts: (ids) => this.sendReadReceipts(ids),
        noteSeen: (e, ts) => this.noteSeen(e, ts),
      }, groupId, forceRescan);
    },
    // Мета-письма групп (VaultGroupMeta: <id>, аватар от админа) — для ВСЕХ
    // групп, где мы участники, а не только для открытой. Вызывается из
    // loadEmails (поллинг): участник, не открывавший группу после смены
    // аватара, всё равно получает его (sidebar + шапка при следующем
    // Список писем НЕ фетчим заново: берём уже загруженный this.emails
    // (loadEmails вызвал fetchEmails выше) — только тела новых meta-писем
    // подтягиваются по одному. Применённый uid кэшируем в localStorage,
    // чтобы не перечитывать одно и то же письмо на каждом поллинге.
    // ── Meta-сканирование групп (логика в features/group-meta.js) ──
    async syncGroupAvatarsFromMeta() { return GroupMetaFeature.syncGroupAvatarsFromMeta(this.groupMetaDeps); },
    // Тонкие прокси во владельца группового состояния (ADR-004 Этап A9).
    // features/* вызывают ctx.setGroupKey — адресуем во владельца.
    setGroupKey(id, key) { return this.groupsStore.setGroupKey(id, key); },
    setGroupAvatar(id, avatar) { return this.groupsStore.setGroupAvatar(id, avatar); },
    clearGroupKeys() { return this.groupsStore.clearGroupKeys(); },
    clearGroupAvatars() { return this.groupsStore.clearGroupAvatars(); },
    // Тонкие прокси во владельца состояния отправки (ADR-004 Этап A10).
    // features/* вызывают ctx.setSending/ctx.setPendingOutgoing — адресуем во владельца.
    setSending(val) { return this.sendingStore.setSending(val); },
    setPendingOutgoing(chatId, msg) { return this.sendingStore.setPendingOutgoing(chatId, msg); },
    getPendingOutgoingBucket(chatId) { return this.sendingStore.getBucket(chatId); },
    mergePendingOutgoing(chatId, partial) { return this.sendingStore.mergePendingOutgoing(chatId, partial); },
    removePendingOutgoing(chatId, msgId) { return this.sendingStore.removePendingOutgoing(chatId, msgId); },
    clearPendingOutgoing() { return this.sendingStore.clearPendingOutgoing(); },
    dropBucket(chatId) { return this.sendingStore.dropBucket(chatId); },
    // Тонкие прокси во владельца сессии (ADR-004 Этап A12).
    // features/* вызывают ctx.logout/setEmails — адресуем во владельца.
    //
    // ПРОКСИ login() УДАЛЁН СОЗНАТЕЛЬНО: он перебивал полный вход
    // (`async login()` выше). Options API — обычный литерал объекта: при двух
    // ключах с одним именем поздний выигрывает, ранний молча исчезает.
    // Итог был такой: кнопка «Войти» только переключала флаг isLoggedIn, к
    // IMAP не подключались ВООБЩЕ (проверено пробой на живой сборке: calls: []
    // после submit формы). Теперь login() — единственный, полный. Фичам, кому
    // был нужен флаг сессии, дано отдельное имя: markLoggedIn.
    logout() { return this.sessionStore.logout(); },
    setEmails(list) { return this.mailboxStore.setEmails(list); },
    clearEmails() { return this.mailboxStore.clearEmails(); },
    emailCount() { return this.mailboxStore.emailCount(); },
    // Тонкие прокси во владельца relay-состояния (ADR-004 Этап A13).
    enableEco(on) { return this.relayStore.enableEco(on); },
    isEcoMode() { return this.relayStore.isEcoMode(); },
    enableRelay(on) { return this.relayStore.enableRelay(on); },
    isRelayEnabled() { return this.relayStore.isRelayEnabled(); },
    setRelayMode(mode) { return this.relayStore.setRelayMode(mode); },
    deliveryMode() { return this.relayStore.deliveryMode(); },
    // Прокси черновику composer (ADR-004 Этап A14). features/* читают proxy
    // this.newMessage; writers — через ctx.setDraft/clearDraft.
    setDraft(text) { return this.chat.setDraft(text); },
    getDraft() { return this.chat.getDraft(); },
    clearDraft() { return this.chat.clearDraft(); },
    // Тонкие прокси во владельца непрочитанных (ADR-004 Этап A11).
    // unreadOf уже определён ниже (читает через this.unreadCounts proxy).
    incUnread(chatKey) { return this.chat.incUnread(chatKey); },
    clearUnread(chatKey) { return this.chat.clearUnread(chatKey); },
    clearAllUnread() { return this.chat.clearAllUnread(); },
    setUnread(map) { return this.chat.setUnread(map); },
    async onAvatarUpdate(dataUrl) { return ProfilesFeature.onAvatarUpdate(this.profileDeps, dataUrl); },
    async onNameUpdate(name) { return ProfilesFeature.onNameUpdate(this.profileDeps, name); },
    // Профиль (имя/аватар) всем контактам с ключом: stealth-письмо
    // {vault:1, type:'profile', name, avatar}. Получатель сохраняет профиль
    // и не рендерит как сообщение (см. processIncoming).
    // Выбор аватара в диалоге «Новая группа»: центр-кроп 128×128 JPEG
    // (те же параметры, что у аватара группы в GroupSettings).
    // ADR-003 Этап 3, партия 12: обрезка и кодирование — в avatar-image.js.
    // Пресет GROUP_AVATAR общий с GroupSettings.vue, и это не украшение:
    // черновик обязан совпадать с тем, что сохранится. Пока копии были
    // написаны вручную, совпадение держалось на удачу.
    async onNewGroupAvatarSelected(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (AvatarImage.avatarTooBig(file.size)) {
        alert(uiStore.tr('err_file_too_big_500'));
        e.target.value = '';
        return;
      }
      e.target.value = '';
      try {
        this.newGroupAvatar = await AvatarImage.fileToAvatarDataUrl(
          file, AvatarImage.GROUP_AVATAR);
      } catch (err) {
        // Раньше обработчиков отказа не было вовсе: битый файл оставлял
        // промес навечно, и сообщения об этом не было нигде.
        console.warn('[avatar] draft image failed:', err && err.message || err);
        alert(uiStore.tr('err_image_decode') || 'Не удалось прочитать изображение');
      }
    },
    // Файл резервной копии выбран — держим его в памяти до нажатия «Восстановить».
    async onRecoveryFilePicked(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this.recoveryFileJson = await file.text();
      this.recoveryFileName = file.name;
    },
    // Восстановление: логин обязателен (доступ к ящику для эскроу-письма),
    // слова — обязательны; файл — опционален.
    // Изоляция фичи (t_7c3929d2) + устойчивость (fix/recovery-resilience):
    // вся логика в RecoveryFeature.loginWithRecovery — тут только делегат.
    // Там: маркер прерванности ДО логина, логин без durable-персиста, импорт
    // файла/эскроу (без фолбэка), ПЕРЕзагрузка ключа без генерации, durable
    // commit и снятие маркера последним.
    async loginWithRecovery() {
      return RecoveryFeature.loginWithRecovery(this.recoveryLoginDeps);
    },
    // --- Качество медиа: 'high' (по умолч.) / 'low' / 'original'
    async mediaQuality() { return MsgStore.mediaQuality(); },
    // Центр-масштаб до maxSide по большей стороне, JPEG q. Возвращает dataURL.
    async onExperimentsCalls(on) {
      this.expCalls = !!on;
      try { await db.kvSet('anon', 'exp-calls', on ? '1' : '0'); } catch (e) {}
    },
    // M2.4: тумблер релея в настройках — живое обновление кэша
    // (гейты автообмена токенами env.tok смотрят на this.relayEnabled).
    // --- Исчезающие сообщения
    // TTL хранится per-chat в kv_store ('ephemeral:<chatId>'), уходит в
    // конверте (env.ttl, секунды). У получателя таймер стартует при ПОКАЗЕ
    // сообщения; у отправителя — сразу после отправки.
    ephemeralLabel(sec) { return EphemeralFeature.ephemeralLabel(this.ephemeralDeps, sec); },
    async applyEphemeral(seconds) { return EphemeralFeature.applyEphemeral(this.ephemeralDeps, seconds); },
    async ephemeralTtlOf(chatId) { return MsgStore.ephemeralTtlOf(chatId); },
    async setEphemeralTtl(chatId, seconds) { return EphemeralFeature.setEphemeralTtl(this.ephemeralDeps, chatId, seconds); },
    scheduleEphemeral(msg, chatId) { return EphemeralFeature.scheduleEphemeral(this.ephemeralDeps, msg, chatId); },
    expireEphemeral(chatId, msgId, mid) { return EphemeralFeature.expireEphemeral(this.ephemeralDeps, chatId, msgId, mid); },

    // --- Key Recovery
    // Минимальный тост: сообщение внизу, автоскрытие (по умолчанию 5с).
    // ── Duress-замок ────────────────────────────────────────
    // (логика в features/duress.js; обёртки см. в блоке feature-обёрток выше)
    //
    // Тело живёт в uiStore (регистрация в setup) — здесь только делегат.
    // БЫЛО: `this.uiStore.setToastMessage(...)`, но `uiStore` — модульный
    // синглтон, на инстансе его нет (`this.uiStore === undefined`) →
    // `TypeError: Cannot read properties of undefined (reading 'setToastMessage')`
    // при каждом вызове. Нашлось на живой приёмке 19.10 (t_e66389bd).
    showToast(message, ms = 5000) {
      uiStore.toast(message, ms);
    },
    // Отправка эскроу-письма СЕБЕ после создания ключа восстановления.
    async onRecoveryCreated({ mnemonic }) {
      console.log('[recovery] onRecoveryCreated, words len =', mnemonic ? mnemonic.split(/\s+/).length : 0);
      try {
        // Отправка и проверка результата — в features/recovery-escrow.js
        // (ADR-003 Этап 3, партия 15). Ключ ТОСТА ТАМ ЖЕ БЫЛ ЗАВЕДЁН НО НЕ
        // ЧИТАЛСЯ: русский текст был продублирован прямо здесь, и англоязычные
        // с китайскими получали по-русски самое важное предупреждение
        // приложения — про то, что через месяц ключ удалят вместе со спамом.
        const r = await RecoveryEscrow.sendEscrowEmail(this.email, mnemonic, 'recovery_spam_toast');
        // Провайдеры кладут служебные письма в Спам, а Gmail удаляет спам
        // через ~30 дней — тогда эскроу пропадёт.
        uiStore.toast(uiStore.tr(r.spamToastKey), 10000);
        // Фоново определяем фактическую папку письма и предупреждаем точечно.
        this.locateEscrow(r.wrappedJson);
      } catch (e) {
        console.error('escrow send failed:', e);
        uiStore.toast((uiStore.tr('recovery_escrow_failed') || 'Не удалось отправить эскроу-письмо: ') + (e.message || e));
      }
    },
    // Ищем только что отправленное эскроу-письмо (совпадение salt+nonce+wrapped)
    // и сообщаем, где оно лежит.
    async locateEscrow(wrappedJson, attempt = 0) {
      return RecoveryEscrow.locateEscrowFlow(this.recoveryEscrowDeps, wrappedJson, attempt);
    },
    // Поиск эскроу-письма в последних письмах + восстановление по словам.
    // Вызывается ПОСЛЕ логина ДО initCrypto() — иначе создастся новая пара.
    // Логика вынесена в features/recovery.js (изоляция фичи, ctx-паттерн):
    // parse/unwrap кандидата устойчивы к чужим/битым письмам, import_backup
    // бросается наружу. App.vue — только тонкий делегат.
    async recoverFromEscrow(mnemonic) {
      return RecoveryFeature.recoverFromEscrow(this.email, mnemonic, { api, crypto, invoke });
    },

    // Аватар группы обновил админ (GroupSettings): сохраняем локально и
    // рассылаем участникам meta-письмо (шифр групповым ключом) — как реакции.
    // Переименование группы: создатель/админ меняет имя. Обновляем
    // локально + рассылаем meta-письмо {meta:1, name} участникам — они
    // применяют при syncGroupMeta (как аватар).
    async onGroupRename(payload) {
      return GroupMetaBroadcast.renameGroupFlow(this.groupDeps, payload);
    },
    async onGroupAvatarUpdate({ groupId, avatar }) {
      this.groupsStore.setGroupAvatar(groupId, avatar);
      await db.kvSet('anon', 'group-avatar:' + groupId, avatar || '');
      if (!avatar) return;
      // Ключ группы мог быть ещё не загружен (настройки открыты без чата) —
      // тогда `if (!groupKey) return` выше МОЛЧА пропускал рассылку и у
      // участников аватар не появлялся никогда. Догружаем ключ (как в
      // selectGroup) и шлём meta-письма в любом случае.
      // Правило догрузки ключа — в features/group-meta-broadcast.js (ADR-003
      // Этап 3, партия 11): оно было продублировано здесь и в onGroupRename, и
      // именно из-за копии в переименовании баг дожил.
      const r = await GroupMetaBroadcast.broadcastGroupMeta(groupId, { avatar },
        { groupKeys: this.groupKeys, cryptoReady: this.cryptoReady });
      if (!r.sent) {
        console.error('Failed to broadcast group avatar:', r.error || r.reason);
      }
    },
    // ── Heal аватарки группы — ВСЯ логика в features/group-avatars.js ──────
    // (изоляция фичи, правило t_7c3929d2: новые фичи не размазывать по
    // App.vue — здесь только обёртки-делегаты, зависимости через this=ctx).
    async healGroupAvatarFromMessage(groupId, gavatar) {
      return GroupAvatarsFeature.healFromMessage(this.groupAvatarsDeps, groupId, gavatar);
    },
    async replyGroupAvatarHeal(groupId) {
      return GroupAvatarsFeature.replyHeal(this.groupAvatarsDeps, groupId);
    },
    async requestGroupAvatarHeal(groupId) {
      return GroupAvatarsFeature.requestHeal(this.groupAvatarsDeps, groupId);
    },
    onAvatarFileSelect(e) { return ProfilesFeature.onAvatarFileSelect(this.profileDeps, e); },
    // ── Отправка 1:1 (логика в features/send.js) — тонкий делегат ──
    // W2 партия 3 (ADR-005 R3): контракт `loadMessages` собирается здесь и
    // ЖИВЬЁМ на каждый вызов — модуль не читает компонент. Состояние чата,
    // почты, ключей и алиасов он берёт у владельцев сам; в контракте остаётся
    // только per-app владелец `chat`/`sending`, токен загрузки (`loadSeq`
    // читается внутри stale()), и эффекты соседних доменов.
    // Без `;` внутри литерала: тело — одно выражение (ратчет App.vue).
    async loadMessages(email) {
      return MessagesFeature.loadMessages({
        chat: this.chat,
        sending: this.sendingStore,
        getLoadSeq: () => this.loadSeq,
        cryptoReady: this.cryptoReady,
        profiles: () => this.profiles,
        isOwnSender: (id) => this.isOwnSender(id),
        isIgnored: (e) => this.isIgnored(e),
        aliasesOf: (e) => this.aliasesOf(e),
        setPeerKey: (e, k, pq) => this.setPeerKey(e, k, pq),
        scheduleEphemeral: (m, c) => this.scheduleEphemeral(m, c),
        showHistoryFirst: (chatKey, stale) => this.showHistoryFirst(chatKey, stale),
        sendReadReceipts: (ids) => this.sendReadReceipts(ids),
        saveCurrentHistory: (chatKey) => this.saveCurrentHistory(chatKey),
        saveChatCache: (chatKey, list) => this.saveChatCache(chatKey, list),
        cacheBody: (k, b) => this.cacheBody(k, b),
        mergeHistory: (chatKey, list) => this.mergeHistory(chatKey, list),
        mergePending: (chatKey, list) => this.mergePending(chatKey, list),
        filterDeleted: (list) => this.filterDeleted(list),
        loadProfiles: () => this.loadProfiles(),
        parsePollEnvelope: (env) => this.parsePollEnvelope(env),
        parseCallSignal: (text) => this.parseCallSignal(text),
        noteSeen: (e, ts) => this.noteSeen(e, ts),
        migratePeerGroups: (a, b) => this.migratePeerGroups(a, b),
        migrateChatHistoryChain: (a, b, c) => this.migrateChatHistoryChain(a, b, c),
        applyReactions: (list, chatKey, wire) => this.applyReactions(list, chatKey, wire),
        applyEdits: (list, chatKey, wire) => this.applyEdits(list, chatKey, wire),
        applyPollVotes: (list, wire) => this.applyPollVotes(list, wire),
        isOutboundLetter: ContactsFeature.isOutboundLetter,
        resolvePeerSender: ContactsFeature.resolvePeerSender,
        resolveEventSender: ContactsFeature.resolveEventSender,
        findKnownPeerByKey: ContactsFeature.findKnownPeerByKey,
      }, email);
    },
    // W2 партия 2 (ADR-005 R3): модуль не читает компонент. В контракте —
    // только то, чем владеет компонент: анти-дубль последней отправки и
    // watchdog (get/set: они читаются И пишутся), UI-режим composer'а
    // (editingMessage/replyTo), sending-store (владелец pendingOutgoing),
    // сборка конверта (протокол, W4) и эффекты других доменов.
    // Без `;` внутри литерала: тело делегата остаётся одним выражением
    // (ратчет App.vue), т.е. ни одной ветки здесь нет.
    async sendMessage() {
      return SendFeature.sendMessage({
        resolveChatKey: ChatFeature.resolveChatKey,
        isRecentDuplicate: ChatFeature.isRecentDuplicate,
        buildReplyPayload: ChatFeature.buildReplyPayload,
        buildNoteMessage: ChatFeature.buildNoteMessage,
        buildSendingMessage: ChatFeature.buildSendingMessage,
        isPeerEncrypted: ContactsFeature.isPeerEncrypted,
        encryptPeerVaultEnvelope: AttachmentsFeature.encryptPeerVaultEnvelope,
        sending: this.sendingStore,
        notes: this.notes,
        chat: this.chat,
        groupKeys: this.groupKeys,
        setGroupKey: (id, k) => this.setGroupKey(id, k),
        cryptoReady: this.cryptoReady,
        getLastSend: () => this.lastSend,
        setLastSend: (v) => (this.lastSend = v),
        getWatchdog: () => this._sendingWatchdog,
        setWatchdog: (t) => (this._sendingWatchdog = t),
        editingMessage: this.editingMessage,
        replyTo: this.replyTo,
        cancelEdit: () => this.cancelEdit(),
        cancelReply: () => this.cancelReply(),
        saveDraft: () => this.saveDraft(),
        isIgnored: (e) => this.isIgnored(e),
        buildEnvelope: (text, ttl) => this.buildEnvelope(text, ttl),
        markPending: (k, m) => this.markPending(k, m),
        saveCurrentHistory: (k) => this.saveCurrentHistory(k),
        recordLocalEdit: (k, id, t, a) => this.recordLocalEdit(k, id, t, a),
        sendEditEmail: (id, t, a) => this.sendEditEmail(id, t, a),
        scheduleEphemeral: (m, c) => this.scheduleEphemeral(m, c),
        sendChannelPost: () => this.sendChannelPost(),
      });
    },
    searchMessages() { return ChatUiFeature.searchMessages(this.chatUiDeps); },
    async onKeysChanged() { return KeysFeature.onKeysChanged(this.keysDeps); },
    async addPeerKey(payload) { return KeysFeature.addPeerKey(this.keysDeps, payload); },
    // Per-folder UID-курсоры для инкрементального фетча. Хранятся в sqlite
    // (initLocalDb загружает их в cursorsCache при входе) — localStorage
    imapCursorsKey(accountId) { return MsgFormat.imapCursorsKey(accountId); },
    loadCursors(accountId) { return LocalStoreFeature.loadCursors(this.localStoreDeps, accountId); },
    saveCursors(accountId, cursors) { return LocalStoreFeature.saveCursors(this.localStoreDeps, accountId, cursors); },
    // ── Загрузка писем (логика в features/emails.js) — тонкий делегат. ──
    // ADR-001 Etap 2: call-site direct -> EmailsFeature.loadEmails(this, silent). Delegate removed.
    // ── Непрочитанные + PUSH-уведомления ─────────
    // processIncoming классифицирует КАЖДЫЙ fetched-батч (поллинг или вход):
    // расшифровывает тела, отличает настоящие сообщения от квитанций/
    // инвайтов/meta, ведёт счётчики непрочитанных и
    // (при notify=true) шлёт системные уведомления. Контент НЕ показываем
    // (зашифровано + zero-metadata) — только имя отправителя/группы.
    // С W1 тип письма определяет Rust (vault_classify_incoming), здесь —
    // расшифровка ключами и эффекты (features/incoming.js).
    //
    // ИДЕМПОТЕНТНОСТЬ: каждое письмо учитывается ровно ОДИН раз
    // processedUnreadIds (персист в kv 'unread-seen') хранит uid|folder уже
    // обработанных сообщений. Без этого любой повторный фетч (сбой IMAP,
    // сброс/коллизия курсоров, полный скан после перезапуска) инкрементил
    // счётчик снова — бейдж рос 1→2→3 и возвращался после открытия чата.
    // Быстрый фетч для звонков: отдельный IMAP-клиент в Rust — не
    // конкурирует за lock основного клиента. Используется ИЗ IDLE-цикла:
    // входящий call_request доходит, даже когда обычный поллинг пропускается
    // из-за занятого lock (троттлинг Gmail / долгие UI-фетчи).
    // Входящие конверты (router) — логика в features/incoming.js; Этап 4
    // декомпозиции. Один драйвер на все 4 вызова (монитор/поллинг/fast/relay).
    // Входящие (W1, ADR-005 R3): контракт зависимостей собирается здесь —
    // модуль больше не читает компонент как ctx (см. features/incoming.js).
    // Методы обёрнуты стрелками: `deps.h = this.handleCallSignal` потерял бы
    // `this` при вызове. channels/groups — геттеры: ренейм адреса по ходу батча
    // вызывает loadGroups, который ПЕРЕПРИСВАИВАЕТ массив (снимок устарел бы).
    // Держим один вызов без промежуточной переменной: тело делегата не должно
    // обрастать собственной логикой (ратчет js-logic).
    async processIncoming(fetched, opts) {
      return IncomingFeature.processIncoming({
        cryptoReady: this.cryptoReady,
        email: this.email,
        peerKeys: this.peerKeys,
        peerPqKeys: this.peerPqKeys || {},
        emailBodyCache: this.emailBodyCache,
        processedUnreadIds: this.processedUnreadIds,
        profiles: this.profiles,
        contactAliases: this.contactAliases,
        groupKeys: this.groupKeys,
        channels: () => this.channels,
        groups: () => this.groups,
        senderEmail: (raw) => this.senderEmail(raw),
        cacheBody: (k, v) => this.cacheBody(k, v),
        isIgnored: (from) => this.isIgnored(from),
        noteSeen: (email, ts) => this.noteSeen(email, ts),
        onMailBounce: (r, why) => this.onMailBounce(r, why),
        handleCallSignal: (sig, from) => this.handleCallSignal(sig, from),
        canonicalOf: (x) => this.canonicalOf(x),
        parseEnvelope: (plain) => this.parseEnvelope(plain),
        localProfileOf: (x) => this.localProfileOf(x),
        nameOf: (x) => this.nameOf(x),
        setPeerKey: (e, k, pq) => this.setPeerKey(e, k, pq),
        migratePeerGroups: (a, b) => this.migratePeerGroups(a, b),
        migrateChatHistoryChain: (a, b, c) => this.migrateChatHistoryChain(a, b, c),
        tryMigrateGroupMember: (g, from) => this.tryMigrateGroupMember(g, from),
        setGroupKey: (id, k) => this.setGroupKey(id, k),
        replyGroupAvatarHeal: (id) => this.replyGroupAvatarHeal(id),
        healGroupAvatarFromMessage: (id, av) => this.healGroupAvatarFromMessage(id, av),
        saveUnreadSeen: () => this.saveUnreadSeen(),
        saveUnreadCounts: () => this.saveUnreadCounts(),
        chatVisible: (k) => this.chatVisible(k),
        isMuted: (k) => this.isMuted(k),
        incUnread: (k) => this.incUnread(k),
        ingestChannelEnvelope: (obj, from) => ChannelsFeature.ingestChannelEnvelope(this.channelsDeps, obj, from),
        isBounceMessage: BounceFeature.isBounceMessage,
        bounceRecipients: BounceFeature.bounceRecipients,
        bounceReason: BounceFeature.bounceReason,
      }, fetched, opts);
    },
    // Виден ли чат сейчас: на mobile чат скрыт, когда пользователь на списке
    // контактов (mobileChatOpen=false), хотя activeChat ещё хранит прошлый чат.
    chatVisible(chatKey) { return ChatUiFeature.chatVisible(this.chatUiDeps, chatKey); },
    unreadOf(chatKey) {
      return this.chat.unreadOf(chatKey);
    },
    async loadUnreadCounts() { return UnreadFeature.loadUnreadCounts(this.unreadDeps); },
    async saveUnreadSeen() { return UnreadFeature.saveUnreadSeen(this.unreadDeps); },
    async saveUnreadCounts() { return UnreadFeature.saveUnreadCounts(this.unreadDeps); },
    async resetUnread(chatKey) { return UnreadFeature.resetUnread(this.unreadDeps, chatKey); },
    // архив + mute per-chat ─────────────────────
    // (загрузка/сохранение kv-блобов и папки — features/folders.js;
    //  обёртки см. в блоке feature-обёрток выше)
    isMuted(key) { return UnreadFeature.isMuted(key); },
    // автоочистка («удалять сообщения с устройства», модель DC) ──
    // Период хранит SettingsPage (kv 'autoclean-period'); здесь — запуск:
    // 1) SQL-purge конвертов/тел/чат-кэшей старше cutoff (db_autoclean_purge);
    // 2) синхронизация памяти: this.emails и emailBodyCache без старых;
    // 3) повтор при каждом входе (mounted) — не только по клику в настройках.
    // ADR-003 Этап 3, партия 13: правила отсечения и чистка зеркал — в
    // features/autoclean.js. Там же три опасных места, размазанных раньше по
    // этому методу: даты в RFC 2822 считаются в JS, письма без даты не трогаются,
    // а письма без идентификатора исключаются — ключ 'INBOX:' в purge удалил бы
    // по префиксу больше, чем задумано.
    async runAutoclean(period) {
      return Autoclean.runAutocleanFlow(this.autocleanDeps, period);
    },
    openChatMenu(target, e) { return ChatUiFeature.openChatMenu(this.chatUiDeps, target, e); },
    closeChatMenu() { return ChatUiFeature.closeChatMenu(this.chatUiDeps); },
    async toggleArchive() {
      const key = this.flagKey(this.chatMenu.target);
      const f = { ...foldersStore.flagOf(key) };
      f.archived = !f.archived;
      foldersStore.setFlag(key, f);
      this.closeChatMenu();
      await this.saveChatFlags();
    },
    async toggleMute() {
      const key = this.flagKey(this.chatMenu.target);
      const f = { ...foldersStore.flagOf(key) };
      f.muted = !f.muted;
      foldersStore.setFlag(key, f);
      this.closeChatMenu();
      await this.saveChatFlags();
    },
    // Ignore-лист из chat-меню (1:1-чат): блокировка E2E-честная — скрывает
    // новые сообщения/звонки у получателя, серверу невидим. После разблока
    // прошлое НЕ возвращается (его не было в истории).
    async toggleIgnoreContact() { return BlockUserFeature.toggleIgnoreContact(this.blockUserDeps); },
    // Разблок из баннера открытого чата: новые сообщения снова показываются.
    async unblockActiveChat() { return BlockUserFeature.unblockActiveChat(this.blockUserDeps); },
    // Ignore из меню сообщения: 1:1 — адрес чата, группа — sender_id автора
    // (msgSenderEmail). Тост объясняет, что именно произошло.
    async blockSenderOfMessage(msg) { return BlockUserFeature.blockSenderOfMessage(this.blockUserDeps, msg); },
    // (логика в features/folders.js; обёртки см. в блоке feature-обёрток выше)
    // Emoji
    insertEmoji(emoji) {
      this.newMessage += emoji
      this.showEmojiPicker = false
    },
    // ── Аудио/файлы-вложения (логика в features/attachments.js) ──
    async sendAudioMessage(audioData) { return AttachmentsFeature.sendAudioMessage({ resolveChatKey: ChatFeature.resolveChatKey, notes: this.notes, chat: this.chat, groupKeys: this.groupKeys, cryptoReady: this.cryptoReady, buildEnvelope: (p) => this.buildEnvelope(p), markPending: (k, m) => this.markPending(k, m), saveCurrentHistory: (k) => this.saveCurrentHistory(k), hideAudioRecorder: () => (this.showAudioRecorder = false) }, audioData); },
    async handleFileSelect(event) { return AttachmentsFeature.handleFileSelect({ resolveChatKey: ChatFeature.resolveChatKey, notes: this.notes, chat: this.chat, groupKeys: this.groupKeys, cryptoReady: this.cryptoReady, buildEnvelope: (p) => this.buildEnvelope(p), markPending: (k, m) => this.markPending(k, m), saveCurrentHistory: (k) => this.saveCurrentHistory(k), compressImage: (d, s, q) => this.compressImage(d, s, q) }, event); },
    // Мерж сохранённых реакций + реакций из писем — features/reactions.js.
    // Отправитель письма — мы сами: sender_id это сырой заголовок From
    // («Имя <email>» или просто email). userId — рудимент серверной эпохи,
    // в serverless он всегда null, поэтому сравниваем по своему email
    // (тот же приём, что isOut в 1-на-1 пути loadMessages).
    isOwnSender(senderId) {
      return ContactsFeature.isOwnSender(senderId, this.email, (e) => this.aliasesOf(e));
    },
    // Нормализация сырого заголовка From («Имя <email>») до чистого email.
    // avatarOf/nameOf ищут профили по email — без этого аватар/имя
    // отправителя в группе не рендерились («аватарки не добавились»).
    senderEmail(raw) { return MsgFormat.senderEmail(raw); },
    // Адаптер для MessageItem: карточка зовёт senderOf(msg-объект), а
    // senderEmail ждёт строку адреса. Письмо группы несёт sender_id
    // (email автора) — достаём его; для локальных записей без sender_id
    // (заметки/служебные) возвращаем пустую строку.
    msgSenderEmail(msg) {
      return ContactsFeature.msgSenderEmail(msg, (raw) => this.senderEmail(raw));
    },
    // --- Квитанции чтения («просмотрено») ---
    // Получатель при открытии чата шлёт отправителю квитанцию {read:1,
    // msg_ids:[...]} (1-на-1: encryptVault с пустой темой; группа:
    // encryptWithGroupKey письмами VaultGroupRead: <id>). Храним уже отосланные
    // msg_id по каждому чату, чтобы не слать повторно при каждом поллинге.
    readsSentStorageKey() { return LocalStoreFeature.readsSentStorageKey(this.localStoreDeps); },
    loadSentReads() { return LocalStoreFeature.loadSentReads(this.localStoreDeps); },
    saveSentReads(data) { return LocalStoreFeature.saveSentReads(this.localStoreDeps, data); },
    // Отправить квитанцию «просмотрено» по входящим сообщениям текущего чата.
    // Вызывается после рендера сообщений (открытие чата и поллинг).
    async sendReadReceipts(incomingIds) {
      return ReceiptsFeature.sendReadReceiptsFlow(this.receiptsDeps, incomingIds);
    },
    // Квитанции «доставлено» по новым входящим (поллинг): как только письмо
    // получено и расшифровано как vault-сообщение — отправителю уходит
    // {delivered:1, msg_ids:[...]} (stealth, пустая тема; тот же wire-формат,
    // что у read-квитанций — отправитель уже умеет их разбирать, App.vue
    // жёлтую точку, пока получатель не откроет чат (тогда уходила read).
    // Групповые письма здесь не обрабатываются (шифр групповым ключом —
    // decryptVault с пир-ключом не пройдёт); для групп статусы — как прежде.
    // ── Квитанции о доставке (логика в features/receipts.js) ──
    async sendDeliveredReceipts(fetched) { return ReceiptsFeature.sendDeliveredReceipts(this.receiptsDeps, fetched); },
    // (tombstonesCache/midTombstonesCache/cursorsCache и прочие поля состояния
    //  перенесены в data() — в methods Vue 3 игнорирует не-функции.)
    // Инициализация локальной БД: загрузить tombstones и курсоры из sqlite.
    // ADR-003 Этап 3, партия 11: загрузка и разбиение тумбстоунов — в
    // features/local-db-init.js.
    //
    // Присваиваем ТОЛЬКО ненулевое. Модуль отдаёт null там, где загрузка не
    // удалась, и пустой массив там, где загрузилось и там правда пусто. Спутать
    // эти состояния — значит при одном отказе Rust стереть то, что было
    // загружено раньше: удалённые письма перестали бы помечаться навсегда.
    async initLocalDb() {
      const r = await LocalDbInit.loadLocalCaches(this.email);
      if (r.tombstones) this.tombstonesCache = r.tombstones;
      if (r.midTombstones) this.midTombstonesCache = r.midTombstones;
      if (r.cursors) this.cursorsCache = r.cursors;
    },
    // --- Копирование сообщений ---
    linkify(text) { return MsgFormat.linkify(text); },
    onMessageTextClick(e) { return ChatUiFeature.onMessageTextClick(this.chatUiDeps, e); },
    // ADR-003 Этап 3: извлечение телефонов и ссылок — в message-format.js.
    // Регулярка телефона теперь ОДНА на этот метод и linkify: копии в App.vue
    // и в модуле разъехались бы, и в меню попадал бы другой набор номеров,
    // чем в тексте сообщения.
    openMessageMenu(event, msg) { return ChatUiFeature.openMessageMenu(this.chatUiDeps, event, msg); },
    // Измерить отрендеренное .message-menu и втянуть в экран. Меню
    // динамическое (пункты скрываются), поэтому размер берём из DOM,
    // а не оцениваем. Оверлей один на экране (v-if + inset:0 перехватывает
    // ввод), так что querySelector находит именно открытое меню.
    async clampMenuAfterRender(key, x, y) { return ChatUiFeature.clampMenuAfterRender(this.chatUiDeps, key, x, y); },
    // Клик по логотипу в шапке → сайт приложения (когда появится, M4).
    // Пока APP_SITE_URL пустой — клик ничего не делает.
    openAppSite() { return ExtLinks.openAppSite(); },
    // Копирование с fallback для WebKitGTK (clipboard API может быть
    // недоступен без фокуса — тогда через временный textarea).
    // ADR-003 Этап 3: сама попытка копирования — в clipboard.js, алерты здесь.
    // Так фолбэк через execCommand проверяется тестом, а не подделкой UI.
    async copyText(text) {
      if (await Clipboard.copyTextToClipboard(text)) {
        alert(uiStore.tr('copied') || 'Скопировано');
      } else {
        alert(uiStore.tr('copy_failed') || 'Не удалось скопировать');
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
    // ADR-003 Этап 3: оркестрация — в features/groups-create.js, UI здесь.
    // Порядок сохранён: группа применяется ДО генерации ключа, иначе при сбое
    // ключа группа существовала бы на Rust-стороне, но не появилась бы в UI —
    // и пользователь увидел бы «не удалось создать» для существующей группы.
    async createGroup() {
      return GroupsCreate.createGroupFlow(this.groupDeps, {
        name: this.newGroupName, avatar: this.newGroupAvatar,
      });
    },
    createGroupAndClose() {
      this.createGroup();
      this.showCreateGroup = false;
    },
    // клон группы — новый чат с тем же
    // составом участников, но пустой историей (например, «Работа» →
    // «Работа — проект X»). Инвайты уходят автоматически: ключ новой
    // группы шифруется на публичный ключ каждого участника (тот же путь,
    // что inviteSelectedMembers). Только создатель оригинала.
    // ADR-003 Этап 3: оркестрация клона — в features/groups-clone.js.
    // UI (prompt/alert/переводы) остаётся здесь намеренно: переносить его в
    // модуль значило бы тащить переводы в слой, который о них не знает.
    // Порядок сохранён: состояние клона применяется ДО рассылки приглашений,
    // как в оригинале — иначе клон появлялся бы в списке с задержкой.
    async cloneGroup() {
      return GroupsClone.cloneGroupFlow(this.groupDeps, { src: this.currentGroup });
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
        alert(uiStore.tr('cannot_remove_creator') || 'Создателя группы нельзя удалить');
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
        alert(uiStore.tr('already_in_group') || 'Этот участник уже в группе');
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
    // MEMBERSHIP ПО FINGERPRINT: from не числится в группе, но у нас
    // есть его peerKey (контакт известен) и он совпадает с peerKey одного из
    // участников → участник сменил почту. Мигрируем адрес в составе (Rust
    // groups_rename_member правит members + created_by) и сохраняем fingerprint
    // участника. Возвращает true, если после миграции from — участник.
    // Атомарность: если письмо пришло до того, как мы узнали новый peerKey,
    // матчинга не будет — но матчинг в processIncoming (setPeerKey) уже
    // сохранил ключ к моменту поллинга.
    // ADR-003 Этап 3: поиск устаревшего участника по трём источникам
    // (кэш → файл → fingerprint группы) — в features/groups-migrate.js.
    // Оставить один источник нельзя: ренейм уже вычистил кэш, и группа
    // осталась бы с двумя участниками на один отпечаток (случай 06.10).
    async tryMigrateGroupMember(group, from) {
      return GroupsMigrate.tryMigrateGroupMember(this.peerKeys, group, from);
    },
    // Смена почты собеседником: переименовать его адрес во ВСЕХ группах, где
    // он участник или создатель. tryMigrateGroupMember вызывается только при
    // разборе ВХОДЯЩЕГО письма; если письма нет (или оно уже разобрано) —
    // группы остаются со старым адресом. Этот проход идемпотентен.
    // ADR-003 Этап 3: перебор групп — в migrations.js. Перечитываем список
    // через колбэк, иначе на экране остались бы старые адреса.
    async migratePeerGroups(oldEmail, newEmail) {
      return Migrations.migratePeerGroups(oldEmail, newEmail, () => this.loadGroups());
    },
    // Ленивое заполнение fingerprint участников группы из peer_keys.
    // Старые groups.json без поля fingerprint: при открытии группы проставляем
    // id участников, чей pubkey известен. Матчинг при смене почты идёт по
    // самому pubkey (tryMigrateGroupMember); поле хранится для будущих
    // офлайн-проверок и UX. Идемпотентен: сохраняет только если заполнилось.
    async backfillGroupFingerprints(group) {
      try {
        let touched = false;
        for (const m of (group.members || [])) {
          if (m.fingerprint) continue;
          const k = this.peerKeys[m.email] || this.peerKeys[String(m.email || '').toLowerCase()];
          if (!k) continue;
          m.fingerprint = k;
          touched = true;
        }
        if (!touched) return;
        await invoke('groups_save_member_fingerprints', {
          groupId: group.id,
          members: (group.members || []).map(m => ({ email: m.email, fingerprint: m.fingerprint || '' })),
        });
        console.log('[groups] fingerprints backfilled:', group.id);
      } catch (e) { /* тихо: поле некритично, матчинг идёт по peer_keys */ }
    },
    // ── Приглашение участников (логика в features/members.js) ──
    async inviteSelectedMembers() { return MembersFeature.inviteSelectedMembers(this.membersDeps); },
    // --- Инвайты группы + запросы контактов 1-на-1: попапы согласия ---
    // ── Приглашения в группы (логика в features/invites.js) ──
    // ADR-005 W2 партия 4: контракт модуля — состояние у владельцев
    // (`invites`: per-app экземпляр invites-store; флаги попапа — uiStore),
    // эффекты — явный deps. Компонент модулю не виден.
    async processInvites() {
      return InvitesFeature.processInvites({
        invites: this.invitesStore,
        loadGroups: () => this.loadGroups(),
        loadChannels: () => this.loadChannels(),
        loadGroupMessages: (id) => this.loadGroupMessages(id, false),
        refreshGroupMembers: () => this.refreshGroupMembers(),
        loadStoredPeerKeys: () => this.loadStoredPeerKeys(),
        loadContacts: () => this.loadContacts(),
        loadProfiles: () => this.loadProfiles(),
      });
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
      return InvitesFeature.acceptInvite(inv, {
        invites: this.invitesStore,
        decryptGroupKey: (...args) => crypto.decryptGroupKey(...args),
        kvSet: (...args) => db.kvSet(...args),
        showToast: (...args) => uiStore.toast(...args),
        t: (key) => uiStore.tr(key),
        loadGroupMessages: (id) => this.loadGroupMessages(id, false),
        isCryptoReady: () => this.cryptoReady,
        groups: () => this.groups,
        // Аватар пишет владелец groups-store (раньше был вызов на СПИСОК
        // групп — TypeError и откат принятого инвайта).
        setGroupAvatar: (id, av) => this.groupsStore.setGroupAvatar(id, av),
        loadGroups: () => this.loadGroups(),
        loadChannels: () => this.loadChannels(),
        showNextInvite: () => this.showNextInvite(),
      });
    },
    async declineInvite(inv) {
      return InvitesFeature.declineInvite(inv, {
        invites: this.invitesStore,
        showNextInvite: () => this.showNextInvite(),
      });
    },
    showNextInvite() {
      return InvitesFeature.showNextInvite({
        invites: this.invitesStore,
        clearNextTimer: () => clearTimeout(this._nextInviteTimer),
        setNextTimer: (fn, delay) => { clearTimeout(this._nextInviteTimer); this._nextInviteTimer = setTimeout(fn, delay); },
      });
    },
    // --- Контакты 1-на-1: принять/отклонить запрос (Session-модель) ---
    async acceptContactInvite(c) {
      return ContactsFeature.acceptContactInvite(c, {
        loadPeerKeyEmails: () => api.loadPeerKeyEmails(),
        markAcceptedContact: (key) => api.markAcceptedContact(key),
        showToast: (...args) => uiStore.toast(...args),
        t: (key) => uiStore.tr(key),
        setPeerKey: (email, pub, pq) => identityStore.setPeerKey(email, pub, pq),
        markLoaded: (email) => identityStore.markLoaded(email),
        savePeerKey: (...args) => crypto.savePeerKey(...args),
        addContact: (email) => api.addContact(email),
        saveProfile: (...args) => api.saveProfile(...args),
        sendContactAccept: (email, pub) => api.sendContactAccept(email, pub),
        publicKey: () => this.publicKey,
        peerKeys: () => this.peerKeys,
        // Очередь запросов контакта и метки «в обработке» — владелец
        // invites-store (ADR-005 W2 партия 4): писали их ДВА модуля.
        markContactHandled: (key) => this.invitesStore.markContactHandled(key),
        unmarkContactHandled: (key) => this.invitesStore.unmarkContactHandled(key),
        splicePendingContacts: () => this.invitesStore.splicePendingContact(this.contactPopupIndex),
        pushPendingContact: (c) => this.invitesStore.pushPendingContact(c),
        loadProfiles: () => this.loadProfiles(),
        loadContacts: () => this.loadContacts(),
        showNextContact: () => this.showNextContact(),
      });
    },
    async declineContactInvite(c) {
      return ContactsFeature.declineContactInvite(c, {
        markContactHandled: (key) => this.invitesStore.markContactHandled(key),
        splicePendingContacts: () => this.invitesStore.splicePendingContact(this.contactPopupIndex),
        markDeclinedContact: (key) => api.markDeclinedContact(key),
        showNextContact: () => this.showNextContact(),
      });
    },
    showNextContact() {
      return ContactsFeature.showNextContact({
        clearNextContactTimer: () => clearTimeout(this._nextContactTimer),
        setNextContactTimer: (fn, delay) => { clearTimeout(this._nextContactTimer); this._nextContactTimer = setTimeout(fn, delay); },
        pendingContacts: () => this.invitesStore.getPendingContacts(),
        contactPopupIndex: () => this.contactPopupIndex,
        setContactPopupIndex: (v) => { this.contactPopupIndex = v; },
        setShowContactPopup: (v) => { this.showContactPopup = v; return this.showContactPopup; },
      });
    },
    async inviteContactById(email) {
      return ContactsFeature.inviteContactById(email, {
        peerKeys: () => this.peerKeys,
        contacts: () => this.contacts,
        loadPeerKeyEmails: () => api.loadPeerKeyEmails(),
        sendContactInvite: (id, pub) => api.sendContactInvite(id, pub),
        showToast: (...args) => uiStore.toast(...args),
        t: (key) => uiStore.tr(key),
        publicKey: () => this.publicKey,
      });
    },
    async deleteContact(email) {
      return ContactsDelete.deleteContactFlow(email, this.contactsDeleteDeps);
    },
    // --- Профили (имя/аватар отправителей в групповых чатах) ---
    // ── Ignore-лист в GroupSettings: с 0.1.165 «заблокированные» группы —
    // это глобальный ignore-лист получателя (E2E-модель), а не декоративный
    // group.blocked (который никто не читал и который не персистился).
    async blockUser(email) { return BlockUserFeature.blockUser(this.blockUserDeps, email); },
    async unblockUser(email) { return BlockUserFeature.unblockUser(this.blockUserDeps, email); },
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
        this.chat.set([]);
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
        this.chat.set([]);
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
/* Кнопки-раскрывашки и кнопка выбора файла — не градиентные:
   .login-box button (0,1,1) бьёт .server-toggle/.btn-secondary (0,1,0),
   поэтому явное повышение специфичности. */
.login-box button.server-toggle {
  background: none; color: var(--text-secondary, #8b949e); font-size: 13px; font-weight: 400;
  border: none; padding: 6px 0;
}
.login-box button.btn-secondary {
  width: auto; background: var(--bg-tertiary, #1a1a3a); color: var(--text-primary, #f1f5f9);
  font-size: 13px; font-weight: 500; padding: 8px 16px;
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.12));
}
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
  /* Ландшафт Android edge-to-edge: навбар у бокового края — контент
     сайдбара без этих отступов уходит за виртуальные кнопки.
     На десктопе и в портрете inset = 0 — правило ничего не меняет. */
  box-sizing: border-box;
  padding-left: var(--safe-left, 0px);
  padding-right: var(--safe-right, 0px);
}

.sidebar-header {
  padding: 20px 16px;
  /* Android edge-to-edge: контент рисуется под статус-бар. Добавляем
     safe-area-inset-top, чтобы иконки не залезали под него и не прилипали.
     На десктопе inset = 0 — правило ничего не меняет. */
  padding-top: calc(20px + var(--safe-top, 0px));
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
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
  gap: 2px;
  flex-shrink: 0;
}

.header-actions button {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 18px;
  padding: 8px 7px;
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

/* Карточка контакта: тап по аватару в шапке */
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
/* .chat-avatar-btn — в ChatHeader.vue (scoped) */

/* Статус «О себе» контакта */
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

/* Стили списка чатов (search-box, contact-*, contacts-empty*, groups-*,
   email-error-hint, archive-toggle) — в ContactList.vue (scoped) */

/* ═══════════════════════════════════════════════════════════════
   Contacts List
   ═══════════════════════════════════════════════════════════════ */
/* (стили списка — в ContactList.vue; здесь остаются шаренные
   с шапкой чата .group-avatar*, .notes-self-avatar*, .status-dot) */

/* Бейджи статуса списка чатов — в ContactList.vue (scoped) */

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

/* Секция групп и заголовок — в ContactList.vue (scoped) */

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
  /* Ландшафт Android edge-to-edge: то же, что у .sidebar — навбар у
     бокового края (left/right insets), иначе поле ввода и шапка чата
     уезжают за виртуальные кнопки. На десктопе inset = 0. */
  box-sizing: border-box;
  padding-left: var(--safe-left, 0px);
  padding-right: var(--safe-right, 0px);
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

/* Стили шапки чата (chat-header, chat-head-col, chat-actions, chat-status,
   relay-delivery-badge) — в ChatHeader.vue (scoped) */

/* ═══════════════════════════════════════════════════════════════
   Messages
   ═══════════════════════════════════════════════════════════════ */

/* Скролл-контейнер сообщений (messages/messages-empty/pinned-banner) —
   в MessageList.vue (scoped); стили карточек .message* остаются здесь. */

/* Reply-иконка в баре ответа/редактирования */
.reply-bar-ic { flex-shrink: 0; }

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
/* ── Голосования ─────────────────────────────────────────── */
.poll-card {
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.25);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 100%;
  box-sizing: border-box;
}
.poll-title {
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  word-break: break-word;
}
.poll-option {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(148, 163, 184, 0.08);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 8px;
  padding: 7px 10px;
  cursor: pointer;
  color: inherit;
  font-size: 13.5px;
  text-align: left;
  transition: background 0.15s;
}
.poll-option:hover:not(:disabled) { background: rgba(99, 102, 241, 0.15); }
.poll-option:disabled { cursor: default; opacity: 0.75; }
.poll-option-mine { border-color: var(--accent-primary, #6366f1); background: rgba(99, 102, 241, 0.12); }
.poll-option-lead { border-color: rgba(34, 197, 94, 0.5); }
.poll-option-label { flex: 1; word-break: break-word; }
.poll-option-count { font-weight: 600; font-size: 12.5px; opacity: 0.8; }
.poll-check { color: var(--accent-primary, #6366f1); font-weight: 700; }
.poll-footer { font-size: 12px; opacity: 0.7; }
/* Стили ленты папок (.folder-strip/.folder-chip) — в FoldersBar.vue */
.chat-menu-folder-label {
  font-size: 11px;
  opacity: 0.6;
  padding: 4px 10px 2px;
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
     (copyMessageText/copyMessageAll). Шапка чата (chat-header-text,
     chat-enc-text) — в ChatHeader.vue (scoped, media hover:none). */
  .message-content,
  .message-sender,
  .message-menu button {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
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
/* Ссылки в СВОЁМ пузыре: фон — градиент accent-primary→#4f46e5, той же
   гаммы, что accent-primary ссылки — шрифт сливался с фоном (координаты
   после отправки). Светлый тон + подчёркивание. */
.message.own .message-content .msg-link {
  color: #e0e7ff;
  text-decoration: underline;
}
.message.own .message-content .msg-link:hover {
  color: #ffffff;
  opacity: 1;
}
.message.own .message-content .msg-phone {
  color: #e0e7ff;
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

/* переключатель архива — в ContactList.vue (scoped) */
/* иконка mute у чата в списке */
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

/* Ignore-баннер над списком сообщений (чат с заблокированным) */
.ignore-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 24px;
  background: rgba(239, 68, 68, 0.08);
  border-bottom: 1px solid rgba(239, 68, 68, 0.25);
  font-size: 13px;
  color: var(--text-primary, #f1f5f9);
}

.ignore-banner .vault-icon { flex-shrink: 0; color: #ef4444; }

.ignore-banner span { flex: 1; color: var(--text-secondary, #94a3b8); }

.ignore-banner-unblock {
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: var(--text-primary, #f1f5f9);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: var(--radius-sm, 6px);
  white-space: nowrap;
}

.ignore-banner-unblock:hover {
  background: rgba(239, 68, 68, 0.15);
}

/* Пустое состояние списка — в MessageList.vue (scoped) */

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

/* Фоновый плеер голосовых (t_c1c44344, Android): карточка-кнопка в стиле
   attachment-file — янтарная иконка play/square + подпись. */
.voicenote-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #fff);
}

.voicenote-btn .voicenote-label {
  opacity: 0.9;
}

.voicenote-btn.playing {
  background: rgba(245, 158, 11, 0.16);
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

/* Members count и список участников: счётчик — в ChatHeader.vue (scoped);
   модалка списка (member-list/member-item/roles) остаётся здесь. */

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

/* Пометка «Избранное» рядом с временем сообщения */
.msg-starred-icon {
  color: #f59e0b;
  flex-shrink: 0;
}

/* Активный режим «показать только избранное» — в ChatHeader.vue (scoped) */

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

/* ── Звонки: «пилюля» исхода звонка в истории чата ──
   Центрированная, полупрозрачная, в общей стилистике Vault (тёмные темы).
   Пропущенный/нет ответа/отклонён — красный акцент; завершён — нейтральный.
   */
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

/* ── Единая кнопка закрытия окон ──
   Один стиль для ВСЕХ модалок: настройки, смена почты, инвайты, участники
   просмотр фото, шифратор, ключи, QR. Крестик = Icon x (фирменный янтарный)
   круглая зона нажатия 40px (достаточно для тача), полупрозрачный фон при
   наведении. Стиль глобальный (не scoped) — применяется и внутри компонентов
   (CipherTool/KeyManager/QRCodePanel). Стрелка «←» остаётся ТОЛЬКО для
   внутренней навигации (раздел настроек → назад к списку), не для закрытия.
   */
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

/* Смена почты — модалка */
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

/* Подсказка в модалках каналов (M2) */
.channel-modal-hint {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-muted, #64748b);
}
/* Панель «Каналы» (M2): единая точка входа */
.channels-panel-empty {
  padding: 10px 2px;
  font-size: 13px;
  color: var(--text-muted, #64748b);
}
.channels-panel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.channels-panel-row:hover {
  background: var(--bg-hover);
}
.channels-panel-name {
  flex: 1;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.channels-panel-tag {
  font-size: 11px;
  color: var(--text-muted, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.4px;
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

/* Аватар в диалоге «Новая группа»: фото вместо эмодзи-иконок
   единый стиль с аватаром аккаунта (круг, оверлей камеры при наведении).
   */
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

/* Единая система кнопок: базовый класс + модификаторы */
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

/* Export dropdown и исчезающие сообщения — в ChatHeader.vue (scoped) */

/* ═══════════════════════════════════════════════════════════════
   Message Input
   ═══════════════════════════════════════════════════════════════ */

.message-input {
  flex-shrink: 0;
  padding: 8px 10px;
  padding-bottom: calc(6px + var(--safe-bottom, 0px));
  border-top: 1px solid var(--border-subtle);
  /* Два ряда: ввод (+ отправка) и фичи */
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  background: var(--bg-secondary);
  position: relative;
}

/* Ряд фич занимает всю ширину (вторая строка flex-wrap) */
.feature-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-basis: 100%;
  padding: 0 4px;
}

.feature-btn {
  width: 40px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.feature-btn:hover { background: var(--bg-hover); border-color: var(--accent-primary); }
.feature-btn:active { transform: scale(0.97); }

.input-wrapper {
  flex: 1;
  min-width: 0;
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
  /* Отступ слева: зазор между эмодзи-кнопкой и подсказкой «Сообщение...»
     (4px у кнопки + 8px здесь = 12px, симметрично правому краю пилюли). */
  padding: 12px 12px 12px 8px;
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
  padding: 6px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.attach-btn:hover {
  background: var(--bg-hover);
}

.send-btn-round {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: var(--accent-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s, opacity 0.15s;
}

.send-btn-round:hover { transform: scale(1.06); }
.send-btn-round:disabled { opacity: 0.5; cursor: default; }

.attach-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  display: flex;
  flex-direction: column;
  min-width: 200px;
  overflow: hidden;
  z-index: 50;
}

.attach-menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 14px;
  text-align: left;
  transition: background 0.12s;
}

.attach-menu-item:hover { background: var(--bg-hover); }

/* Пустые состояния (empty-state/empty-icon/empty-text) — в MessageList.vue
   (scoped) */

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

/* Responsive: мобильная навигация */
.mobile-hidden {
  display: none !important;
}

@media (max-width: 767px), (max-height: 479px) {
  .message { max-width: 86%; }

  .sidebar {
    width: 100%;
  }
  .main-area {
    width: 100%;
  }
  /* Шапка чата на узком экране — в ChatHeader.vue (scoped, media<768). */
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

/* Android edge-to-edge: фуллскрин-модалки на мобильном начинаются от
   top:0 — стрелка «←» и заголовки уезжали под статус-бар. Отступ сверху через
   safe-area-inset-top (на десктопе inset=0, правило ничего не меняет).
   Правило стоит ПОСЛЕ.invite-popup-panel, чтобы перебить его padding-шортхэнд.
   box-sizing обязателен: глобального border-box нет, иначе padding раздует
   высоту модалки и контент выпадет за экран.
   */
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

/* Восстановление аккаунта на входе */
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

/* Тост внизу экрана */
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