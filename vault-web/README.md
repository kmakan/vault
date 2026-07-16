# Vault Web — Vault/Vault UI

Web interface for Vault/Vault E2E encrypted messenger.

## Tech Stack

- **SvelteKit** — Full-stack framework
- **Svelte 5** — Reactivity with runes (`$state`, `$derived`, `$props`)
- **TypeScript** — Type safety
- **Tailwind CSS** — Utility-first styling (via `@tailwindcss/vite`)
- **Custom CSS Variables** — Telegram-inspired dark theme

## Components

| Component | Description |
|-----------|-------------|
| `Sidebar` | Left navigation — logo, nav items, user info. Collapsible. |
| `ChatList` | Scrollable chat list with search, avatars, unread badges, online status |
| `ChatWindow` | Message area — header, encryption banner, messages, input with send/attach |
| `MessageBubble` | Single message — own/incoming, timestamp, read status, lock icon |

## Project Structure

```
vault-web/
├── src/
│   ├── app.css                    # Global styles + CSS variables (dark theme)
│   ├── app.html                   # HTML shell
│   ├── lib/
│   │   ├── types.ts               # TypeScript interfaces (Chat, Message, Contact, User)
│   │   ├── mock-data.ts           # Hardcoded mock data for development
│   │   └── components/
│   │       ├── Sidebar.svelte     # Left sidebar navigation
│   │       ├── ChatList.svelte    # Chat list with search
│   │       ├── ChatWindow.svelte  # Chat view with messages
│   │       └── MessageBubble.svelte  # Individual message bubble
│   └── routes/
│       ├── +layout.svelte         # Root layout (imports CSS)
│       └── +page.svelte           # Main page (assembles all components)
├── package.json
├── vite.config.ts                 # Vite + Tailwind + SvelteKit
└── README.md
```

## Quick Start

```bash
cd vault-web
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server on port 5173 |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |
| `npm run check` | TypeScript + Svelte type checking |

## Design

- **Theme**: Dark, Telegram-inspired color palette
- **Layout**: Three-panel — sidebar + chat list + chat window
- **Responsive**: Sidebar collapses to icons; chat list fills on mobile
- **Encryption UX**: Lock icons, encryption banners, key indicators

## Current State

This is a **UI skeleton** — a visual prototype with hardcoded mock data.
Not yet connected to the vault-backend API.

### What's working:
- ✅ Dark theme with CSS variables
- ✅ Three-panel layout (sidebar, chat list, chat window)
- ✅ Chat list with avatars, online status, unread badges
- ✅ Message bubbles (own/incoming) with timestamps and read receipts
- ✅ Message input with send button
- ✅ Encryption indicators
- ✅ Empty state when no chat selected

### What's next:
- [ ] Connect to vault-backend REST/WebSocket API
- [ ] Authentication flow (keypair generation, login)
- [ ] Real-time messaging via WebSocket
- [ ] File/image attachments
- [ ] Contact management
- [ ] Responsive mobile layout
- [ ] Message search
- [ ] E2E key exchange visualization
