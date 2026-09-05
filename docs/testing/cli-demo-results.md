# CLI Demo Test Results

Дата: Вс 16 авг 2026 15:08:55 MSK

## Test: Help command
Команда: `/help`

Вывод:
```

  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  ⣿                                                            ⣿
  ⣿   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗            ⣿
  ⣿   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝            ⣿
  ⣿   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗            ⣿
  ⣿   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║            ⣿
  ⣿   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║            ⣿
  ⣿   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝            ⣿
  ⣿                   E2E Encrypted Messenger                    ⣿
  ⣿                                                            ⣿
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  v0.1.0 | type /help for commands


  ⚠ Not connected. Use /connect <email> <app-password>


  Vault CLI — Commands
  ──────────────────────────────────────────────────
  
    /help [topic]     Show detailed help for a topic
    /status           Show connection and key status
    /clear            Clear screen
    /quit             Exit Vault
  
    SESSION
      /connect <email> <pass> [server]   Connect to IMAP
      /chat <email>      Enter chat mode
      /inbox             List recent messages
      /read <id>         Read a message
  
    MESSAGING
      /send <message>    Send encrypted message
      /reply <id> <msg>  Reply to a message
      /forward <id> <email>  Forward a message
      /thread <subject>  Show message thread
      /search <query>    Search messages
  
    KEYS & ENCRYPTION
      /keygen            Generate key pair
      /keys              Show key status
      /ks <email> [m]  Share public key (copy|signal|pgp|briar)
      /encrypt <text>    Encrypt text
      /decrypt <text>    Decrypt text
  
    REACTIONS & PINNING
      /react <id> <emoji>    React to message
      /unreact <id> <emoji>  Remove reaction
      /pin <id>              Pin message
      /unpin <id>            Unpin message
  
    GROUPS
      /cg <name>         Create group
      /gm <id>           List members
      /gi <id> <email>   Invite member
      /gr <id> <email>   Remove member
      /pm <id> <email>   Promote to admin
      /dm <id> <email>   Demote to member
      /bk <id> <email>   Block user
```

✅ PASS

---

## Test: Status command
Команда: `/status`

Вывод:
```

  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  ⣿                                                            ⣿
  ⣿   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗            ⣿
  ⣿   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝            ⣿
  ⣿   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗            ⣿
  ⣿   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║            ⣿
  ⣿   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║            ⣿
  ⣿   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝            ⣿
  ⣿                   E2E Encrypted Messenger                    ⣿
  ⣿                                                            ⣿
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  v0.1.0 | type /help for commands


  ⚠ Not connected. Use /connect <email> <app-password>

  ──────────────────────────────────────────────────
  ○ Email: not connected
  ○ Chat: none
  ○ Keys: none (use /keygen)
  ──────────────────────────────────────────────────
```

✅ PASS

---

## Test: Key generation
Команда: `/keygen`

Вывод:
```

  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  ⣿                                                            ⣿
  ⣿   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗            ⣿
  ⣿   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝            ⣿
  ⣿   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗            ⣿
  ⣿   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║            ⣿
  ⣿   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║            ⣿
  ⣿   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝            ⣿
  ⣿                   E2E Encrypted Messenger                    ⣿
  ⣿                                                            ⣿
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  v0.1.0 | type /help for commands


  ⚠ Not connected. Use /connect <email> <app-password>

  → Generating new key pair...
  ✓ New key pair generated
  🔐 728a7d642951d58552dd8b5d11e7994bb6826bc56a592e000290b70976a45e45
  → Share your public key with /keyshare <contact>
```

✅ PASS

---

## Test: Contacts list
Команда: `/contacts`

Вывод:
```

  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  ⣿                                                            ⣿
  ⣿   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗            ⣿
  ⣿   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝            ⣿
  ⣿   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗            ⣿
  ⣿   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║            ⣿
  ⣿   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║            ⣿
  ⣿   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝            ⣿
  ⣿                   E2E Encrypted Messenger                    ⣿
  ⣿                                                            ⣿
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  v0.1.0 | type /help for commands


  ⚠ Not connected. Use /connect <email> <app-password>

  → No contacts yet. Use /add <email> [name] or /invite <email>.
```

✅ PASS

---

## Test: Settings
Команда: `/settings`

Вывод:
```

  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  ⣿                                                            ⣿
  ⣿   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗            ⣿
  ⣿   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝            ⣿
  ⣿   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗            ⣿
  ⣿   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║            ⣿
  ⣿   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║            ⣿
  ⣿   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝            ⣿
  ⣿                   E2E Encrypted Messenger                    ⣿
  ⣿                                                            ⣿
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  v0.1.0 | type /help for commands


  ⚠ Not connected. Use /connect <email> <app-password>

  ──────────────────────────────────────────────────
  → Settings:
  Email:   not set
  Server:  default
  ──────────────────────────────────────────────────
```

✅ PASS

---

## Test: Inbox
Команда: `/inbox`

Вывод:
```

  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  ⣿                                                            ⣿
  ⣿   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗            ⣿
  ⣿   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝            ⣿
  ⣿   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗            ⣿
  ⣿   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║            ⣿
  ⣿   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║            ⣿
  ⣿   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝            ⣿
  ⣿                   E2E Encrypted Messenger                    ⣿
  ⣿                                                            ⣿
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  v0.1.0 | type /help for commands


  ⚠ Not connected. Use /connect <email> <app-password>

  ✗ Not connected. Use /connect first.
```

✅ PASS

---

## Test: Keys display
Команда: `/keys`

Вывод:
```

  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  ⣿                                                            ⣿
  ⣿   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗            ⣿
  ⣿   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝            ⣿
  ⣿   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗            ⣿
  ⣿   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║            ⣿
  ⣿   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║            ⣿
  ⣿   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝            ⣿
  ⣿                   E2E Encrypted Messenger                    ⣿
  ⣿                                                            ⣿
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  v0.1.0 | type /help for commands


  ⚠ Not connected. Use /connect <email> <app-password>

  ──────────────────────────────────────────────────
  → Key status:
  ○ No keys generated
  → Use /keygen to generate a key pair
  ──────────────────────────────────────────────────
```

✅ PASS

---

