// Каталог настроек IMAP/SMTP известных почтовых провайдеров.
// Пользователь выбирает провайдера в «Настройках сервера» — поля
// IMAP/SMTP заполняются автоматически, вводить ничего не нужно.
//
// Порты/хосты проверены: Gmail (дефолт приложения), Zoho (тест kmakan,
// Остальные — стандартные публичные значения провайдеров.
//
// max_attachment_mb — консервативный лимит размера ВЛОЖЕНИЯ (не письма):
// письмо с base64-телом ~на 33% больше файла, поэтому проверка в
// handleFileSelect сравнивает file.size с ~70% от этого лимита, чтобы
// предупредить ДО отправки, пока провайдер ещё не отклонил письмо.

export const MAIL_PROVIDERS = [
  {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap_server: 'imap.gmail.com',
    imap_port: 993,
    smtp_server: 'smtp.gmail.com',
    smtp_port: 587,
    max_attachment_mb: 25,
    hint: 'Нужен «Пароль приложения» (Google Аккаунт → Безопасность → 2FA → Пароли приложений).',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    domains: ['zoho.com', 'zoho.eu', 'zoho.in'],
    imap_server: 'imap.zoho.com',
    imap_port: 993,
    smtp_server: 'smtp.zoho.com',
    smtp_port: 587,
    max_attachment_mb: 25,
    hint: 'Для EU/IN-аккаунтов замените домен: imap.zoho.eu, smtp.zoho.eu (или .in).',
  },
  {
    id: 'yandex',
    label: 'Яндекс Почта',
    domains: ['yandex.ru', 'yandex.com', 'ya.ru', 'yandex.by', 'yandex.kz'],
    imap_server: 'imap.yandex.com',
    imap_port: 993,
    smtp_server: 'smtp.yandex.com',
    smtp_port: 465,
    max_attachment_mb: 30,
    hint: 'Включите «Пароли приложений» в настройках Яндекс ID и используйте его вместо пароля.',
  },
  {
    id: 'mailru',
    label: 'Mail.ru',
    domains: ['mail.ru', 'list.ru', 'bk.ru', 'inbox.ru'],
    imap_server: 'imap.mail.ru',
    imap_port: 993,
    smtp_server: 'smtp.mail.ru',
    smtp_port: 465,
    max_attachment_mb: 30,
    hint: 'Нужен «Пароль для внешних приложений» (Mail.ru → Безопасность → Пароли для внешних приложений).',
  },
  {
    id: 'outlook',
    label: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'outlook.ru'],
    imap_server: 'outlook.office365.com',
    imap_port: 993,
    smtp_server: 'smtp.office365.com',
    smtp_port: 587,
    max_attachment_mb: 20,
    hint: 'При включённой 2FA нужен пароль приложения (account.microsoft.com → Security). Обычный пароль — только без 2FA.',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap_server: 'imap.mail.me.com',
    imap_port: 993,
    smtp_server: 'smtp.mail.me.com',
    smtp_port: 587,
    max_attachment_mb: 20,
    hint: 'Нужен пароль приложения (appleid.apple.com → Безопасность).',
  },
  {
    id: 'gmx',
    label: 'GMX',
    domains: ['gmx.net', 'gmx.de', 'gmx.com'],
    imap_server: 'imap.gmx.net',
    imap_port: 993,
    smtp_server: 'smtp.gmx.net',
    smtp_port: 587,
    max_attachment_mb: 50,
    hint: '',
  },
  {
    id: 'webde',
    label: 'WEB.DE',
    domains: ['web.de'],
    imap_server: 'imap.web.de',
    imap_port: 993,
    smtp_server: 'smtp.web.de',
    smtp_port: 587,
    max_attachment_mb: 50,
    hint: '',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imap_server: 'imap.fastmail.com',
    imap_port: 993,
    smtp_server: 'smtp.fastmail.com',
    smtp_port: 587,
    max_attachment_mb: 70,
    hint: 'Используйте App Password (Settings → Privacy & Security).',
  },
  {
    id: 'rambler',
    label: 'Rambler',
    domains: ['rambler.ru'],
    imap_server: 'imap.rambler.ru',
    imap_port: 993,
    smtp_server: 'smtp.rambler.ru',
    smtp_port: 465,
    max_attachment_mb: 25,
    hint: '',
  },
];

// «Другой» — ручные поля IMAP/SMTP (id не входит в MAIL_PROVIDERS).
export const CUSTOM_PROVIDER_ID = 'custom';

export function findProvider(id) {
  return MAIL_PROVIDERS.find(p => p.id === id) || null;
}

// Обратное определение провайдера по сохранённому IMAP-хосту — чтобы
// после перезапуска селект показывал выбранного провайдера, а не «Другой».
export function detectProviderByServer(imapServer) {
  if (!imapServer) return '';
  const host = String(imapServer).trim().toLowerCase();
  const p = MAIL_PROVIDERS.find(pr => pr.imap_server.toLowerCase() === host);
  return p ? p.id : CUSTOM_PROVIDER_ID;
}

// Автоподбор провайдера по домену введённого email (kmakan@zoho.com → zoho).
// Возвращает id провайдера или '' если домен неизвестен.
export function detectProviderByEmail(email) {
  if (!email) return '';
  const domain = String(email).split('@')[1]?.trim().toLowerCase() || '';
  if (!domain) return '';
  const p = MAIL_PROVIDERS.find(pr => (pr.domains || []).includes(domain));
  return p ? p.id : '';
}

// Консервативный лимит вложений (МБ) для текущего email: по домену из
// каталога; неизвестный/кастомный домен — дефолт 25 МБ.
// ВАЖНО: это лимит размера ФАЙЛА, а не письма (base64-тело ~+33%).
export function getAttachmentLimitMb(email) {
  const id = detectProviderByEmail(email);
  const p = id ? findProvider(id) : null;
  return (p && p.max_attachment_mb) || 25;
}
