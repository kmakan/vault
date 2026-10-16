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
            @download="downloadAttachment"
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
import { useSession } from './features/call-session.js';
import { reactive } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import api, { db } from './api.js';
import { createChatStore } from './chat-store.js';
import { createGroupsStore } from './features/groups-store.js';
import { createSendingStore } from './features/sending-store.js';
import { sessionStore as sessionState, mailboxStore as mailboxState, chatStore as chatState, uiStore } from './features/session-store.js';
import { relayState } from './features/relay-idle.js';
import { connLostGuard } from './features/call-idle.js';
import { accountNamespace, ensureAccountNamespace, resetAccountNamespaceCache } from './identity.js';
import crypto from './crypto.js';
import { initNotifications, notifyNewMessage } from './notify.js';
// убран в serverless-архитектуре. Typing-индикатор вернётся с транспортом на M3.
import * as Video from './features/video.js';
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
import * as ContactsDelete from './features/contacts-delete.js';
import * as RecoveryEscrow from './features/recovery-escrow.js';
import * as RestoreFailure from './features/restore-failure.js';
import * as MsgStore from './message-store.js';
import * as ExtLinks from './external-links.js';
import * as Migrations from './migrations.js';
import { contactsStore } from './features/contacts-store.js';
// ADR-004 J.6: identity-store owner для peerKeys/peerPqKeys/peerKeyInput/peerKeysLoaded.
import { identityStore } from './features/identity-store.js';
// ADR-004 J.5d: channels-store owner для channelPosts/channelUnread.
import { channelsStore } from './features/channels-store.js';
import * as GroupsMigrate from './features/groups-migrate.js';
import * as GroupsLoad from './features/groups-load.js';
import * as GroupsClone from './features/groups-clone.js';
import * as GroupsCreate from './features/groups-create.js';
import * as ForwardFeature from './features/forward.js';
import * as FoldersFeature from './features/folders.js';
// Фабрики состояния — из чистых модулей без импортов (их поднимает
// check-template.cjs, чтобы разрезолвить спреды в data()).
import { foldersState } from './features/folders/state.js';
import { duressState } from './features/duress/state.js';
import { pollState } from './features/poll/state.js';
import { forwardState } from './features/forward/state.js';
import * as DraftsFeature from './features/drafts.js';
import * as DuressFeature from './features/duress.js';
import * as GroupAvatarsFeature from './features/group-avatars.js';
import * as IncomingFeature from './features/incoming.js';
import * as ReactionsFeature from './features/reactions.js';
import * as EditsFeature from './features/edits.js';
import * as HistoryFeature from './features/history.js';
import * as RelayFeature from './features/relay.js';
import * as CallsFeature from './features/calls.js';
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
    // Модуль-владелец переписки (ADR-004, Этап A1).
    // reactive() оборачивает стор: методы мутируют this.state через прокси,
    // поэтому Vue видит изменения. Без обёртки мутации шли бы мимо прокси
    // и интерфейс не обновлялся бы — тихо.
    const chat = reactive(createChatStore());
    // Модуль-владелец состояния групп (ADR-004, Этап A9). Аналогично чат-хранилищу:
    // groupKeys и groupAvatars больше не data()-свойства, а живут в владельце.
    const groups = reactive(createGroupsStore());
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
    const callSession = useSession();
    // J.3b: init uiStore (t/showToast) через proxy на this.* (i18n plugin + method).
    // Vue options this.* доступен после монтирования — lazy proxy.
    const uiT = computed(() => this?.t ?? ((k) => k));
    const uiToast = computed(() => this?.showToast ?? (() => {}));
    watch(uiT, (fn) => uiStore.setT(fn), { immediate: true });
    watch(uiToast, (fn) => uiStore.setShowToast(fn), { immediate: true });
    return { t, setLocale, availableLocales, currentLocale, chat, groups, sendingStore, sessionStore, relayStore, mailboxStore, chatStore, callSession };
  },
  data() {
    return {
      currentView: 'chats',
      // Мобильная навигация: на узком экране
      // видна ОДНА панель — список чатов ИЛИ открытый чат на весь экран.
      // mobileChatOpen=true — показан чат (main-area), кнопка «назад» в шапке.
      mobileChatOpen: false,
      // Счётчики непрочитанных по чатам (email | 'group:<id>' → число).
      // Источник данных — chat-store (ADR-004 A11); сбрасываются при открытии чата.
      // флаги чатов email|'group:<id>' →
      // { archived, muted }. Архив скрыт из основного списка (переключатель
      // «Показать архив»), mute — без звука/без пуш-уведомления (счётчик
      // непрочитанных остаётся). Персист в sqlite kv 'chat-flags'.
      chatFlags: {},
      // Глобальный ignore-лист (E2E-честная блокировка): объект
      // { email: tsБлокировки }. Сообщения/звонки/уведомления от этих
      // отправителей скрываются у НАШЕГО получателя (сервер в serverless
      // блокировать не может — контент ему не виден). Новое НЕ попадает в
      // историю (после разблокировки не появляется), старое — остаётся.
      // Персист в sqlite kv 'ignored-users'.
      ignoredUsers: {},
      showArchived: false,
      // Контекстное меню чата (долгое нажатие / правый клик в списке).
      chatMenu: { show: false, target: null },
      // Избранное: помеченные сообщения чата.
      // chatKey → массив msg.id; персист в sqlite kv_store ('starred:<chatKey>').
      // Локально, как «Удалить у меня»: собеседнику не видно, по почте не
      // синхронизируется. showStarredOnly — режим «показать только избранные»
      // в шапке открытого чата (сам чат при открытии показывается как обычно).
      starredMap: {},
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
      emailsLoading: false,
      emailError: '',
      // Оптимистичные исходящие, ещё не подтверждённые письмом из ящика:
      // chatKey → { msgId: msg }. Поллинг перестраивает messages из IMAP и
      // стирал ещё не доставленное сообщение (оно «появлялось и исчезало»);
      // теперь mergePending подмешивает их обратно, пока копия письма не
      // придёт из Sent/All Mail — тогда реальное письмо заменяет запись.
      // Теперь во владельце sending-store (ADR-004, A10).
      cryptoReady: false,
      publicKey: null,
      fingerprint: null,
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
      showKeyManager: false,
      showQRCode: false,
      showCipher: false,
      searchQuery: '',
      // Groups
      groups: [],
      // channels — proxy на mailboxStore.state.channels (J.3c).
      // channelAvatarsinj в channels-store (J.7 proxy).
      // UI (t_a14ac823): активный канал + модалки создания/подписки
      currentChannel: null,
      showChannelPanel: false,
      showCreateChannel: false,
      showJoinChannel: false,
      newChannelName: '',
      newChannelAbout: '',
      joinChannelLink: '',
      postingChannel: false,
      groupKeys: {},  // group_id → groupKeyHex (shared symmetric key)
      groupAvatars: {},  // group_id → dataUrl (загруженный аватар группы)
      groupIconMap: {},
      // currentGroup/activeChatType — proxy на chat-store (J.3a).
      newGroupName: '',
      // фото вместо эмодзи-иконок.
      newGroupAvatar: '',
      // Тост-уведомление внизу экрана (Key Recovery и пр.)
      toastMessage: '',
      toastTimer: null,
      // Исчезающие сообщения: активные таймеры удаления
      // { msgKey: timeoutId }, msgKey = chatId + ':' + msgId
      ephemeralTimers: {},
      ephemeralTick: 0,
      showEphemeralMenu: false,
      currentEphemeralTtl: 0,
      myBio: '',
      // Зелёная точка: email → ts последней активности контакта
      // (входящее письмо/квитанция). Не онлайн-статус: «видели за 10 мин».
      lastSeenMap: {},
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
      // Папки чатов: состояние живёт в features/folders.js (ADR-001 Этап 1)
      ...foldersState(),
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
    // Прокси во владельца переписки (ADR-004, Этап A1).
    // Все существующие this.messages = ... и this.messages в шаблоне продолжают
    // работать без изменений, но запись идёт через владельца.
    messages: {
      get() { return this.chat.state.messages; },
      set(v) { this.chat.set(v); },
    },
    // Прокси во владельца группового состояния (ADR-004, Этап A9).
    // groupKeys/groupAvatars больше не data()-свойства, а proxy на groups-store.
    // Геттер сохраняет обратную совместимость для чтения; запись — через API.
    groupKeys: {
      get() { return this.groups.state.groupKeys; },
    },
    groupAvatars: {
      get() { return this.groups.state.groupAvatars; },
    },
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
    activeChat: { get() { return chatStore.state.activeChat; }, set(v) { chatStore.state.activeChat = v ?? null; } },
    currentGroup: { get() { return chatStore.state.currentGroup; }, set(v) { chatStore.state.currentGroup = v ?? null; } },
    activeChatType: {
      get() { return chatStore.state.activeChatType; },
      set(v) { chatStore.state.activeChatType = v; },
    },
    // Прокси во владельца mailbox (J.3c): channels + body cache.
    channels: { get() { return mailboxStore.state.channels; }, set(v) { mailboxStore.state.channels = v || []; } },
    emailBodyCache: {
      get() { return mailboxStore.state.emailBodyCache; },
      set(v) { mailboxStore.state.emailBodyCache = v || {}; },
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
      return ForwardFeature.forwardTargets(this);
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
      // J.2: синхронизация форма-логина → sessionStore.currentEmail
      sessionStore.setCurrentEmail(val);
    }
  },
  async mounted() {
    // Duress-замок: включён ли (до авторизации)
    this.checkDuressLock();
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
      Video.decodeFrame(p);
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
          try { if (await PresenceFeature.isEnabled(this)) PresenceFeature.startHeartbeats(this); } catch (e) { /* kv */ }
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
    Video.stopCamera();
    Video.stopRemoteVideo();
  },
  methods: {
    // ── Голосования (poll) — логика в features/poll.js; обёртки держат
    // шаблонные биндинги явными (гейт check-template резолвит имена).
    parsePollEnvelope(env) { return PollFeature.parsePollEnvelope(env); },
    pollVotes(poll) { return PollFeature.pollVotes(poll); },
    pollOptionCount(poll, i) { return PollFeature.pollOptionCount(poll, i); },
    pollLead(poll) { return PollFeature.pollLead(poll); },
    pollLeadLabel(poll) { return PollFeature.pollLeadLabel(poll); },
    castPollVote(msg, option) { return PollFeature.castPollVote(this, msg, option); },
    async sendPoll(question, options) { return PollFeature.sendPoll(this, question, options); },
    applyPollVotes(list, wirePollVotes) { return PollFeature.applyPollVotes(list, wirePollVotes, this.email); },
    // ── Реакции (логика в features/reactions.js) ──
    reactionsStorageKey() { return ReactionsFeature.reactionsStorageKey(this); },
    loadStoredReactions() { return ReactionsFeature.loadStoredReactions(this); },
    saveStoredReactions(data) { return ReactionsFeature.saveStoredReactions(this, data); },
    applyReactions(list, chatKey, wireReactions) { return ReactionsFeature.applyReactions(this, list, chatKey, wireReactions); },
    sendReactionEmail(msgId, emoji, action) { return ReactionsFeature.sendReactionEmail(this, msgId, emoji, action); },
    toggleReactionPicker(msgId) { return ReactionsFeature.toggleReactionPicker(this, msgId); },
    addReaction(msgId, emoji) { return ReactionsFeature.addReaction(this, msgId, emoji); },
    toggleReaction(msgId, emoji) { return ReactionsFeature.toggleReaction(this, msgId, emoji); },
    // ── Правки/удаления + tombstones (логика в features/edits.js) ──
    editsStorageKey() { return EditsFeature.editsStorageKey(this); },
    loadStoredEdits() { return EditsFeature.loadStoredEdits(this); },
    saveStoredEdits(data) { return EditsFeature.saveStoredEdits(this, data); },
    recordLocalEdit(chatKey, msgId, text, action) { return EditsFeature.recordLocalEdit(this, chatKey, msgId, text, action); },
    tombstonesKey() { return EditsFeature.tombstonesKey(this); },
    loadTombstones() { return EditsFeature.loadTombstones(this); },
    addTombstone(msgId) { return EditsFeature.addTombstone(this, msgId); },
    isTombstoned(msgId) { return EditsFeature.isTombstoned(this, msgId); },
    midTombstonesKey() { return EditsFeature.midTombstonesKey(this); },
    loadMidTombstones() { return EditsFeature.loadMidTombstones(this); },
    addMidTombstone(mid) { return EditsFeature.addMidTombstone(this, mid); },
    isMidTombstoned(mid) { return EditsFeature.isMidTombstoned(this, mid); },
    filterDeleted(list) { return EditsFeature.filterDeleted(this, list); },
    applyEdits(list, chatKey, wireEdits) { return EditsFeature.applyEdits(this, list, chatKey, wireEdits); },
    sendEditEmail(msgId, text, action) { return EditsFeature.sendEditEmail(this, msgId, text, action); },
    // ── История/кэши/оптимистичные исходящие (логика в features/history.js) ──
    bodyCacheKey() { return HistoryFeature.bodyCacheKey(this); },
    chatCacheKey(chat) { return HistoryFeature.chatCacheKey(this, chat); },
    loadBodyCache() { return HistoryFeature.loadBodyCache(this); },
    cacheBody(key, body) { return HistoryFeature.cacheBody(this, key, body); },
    persistBodyCache() { return HistoryFeature.persistBodyCache(this); },
    loadChatCache(chat) { return HistoryFeature.loadChatCache(this, chat); },
    saveChatCache(chat, list) { return HistoryFeature.saveChatCache(this, chat, list); },
    markPending(chatKey, msg) { return HistoryFeature.markPending(this, chatKey, msg); },
    mergePending(chatKey, list) { return HistoryFeature.mergePending(this, chatKey, list); },
    loadLocalHistory(chatKey) { return HistoryFeature.loadLocalHistory(this, chatKey); },
    normalizeStaleSending(hist) { return HistoryFeature.normalizeStaleSending(this, hist); },
    mergeHistory(chatKey, list) { return HistoryFeature.mergeHistory(this, chatKey, list); },
    msgTs(m) { return HistoryFeature.msgTs(m); },
    showHistoryFirst(chatKey, isStale) { return HistoryFeature.showHistoryFirst(this, chatKey, isStale); },
    saveCurrentHistory(chatKey) { return HistoryFeature.saveCurrentHistory(this, chatKey); },
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
    parseCallSignal(decrypted) { return CallsFeature.parseCallSignal(decrypted); },
    async sendCallEnvelope(peer, payload, opts = {}) { return CallsFeature.sendCallEnvelope(this, peer, payload, opts); },
    async handleCallSignal(sig, from) { return CallsFeature.handleCallSignal(this, sig, from); },
    async onMailBounce(recipients, reason) { return CallsFeature.onMailBounce(this, recipients, reason); },
    async startCall() { return CallsFeature.startCall(this); },
    async acceptCall() { return CallsFeature.acceptCall(this); },
    async rejectCall() { return CallsFeature.rejectCall(this); },
    async endCall() {
      this.stopCallVideo();
      return CallsFeature.endCall(this);
    },
    async hangup(reason) {
      this.stopCallVideo();
      return CallsFeature.hangup(this, reason);
    },
    async cancelCall(reason) { return CallsFeature.cancelCall(this, reason); },
    async recordCallEvent(peer, kind, ts, durationSec, callId) { return CallsFeature.recordCallEvent(this, peer, kind, ts, durationSec, callId); },
    callEventLabel(msg) { return CallsFeature.callEventLabel(this.t, msg); },
    callPillIcon(msg) { return CallsFeature.callPillIcon(msg); },
    canCallBack(msg) { return CallsFeature.canCallBack({
      activeChat: this.activeChat, activeChatType: this.activeChatType,
      callState: this.callState, expCalls: this.expCalls, peerKeys: this.peerKeys,
    }, msg); },
    callBack() { return CallsFeature.callBack(this); },
    toggleCallMute() { this.callMuted = CallsFeature.toggleCallMute({ callMuted: this.callMuted, currentCall: this.currentCall }); },
    toggleSpeaker() { this.callSpeaker = CallsFeature.toggleSpeaker({ callSpeaker: this.callSpeaker, currentCall: this.currentCall }); },
    // M3: видео живёт в features/video.js — здесь только тонкая
    // точка сборки (reactive-флаг + вызов фичи), как у mute/speaker.
    toggleCallVideo() {
      if (!this.currentCall || !this.callMediaConnected) return;
      if (this.callVideoOn) { this.stopCallVideo(); } else { this.startCallVideo(); }
    },
    async startCallVideo() {
      const c = this.currentCall;
      if (!c || this.callVideoOn) return;
      const cid = c.call_id;
      // Сначала поднимаем флаг: canvas рендерится по v-if=videoOn,
      // и только когда DOM готов — стартуем remote-декодер.
      this.callVideoOn = true;
      await this.$nextTick();
      const overlay = this.$refs.callOverlay;
      const canvasEl = overlay ? overlay.getRemoteVideoEl() : null;
      try {
        const ok = await Video.startRemoteVideo(cid, canvasEl);
        if (!ok) {
          this.callVideoOn = false;
          uiStore.toast(uiStore.tr('video_unavailable') || 'Видео недоступно в этом WebView', 3000);
          return;
        }
        await api.mediaVideoStart(cid);
      } catch (e) {
        console.error('[video] remote start failed:', e);
        this.callVideoOn = false;
        Video.stopRemoteVideo();
        uiStore.toast(uiStore.tr('video_start_failed') || 'Не удалось включить видео', 3000);
        return;
      }
      // Локальная камера: кадры → Rust → собеседник (превью нет — air).
      try {
        await Video.startCamera(cid);
      } catch (e) {
        // Камера недоступна/отказала — remote-видео собеседника всё равно
        // работает; переключатель остается «вкл», звонок не роняем.
        console.warn('[video] camera unavailable, remote-only:', e && e.message || e);
        uiStore.toast(uiStore.tr('video_camera_off') || 'Камера недоступна — видно только собеседника', 3000);
      }
    },
    stopCallVideo() {
      if (!this.currentCall) return;
      Video.stopCamera();
      Video.stopRemoteVideo();
      this.callVideoOn = false;
      api.mediaVideoStop(this.currentCall.call_id).catch((e) => console.warn('[video] stop failed:', e));
    },
    startSignalResend(peer, payload, call_id) { return CallsFeature.startSignalResend(this, peer, payload, call_id); },
    stopSignalResend() { return CallsFeature.stopSignalResend(this); },
    sendTerminalRepeat(peer, type, call_id) { return CallsFeature.sendTerminalRepeat(this, peer, type, call_id); },
    armMediaFallback() { return CallsFeature.armMediaFallback(this); },
    startCallClock() { this.callSession.startCallClock(); },
    stopCallClock() { this.callSession.stopCallClock(); },
    startFastPolling() { return CallsFeature.startFastPolling(() => this.idleLoop(), this.callSession.callIdleMonitorUp); },
    stopFastPolling() { return CallsFeature.stopFastPolling(); },
    playCallSound(name, looped) { return CallsFeature.playCallSound(this, name, looped); },
    stopCallSound() { return CallsFeature.stopCallSound(this); },
    // ── Профили контактов (логика в features/profiles.js) ──
    aliasesOf(email) { return ProfilesFeature.aliasesOf(this, email); },
    profileOf(email) { return ProfilesFeature.profileOf(this, email); },
    localProfileOf(email) { return ProfilesFeature.localProfileOf(this, email); },
    nameOf(email) { return ProfilesFeature.nameOf(this, email); },
    avatarOf(email) { return ProfilesFeature.avatarOf(this, email); },
    loadLocalProfiles() { return ProfilesFeature.loadLocalProfiles(this); },
    saveLocalProfiles() { return ProfilesFeature.saveLocalProfiles(this); },
    async loadProfiles() { return ProfilesFeature.loadProfiles(this); },
    async getBio() { return ProfilesFeature.getBio(this); },
    async setBio(text) { return ProfilesFeature.setBio(this, text); },
    async onBioSave(text) { return ProfilesFeature.onBioSave(this, text); },
    async onProfileSave() { return ProfilesFeature.onProfileSave(this); },
    async broadcastProfile() { return ProfilesFeature.broadcastProfile(this); },
    async openContactCard(email) { return ProfilesFeature.openContactCard(this, email); },
    startEditFromCard() { return ProfilesFeature.startEditFromCard(this); },
    openContactEdit(email) { return ProfilesFeature.openContactEdit(this, email); },
    handleContactAvatarSelect(event) { return ProfilesFeature.handleContactAvatarSelect(this, event); },
    saveContactEdit() { return ProfilesFeature.saveContactEdit(this); },
    resetContactEdit() { return ProfilesFeature.resetContactEdit(this); },
    async shrinkAvatar(dataUrl) { return ProfilesFeature.shrinkAvatar(dataUrl); },
    compressImage(dataUrl, maxSide, quality) { return ProfilesFeature.compressImage(dataUrl, maxSide, quality); },
    noteSeen(email, ts) { return ProfilesFeature.noteSeen(this, email, ts); },
    isRecentlySeen(email) { return ProfilesFeature.isRecentlySeen(this, email); },
    // ── Presence (t_e858bdb9) — heartbeat-зелёная точка; логика в
    // features/presence.js. Тумблер живёт в настройках (Приватность).
    isOnline(email) { return PresenceFeature.isOnline(this, email); },
    presenceSetEnabled(on) {
      PresenceFeature.setEnabled(this, on).catch(e =>
        console.warn('[presence] setEnabled failed:', e && e.message || e));
    },
    // ── Пересылка (forward) — логика в features/forward.js; обёртки держат
    // шаблонные биндинги явными (гейт check-template резолвит имена).
    startForward(msg) { return ForwardFeature.startForward(this, msg); },
    doForward(key) { return ForwardFeature.doForward(this, key); },
    // ── Папки чатов (folders) — логика в features/folders.js; loadChatFlags
    // грузит единый kv-блоб (flags + folder names), архив/mute меняются
    // toggleArchive/toggleMute ниже (чат-меню) через общий saveChatFlags.
    async loadChatFlags() { return FoldersFeature.loadChatFlags(this); },
    async saveChatFlags() { return FoldersFeature.saveChatFlags(this); },
    flagKey(target) { return FoldersFeature.flagKey(target); },
    chatFlagOf(key) { return FoldersFeature.chatFlagOf(this, key); },
    async setChatFolder(name) { return FoldersFeature.setChatFolder(this, name); },
    async createChatFolder() { return FoldersFeature.createChatFolder(this); },
    // ── Ignore-лист (E2E-честная блокировка отправителя). Логика — здесь,
    // не в features/: точек интеграции мало, а data-инвариант (объект
    // email→ts) связан с тремя путями доставки (почта/релей/история).
    // Загрузка из sqlite kv 'ignored-users' (вызывается при входе рядом с
    // loadChatFlags). Повреждённый блоб — тихо пустой список.
    async loadIgnoredUsers() {
      try {
        const raw = await db.kvGet(await accountNamespace(this.email), 'ignored-users');
        this.ignoredUsers = raw ? (JSON.parse(raw) || {}) : {};
      } catch (e) { this.ignoredUsers = {}; }
    },
    async saveIgnoredUsers() {
      try {
        await db.kvSet(await accountNamespace(this.email), 'ignored-users', JSON.stringify(this.ignoredUsers));
      } catch (e) { /* kv недоступен — список живёт в памяти до перезапуска */ }
    },
    // Заблокирован ли отправитель для НАС (смена почты не помогает:
    // проверяем и сам email, и все алиасы того же peer-ключа).
    isIgnored(email) {
      const key = String(email || '').toLowerCase();
      if (!key || !this.ignoredUsers) return false;
      if (this.ignoredUsers[key]) return true;
      // Алиасы: отправитель сменил адрес, ключ тот же — блок следует за ним.
      const pk = this.peerKeys && (this.peerKeys[key] || this.peerKeys[email]);
      if (!pk) return false;
      for (const k of Object.keys(this.ignoredUsers)) {
        if (this.peerKeys[k] === pk) return true;
      }
      return false;
    },
    // Заблокировать отправителя: с этого момента его новые сообщения,
    // звонки и уведомления скрыты у получателя. Возвращает false, если
    // email пустой или это наш собственный адрес.
    async ignoreUser(email) {
      const key = String(email || '').toLowerCase().trim();
      if (!key || key === (this.email || '').toLowerCase()) return false;
      if (!this.isIgnored(key)) {
        this.ignoredUsers[key] = Date.now();
        await this.saveIgnoredUsers();
      }
      return true;
    },
    // Снять блокировку: новые сообщения снова показываются. Прошлое (то,
    // что скрылось, пока блок был активен) не возвращается — его не было
    // в истории. Снимаем и сам адрес, и алиасы того же ключа.
    async unignoreUser(email) {
      const key = String(email || '').toLowerCase().trim();
      if (!key) return;
      const pk = this.peerKeys && (this.peerKeys[key] || this.peerKeys[email]);
      for (const k of Object.keys(this.ignoredUsers)) {
        if (k === key || (pk && this.peerKeys[k] === pk)) {
          delete this.ignoredUsers[k];
        }
      }
      await this.saveIgnoredUsers();
    },
    // ── Черновики (drafts) — логика в features/drafts.js; очередь сериализации
    // kv-блоба (гонка save/restore) — на статике модуля, не компонента.
    draftRun(fn) { return DraftsFeature.draftRun(fn); },
    saveDraft() { return DraftsFeature.saveDraft(this); },
    restoreDraft(chatKey) { return DraftsFeature.restoreDraft(this, chatKey); },
    // ── Duress-замок — логика в features/duress.js; LockScreen-события
    // (unlock/duress/panic) приходят из шаблона в эти обёртки.
    async checkDuressLock() { return DuressFeature.checkDuressLock(this); },
    onLockUnlock() { return DuressFeature.onLockUnlock(this); },
    onLockDuress() { return DuressFeature.onLockDuress(this); },
    async onLockPanic() { return DuressFeature.onLockPanic(this); },
    async sendDuressSos() { return DuressFeature.sendDuressSos(this); },
    // §1: пояснение индикатора доставки человеческим языком.
    relayExplainDelivery() {
      if (this.relayDeliveryMode === 'email') {
        uiStore.toast(uiStore.tr('relay_limit_toast') || 'Релей недоступен или лимит исчерпан — доставка идёт по почте, ничего не теряется.', 4000);
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
    // ── Вложения (логика в features/attachments.js) — тонкие делегаты,
    // имена сохранены для шаблонных биндингов (гейт check-template). ──
    downloadAttachment(attachment) { return AttachmentsFeature.downloadAttachment(this, attachment); },
    // ADR-001: showToast обёрнут в стрелку — метод компонента теряет this,
//            если передать его ссылкой (внутри использует состояние).
async toggleVoiceNote(msg, attachment) {
      this.voicePlayingId = await AttachmentsFeature.toggleVoiceNote({
        isAndroidClient: this.isAndroidClient, voicePlayingId: this.voicePlayingId,
        showToast: (m, ms) => uiStore.toast(m, ms), t: this.t,
      }, msg, attachment);
    },
    async fetchDodAttachment(msg, attachment) { return AttachmentsFeature.fetchDodAttachment(this, msg, attachment); },
    async downloadDodAttachment(msg, attachment) { return AttachmentsFeature.downloadDodAttachment(this, msg, attachment); },
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
    async initCrypto({ allowCreate = false } = {}) {
      try {
        const result = await crypto.initFromStorage();
        if (result.loaded) {
          this.publicKey = result.keypair.public_key;
        } else if (allowCreate) {
          const keypair = await crypto.generateKeypair();
          this.publicKey = keypair.public_key;
          await crypto.saveToStorage();
        } else {
          // Ключа нет, а генерировать нельзя: сбрасываем готовность и НЕ
          // создаём пару. Вызывающий обязан показать форму входа/восстановления.
          console.warn('[crypto] нет сохранённого ключа, генерация запрещена (allowCreate=false)');
          this.cryptoReady = false;
          this.publicKey = null;
          return false;
        }
        this.fingerprint = await crypto.fingerprint();
        // Fire-and-forget: заполняем свой fingerprint у участников групп, которые
        // ещё никто не открывал в UI (там fp заполняется лениво при открытии) —
        // иначе fp-only фильтр «моих групп» их не находит. Вход не блокируем.
        invoke('groups_backfill_my_fingerprint', {
          email: this.email || '',
          fingerprint: String(this.fingerprint || ''),
        }).catch(() => {});
        this.cryptoReady = true;
        await this.loadStoredPeerKeys();
        // Ключ теперь есть → пересчитываем namespace на fp:<fingerprint> и
        // ОДИН раз переносим накопленные email-строки. Без сброса кэша
        // резолвер остался бы на legacy-емейле (fp закэширован как '' до
        // загрузки ключа), и весь трек fp-идентичности был бы мёртвым.
        resetAccountNamespaceCache();
        if (this.email) {
          try { await ensureAccountNamespace(this.email); }
          catch (e) { console.warn('[identity] namespace bootstrap failed:', e); }
        }
        return true;
      } catch (error) {
        console.error('Crypto init failed:', error);
        this.cryptoReady = false;
        return false;
      }
    },
    async loadStoredPeerKeys() {
      try {
        // Сбрасываем перед загрузкой: удалённые в Rust ключи должны
        // пропасть из памяти.
        identityStore.clearPeerKeys();
        const stored = await crypto.loadPeerKeys();
        for (const pk of stored) {
          this.peerKeys[pk.email] = pk.public_key;
          this.peerKeysLoaded[pk.email] = true;
          if (pk.pq_public_key) this.peerPqKeys[pk.email] = pk.pq_public_key;
        }
        // M2.4: отложенные ntfy-клики (холодный старт) — ключи загружены,
        // можно открывать чаты. Drain также доступен глобально (__vaultOpenChat).
        try {
          window.__VAULT_DRAIN = () => {
            const q = window.__VAULT_CHAT_QUEUE || [];
            // Холодный старт: Kotlin держит выбранный чат в native-мосте
            // VaultDeepLink.take() (localStorage мог быть недоступен до
            // загрузки страницы). Забираем его оттуда...
            try {
              const native = window.VaultDeepLink && window.VaultDeepLink.take && window.VaultDeepLink.take();
              if (native) q.push(native);
            } catch (e) { /* не Android / моста нет */ }
            // ...и из localStorage (запасной путь).
            try {
              const pending = localStorage.getItem('vault-pending-chat');
              if (pending) {
                localStorage.removeItem('vault-pending-chat');
                q.push(pending);
              }
            } catch (e) { /* ignore */ }
            while (q.length) {
              const chat = q.shift();
              this.openChatByKey(chat);
              if (this.isMobile) this.mobileChatOpen = true;
            }
          };
          window.__VAULT_DRAIN();
        } catch (e) { /* ignore */ }
      } catch (error) {
        console.error('Failed to load peer keys:', error);
      }
    },
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
      PresenceFeature.stopHeartbeats(this); // M2: heartbeat больше не отправляем
      try { await api.logout(); } catch (e) { /* ignore */ }
      // Сбрасываем всё состояние сессии к экрану логина.
      this.isLoggedIn = false;
      this.userId = null;
      this.email = '';
      this.password = '';
      this.groups = [];
      this.clearGroupKeys();
      this.currentGroup = null;
      this.activeChatType = 'chat';
      this.contacts = [];
      this.activeChat = null;
      this.messages = [];
      this.clearAllUnread();
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
    async migrateLocalStores(oldEmail, newEmail) { return MigrateFeature.migrateLocalStores(this, oldEmail, newEmail); },
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
    canonicalOf(email) {
      const key = this.peerKeys[email || ''] || this.peerKeys[String(email || '').toLowerCase()];
      if (!key) return email;
      const shown = this.contacts.find(c => c.public_key === key);
      return shown ? shown.email : email;
    },
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
      this.groups.mergeGroupKeys(r.keys || {});
      this.groups.mergeGroupAvatars(r.avatars || {});
      Object.assign(this.groupIconMap, r.icons);
      for (const c of r.newContacts) this.contacts.push(c);
    },
    // M2: broadcast-каналы — хранение через tauri channels.rs (channels.json).
    channelPostsToMessages(ch) {
      // kv-лог постов → формат MessageItem (own = наш пост/эхо).
      const posts = this.channelPosts[ch.id] || [];
      return posts.map(p => ({
        id: p.id || ('post-' + p.ts),
        content: p.body || '',
        from: (p.sender && p.sender === (ch.owner || this.email)) || (!p.sender && ch.is_owner) ? 'me' : p.sender,
        sender_id: p.sender || ch.owner || '',
        time: new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ts: p.ts,
        encrypted: true,
        vault: true,
      }));
    },
    async selectChannel(ch) {
      this.saveDraft();
      this.messages = [];
      this.newMessage = '';
      this.cancelReply();
      this.activeChat = 'channel:' + ch.id;
      this.activeChatType = 'channel';
      this.currentChannel = ch;
      this.currentGroup = null;
      this.showStarredOnly = false;
      this.loadSeq++;
      this.messages = this.channelPostsToMessages(ch);
      this.channelUnread[ch.id] = 0; // канал открыт — сбрасываем счётчик
      // last_ts монотонный (Rust-гейт): пишем максимум visible-постов,
      // иначе последующие непрочитанные перестанут считаться.
      const maxTs = (this.channelPosts[ch.id] || []).reduce((m, p) => Math.max(m, p.ts || 0), 0);
      if (maxTs) ChannelsFeature.updateChannel(ch.id, { last_ts: maxTs }).catch(() => {});
      this.openMobileChat();
      await this.$nextTick();
      this.scrollToBottom(true);
    },
    async createChannelAndClose() {
      const name = this.newChannelName.trim();
      if (!name || this.postingChannel) return;
      this.postingChannel = true;
      try {
        const ch = await ChannelsFeature.createChannel(name, this.newChannelAbout.trim(), this.email || '', this.fingerprint || '');
        await this.loadChannels();
        this.showCreateChannel = false;
        this.newChannelName = '';
        this.newChannelAbout = '';
        const fresh = this.channels.find(c => c.id === ch.id) || ch;
        await this.selectChannel(fresh);
        uiStore.toast(uiStore.tr('channel_created') || 'Канал создан — поделитесь ссылкой', 4000);
      } catch (e) {
        console.error('[channels] create:', e);
        uiStore.toast(uiStore.tr('channel_create_failed') || 'Не удалось создать канал', 3000);
      } finally { this.postingChannel = false; }
    },
    async joinChannelAndClose() {
      const parsed = ChannelsFeature.parseJoinLink(this.joinChannelLink.trim());
      if (!parsed) {
        uiStore.toast(uiStore.tr('channel_join_bad_link') || 'Ссылка канала не распознана', 3000);
        return;
      }
      try {
        await ChannelsFeature.importChannel(parsed.id, parsed.name, parsed.key, parsed.owner, parsed.ownerFpr);
        await this.loadChannels();
        this.showJoinChannel = false;
        this.joinChannelLink = '';
        const ch = this.channels.find(c => c.id === parsed.id);
        if (ch) await this.selectChannel(ch);
      } catch (e) {
        console.error('[channels] join:', e);
        uiStore.toast(uiStore.tr('channel_join_failed') || 'Не удалось подписаться', 3000);
      }
    },
    copyChannelLink() {
      const ch = this.currentChannel;
      if (!ch) return;
      const link = ChannelsFeature.buildJoinLink(ch);
      try { navigator.clipboard.writeText(link); uiStore.toast(uiStore.tr('channel_link_copied') || 'Ссылка на канал скопирована', 2500); }
      catch (e) { console.warn('[channels] clipboard:', e); }
    },
    copyChannelLinkById(id) {
      const ch = this.channelById(id);
      this.closeChatMenu();
      if (!ch) return;
      try { navigator.clipboard.writeText(ChannelsFeature.buildJoinLink(ch)); uiStore.toast(uiStore.tr('channel_link_copied') || 'Ссылка на канал скопирована', 2500); }
      catch (e) { console.warn('[channels] clipboard:', e); }
    },
    // Отправка поста владельцем (composer → post-конверт). Тело шифруется
    // broadcast-ключом канала (тот же симметричный путь, что группы).
    async sendChannelPost() {
      const ch = this.currentChannel;
      const text = this.newMessage.trim();
      if (!ch || !ch.is_owner || !text || this.postingChannel) return;
      this.postingChannel = true;
      try {
        const payload = ChannelsFeature.buildPostPayload(ch.id, text, []);
        const content = await crypto.encryptWithGroupKey(payload, ch.key);
        const env = JSON.parse(payload);
        // optimistic local (владельческое эхо-письмо может и не вернуться)
        this.noteChannelPost(ch.id, env.ts, env, this.email);
        this.channelUnread[ch.id] = 0; // собственный пост — не «непрочитанное»
        this.messages = this.channelPostsToMessages(ch);
        this.newMessage = '';
        await this.$nextTick();
        this.scrollToBottom(true);
        const res = await ChannelsFeature.sendChannelPost(ch, content, env, this.email);
        ChannelsFeature.updateChannel(ch.id, { last_ts: env.ts }).catch(() => {});
        if (!res.relayOk && res.mailSent === 0 && (ch.known_subscribers || []).length) {
          uiStore.toast(uiStore.tr('channel_post_email_only') || 'Релей недоступен — пост ушёл только известным подписчикам', 4000);
        }
      } catch (e) {
        console.error('[channels] post:', e);
        uiStore.toast(uiStore.tr('channel_post_failed') || 'Пост не отправлен', 3000);
      } finally { this.postingChannel = false; }
    },
    async deleteChannelConfirmed() {
      const t2 = this.chatMenu.target;
      if (!t2 || t2.type !== 'channel') return;
      if (!confirm(uiStore.tr('channel_delete_confirm') || 'Удалить канал и всю его локальную историю?')) return;
      this.closeChatMenu();
      try {
        await ChannelsFeature.deleteChannel(t2.id);
        if (this.activeChat === 'channel:' + t2.id) {
          this.activeChat = '';
          this.activeChatType = 'chat';
          this.currentChannel = null;
          this.messages = [];
        }
        await this.loadChannels();
      } catch (e) { console.error('[channels] delete:', e); }
    },
    async loadChannels() {
      try {
        this.channels = await ChannelsFeature.loadChannels();
        // last_ts > 0 у подписчика = есть непрочитанное (считаем по post-логу kv)
        for (const ch of this.channels) {
          const posts = JSON.parse((await db.kvGet(await accountNamespace(this.email), 'channel-posts:' + ch.id)) || '[]');
          this.channelPosts[ch.id] = posts;
          this.channelUnread[ch.id] = posts.filter(p => p.ts > (ch.last_ts || 0)).length;
          this.channelsStore.setChannelAvatar(ch.id, (await db.kvGet('anon', 'channel-avatar:' + ch.id)) || '');
        }
      } catch (e) { console.error('Failed to load channels:', e); }
    },
    // Владелец переименовывает канал: локальный патч + meta-конверт
    // подписчикам (name/about летят тем же транспортом, что посты).
    async renameChannel(id) {
      const ch = this.channelById(id);
      this.closeChatMenu();
      if (!ch || !ch.is_owner) return;
      const name = prompt(uiStore.tr('channel_rename_prompt') || 'Новое название канала', ch.name || '');
      if (!name || !name.trim() || name.trim() === ch.name) return;
      ch.name = name.trim();
      try {
        await ChannelsFeature.updateChannel(id, { name: ch.name });
        const res = await ChannelsFeature.sendChannelMeta(ch, this.email);
        if (!res.relayOk && res.mailSent === 0 && (ch.known_subscribers || []).length) {
          uiStore.toast(uiStore.tr('channel_post_email_only') || 'Релей недоступен — пост ушёл только известным подписчикам', 4000);
        }
      } catch (e) { console.error('[channels] rename:', e); }
    },
    // Router helpers (features/incoming.js вызывает через ctx)
    channelById(id) { return this.channels.find(c => c.id === id) || null; },
    // Новый пост канала: сохраняем в kv-лог (аналог истории, только локально),
    // инкремент непрочитанных.
    noteChannelPost(chId, ts, payload, senderEmail) {
      const ch = this.channelById(chId);
      if (!ch) return;
      const posts = this.channelPosts[chId] || [];
      const body = (payload && payload.post && payload.post.body) || '';
      const images = (payload && payload.post && payload.post.images) || [];
      if (posts.some(p => p.id === payload.id)) return; // дедуп post.id
      posts.push({ id: payload.id, ts, body, images, sender: senderEmail || '' });
      posts.sort((a, b) => a.ts - b.ts);
      this.channelPosts[chId] = posts.slice(-200); // локальный лог компактный
      this.channelUnread[chId] = (this.channelUnread[chId] || 0) + 1;
      accountNamespace(this.email).then(ns =>
        db.kvSet(ns, 'channel-posts:' + chId, JSON.stringify(this.channelPosts[chId])).catch(() => {})
      );
    },
    noteChannelHello(chId, senderEmail) {
      console.log('[channel] hello from', senderEmail, '→ chan', chId);
    },
    setPeerKey(email, key, pq = null) {
      this.peerKeys[email] = key;
      // PQ: pq может прийти из конверта (env.pq) — сохраняем в
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
      identityStore.setPeerKeyInput('');
    },
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
      this.messages = [];
      this.newMessage = '';
      this.cancelReply();
      await this.restoreDraft(email);
      // показываем кэш прошлой сессии, пока идёт
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
          await this.loadEmails(true);
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
    scrollToBottom(force = false) {
      this.$nextTick(() => {
        const el = this.$refs.messageList && this.$refs.messageList.container;
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
      const el = this.$refs.messageList && this.$refs.messageList.container;
      if (!el) return;
      this.showJumpToBottom = el.scrollHeight - el.scrollTop - el.clientHeight > 200;
    },
    jumpToBottom() {
      const el = this.$refs.messageList && this.$refs.messageList.container;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      this.showJumpToBottom = false;
    },
    // --- Закрепление сообщения в группе (только админ) ---
    // Хранится в sqlite kv_store (pinned:<groupId>; последнее по дате — как
    // meta-аватар) + бродкастится письмом {pin:1, msg_id, action, preview}
    // под групповым ключом (stealth, пустая тема — единый проход
    // loadGroupMessages классифицирует по содержимому).
    async readPinned(groupId) { return MsgStore.readPinned(groupId); },
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
      // Форма pin-письма и её разбор — в features/group-pin-wire.js (ADR-003
      // партия 13). Раньше отправитель писал форму здесь, а приёмник читал её
      // в features/groups.js: две рукописные копии без общей проверки, и
      // расхождение заменялось бы ТИХО — 'op' вместо 'action' превращал бы
      // открепление в закрепление, без исключения и без записи в журнал.
      const decision = PinWire.buildPinDecision(msg, currentlyPinned);
      // Оптимистично применяем локально (SMTP-круг займёт десятки секунд).
      await this.setPinnedState(gid,
        decision.action === PinWire.PIN_ACTION.PIN ? decision : null);
      try {
        const groupKey = this.groupKeys[gid] || (await api.getMyGroupKey(gid))?.group_key;
        if (!groupKey) return;
        const content = await crypto.encryptWithGroupKey(
          JSON.stringify(PinWire.buildPinWirePayload(decision)), groupKey);
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
      const el = this.$refs.messageList && this.$refs.messageList.container;
      if (!el) return;
      const t = el.querySelector('[data-msg-id="' + CSS.escape(this.pinnedMsgId) + '"]');
      if (!t) { this.jumpToBottom(); return; }
      el.scrollTo({ top: t.offsetTop - 24, behavior: 'smooth' });
    },
    async selectGroup(group) {
      this.saveDraft(); // черновик прошлого чата
      this.messages = [];
      this.newMessage = '';
      this.cancelReply();
      await this.restoreDraft('group:' + group.id);
      const cachedGroup = await this.loadChatCache(`group:${group.id}`);
      if (cachedGroup && cachedGroup.length) {
        cachedGroup.sort((a, b) => this.msgTs(a) - this.msgTs(b));
        this.messages = cachedGroup;
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
            this.groups.setGroupKey(group.id, keyData.group_key);
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
              this.groups.setGroupKey(group.id, groupKeyHex);
            }
          }
        } catch (e) {
          console.warn('Could not load group key:', e);
        }
      }

      await this.loadGroupMessages(group.id);
      this.scrollToBottom(true);
    },
    // --- Заметки для себя
    // Хранятся ТОЛЬКО в localStorage (vault-notes-<email>), не шифруются,
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
      const env = {
        vault: 1,
        id: this.newMessageId(),
        text: text,
        name: name,
        avatar: avatar,
        ...(gavatar ? { gavatar } : {}),
        key: crypto.publicKey || '',
        ts: Date.now(),
      };
      // PQ: свой ML-KEM ek — получатель сохранит контакт и сможет
      // ответить гибридом (конверт несёт оба публичных ключа).
      if (crypto.pqEk) env.pq = crypto.pqEk;
      // M2.4 АВТООБМЕН токенами: конверт несёт мой relay read-токен —
      // адрес моей очереди. Получатель молча сохранит его и сможет
      // слать мне мгновенные пуши. Пользователь ничего не вводит.
      // Гейт this.relayEnabled СНЯТ (как в calls.js sendCallEnvelope):
      // адрес нашей очереди нужен собеседнику независимо от нашего
      // переключателя — иначе выключенный релей у одного ломает обмен.
      try {
        const { relays, active } = await (await import('./relay-client.js')).getSettings(this.email);
        const myTok = ((relays[active] || relays[0]) || {}).myToken || '';
        if (myTok) env.tok = myTok;
      } catch (e) { /* релей опционален */ }
      // Исчезающие сообщения: ttl в секундах от момента ПРОСМОТРА
      // получателем. 0 = обычное сообщение. Получатель ставит локальный
      // таймер удаления после показа (expireEphemeral).
      if (ttl && Number(ttl) > 0) env.ttl = Number(ttl);
      return JSON.stringify(env);
    },
    // Распарсить расшифрованный конверт. null = старый формат (простой текст).
    parseEnvelope(decrypted) { return MsgFormat.parseEnvelope(decrypted); },
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
      if (st === 'read') return uiStore.tr('status_read') || 'Read';
      if (st === 'delivered') return uiStore.tr('status_delivered') || 'Delivered';
      if (st === 'sending') return uiStore.tr('status_sending') || 'Sending';
      if (st === 'failed') {
        const who = msg.failedTo && msg.failedTo.length ? ': ' + msg.failedTo.join(', ') : '';
        return 'Not delivered' + who;
      }
      return uiStore.tr('status_sent') || 'Sent';
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
        const ok = await confirm(uiStore.tr('delete_message_confirm') || 'Удалить заметку?');
        if (!ok) return;
        const list = this.loadNotes().filter(n => n.id !== msg.id);
        this.saveNotes(list);
        this.messages = list;
        return;
      }
      const ok = await confirm(uiStore.tr('delete_message_confirm') || 'Удалить сообщение у всех?');
      if (!ok) return;
      // Оптимистично помечаем удалённым локально + tombstone (поллинг
      // не «воскресит» сообщение: письмо-оригинал и история фильтруются).
      this.addTombstone(msg.id);
      this.addMidTombstone(msg.mid);
      msg.deleted = true;
      msg.content = '';
      // (у получателей — после доставки delete-письма).
      const idx = this.messages.indexOf(msg);
      if (idx !== -1) this.messages.splice(idx, 1);
      const chatKey = this.activeChatType === 'group' && this.currentGroup
        ? 'group:' + this.currentGroup.id
        : this.activeChat;
      this.recordLocalEdit(chatKey, msg.id, null, 'delete');
      await this.sendEditEmail(msg.id, null, 'delete');
    },
    // «Удалить у меня»: убрать сообщение ТОЛЬКО со своего
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
      this.saveChatCache(chatKey, this.messages);
    },
    // ── Избранное ────────────────────────────────
    // Пометка сообщений только локально (как «Удалить у меня»): собеседнику
    // не видно, по почте не синхронизируется. Персист в sqlite kv_store под
    // ключом 'starred:<chatKey>' — переживает перезапуск и рескан из писем,
    // т.к. фильтр идёт по msg.id при рендере (звёздочка + режим избранного).
    isStarred(msg) {
      return !!(msg && msg.id && this.starredSet.has(msg.id));
    },
    async toggleStar(msg) {
      if (!msg || !msg.id) return;
      const key = this.currentChatKey;
      if (!key || key === '__notes__') return;
      const list = new Set(this.starredMap[key] || []);
      if (list.has(msg.id)) list.delete(msg.id);
      else list.add(msg.id);
      // Реактивность: новый объект массива, иначе Vue не увидит изменение.
      this.starredMap = { ...this.starredMap, [key]: Array.from(list) };
      try {
        if (list.size) await db.kvSet(await accountNamespace(this.email), 'starred:' + key, JSON.stringify(Array.from(list)));
        else await db.kvDelete(await accountNamespace(this.email), 'starred:' + key);
      } catch (e) { /* kv недоступен — живёт в памяти до перезапуска */ }
    },
    async loadStarredFor(chatKey) {
      if (!chatKey || chatKey === '__notes__') return;
      try {
        const raw = await db.kvGet(await accountNamespace(this.email), 'starred:' + chatKey);
        const arr = raw ? JSON.parse(raw) : [];
        this.starredMap = { ...this.starredMap, [chatKey]: Array.isArray(arr) ? arr : [] };
      } catch (e) { /* тихо */ }
    },
    // ── Сообщения 1:1 (логика в features/messages.js) — тонкий делегат ──
    async loadMessages(email) { return MessagesFeature.loadMessages(this, email); },
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
    async loadGroupMessages(groupId, forceRescan = false) { return GroupsFeature.loadGroupMessages(this, groupId, forceRescan); },
    // Мета-письма групп (VaultGroupMeta: <id>, аватар от админа) — для ВСЕХ
    // групп, где мы участники, а не только для открытой. Вызывается из
    // loadEmails (поллинг): участник, не открывавший группу после смены
    // аватара, всё равно получает его (sidebar + шапка при следующем
    // Список писем НЕ фетчим заново: берём уже загруженный this.emails
    // (loadEmails вызвал fetchEmails выше) — только тела новых meta-писем
    // подтягиваются по одному. Применённый uid кэшируем в localStorage,
    // чтобы не перечитывать одно и то же письмо на каждом поллинге.
    // ── Meta-сканирование групп (логика в features/group-meta.js) ──
    async syncGroupAvatarsFromMeta() { return GroupMetaFeature.syncGroupAvatarsFromMeta(this); },
    // Тонкие прокси во владельца группового состояния (ADR-004 Этап A9).
    // features/* вызывают ctx.setGroupKey — адресуем во владельца.
    setGroupKey(id, key) { return this.groups.setGroupKey(id, key); },
    setGroupAvatar(id, avatar) { return this.groups.setGroupAvatar(id, avatar); },
    clearGroupKeys() { return this.groups.clearGroupKeys(); },
    clearGroupAvatars() { return this.groups.clearGroupAvatars(); },
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
    // features/* вызывают ctx.login/logout/setEmails — адресуем во владельца.
    login() { return this.sessionStore.login(); },
    logout() { return this.sessionStore.logout(); },
    setEmails(list) { return this.sessionStore.setEmails(list); },
    clearEmails() { return this.sessionStore.clearEmails(); },
    emailCount() { return this.sessionStore.emailCount(); },
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
    async onAvatarUpdate(dataUrl) {
      this.userAvatarUrl = dataUrl
      // Локально: память + kv (переживёт перезапуск). НЕ шлём письмо —
      // контакты узнают ТОЛЬКО по «Сохранить» (единое письмо имя+аватар+статус).
      // ts = Date.now() — СВОЁ действие (иначе guard tsNum=0 блокирует запись
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
      await RecoveryFeature.loginWithRecovery(this, {
        api, crypto, invoke, db, relay, RelayFeature, initNotifications, t: this.t,
      });
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
      uiStore.toast(
        seconds > 0
          ? 'Исчезающие сообщения: ' + this.ephemeralLabel(seconds) + ' (новые сообщения в этом чате)'
          : 'Исчезающие сообщения выключены',
      );
    },
    async ephemeralTtlOf(chatId) { return MsgStore.ephemeralTtlOf(chatId); },
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

    // --- Key Recovery
    // Минимальный тост: сообщение внизу, автоскрытие (по умолчанию 5с).
    // ── Duress-замок ────────────────────────────────────────
    // (логика в features/duress.js; обёртки см. в блоке feature-обёрток выше)
    showToast(message, ms = 5000) {
      this.toastMessage = message;
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toastMessage = ''; }, ms);
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
                // Вариант A: автоматически копируем письмо во INBOX
                // чтобы провайдер не удалил его из спама. Если не вышло —
                // просим пользователя переложить вручную. В любом случае
                // предупреждаем, что письмо удалять нельзя.
                try {
                  await invoke('email_copy_to_inbox', { uid: String(m.uid), folder });
                  uiStore.toast(t('recovery_moved_toast'), 12000);
                } catch (e) {
                  console.warn('escrow copy to inbox failed:', e);
                  uiStore.toast(t('recovery_spam_folder') + folder + t('recovery_spam_move'), 15000);
                }
              } else {
                uiStore.toast(t('recovery_keep'), 8000);
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
    // Логика вынесена в features/recovery.js (изоляция фичи, ctx-паттерн):
    // parse/unwrap кандидата устойчивы к чужим/битым письмам, import_backup
    // бросается наружу. App.vue — только тонкий делегат.
    async recoverFromEscrow(mnemonic) {
      return RecoveryFeature.recoverFromEscrow(this, mnemonic, { api, crypto, invoke });
    },

    // Аватар группы обновил админ (GroupSettings): сохраняем локально и
    // рассылаем участникам meta-письмо (шифр групповым ключом) — как реакции.
    // Переименование группы: создатель/админ меняет имя. Обновляем
    // локально + рассылаем meta-письмо {meta:1, name} участникам — они
    // применяют при syncGroupMeta (как аватар).
    async onGroupRename({ groupId, name }) {
      const g = this.groups.find(x => x.id === groupId);
      if (g) g.name = name;
      if (this.currentGroup && this.currentGroup.id === groupId) this.currentGroup.name = name;
      // Локальное имя применено ДО рассылки и не откатывается при её отказе —
      // так было и раньше, поведение сохранено. Читать av и слать — в
      // features/group-meta-broadcast.js (ADR-003 Этап 3, партия 11).
      try {
        const curAv = await GroupMetaBroadcast.loadGroupAvatar(groupId);
        const fields = GroupMetaBroadcast.buildRenameMetaFields(name, curAv);
        const r = await GroupMetaBroadcast.broadcastGroupMeta(groupId, fields,
          { groupKeys: this.groupKeys, cryptoReady: this.cryptoReady });
        if (r.sent) console.log('[group] renamed', groupId, '→', name);
        else if (r.reason === 'no-group-key') {
          // Раньше здесь был молчаливый return, и это стоило дефекта: ключ не
          // загружен, пока группу не открыли в чате, поэтому ПЕРЕИМЕНОВАНИЕ из
          // настроек без открытия чата не рассылалось вообще. Тот же баг был
          // исправлен рядом, в onGroupAvatarUpdate, — теперь правило одно.
          console.warn('[group] rename broadcast skipped, no group key:', groupId);
        } else {
          console.warn('[group] rename broadcast failed:', r.error);
        }
      } catch (e) {
        console.warn('[group] rename broadcast failed:', e);
      }
    },
    async onGroupAvatarUpdate({ groupId, avatar }) {
      this.groups.setGroupAvatar(groupId, avatar);
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
      return GroupAvatarsFeature.healFromMessage(this, groupId, gavatar);
    },
    async replyGroupAvatarHeal(groupId) {
      return GroupAvatarsFeature.replyHeal(this, groupId);
    },
    async requestGroupAvatarHeal(groupId) {
      return GroupAvatarsFeature.requestHeal(this, groupId);
    },
    onAvatarFileSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        alert(uiStore.tr('err_file_too_big_2m'));
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
    // ── Отправка 1:1 (логика в features/send.js) — тонкий делегат ──
    async sendMessage() { return SendFeature.sendMessage(this); },
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
          alert(uiStore.tr('err_enter_email'));
          return;
        }
        const normalized = email.trim().toLowerCase();
        await crypto.savePeerKey(normalized, publicKeyHex, null);
        // ДЕДУП: тот же ключ уже известен под другим адресом (собеседник
        // сменил почту) — удаляем старую запись, чтобы контакт не
        // продублировался (QR от контакта, сменившего почту: одна запись).
        const oldSame = Object.keys(this.peerKeys).find(
          k => String(k).toLowerCase() !== normalized && this.peerKeys[k] === publicKeyHex
        );
        if (oldSame) {
          delete this.peerKeys[oldSame];
          delete this.peerPqKeys[oldSame];
          delete this.peerKeysLoaded[oldSame];
          try { await crypto.removePeerKey(oldSame); } catch {}
          api.removeContact(oldSame);
        }
        this.peerKeys[normalized] = publicKeyHex;
        this.peerKeysLoaded[normalized] = true;
        // ВЗАИМНОСТЬ: после QR-сканирования/вставки ключа отправляем
        // приглашение обратно — иначе у собеседника контакт не появится
        // (мы сохранили его ключ, а он наш — нет).
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
    imapCursorsKey(accountId) { return MsgFormat.imapCursorsKey(accountId); },
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
    // ── Загрузка писем (логика в features/emails.js) — тонкий делегат. ──
    async loadEmails(silent = false) { return EmailsFeature.loadEmails(this, silent); },
    // ── Непрочитанные + PUSH-уведомления ─────────
    // processIncoming классифицирует КАЖДЫЙ fetched-батч (поллинг или вход):
    // расшифровывает тела, отличает настоящие сообщения от квитанций/
    // инвайтов/meta (parseEnvelope), ведёт счётчики непрочитанных и
    // (при notify=true) шлёт системные уведомления. Контент НЕ показываем
    // (зашифровано + zero-metadata) — только имя отправителя/группы.
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
    async processIncoming(fetched, opts) { return IncomingFeature.processIncoming(this, fetched, opts); },
    // Виден ли чат сейчас: на mobile чат скрыт, когда пользователь на списке
    // контактов (mobileChatOpen=false), хотя activeChat ещё хранит прошлый чат.
    chatVisible(chatKey) {
      // Мобильная навигация: кнопка «назад» возвращает к списку чатов
      // (mobileChatOpen=false), но activeChat/activeChatType ещё хранят
      // прошлый чат. Без проверки mobileChatOpen для групп новые групповые
      // сообщения считались «видимыми» — ни бейджа, ни уведомления.
      if (chatKey.indexOf('group:') === 0) {
        return this.activeChatType === 'group' && this.activeChat === chatKey &&
          (!this.isMobile || this.mobileChatOpen);
      }
      return this.activeChatType === 'chat' && this.activeChat === chatKey &&
        (!this.isMobile || this.mobileChatOpen);
    },
    unreadOf(chatKey) {
      return this.chat.unreadOf(chatKey);
    },
    async loadUnreadCounts() {
      try {
        const raw = await db.kvGet(await accountNamespace(this.email), 'unread-counts');
        this.unreadCounts = raw ? JSON.parse(raw) : {};
        const seenRaw = await db.kvGet(await accountNamespace(this.email), 'unread-seen');
        this.processedUnreadIds = new Set(seenRaw ? JSON.parse(seenRaw) : []);
      } catch (e) { this.unreadCounts = {}; this.processedUnreadIds = new Set(); }
    },
    async saveUnreadSeen() {
      try {
        await db.kvSet(await accountNamespace(this.email), 'unread-seen', JSON.stringify(Array.from(this.processedUnreadIds)));
      } catch (e) { /* kv недоступен — дедуп живёт в памяти до перезапуска */ }
    },
    async saveUnreadCounts() {
      try {
        await db.kvSet(await accountNamespace(this.email), 'unread-counts', JSON.stringify(this.unreadCounts));
      } catch (e) { /* kv недоступен — счётчики живут в памяти до перезапуска */ }
    },
    async resetUnread(chatKey) {
      if (this.unreadOf(chatKey) > 0) {
        this.clearUnread(chatKey);
        await this.saveUnreadCounts();
      }
    },
    // архив + mute per-chat ─────────────────────
    // (загрузка/сохранение kv-блобов и папки — features/folders.js;
    //  обёртки см. в блоке feature-обёрток выше)
    isMuted(key) {
      // Ключи chatFlags — lowercased (flagKey); chatKey из processIncoming
      // может прийти в каноническом регистре контакта — нормализуем.
      return !!this.chatFlagOf(String(key || '').toLowerCase()).muted;
    },
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
      const p = period || (await db.kvGet('anon', 'autoclean-period')) || 'off';
      if (p === 'off' || !this.isLoggedIn) return;
      if (!Autoclean.periodDaysOf(p)) return;
      try {
        const acc = this.email || 'anon';
        const cutoff = Autoclean.autocleanCutoff(p);
        const r = await Autoclean.runPurge(acc, {
          emails: this.emails,
          emailBodyCache: this.emailBodyCache,
          bodyCacheOrder: this.bodyCacheOrder,
        }, cutoff);
        if (!r.applied) return;
        this.emails = r.applied.emails;
        this.emailBodyCache = r.applied.emailBodyCache;
        this.bodyCacheOrder = r.applied.bodyCacheOrder;
        this.persistBodyCache();
        console.info('[autoclean] purged', r.purged, 'bodies /', r.keys.length, 'msgs, period', p);
      } catch (e) {
        console.warn('[autoclean] failed:', e);
      }
    },
    openChatMenu(target, e) {
      e.preventDefault();
      e.stopPropagation();
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
      // Финальный клампинг по фактическому размеру меню (оценка выше —
      // статическая, реальных пунктов может быть больше/меньше).
      this.clampMenuAfterRender('chatMenu', x, y);
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
      if (!f.archived && !f.muted && !f.folder) delete this.chatFlags[key];
      else this.chatFlags[key] = f;
      this.closeChatMenu();
      await this.saveChatFlags();
    },
    // Ignore-лист из chat-меню (1:1-чат): блокировка E2E-честная — скрывает
    // новые сообщения/звонки у получателя, серверу невидим. После разблока
    // прошлое НЕ возвращается (его не было в истории).
    async toggleIgnoreContact() {
      const email = this.chatMenu.target && this.chatMenu.target.email;
      if (!email) return;
      const wasIgnored = this.isIgnored(email);
      if (wasIgnored) {
        await this.unignoreUser(email);
        uiStore.toast(uiStore.tr('ignore_off_toast') || 'Разблокирован');
      } else {
        await this.ignoreUser(email);
        // Открытый чат с ним: чистим экран от НОВЫХ (старые остаются),
        // иначе выглядело бы, что блок не работает.
        if (this.activeChatType === 'chat' && this.activeChat === email) {
          await this.loadMessages(this.activeChat);
        }
        uiStore.toast(uiStore.tr('ignore_on_toast') || 'Заблокирован');
      }
      this.closeChatMenu();
    },
    // Разблок из баннера открытого чата: новые сообщения снова показываются.
    async unblockActiveChat() {
      if (this.activeChatType !== 'chat' || !this.activeChat) return;
      await this.unignoreUser(this.activeChat);
      uiStore.toast(uiStore.tr('ignore_off_toast') || 'Разблокирован');
      // Подтягиваем письма, пришедшие за время блока? НЕТ — их не было в
      // истории (фильтр до расшифровки), возвращать их нечем. Просто
      // перерисовываем: баннер уходит, новые сообщения начинают приходить.
      await this.loadMessages(this.activeChat);
    },
    // Ignore из меню сообщения: 1:1 — адрес чата, группа — sender_id автора
    // (msgSenderEmail). Тост объясняет, что именно произошло.
    async blockSenderOfMessage(msg) {
      if (!msg || msg.from === 'me') return;
      const sender = this.msgSenderEmail(msg)
        || (this.activeChatType === 'chat' ? this.activeChat : '');
      if (!sender) return;
      if (this.isIgnored(sender)) {
        await this.unignoreUser(sender);
        uiStore.toast(uiStore.tr('ignore_off_toast') || 'Разблокирован');
      } else {
        await this.ignoreUser(sender);
        // Перестраиваем чат, если открыт с ним (1:1) — новые уже скрыты.
        if (this.activeChatType === 'chat' && this.activeChat === sender) {
          await this.loadMessages(this.activeChat);
        }
        uiStore.toast(uiStore.tr('ignore_on_toast') || 'Заблокирован');
      }
    },
    // (логика в features/folders.js; обёртки см. в блоке feature-обёрток выше)
    // Emoji
    insertEmoji(emoji) {
      this.newMessage += emoji
      this.showEmojiPicker = false
    },
    // ── Аудио/файлы-вложения (логика в features/attachments.js) ──
    async sendAudioMessage(audioData) { return AttachmentsFeature.sendAudioMessage(this, audioData); },
    async handleFileSelect(event) { return AttachmentsFeature.handleFileSelect(this, event); },
    // Мерж сохранённых реакций + реакций из писем — features/reactions.js.
    // Отправитель письма — мы сами: sender_id это сырой заголовок From
    // («Имя <email>» или просто email). userId — рудимент серверной эпохи,
    // в serverless он всегда null, поэтому сравниваем по своему email
    // (тот же приём, что isOut в 1-на-1 пути loadMessages).
    isOwnSender(senderId) {
      if (!senderId || !this.email) return false;
      const s = String(senderId).toLowerCase();
      // Свои письма могли прийти и со СТАРОГО адреса (смена почты) —
      // проверяем все свои алиасы (aliasesOf: один pubkey → все адреса).
      return this.aliasesOf(this.email).some(a => s.includes(a));
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
      if (msg == null) return '';
      const raw = typeof msg === 'string' ? msg : msg.sender_id || '';
      return this.senderEmail(raw);
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
      // иначе при медленном SMTP (30-60с) следующий поллинг (30с) считает
      // fresh заново и уходит вторая копия квитанции (в ящиках лежали дубли
      // {read:1} с одинаковыми msg_ids — «письма отправляются циклично»).
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
    // жёлтую точку, пока получатель не откроет чат (тогда уходила read).
    // Групповые письма здесь не обрабатываются (шифр групповым ключом —
    // decryptVault с пир-ключом не пройдёт); для групп статусы — как прежде.
    // ── Квитанции о доставке (логика в features/receipts.js) ──
    async sendDeliveredReceipts(fetched) { return ReceiptsFeature.sendDeliveredReceipts(this, fetched); },
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
    onMessageTextClick(e) {
      const urlEl = e.target.closest('a[data-url]');
      if (urlEl) { e.preventDefault(); openExternal(urlEl.dataset.url).catch(() => {}); return; }
      const phoneEl = e.target.closest('a[data-phone]');
      if (phoneEl) { e.preventDefault(); this.copyText(phoneEl.dataset.phone); }
    },
    // ADR-003 Этап 3: извлечение телефонов и ссылок — в message-format.js.
    // Регулярка телефона теперь ОДНА на этот метод и linkify: копии в App.vue
    // и в модуле разъехались бы, и в меню попадал бы другой набор номеров,
    // чем в тексте сообщения.
    openMessageMenu(event, msg) {
      // меню открывается, шаблон прячет неприменимое по msg.callEvent.
      const content = msg.callEvent ? '' : (msg.content || '');
      const { phones, urls } = MsgFormat.extractPhonesAndUrls(content);
      // Android WebView при долгом нажатии иногда присылает clientX/Y=0
      // (как в openChatMenu) — берём координаты пузыря, иначе меню в углу.
      let x = event.clientX, y = event.clientY;
      if (!x && !y && event.target && event.target.getBoundingClientRect) {
        const r = event.target.getBoundingClientRect();
        x = r.left + 12;
        y = r.bottom + 4;
      }
      this.messageMenu = { x, y, msg, phones, urls };
      // Клампинг по фактическому размеру (после рендера): без него меню
      // уходит за нижний/правый край — последнее сообщение при полном
      // экране на десктопе, на телефоне — за оба края.
      this.clampMenuAfterRender('messageMenu', x, y);
    },
    // Измерить отрендеренное .message-menu и втянуть в экран. Меню
    // динамическое (пункты скрываются), поэтому размер берём из DOM,
    // а не оцениваем. Оверлей один на экране (v-if + inset:0 перехватывает
    // ввод), так что querySelector находит именно открытое меню.
    async clampMenuAfterRender(key, x, y) {
      await this.$nextTick();
      const mm = this[key];
      if (!mm || mm.x !== x || mm.y !== y || (key === 'chatMenu' && !mm.show)) return;
      const el = document.querySelector('.message-menu');
      if (!el) return;
      const M = 8;
      const w = el.offsetWidth + 2;  // + границы
      const h = el.offsetHeight + 2;
      const nx = Math.max(M, Math.min(x, window.innerWidth - w - M));
      const ny = Math.max(M, Math.min(y, window.innerHeight - h - M));
      if (nx !== x || ny !== y) this[key] = { ...mm, x: nx, y: ny };
    },
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
      if (!this.newGroupName.trim()) return;
      try {
        const { group, groupKey } = await GroupsCreate.createGroup({
          name: this.newGroupName, avatar: this.newGroupAvatar, cryptoReady: this.cryptoReady,
          onCreated: ({ group: g, avatar: av }) => {
            if (av) this.groups.setGroupAvatar(g.id, av);
            this.groups.push(g);
            this.currentGroup = g;
          },
        });
        if (groupKey) this.groups.setGroupKey(group.id, groupKey);
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
      const src = this.currentGroup;
      if (!src || src.created_by !== this.email) return;
      const base = (src.name || 'Группа').trim();
      const name = prompt(uiStore.tr('group_clone_prompt') || 'Имя новой группы (клон)', base + ' 2');
      if (!name || !name.trim()) return;
      this.showGroupSettings = false;
      try {
        // group и avatar не деструктурируем: они уже применены в onCreated.
        const { invited, skipped } = await GroupsClone.cloneGroup({
          src, name, email: this.email, peerKeys: this.peerKeys, publicKey: this.publicKey,
          onCreated: ({ group: g, avatar: av }) => {
            if (av) this.groups.setGroupAvatar(g.id, av);
            this.groups.push(g);
            this.currentGroup = g;
            if (g.group_key) this.groups.setGroupKey(g.id, g.group_key);
          },
        });
        const msg = (uiStore.tr('group_clone_done') || 'Клон создан')
          + (invited.length ? ': ' + uiStore.tr('group_clone_invited') + ' ' + invited.join(', ') : '')
          + (skipped.length ? '\n' + (uiStore.tr('group_clone_skipped') || 'пропущены (нет ключа)') + ': ' + skipped.join(', ') : '');
        alert(msg);
      } catch (e) {
        console.error('cloneGroup failed:', e);
        alert((uiStore.tr('group_clone_failed') || 'Не удалось создать клон') + ': ' + e.message);
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
    async inviteSelectedMembers() { return MembersFeature.inviteSelectedMembers(this); },
    // --- Инвайты группы + запросы контактов 1-на-1: попапы согласия ---
    // ── Приглашения в группы (логика в features/invites.js) ──
    async processInvites() { return InvitesFeature.processInvites(this); },
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
        // Дубль-инвайт: группа уже есть локально (приглашение принято ранее).
        // Это НЕ ошибка — тихо сообщаем (ключ уже помечен обработанным выше).
        if (this.groups.some(g => g.id === inv.group_id)) {
          uiStore.toast((uiStore.tr('already_in_groups') || 'Вы уже состоите в этой группе') + ': ' + (inv.group_name || inv.group_id), 3000);
          this.showNextInvite();
          return;
        }
        // Новый формат: group_key зашифрован на нашем публичном ключе —
        // расшифровываем своим приватным ключом (ECDH + sender_public_key).
        let groupKey = inv.group_key || null;
        if (!groupKey && inv.group_key_enc && inv.sender_public_key && this.cryptoReady) {
          groupKey = await crypto.decryptGroupKey(inv.group_key_enc, inv.sender_public_key);
          if (!groupKey) throw new Error('Не удалось расшифровать ключ группы');
        }
        if (!groupKey) throw new Error('В приглашении нет ключа группы');
        await api.acceptGroupInvite(inv.group_id, { ...inv, group_key: groupKey });
        // Аватар группы из инвайта — сохраняем в kv_store.
        if (inv.group_avatar) {
          await db.kvSet('anon', 'group-avatar:' + inv.group_id, inv.group_avatar);
          this.groups.setGroupAvatar(inv.group_id, inv.group_avatar);
        }
        await this.loadGroups();
          try { await this.loadChannels(); } catch (e) { /* не критично */ }
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
        // Дубль-инвайт: контакт уже есть (приглашение уже принято).
        // Поллинг обычно фильтрует таких (peers.has в fetchPendingContactInvites),
        // но два письма от одного отправителя могут прийти одним пакетом —
        // это НЕ ошибка: помечаем обработанным и тихо сообщаем.
        let exists = !!this.peerKeys[c.sender];
        if (!exists) {
          try { exists = (await api.loadPeerKeyEmails()).has(c.sender); }
          catch (e) { /* с диска не прочитать — считаем новым */ }
        }
        if (exists) {
          await api.markAcceptedContact(key);
          uiStore.toast((uiStore.tr('already_in_contacts') || 'Этот контакт уже в вашем списке') + ': ' + c.sender, 3000);
          this.showNextContact();
          return;
        }
        // PQ: pq-ключ приглашающего (если прислал) — контакт сразу
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
        api.saveProfile(c.sender, c.sender_name, c.sender_avatar,
          Date.parse(c.date) || Date.now());
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
      // Проверяем память И диск: ключ мог быть загружен с диска позже,
      // а in-memory peerKeys ещё не заполнен.
      // exists-check по трём источникам: (1) in-memory peerKeys, (2) список
      // контактов, который показывает UI (this.contacts — виден даже если
      // in-memory peerKeys ещё не заполнен), (3) диск loadPeerKeyEmails.
      // Любой найден → дубль, тост «уже в списке» (защита от повторных
      // приглашений принятым контактам).
      const low = id.toLowerCase();
      let exists = !!this.peerKeys[id] || !!this.peerKeys[low];
      if (!exists && Array.isArray(this.contacts)) {
        exists = this.contacts.some(c => (c && c.email || '').toLowerCase() === low);
      }
      if (!exists) {
        try {
          exists = [...(await api.loadPeerKeyEmails())].some(e => e === id || e.toLowerCase() === low);
        } catch (e) { /* диск недоступен — считаем новым */ }
      }
      if (exists) {
        uiStore.toast((uiStore.tr('already_in_contacts') || 'Этот контакт уже в вашем списке') + ': ' + id, 3000);
        return;
      }
      try {
        await api.sendContactInvite(id, this.publicKey);
        uiStore.toast((uiStore.tr('invite_sent') || 'Приглашение отправлено') + ': ' + id, 3000);
      } catch (e) {
        // Tauri-команды отклоняют СТРОКОЙ (Rust Err(e.to_string())), не
        // Error-объектом: e.message может быть undefined — нормализуем.
        const emsg = (e && e.message) ? e.message : String(e);
        uiStore.toast((uiStore.tr('invite_send_failed') || 'Не удалось отправить приглашение: ') + emsg, 5000);
      }
    },
    async deleteContact(email) {
      if (!(await confirm(uiStore.tr('contact_delete_confirm') || 'Удалить контакт? Его ключ шифрования будет удалён.'))) return;
      try {
        // Четыре шага и их порядок — в features/contacts-delete.js (ADR-003
        // Этап 3, партия 14). Порядок содержателен: снести ключ, пометить старые
        // handshake по uid (НОВЫЕ приглашения должны доходить), снять наше
        // приглашение, убрать stub. Отказ любого шага останавливает остальные —
        // полуудалённый контакт хуже неудалённого.
        await ContactsDelete.deleteContactLocally(email);
        delete this.peerKeys[email];
        delete this.peerKeysLoaded[email];
        const st = ContactsDelete.contactRemovalState(email, this);
        if (st.closeChat) {
          this.activeChat = null;
          this.activeChatType = st.activeChatType;
        }
        await this.loadContacts();
      } catch (e) {
        // Состояние НЕ применяется: ключ мог снестись, а запись остаться.
        alert('Failed to delete contact: ' + e.message);
      }
    },
    // --- Профили (имя/аватар отправителей в групповых чатах) ---
    // ── Ignore-лист в GroupSettings: с 0.1.165 «заблокированные» группы —
    // это глобальный ignore-лист получателя (E2E-модель), а не декоративный
    // group.blocked (который никто не читал и который не персистился).
    async blockUser(email) {
      if (!this.currentGroup || !email) return;
      await this.ignoreUser(email);
      uiStore.toast(uiStore.tr('ignore_on_toast') || 'Заблокирован: новые сообщения и звонки скрыты');
    },
    async unblockUser(email) {
      if (!email) return;
      await this.unignoreUser(email);
      uiStore.toast(uiStore.tr('ignore_off_toast') || 'Разблокирован');
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