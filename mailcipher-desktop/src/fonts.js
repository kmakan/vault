// Font definitions — applied via CSS font-family
export const fonts = {
  system: {
    name: 'System',
    icon: '💻',
    family: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', monospace",
  },
  inter: {
    name: 'Inter',
    icon: '🔤',
    family: "'Inter', sans-serif",
    mono: "'JetBrains Mono', monospace",
    url: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  },
  jetbrains: {
    name: 'JetBrains',
    icon: '⌨️',
    family: "'JetBrains Mono', monospace",
    mono: "'JetBrains Mono', monospace",
    url: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
  },
  // Pro fonts
  manrope: {
    name: 'Manrope',
    icon: '✨',
    family: "'Manrope', sans-serif",
    mono: "'JetBrains Mono', monospace",
    url: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap',
    pro: true,
  },
  plusJakarta: {
    name: 'Plus Jakarta',
    icon: '💎',
    family: "'Plus Jakarta Sans', sans-serif",
    mono: "'Fira Code', monospace",
    url: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap',
    pro: true,
  },
  spaceGrotesk: {
    name: 'Space Grotesk',
    icon: '🚀',
    family: "'Space Grotesk', sans-serif",
    mono: "'Fira Code', monospace",
    url: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap',
    pro: true,
  },
  outfit: {
    name: 'Outfit',
    icon: '👔',
    family: "'Outfit', sans-serif",
    mono: "'Fira Code', monospace",
    url: 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
    pro: true,
  },
}

const loadedFonts = new Set()

export function applyFont(fontId) {
  const font = fonts[fontId]
  if (!font) return

  // Load Google Font if URL provided
  if (font.url && !loadedFonts.has(fontId)) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = font.url
    document.head.appendChild(link)
    loadedFonts.add(fontId)
  }

  const root = document.documentElement
  root.style.setProperty('--font-sans', font.family)
  root.style.setProperty('--font-mono', font.mono)
  localStorage.setItem('whisper-font', fontId)
}

export function loadSavedFont() {
  return localStorage.getItem('whisper-font') || 'system'
}
