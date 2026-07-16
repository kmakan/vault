<template>
  <div class="emoji-picker" v-if="show">
    <div class="emoji-picker__header">
      <input
        type="text"
        class="emoji-search"
        :placeholder="t('general_search') + '...'"
        v-model="searchQuery"
        ref="searchInput"
      />
      <button class="emoji-close" @click="$emit('close')">✕</button>
    </div>
    <div class="emoji-picker__categories">
      <button
        v-for="cat in categories"
        :key="cat.id"
        :class="['cat-btn', { active: activeCategory === cat.id }]"
        @click="activeCategory = cat.id"
      >{{ cat.icon }}</button>
    </div>
    <div class="emoji-picker__grid" ref="grid">
      <div
        v-for="emoji in filteredEmojis"
        :key="emoji.id"
        class="emoji-item"
        @click="selectEmoji(emoji)"
        :title="emoji.name"
      >{{ emoji.native }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from '../i18n.js'

const { t } = useI18n()

const props = defineProps({
  show: { type: Boolean, default: false },
})

const emit = defineEmits(['select', 'close'])

const searchQuery = ref('')
const activeCategory = ref('smileys')
const searchInput = ref(null)

const categories = [
  { id: 'smileys', icon: '😀', name: 'Smileys' },
  { id: 'people', icon: '👋', name: 'People' },
  { id: 'nature', icon: '🌿', name: 'Nature' },
  { id: 'food', icon: '🍔', name: 'Food' },
  { id: 'activities', icon: '⚽', name: 'Activities' },
  { id: 'travel', icon: '🚗', name: 'Travel' },
  { id: 'objects', icon: '💡', name: 'Objects' },
  { id: 'symbols', icon: '❤️', name: 'Symbols' },
  { id: 'flags', icon: '🏁', name: 'Flags' },
  { id: 'whisper', icon: '🔐', name: 'Whisper' },
  { id: 'crypto', icon: '₿', name: 'Crypto' },
  { id: 'comms', icon: '📡', name: 'Communication' },
]

// Curated emoji set (most used)
const allEmojis = [
  // Smileys
  { id: 'grinning', native: '😀', category: 'smileys', name: 'Grinning' },
  { id: 'joy', native: '😂', category: 'smileys', name: 'Joy' },
  { id: 'smiley', native: '😃', category: 'smileys', name: 'Smiley' },
  { id: 'wink', native: '😉', category: 'smileys', name: 'Wink' },
  { id: 'heart_eyes', native: '😍', category: 'smileys', name: 'Heart Eyes' },
  { id: 'thinking', native: '🤔', category: 'smileys', name: 'Thinking' },
  { id: 'neutral', native: '😐', category: 'smileys', name: 'Neutral' },
  { id: 'expressionless', native: '😑', category: 'smileys', name: 'Expressionless' },
  { id: 'unamused', native: '😒', category: 'smileys', name: 'Unamused' },
  { id: 'sweat', native: '😓', category: 'smileys', name: 'Sweat' },
  { id: 'pensive', native: '😔', category: 'smileys', name: 'Pensive' },
  { id: 'confused', native: '😕', category: 'smileys', name: 'Confused' },
  { id: 'confounded', native: '😖', category: 'smileys', name: 'Confounded' },
  { id: 'kissing_heart', native: '😘', category: 'smileys', name: 'Kissing Heart' },
  { id: 'stuck_out_tongue_winking', native: '😜', category: 'smileys', name: 'Stuck Out Tongue Winking' },
  { id: 'stuck_out_tongue', native: '😛', category: 'smileys', name: 'Stuck Out Tongue' },
  { id: 'disappointed', native: '😞', category: 'smileys', name: 'Disappointed' },
  { id: 'worried', native: '😟', category: 'smileys', name: 'Worried' },
  { id: 'angry', native: '😠', category: 'smileys', name: 'Angry' },
  { id: 'rage', native: '😡', category: 'smileys', name: 'Rage' },
  { id: 'cry', native: '😢', category: 'smileys', name: 'Cry' },
  { id: 'sob', native: '😭', category: 'smileys', name: 'Sob' },
  { id: 'scream', native: '😱', category: 'smileys', name: 'Scream' },
  { id: 'cold_sweat', native: '😰', category: 'smileys', name: 'Cold Sweat' },
  { id: 'hushed', native: '😯', category: 'smileys', name: 'Hushed' },
  { id: 'sleeping', native: '😴', category: 'smileys', name: 'Sleeping' },
  { id: 'drool', native: '🤤', category: 'smileys', name: 'Drool' },
  { id: 'dizzy_face', native: '😵', category: 'smileys', name: 'Dizzy Face' },
  { id: 'money_mouth', native: '🤑', category: 'smileys', name: 'Money Mouth' },
  { id: 'nerd', native: '🤓', category: 'smileys', name: 'Nerd' },
  { id: 'sunglasses', native: '😎', category: 'smileys', name: 'Sunglasses' },
  { id: 'cowboy', native: '🤠', category: 'smileys', name: 'Cowboy' },
  { id: 'clown', native: '🤡', category: 'smileys', name: 'Clown' },
  { id: 'ghost', native: '👻', category: 'smileys', name: 'Ghost' },
  { id: 'skull', native: '💀', category: 'smileys', name: 'Skull' },
  { id: 'alien', native: '👽', category: 'smileys', name: 'Alien' },
  { id: 'robot', native: '🤖', category: 'smileys', name: 'Robot' },
  // People
  { id: 'thumbsup', native: '👍', category: 'people', name: 'Thumbs Up' },
  { id: 'thumbsdown', native: '👎', category: 'people', name: 'Thumbs Down' },
  { id: 'ok_hand', native: '👌', category: 'people', name: 'OK Hand' },
  { id: 'punch', native: '👊', category: 'people', name: 'Punch' },
  { id: 'fist', native: '✊', category: 'people', name: 'Fist' },
  { id: 'wave', native: '👋', category: 'people', name: 'Wave' },
  { id: 'clap', native: '👏', category: 'people', name: 'Clap' },
  { id: 'pray', native: '🙏', category: 'people', name: 'Pray' },
  { id: 'muscle', native: '💪', category: 'people', name: 'Muscle' },
  { id: 'heart', native: '❤️', category: 'people', name: 'Heart' },
  { id: 'orange_heart', native: '🧡', category: 'people', name: 'Orange Heart' },
  { id: 'yellow_heart', native: '💛', category: 'people', name: 'Yellow Heart' },
  { id: 'green_heart', native: '💚', category: 'people', name: 'Green Heart' },
  { id: 'blue_heart', native: '💙', category: 'people', name: 'Blue Heart' },
  { id: 'purple_heart', native: '💜', category: 'people', name: 'Purple Heart' },
  { id: 'black_heart', native: '🖤', category: 'people', name: 'Black Heart' },
  { id: 'broken_heart', native: '💔', category: 'people', name: 'Broken Heart' },
  { id: 'fire', native: '🔥', category: 'people', name: 'Fire' },
  { id: 'star', native: '⭐', category: 'people', name: 'Star' },
  { id: '100', native: '💯', category: 'people', name: '100' },
  { id: 'sparkles', native: '✨', category: 'people', name: 'Sparkles' },
  { id: 'eyes', native: '👀', category: 'people', name: 'Eyes' },
  { id: 'point_up', native: '☝️', category: 'people', name: 'Point Up' },
  { id: 'point_down', native: '👇', category: 'people', name: 'Point Down' },
  { id: 'point_left', native: '👈', category: 'people', name: 'Point Left' },
  { id: 'point_right', native: '👉', category: 'people', name: 'Point Right' },
  // Nature
  { id: 'seedling', native: '🌱', category: 'nature', name: 'Seedling' },
  { id: 'herb', native: '🌿', category: 'nature', name: 'Herb' },
  { id: 'tree', native: '🌳', category: 'nature', name: 'Tree' },
  { id: 'cactus', native: '🌵', category: 'nature', name: 'Cactus' },
  { id: 'flower', native: '🌸', category: 'nature', name: 'Flower' },
  { id: 'sunflower', native: '🌻', category: 'nature', name: 'Sunflower' },
  { id: 'sun', native: '☀️', category: 'nature', name: 'Sun' },
  { id: 'moon', native: '🌙', category: 'nature', name: 'Moon' },
  { id: 'star2', native: '🌟', category: 'nature', name: 'Star' },
  { id: 'rainbow', native: '🌈', category: 'nature', name: 'Rainbow' },
  { id: 'cloud', native: '☁️', category: 'nature', name: 'Cloud' },
  { id: 'snowflake', native: '❄️', category: 'nature', name: 'Snowflake' },
  { id: 'fire2', native: '🔥', category: 'nature', name: 'Fire' },
  { id: 'droplet', native: '💧', category: 'nature', name: 'Droplet' },
  { id: 'ocean', native: '🌊', category: 'nature', name: 'Ocean' },
  // Food
  { id: 'apple', native: '🍎', category: 'food', name: 'Apple' },
  { id: 'pizza', native: '🍕', category: 'food', name: 'Pizza' },
  { id: 'hamburger', native: '🍔', category: 'food', name: 'Hamburger' },
  { id: 'fries', native: '🍟', category: 'food', name: 'Fries' },
  { id: 'coffee', native: '☕', category: 'food', name: 'Coffee' },
  { id: 'beer', native: '🍺', category: 'food', name: 'Beer' },
  { id: 'wine', native: '🍷', category: 'food', name: 'Wine' },
  { id: 'cake', native: '🎂', category: 'food', name: 'Cake' },
  { id: 'cookie', native: '🍪', category: 'food', name: 'Cookie' },
  { id: 'chocolate', native: '🍫', category: 'food', name: 'Chocolate' },
  // Activities
  { id: 'soccer', native: '⚽', category: 'activities', name: 'Soccer' },
  { id: 'basketball', native: '🏀', category: 'activities', name: 'Basketball' },
  { id: 'football', native: '🏈', category: 'activities', name: 'Football' },
  { id: 'baseball', native: '⚾', category: 'activities', name: 'Baseball' },
  { id: 'tennis', native: '🎾', category: 'activities', name: 'Tennis' },
  { id: 'golf', native: '⛳', category: 'activities', name: 'Golf' },
  { id: 'trophy', native: '🏆', category: 'activities', name: 'Trophy' },
  { id: 'medal', native: '🏅', category: 'activities', name: 'Medal' },
  { id: 'game', native: '🎮', category: 'activities', name: 'Game' },
  { id: 'dice', native: '🎲', category: 'activities', name: 'Dice' },
  // Travel
  { id: 'car', native: '🚗', category: 'travel', name: 'Car' },
  { id: 'airplane', native: '✈️', category: 'travel', name: 'Airplane' },
  { id: 'rocket', native: '🚀', category: 'travel', name: 'Rocket' },
  { id: 'ship', native: '🚢', category: 'travel', name: 'Ship' },
  { id: 'hotel', native: '🏨', category: 'travel', name: 'Hotel' },
  { id: 'house', native: '🏠', category: 'travel', name: 'House' },
  { id: 'office', native: '🏢', category: 'travel', name: 'Office' },
  { id: 'hospital', native: '🏥', category: 'travel', name: 'Hospital' },
  { id: 'church', native: '⛪', category: 'travel', name: 'Church' },
  { id: 'mountain', native: '⛰️', category: 'travel', name: 'Mountain' },
  // Objects
  { id: 'bulb', native: '💡', category: 'objects', name: 'Bulb' },
  { id: 'wrench', native: '🔧', category: 'objects', name: 'Wrench' },
  { id: 'hammer', native: '🔨', category: 'objects', name: 'Hammer' },
  { id: 'key', native: '🔑', category: 'objects', name: 'Key' },
  { id: 'lock', native: '🔒', category: 'objects', name: 'Lock' },
  { id: 'unlock', native: '🔓', category: 'objects', name: 'Unlock' },
  { id: 'mail', native: '📧', category: 'objects', name: 'Mail' },
  { id: 'phone', native: '📱', category: 'objects', name: 'Phone' },
  { id: 'computer', native: '💻', category: 'objects', name: 'Computer' },
  { id: 'camera', native: '📷', category: 'objects', name: 'Camera' },
  // Symbols
  { id: 'check', native: '✅', category: 'symbols', name: 'Check' },
  { id: 'x', native: '❌', category: 'symbols', name: 'X' },
  { id: 'warning', native: '⚠️', category: 'symbols', name: 'Warning' },
  { id: 'question', native: '❓', category: 'symbols', name: 'Question' },
  { id: 'exclamation', native: '❗', category: 'symbols', name: 'Exclamation' },
  { id: 'info', native: 'ℹ️', category: 'symbols', name: 'Info' },
  { id: 'recycle', native: '♻️', category: 'symbols', name: 'Recycle' },
  { id: 'copyright', native: '©️', category: 'symbols', name: 'Copyright' },
  { id: 'registered', native: '®️', category: 'symbols', name: 'Registered' },
  { id: 'tm', native: '™️', category: 'symbols', name: 'Trademark' },
  // Flags
  { id: 'flag_ru', native: '🇷🇺', category: 'flags', name: 'Russia' },
  { id: 'flag_us', native: '🇺🇸', category: 'flags', name: 'USA' },
  { id: 'flag_gb', native: '🇬🇧', category: 'flags', name: 'UK' },
  { id: 'flag_de', native: '🇩🇪', category: 'flags', name: 'Germany' },
  { id: 'flag_fr', native: '🇫🇷', category: 'flags', name: 'France' },
  { id: 'flag_jp', native: '🇯🇵', category: 'flags', name: 'Japan' },
  { id: 'flag_cn', native: '🇨🇳', category: 'flags', name: 'China' },
  { id: 'flag_br', native: '🇧🇷', category: 'flags', name: 'Brazil' },
  { id: 'flag_in', native: '🇮🇳', category: 'flags', name: 'India' },
  { id: 'flag_kz', native: '🇰🇿', category: 'flags', name: 'Kazakhstan' },
  // Whisper custom
  { id: 'whisper_lock', native: '🔐', category: 'whisper', name: 'Whisper Lock' },
  { id: 'shield', native: '🛡️', category: 'whisper', name: 'Shield' },
  { id: 'key_whisper', native: '🗝️', category: 'whisper', name: 'Key' },
  { id: 'envelope', native: '📨', category: 'whisper', name: 'Envelope' },
  { id: 'locked', native: '🔒', category: 'whisper', name: 'Locked' },
  { id: 'unlocked', native: '🔓', category: 'whisper', name: 'Unlocked' },
  { id: 'eye', native: '👁️', category: 'whisper', name: 'Eye' },
  { id: 'incognito', native: '🥷', category: 'whisper', name: 'Incognito' },
  { id: 'hacker', native: '🕵️', category: 'whisper', name: 'Hacker' },
  { id: 'fingerprint', native: '🖐️', category: 'whisper', name: 'Fingerprint' },
  { id: 'vault', native: '🏦', category: 'whisper', name: 'Vault' },
  { id: 'detective', native: '🕵️', category: 'whisper', name: 'Detective' },
  { id: 'ninja', native: '🥷', category: 'whisper', name: 'Ninja' },
  { id: 'ghost_whisper', native: '👻', category: 'whisper', name: 'Ghost' },
  { id: 'mask', native: '🎭', category: 'whisper', name: 'Mask' },
  { id: 'lock_with_pen', native: '🔏', category: 'whisper', name: 'Lock & Pen' },
  { id: 'key2', native: '🔑', category: 'whisper', name: 'Key' },
  { id: 'ring', native: '💍', category: 'whisper', name: 'Ring' },
  { id: 'gem', native: '💎', category: 'whisper', name: 'Gem' },
  // Crypto
  { id: 'bitcoin', native: '₿', category: 'crypto', name: 'Bitcoin' },
  { id: 'ethereum', native: 'Ξ', category: 'crypto', name: 'Ethereum' },
  { id: 'crypto_coin', native: '🪙', category: 'crypto', name: 'Coin' },
  { id: 'money_bag', native: '💰', category: 'crypto', name: 'Money Bag' },
  { id: 'credit_card', native: '💳', category: 'crypto', name: 'Credit Card' },
  { id: 'chart_up', native: '📈', category: 'crypto', name: 'Chart Up' },
  { id: 'chart_down', native: '📉', category: 'crypto', name: 'Chart Down' },
  { id: 'diamond', native: '💎', category: 'crypto', name: 'Diamond' },
  { id: 'gem2', native: '◇', category: 'crypto', name: 'Gem' },
  { id: 'crown', native: '👑', category: 'crypto', name: 'Crown' },
  // Communication
  { id: 'satellite', native: '📡', category: 'comms', name: 'Satellite' },
  { id: 'radio', native: '📻', category: 'comms', name: 'Radio' },
  { id: 'phone2', native: '📞', category: 'comms', name: 'Phone' },
  { id: 'bell', native: '🔔', category: 'comms', name: 'Bell' },
  { id: 'megaphone', native: '📢', category: 'comms', name: 'Megaphone' },
  { id: 'loudspeaker', native: '🔊', category: 'comms', name: 'Speaker' },
  { id: 'pager', native: '📟', category: 'comms', name: 'Pager' },
  { id: 'fax', native: '📠', category: 'comms', name: 'Fax' },
  { id: 'antenna', native: '📺', category: 'comms', name: 'TV' },
  { id: 'wifi', native: '📶', category: 'comms', name: 'WiFi' },
]

const filteredEmojis = computed(() => {
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    return allEmojis.filter(e => e.name.toLowerCase().includes(q))
  }
  return allEmojis.filter(e => e.category === activeCategory.value)
})

