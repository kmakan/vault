// Sfera UI: темы оформления. Палитра согласована с мессенджером:
// фиолетовый (#6366f1 / #818cf8) как основной акцент и янтарный
// (#f59e0b / #fbbf24) как вторичный — для подписки, квот и предупреждений.
// Никакой логики: только CSS-переменные, которые читает Vue-слой.

const BASE = Object.freeze({
  '--font-sans': "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  '--radius-lg': '12px',
  '--radius-md': '8px',
  '--radius-sm': '6px',
  '--radius-full': '9999px',
  '--shadow-sm': '0 2px 8px rgba(0, 0, 0, 0.25)',
  // Янтарный вторичный акцент — общий для всех тем (подписка/квоты).
  '--accent-warm': '#f59e0b',
  '--accent-warm-soft': '#fbbf24',
});

export const THEMES = Object.freeze({
  dark: {
    name: 'Dark',
    vars: {
      ...BASE,
      'color-scheme': 'dark',
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
    },
  },
  light: {
    name: 'Light',
    vars: {
      ...BASE,
      'color-scheme': 'light',
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
    },
  },
  amber: {
    name: 'Amber',
    vars: {
      ...BASE,
      'color-scheme': 'dark',
      '--bg-primary': '#16110a',
      '--bg-secondary': '#1f1810',
      '--bg-tertiary': '#2b2116',
      '--bg-hover': '#33281a',
      '--bg-active': '#40311f',
      '--accent-primary': '#f59e0b',
      '--accent-secondary': '#fbbf24',
      '--accent-glow': 'rgba(245, 158, 11, 0.3)',
      '--text-primary': '#fef3c7',
      '--text-secondary': '#d6c6a5',
      '--text-muted': '#9c8a6d',
      '--border-subtle': 'rgba(245, 158, 11, 0.1)',
      '--border-hover': 'rgba(245, 158, 11, 0.2)',
    },
  },
});

export const DEFAULT_THEME = 'dark';

export function themeNames() {
  return Object.keys(THEMES);
}

export function themeVars(code) {
  return THEMES[code]?.vars ?? THEMES[DEFAULT_THEME].vars;
}
