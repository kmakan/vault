export function isTextMime(type, name) {
  if (type && (type.startsWith('text/') || /^(application\/(json|xml|javascript|x-sh)|application\/(x-)?(yaml|csv|markdown))$/.test(type))) return true;
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (ext) {
    const textExts = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'sh', 'bash', 'zsh', 'py', 'js', 'ts', 'vue', 'html', 'css', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift', 'sql', 'env', 'gitignore', 'editorconfig'];
    if (textExts.includes(ext[1])) return true;
  }
  return false;
}

export function newMessageId() {
  try {
    // ВАЖНО: window.crypto — НЕ импортированный модуль crypto.js!
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  } catch (e) { /* fallback below */ }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function parseEnvelope(decrypted) {
  if (!decrypted || typeof decrypted !== 'string') return null;
  try {
    const obj = JSON.parse(decrypted);
    if (obj && obj.vault === 1 && typeof obj.text === 'string') {
      const env = { id: obj.id || '', text: obj.text, name: obj.name || '', avatar: obj.avatar || '', type: obj.type || '', ts: obj.ts || 0, key: obj.key || '', pq: typeof obj.pq === 'string' ? obj.pq : '', ttl: Number(obj.ttl) || 0, bio: typeof obj.bio === 'string' ? obj.bio : undefined, tok: typeof obj.tok === 'string' ? obj.tok : '', gavatar: typeof obj.gavatar === 'string' ? obj.gavatar : '' };
      // Голосование: poll-подконверт (валидация в features/poll.js).
      if (obj.poll && typeof obj.poll === 'object') {
        env.poll = {
          id: String(obj.poll.id || obj.id || ''),
          question: typeof obj.poll.question === 'string' ? obj.poll.question : '',
          options: Array.isArray(obj.poll.options) ? obj.poll.options.map(o => String(o)) : [],
        };
      }
      return env;
    }
  } catch { /* not an envelope — legacy plaintext */ }
  return null;
}

// Ответ на сообщение: цитата/тело. Раньше эти три функции жили методами в
// App.vue (ADR-005 W3, партия 3) — формат сообщения belongs к формату.
export function hasReplyQuote(content) {
  return splitReply(content).quote !== '';
}
export function replyQuote(content) {
  return splitReply(content).quote;
}
export function replyBody(content) {
  return splitReply(content).body;
}

export function splitReply(content) {
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
}

// Short excerpt used for the reply bar and for the "> " quote prefix.
// Чистая: вырезает тело (без цитаты), схлопывает пробелы, обрезает до maxLen + эллипс.
export function replyPreview(content, maxLen = 60) {
  let text = splitReply(content || '').body;
  if (!text) text = content || '';
  text = String(text).replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) text = text.slice(0, maxLen).trim() + '…';
  return text;
}

// Status tooltip (outgoing message status circle). Чистая, tr — адаптер.
export function statusTitle(msg, tr) {
  const st = (msg && msg.status) || 'sent';
  if (st === 'read') return tr('status_read') || 'Read';
  if (st === 'delivered') return tr('status_delivered') || 'Delivered';
  if (st === 'sending') return tr('status_sending') || 'Sending';
  if (st === 'failed') {
    const who = msg.failedTo && msg.failedTo.length ? ': ' + msg.failedTo.join(', ') : '';
    return 'Not delivered' + who;
  }
  return tr('status_sent') || 'Sent';
}

