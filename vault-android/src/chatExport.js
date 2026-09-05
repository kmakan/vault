// Chat export utilities — JSON and TXT formats

export function exportChatJSON(messages, contact) {
  const data = {
    app: 'Vault (MailCipher)',
    version: '0.1.0',
    exportDate: new Date().toISOString(),
    contact: contact,
    messageCount: messages.length,
    messages: messages.map(m => ({
      id: m.id,
      from: m.from,
      content: m.content,
      time: m.time,
      encrypted: m.encrypted || false,
      reactions: m.reactions || [],
    })),
  }
  return JSON.stringify(data, null, 2)
}

export function exportChatTXT(messages, contact) {
  let txt = `Vault Chat Export\n`
  txt += `Contact: ${contact}\n`
  txt += `Exported: ${new Date().toLocaleString()}\n`
  txt += `Messages: ${messages.length}\n`
  txt += `${'─'.repeat(50)}\n\n`

  for (const m of messages) {
    const sender = m.from === 'me' ? 'You' : contact
    const encrypted = m.encrypted ? ' 🔒' : ''
    const reactions = m.reactions?.length ? ` [${m.reactions.join(' ')}]` : ''
    txt += `[${m.time || '?'}] ${sender}${encrypted}${reactions}\n`
    txt += `${m.content}\n\n`
  }

  return txt
}

export function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Decode a base64 string into bytes (in 0x8000-byte chunks via Uint8Array),
// assemble it into a Blob and trigger a browser download of the attachment.
export function downloadBase64(base64, filename, mimeType) {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  const chunk = 0x8000
  for (let i = 0; i < len; i += chunk) {
    bytes.set(binary.substring(i, i + chunk).split('').map(c => c.charCodeAt(0)), i)
  }
  const blob = new Blob([bytes], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
