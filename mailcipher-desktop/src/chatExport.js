// Chat export utilities — JSON and TXT formats

export function exportChatJSON(messages, contact) {
  const data = {
    app: 'Whisper (MailCipher)',
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
  let txt = `Whisper Chat Export\n`
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
