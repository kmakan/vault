// File size limits by email provider (in bytes)
export const providerLimits = {
  gmail: {
    name: 'Gmail',
    maxAttachment: 25 * 1024 * 1024, // 25MB
    maxTotal: 25 * 1024 * 1024,
    warning: 'Gmail limits attachments to 25MB',
  },
  outlook: {
    name: 'Outlook',
    maxAttachment: 20 * 1024 * 1024, // 20MB
    maxTotal: 20 * 1024 * 1024,
    warning: 'Outlook limits attachments to 20MB',
  },
  yandex: {
    name: 'Yandex',
    maxAttachment: 30 * 1024 * 1024, // 30MB
    maxTotal: 30 * 1024 * 1024,
    warning: 'Yandex limits attachments to 30MB',
  },
  mailru: {
    name: 'Mail.ru',
    maxAttachment: 25 * 1024 * 1024, // 25MB
    maxTotal: 25 * 1024 * 1024,
    warning: 'Mail.ru limits attachments to 25MB',
  },
  custom: {
    name: 'Custom',
    maxAttachment: 10 * 1024 * 1024, // 10MB conservative default
    maxTotal: 10 * 1024 * 1024,
    warning: 'Custom server — using 10MB default limit',
  },
}

export function detectProvider(email) {
  if (!email) return 'custom'
  const domain = email.split('@')[1]?.toLowerCase() || ''
  if (domain.includes('gmail') || domain.includes('googlemail')) return 'gmail'
  if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live')) return 'outlook'
  if (domain.includes('yandex')) return 'yandex'
  if (domain.includes('mail.ru') || domain.includes('list.ru')) return 'mailru'
  return 'custom'
}

export function getLimit(providerId) {
  return providerLimits[providerId] || providerLimits.custom
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(1) + ' MB'
}

export function checkFileSize(fileSize, providerId) {
  const limit = getLimit(providerId)
  if (fileSize > limit.maxAttachment) {
    return {
      ok: false,
      message: `${limit.warning}. Your file: ${formatBytes(fileSize)} — exceeds limit.`,
      limit: limit.maxAttachment,
    }
  }
  // Warning at 80%
  if (fileSize > limit.maxAttachment * 0.8) {
    return {
      ok: true,
      warning: `File is ${formatBytes(fileSize)} — close to ${limit.name} limit of ${formatBytes(limit.maxAttachment)}.`,
      limit: limit.maxAttachment,
    }
  }
  return { ok: true, limit: limit.maxAttachment }
}
