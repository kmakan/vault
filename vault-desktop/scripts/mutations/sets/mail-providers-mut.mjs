// Набор мутаций: mail-providers-mut
// Цель: убедиться, что смоук mail-providers-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'mail-providers-mut',
  file: 'src/mailProviders.js',
  smoke: 'mail-providers-smoke.mjs',
  mutations: [
    { name: "IMAP-порт перепутан (993 → 143)",
      pattern: "    imap_server: 'imap.gmail.com',\n    imap_port: 993,",
      replacement: "    imap_server: 'imap.gmail.com',\n    imap_port: 143," },
    { name: "провайдер определяется по хосту, но не по домену",
      pattern: "  const p = MAIL_PROVIDERS.find(pr => (pr.domains || []).includes(domain));",
      replacement: "  const p = null;" },
    { name: "неизвестный IMAP-хост определяется как gmail",
      pattern: "  return p ? p.id : CUSTOM_PROVIDER_ID;",
      replacement: "  return p ? p.id : 'gmail';" },
    { name: "лимит вложений для неизвестного домена берётся у gmail",
      pattern: "  return (p && p.max_attachment_mb) || 25;",
      replacement: "  return (p && p.max_attachment_mb) || 50;" },
    { name: "findProvider подменяет несуществующего провайдера первым",
      pattern: "  return MAIL_PROVIDERS.find(p => p.id === id) || null;",
      replacement: "  return MAIL_PROVIDERS.find(p => p.id === id) || MAIL_PROVIDERS[0];" },
    { name: "домены провайдера не учитываются при определении по email",
      pattern: "  if (!domain) return '';",
      replacement: "  if (true) return '';" },
  ],
};
