<template>
  <div
    :data-msg-id="msg.id"
    :class="['message', { own: msg.from === 'me', 'call-event': !!msg.callEvent, 'drag-over-before': dragOverId === msg.id && dragOverPos === 'before', 'drag-over-after': dragOverId === msg.id && dragOverPos === 'after' }]"
    :draggable="notes"
    @dragstart="$emit('note-drag-start', $event, msg)"
    @dragover="$emit('note-drag-over', $event, msg)"
    @dragleave="$emit('note-drag-leave', $event, msg)"
    @drop="$emit('note-drop', $event, msg)"
    @dragend="$emit('note-drag-end')"
    @click.stop="$emit('toggle-reaction-picker', msg.id)"
    @contextmenu.prevent="$emit('context-menu', $event, msg)"
  >
    <!-- Звонки: «пилюля» пропущенного/завершённого вызова
         Текст только через t.
         -->
    <div v-if="msg.callEvent" class="call-pill" :class="'call-pill--' + msg.callEvent.kind">
      <Icon :name="callPillIcon(msg)" :size="13" color="currentColor" />
      <span class="call-pill-label">{{ callEventLabel(msg) }}</span>
      <span class="call-pill-time">{{ msg.time }}</span>
      <button v-if="canCallBack(msg)" class="call-back-btn" :title="t('call_back')" @click.stop="$emit('call-back')">
        <Icon name="phone" :size="12" color="currentColor" />{{ t('call_back') }}
      </button>
    </div>
    <template v-else>
    <!-- Отправитель в групповом чате (имя/аватар из профиля) -->
    <div v-if="isGroup && msg.from !== 'me'" class="message-sender">
      <UserAvatar :email="senderOf(msg)" :avatarUrl="avatarOf(senderOf(msg))" :size="26" />
      <span class="message-sender-name">{{ nameOf(senderOf(msg)) }}</span>
    </div>
    <div class="message-content">
      <template v-if="msg.deleted">
        <Icon name="ban" :size="13" /> <span class="message-deleted">{{ t('message_deleted') || 'Сообщение удалено' }}</span>
      </template>
      <template v-else>
      <div v-if="hasReplyQuote(msg.content)" class="reply-quote">{{ replyQuote(msg.content) }}</div>
      <!-- Голосование: карточка вместо текста (poll-конверт) -->
      <div v-if="msg.poll" class="poll-card">
        <div class="poll-title"><Icon name="bar-chart" :size="14" /> {{ msg.poll.question }}</div>
        <button v-for="(opt, i) in msg.poll.options" :key="i"
                class="poll-option"
                :class="{ 'poll-option-mine': msg.poll.myVote === i, 'poll-option-lead': pollLead(msg.poll) === i }"
                :disabled="msg.poll.closed || msg.poll.myVote !== null"
                @click.stop="$emit('poll-vote', msg, i)">
          <span class="poll-option-label">{{ opt }}</span>
          <span class="poll-option-count" v-if="pollVotes(msg.poll).total">{{ pollOptionCount(msg.poll, i) }}</span>
          <span class="poll-check" v-if="msg.poll.myVote === i">✓</span>
        </button>
        <div class="poll-footer" v-if="pollVotes(msg.poll).total">
          {{ pollVotes(msg.poll).voters }} {{ t('poll_voted') }} · {{ pollLeadLabel(msg.poll) }}
        </div>
      </div>
      <span v-else v-html="linkify(replyBody(msg.content))" @click="$emit('text-click')"></span>
      <span v-if="msg.edited" class="message-edited-badge" :title="t('edited') || 'Отредактировано'">✎</span>
      <div v-if="msg.attachment && msg.attachment.isImage" class="attachment-preview">
        <img :src="'data:' + msg.attachment.type + ';base64,' + msg.attachment.data"
             :alt="msg.attachment.name"
             class="attachment-image"
             @click="$emit('open-image', msg.attachment)" />
        <button class="attachment-dl-btn" @click.stop="$emit('download', msg.attachment)"><Icon name="download" :size="13" /> {{ t('download') || 'Скачать' }}</button>
      </div>
      <div v-else-if="msg.attachment && msg.attachment.isAudio" class="attachment-preview">
        <audio controls class="attachment-audio"
               :src="'data:' + msg.attachment.type + ';base64,' + msg.attachment.data"></audio>
        <button class="attachment-dl-btn" @click.stop="$emit('download', msg.attachment)"><Icon name="download" :size="13" /> {{ t('download') || 'Скачать' }}</button>
      </div>
      <div v-else-if="msg.attachment && msg.attachment.isText" class="attachment-preview">
        <pre class="attachment-text">{{ msg.attachment.textContent }}</pre>
        <button class="attachment-dl-btn" @click.stop="$emit('download', msg.attachment)"><Icon name="download" :size="13" /> {{ t('download') || 'Скачать' }}</button>
      </div>
      <div v-else-if="msg.attachment" class="attachment-preview">
        <div class="attachment-file" @click.stop="$emit('download', msg.attachment)">
          <Icon name="file" :size="13" /> {{ msg.attachment.name }} ({{ (msg.attachment.size / 1024).toFixed(1) }}KB)
          <span class="attachment-dl-btn"><Icon name="download" :size="13" /> {{ t('download') || 'Скачать' }}</span>
        </div>
      </div>
      </template>
    </div>
    <!-- Reply button (visible on hover) -->
    <button class="reply-btn" :title="t('chat_reply_to') || 'Reply'" @click.stop="$emit('reply', msg)"><Icon name="reply" :size="13" /></button>
    <!-- Copy button (visible on hover) -->
    <button class="copy-btn" :title="t('copy_text') || 'Копировать текст'" @click.stop="$emit('copy-text', msg)"><Icon name="copy" :size="13" /></button>
    <!-- Pin — только админ группы (hover) -->
    <button v-if="isGroup && isAdmin" class="pin-btn" :title="t('pin_message') || 'Закрепить'" @click.stop="$emit('pin', msg)"><Icon name="pin" :size="13" /></button>
    <!-- Edit/Delete — только свои сообщения (видны на hover) -->
    <button v-if="msg.from === 'me' && !msg.deleted" class="edit-btn" :title="t('edit_message') || 'Редактировать'" @click.stop="$emit('edit', msg)"><Icon name="pencil" :size="13" /></button>
    <button v-if="msg.from === 'me' && !msg.deleted" class="delete-btn" :title="t('delete_message') || 'Удалить'" @click.stop="$emit('delete', msg)"><Icon name="trash" :size="13" /></button>
    <!-- Reactions -->
    <div class="message-reactions" v-if="msg.reactions && msg.reactions.length">
      <span
        v-for="(r, ri) in msg.reactions"
        :key="ri"
        class="reaction-badge"
        @click.stop="$emit('toggle-reaction', msg.id, r)"
      >{{ r }}</span>
    </div>
    <div class="message-footer">
      <!-- Пометка «Избранное»: звёздочка рядом с временем -->
      <Icon v-if="isStarred(msg)" name="star" :size="11" cls="msg-starred-icon" />
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
      v-if="reactionPickerId === msg.id"
      class="reaction-picker"
      @click.stop
    >
      <button v-for="emoji in quickReactions" :key="emoji" class="reaction-emoji" @click="$emit('add-reaction', msg.id, emoji)">{{ emoji }}</button>
    </div>
    </template>
  </div>