function selectEmoji(emoji) {
  emit('select', emoji.native)
  emit('close')
}

watch(() => props.show, (val) => {
  if (val) {
    nextTick(() => {
      searchInput.value?.focus()
    })
  }
})
</script>

<style scoped>
.emoji-picker {
  position: absolute;
  bottom: 60px;
  left: 0;
  width: 350px;
  max-height: 400px;
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 12px;
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.5));
  display: flex;
  flex-direction: column;
  z-index: 100;
  overflow: hidden;
}

.emoji-picker__header {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
}

.emoji-search {
  flex: 1;
  background: var(--bg-primary, #0a0a1a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--text-primary, #f1f5f9);
  font-size: 13px;
  outline: none;
}

.emoji-search:focus {
  border-color: var(--accent-primary, #6366f1);
}

.emoji-close {
  background: none;
  border: none;
  color: var(--text-muted, #64748b);
  cursor: pointer;
  font-size: 16px;
  padding: 4px 8px;
}

.emoji-close:hover {
  color: var(--text-primary, #f1f5f9);
}

.emoji-picker__categories {
  display: flex;
  gap: 2px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  overflow-x: auto;
}

.cat-btn {
  background: none;
  border: none;
  font-size: 18px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.cat-btn:hover {
  opacity: 0.8;
}

.cat-btn.active {
  opacity: 1;
  background: var(--bg-hover, #1e1e4a);
}

.emoji-picker__grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  padding: 8px;
  overflow-y: auto;
  max-height: 280px;
}

.emoji-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  font-size: 22px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.1s;
}

.emoji-item:hover {
  background: var(--bg-hover, #1e1e4a);
  transform: scale(1.1);
}
</style>
