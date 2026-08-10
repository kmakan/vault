// Theme definitions — each theme overrides CSS custom properties
export const themes = {
  dark: {
    name: 'Dark',
    icon: '🌙',
    vars: {
      '--bg-primary': '#0a0a1a',
      '--bg-secondary': '#12122a',
      '--bg-tertiary': '#1a1a3e',
      '--bg-hover': '#1e1e4a',
      '--bg-active': '#252560',
      '--accent-primary': '#6366f1',
      '--accent-secondary': '#818cf8',
      '--accent-glow': 'rgba(99, 102, 241, 0.3)',
      '--text-primary': '#f1f5f9',
      '--text-secondary': '#94a3b8',
      '--text-muted': '#64748b',
      '--border-subtle': 'rgba(255, 255, 255, 0.06)',
      '--border-hover': 'rgba(255, 255, 255, 0.1)',
    }
  },
  light: {
    name: 'Light',
    icon: '☀️',
    vars: {
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f8fafc',
      '--bg-tertiary': '#f1f5f9',
      '--bg-hover': '#e2e8f0',
      '--bg-active': '#cbd5e1',
      '--accent-primary': '#6366f1',
      '--accent-secondary': '#818cf8',
      '--accent-glow': 'rgba(99, 102, 241, 0.15)',
      '--text-primary': '#0f172a',
      '--text-secondary': '#475569',
      '--text-muted': '#94a3b8',
      '--border-subtle': 'rgba(0, 0, 0, 0.08)',
      '--border-hover': 'rgba(0, 0, 0, 0.15)',
    }
  },
  dracula: {
    name: 'Dracula',
    icon: '🧛',
    vars: {
      '--bg-primary': '#282a36',
      '--bg-secondary': '#21222c',
      '--bg-tertiary': '#343746',
      '--bg-hover': '#44475a',
      '--bg-active': '#6272a4',
      '--accent-primary': '#ff79c6',
      '--accent-secondary': '#bd93f9',
      '--accent-glow': 'rgba(255, 121, 198, 0.25)',
      '--text-primary': '#f8f8f2',
      '--text-secondary': '#ccc',
      '--text-muted': '#6272a4',
      '--border-subtle': 'rgba(255, 255, 255, 0.06)',
      '--border-hover': 'rgba(255, 255, 255, 0.1)',
      '--status-online': '#50fa7b',
      '--status-encrypted': '#bd93f9',
    }
  },
  kanagawa: {
    name: 'Kanagawa',
    icon: '🏯',
    vars: {
      '--bg-primary': '#1f1f28',
      '--bg-secondary': '#16161d',
      '--bg-tertiary': '#2a2a37',
      '--bg-hover': '#34344a',
      '--bg-active': '#494964',
      '--accent-primary': '#7e9cd8',
      '--accent-secondary': '#957fb8',
      '--accent-glow': 'rgba(126, 156, 216, 0.25)',
      '--text-primary': '#dcd7ba',
      '--text-secondary': '#938aa9',
      '--text-muted': '#545464',
      '--border-subtle': 'rgba(255, 255, 255, 0.06)',
      '--border-hover': 'rgba(255, 255, 255, 0.1)',
      '--status-online': '#98bb6c',
      '--status-encrypted': '#7e9cd8',
    }
  },
  nord: {
    name: 'Nord',
    icon: '❄️',
    vars: {
      '--bg-primary': '#2e3440',
      '--bg-secondary': '#3b4252',
      '--bg-tertiary': '#434c5e',
      '--bg-hover': '#4c566a',
      '--bg-active': '#5e81ac',
      '--accent-primary': '#88c0d0',
      '--accent-secondary': '#81a1c1',
      '--accent-glow': 'rgba(136, 192, 208, 0.25)',
      '--text-primary': '#eceff4',
      '--text-secondary': '#d8dee9',
      '--text-muted': '#4c566a',
      '--border-subtle': 'rgba(255, 255, 255, 0.06)',
      '--border-hover': 'rgba(255, 255, 255, 0.1)',
      '--status-online': '#a3be8c',
      '--status-encrypted': '#88c0d0',
    }
  },
  solarized: {
    name: 'Solarized',
    icon: '🌅',
    vars: {
      '--bg-primary': '#002b36',
      '--bg-secondary': '#073642',
      '--bg-tertiary': '#0a4050',
      '--bg-hover': '#0d4a5a',
      '--bg-active': '#268bd2',
      '--accent-primary': '#268bd2',
      '--accent-secondary': '#2aa198',
      '--accent-glow': 'rgba(38, 139, 210, 0.25)',
      '--text-primary': '#fdf6e3',
      '--text-secondary': '#93a1a1',
      '--text-muted': '#586e75',
      '--border-subtle': 'rgba(255, 255, 255, 0.06)',
      '--border-hover': 'rgba(255, 255, 255, 0.1)',
      '--status-online': '#859900',
      '--status-encrypted': '#268bd2',
    }
  },
  vendetta: {
    name: 'Vendetta',
    icon: '🎭',
    vars: {
      // Чёрный антрацит — как флаг анархии
      '--bg-primary': '#0a0a0a',
      '--bg-secondary': '#141414',
      '--bg-tertiary': '#1e1e1e',
      '--bg-hover': '#2a2a2a',
      '--bg-active': '#3a3a3a',
      // Красный акцент — как буква V в иконке Vendetta
      '--accent-primary': '#d21f2b',
      '--accent-secondary': '#e53945',
      '--accent-glow': 'rgba(210, 31, 43, 0.28)',
      // Серые оттенки текста
      '--text-primary': '#e8e8e8',
      '--text-secondary': '#9a9a9a',
      '--text-muted': '#6b6b6b',
      '--border-subtle': 'rgba(255, 255, 255, 0.07)',
      '--border-hover': 'rgba(255, 255, 255, 0.13)',
      // Дополнительные (используются компонентами)
      '--status-online': '#2ecc71',
      '--status-warning': '#e67e22',
      '--status-encrypted': '#d21f2b',
      '--danger': '#d21f2b',
      '--danger-hover': '#b01822',
      '--success': '#27ae60',
    }
  },
}

export function applyTheme(themeId) {
  const theme = themes[themeId]
  if (!theme) return
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value)
  }
  localStorage.setItem('vault-theme', themeId)
}

export function loadSavedTheme() {
  return localStorage.getItem('vault-theme') || 'dark'
}