</template>

<script setup>
import { useI18n } from '../i18n.js'
import Icon from './Icon.vue'
import UserAvatar from './UserAvatar.vue'

// Карточка сообщения (Этап 3 декомпозиции App.vue): презентационный
// компонент — текст/вложения/опросы/reactions/статусы рендерятся здесь,
// вся логика (шифрование, отправка, drag-заметок) остаётся в App +
// features/*.js и дёргается событиями.
const { t } = useI18n()

defineProps({
  msg: { type: Object, required: true },
  isGroup: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  notes: { type: Boolean, default: false },
  dragOverId: { type: String, default: '' },
  dragOverPos: { type: String, default: '' },
  reactionPickerId: { type: String, default: '' },
  quickReactions: { type: Array, default: () => [] },
  // функции-рендеры родителя (текст-хелперы и колбэки карточки)
  nameOf: { type: Function, required: true },
  avatarOf: { type: Function, required: true },
  senderOf: { type: Function, required: true },
  linkify: { type: Function, required: true },
  replyBody: { type: Function, required: true },
  replyQuote: { type: Function, required: true },
  hasReplyQuote: { type: Function, required: true },
  statusTitle: { type: Function, required: true },
  isStarred: { type: Function, required: true },
  callPillIcon: { type: Function, required: true },
  callEventLabel: { type: Function, required: true },
  canCallBack: { type: Function, required: true },
  pollLead: { type: Function, required: true },
  pollVotes: { type: Function, required: true },
  pollOptionCount: { type: Function, required: true },
  pollLeadLabel: { type: Function, required: true },
})

defineEmits([
  'context-menu', 'toggle-reaction-picker', 'toggle-reaction', 'add-reaction',
  'note-drag-start', 'note-drag-over', 'note-drag-leave', 'note-drop', 'note-drag-end',
  'reply', 'copy-text', 'pin', 'edit', 'delete', 'poll-vote',
  'open-image', 'download', 'text-click', 'call-back',
])
</script>

<!-- Стили карточки (.message*, call-pill, attachment*, reaction*, poll-card
     внутри сообщения) — scoped здесь; глобально в App.vue пока остаются
     правила media/touch, трогающие .message-content (перейдут с поздними
     шагами). -->