// parseEnvelopeSafe(str): JSON.parse конверта с catch→null (не падает на муссе).
export function parseEnvelopeSafe(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// formatTimeLabel(ts): «12:00»-формат для времени сообщения/поста.
// Чистая (no tz/locale side-effects beyond Intl.DateTimeFormat).
export function formatTimeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// imapCursorsKey/account markers
export function imapCursorsKey(accountId) {
  return 'vault-imap-cursors-' + accountId;
}

export function senderEmail(raw) {
  if (!raw) return '';
  const m = String(raw).match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

// Регулярка телефона ОДНА на linkify и меню сообщения. Копии в App.vue и здесь
// разъехались бы при правке одной из них: в меню попадал бы другой набор
// номеров, чем в тексте, и пользователь увидел бы разное в двух местах одного
// сообщения.
const PHONE_RE = /(?<![\d])(?:\+?\d{1,3}[\s()-]*)?\(?\d{2,3}\)?[\s()-]*\d{3}[\s()-]*\d{2}[\s()-]*\d{2}/g;
// URL для МЕНЮ — своя регулярка, не путать с регуляркой linkify: здесь
// отбрасываются ']' и ')' (текст вставляется в меню, а не в HTML), и требуется
// минимум два символа. Расхождение с linkify намеренное и зафиксировано тестом.
const MENU_URL_RE = /https?:\/\/[^\s\])"']{2,}/g;

// Телефоны и ссылки из текста сообщения — для контекстного меню. Дубликаты
// убираются по первому вхождению (порядок появления в тексте).
export function extractPhonesAndUrls(content) {
  const phones = [...content.matchAll(PHONE_RE)]
    .map(m => m[0].trim())
    .filter((v, i, a) => a.indexOf(v) === i);
  const urls = [...content.matchAll(MENU_URL_RE)]
    .map(m => m[0])
    .filter((v, i, a) => a.indexOf(v) === i);
  return { phones, urls };
}

export function linkify(text) {
  // Безопасная автолинковка: текст → экранированный HTML → ссылки/телефоны.
  // Телефоны заменяются через плейсхолдеры ДО URL, чтобы не пересекаться.
  const esc = String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const phones = [];
  // Телефон: код (+7/8/международный до 3 цифр) опционален, разделители
  // (пробел/скобки/дефисы) — в любом количестве и любом месте между
  // группами: 8(999)123-45-67, +7 (999) 123 45 67, +380 67 123 45 67.
  let tmp = esc.replace(PHONE_RE, (m) => { phones.push(m.trim()); return `\u0000P${phones.length - 1}\u0000`; });
  tmp = tmp.replace(/(https?:\/\/[^\s<"']+)/g, '<a href="$1" data-url="$1" class="msg-link">$1</a>');
  tmp = tmp.replace(/\u0000P(\d+)\u0000/g, (_, i) => `<a href="tel:${phones[+i]}" data-phone="${phones[+i]}" class="msg-link msg-phone">${phones[+i]}</a>`);
  return tmp;
}

export function parseMessageContent(content) {
  if (!content || typeof content !== 'string') return { text: content, attachment: null };
  try {
    const parsed = JSON.parse(content);
    if (parsed && parsed.vault_attachment) {
      const isImage = parsed.type && parsed.type.startsWith('image/');
      const isAudio = parsed.type && parsed.type.startsWith('audio/');
      // Текстовые файлы (text/*, json, md, csv...) показываем инлайн,
      // как картинки/аудио, а не только как файл для скачивания.
      const isText = !isImage && !isAudio && isTextMime(parsed.type, parsed.name);
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
      // Download-on-demand: данные НЕ в конверте — во втором письме
      // (dod = его Message-ID). Карточка рендерится сразу (имя/размер
      // из меты), содержимое подтягивается по клику — fetchDodAttachment.
      const isDod = typeof parsed.dod === 'string' && parsed.dod.length > 0;
      return {
        text: label,
        attachment: {
          name: parsed.name, type: parsed.type, size: parsed.size, data: parsed.data,
          isImage: isImage && !isDod, isAudio: isAudio && !isDod, isText: isText && !isDod,
          textContent: isDod ? '' : textContent,
          isDod, dod: isDod ? parsed.dod : '', dodStatus: 'idle', // idle|loading|ready|error
        },
      };
    }
  } catch { /* not JSON — plain text message */ }
  return { text: content, attachment: null };
}
