// Набор мутаций: poll-mut
// Цель: убедиться, что смоук poll-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'poll-mut',
  file: 'src/features/poll.js',
  smoke: 'poll-smoke.mjs',
  mutations: [
    { name: "опрос с одним вариантом принимается",
      pattern: "  if (opts.length < 2 || opts.length > 10) return null;",
      replacement: "  if (opts.length < 1 || opts.length > 10) return null;" },
    { name: "вопрос опроса не обрезается",
      pattern: "    question: String(env.poll.question).slice(0, 200),",
      replacement: "    question: String(env.poll.question)," },
    { name: "не-poll конверт принимается как опрос",
      pattern: "  if (!env || env.type !== 'poll' || !env.poll || !env.poll.question) return null;",
      replacement: "  if (!env || !env.poll || !env.poll.question) return null;" },
    { name: "голос не применяется к карточке",
      pattern: "export function applyPollVotes(list, wirePollVotes, email) {",
      replacement: "export function applyPollVotes(list, wirePollVotes, email) {\n  return list;" },
  ],
};
