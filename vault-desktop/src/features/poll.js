// Feature module: polls (опросы). Stage 1 of the App.vue decomposition —
// pure functions receive the component instance as `ctx` instead of `this`,
// so every dependency is explicit and testable in isolation.
// Stage 2 will move the template + data fields into PollDialog.vue.

import api from '../api.js';
import crypto from '../crypto.js';

// Состояние фичи — в ./poll/state.js (чистый модуль без импортов: его
// поднимает check-template.cjs для резолва спреда `...pollState()`).
export { pollState } from './poll/state.js';

// Wire format: one vote = signal email {poll:1, poll_id, option} (same
// channel as reactions). Envelope card: type:'poll' with poll sub-object.
// Validation for inbound envelopes.
export function parsePollEnvelope(env) {
  if (!env || env.type !== 'poll' || !env.poll || !env.poll.question) return null;
  const opts = (env.poll.options || []).map(o => String(o).slice(0, 100)).filter(Boolean);
  if (opts.length < 2 || opts.length > 10) return null;
  return {
    id: String(env.poll.id || env.id || ''),
    question: String(env.poll.question).slice(0, 200),
    options: opts.slice(0, 10),
    votes: {},   // email -> option index (последний голос)
    myVote: null,
  };
}

// Aggregated counts for a poll card.
export function pollVotes(poll) {
  const counts = new Array(poll.options.length).fill(0);
  const voters = {};
  for (const [email, opt] of Object.entries(poll.votes || {})) {
    if (opt >= 0 && opt < counts.length) {
      counts[opt] += 1;
      voters[email] = true;
    }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  return { counts, total, voters: Object.keys(voters).length };
}

export function pollOptionCount(poll, i) { return pollVotes(poll).counts[i] || 0; }

export function pollLead(poll) {
  const v = pollVotes(poll);
  let best = -1, bestN = -1;
  v.counts.forEach((n, i) => { if (n > bestN) { best = i; bestN = n; } });
  return bestN > 0 ? best : -1;
}

export function pollLeadLabel(poll) {
  const v = pollVotes(poll);
  const lead = pollLead(poll);
  if (lead < 0 || v.total === 0) return '';
  const pct = Math.round(v.counts[lead] * 100 / v.total);
  return `${poll.options[lead]} — ${pct}%`;
}

// Cast a vote: optimistic (myVote + счётчик сразу), signal email, rollback on failure.
// ADR-001: зависимости в сигнатуре — email/релей/api/crypto/saveCurrentHistory явно.
export function castPollVote({ email, activeChat, activeChatType, currentGroup, groupKeys, peerKeys, peerPqKeys, saveCurrentHistory }, msg, option) {
  const poll = msg.poll;
  if (!poll || poll.myVote !== null) return;
  const prev = poll.myVote;
  const prevSelfVote = poll.votes[email];
  poll.myVote = option;
  poll.votes[email] = option;
  const payload = JSON.stringify({ poll: 1, poll_id: poll.id, option });
  (async () => {
    try {
      if (activeChatType === 'group' && currentGroup) {
        const groupKey = (groupKeys || {})[currentGroup.id];
        if (!groupKey) throw new Error('no group key');
        const content = await crypto.encryptWithGroupKey(payload, groupKey);
        await api.sendGroupReact(currentGroup.id, content);
      } else if (activeChat && (peerKeys || {})[activeChat]) {
        crypto.setPeerPublicKey((peerKeys || {})[activeChat], peerPqKeys && (peerPqKeys || {})[activeChat]);
        const content = await crypto.encryptVault(payload);
        await api.sendReaction(activeChat, content);
      } else {
        throw new Error('no peer key');
      }
      const chatKey = activeChatType === 'group'
        ? 'group:' + (currentGroup ? currentGroup.id : '')
        : activeChat;
      if (typeof saveCurrentHistory === 'function') saveCurrentHistory(chatKey);
    } catch (e) {
      console.error('[poll] vote failed:', e);
      poll.myVote = prev;
      if (prevSelfVote === undefined) delete poll.votes[email];
      else poll.votes[email] = prevSelfVote;
    }
  })();
}

// Send a poll envelope (type:'poll' card for receivers).
// ADR-001: зависимости в сигнатуре вместо ctx (newMessageId/displayName/cryptoReady/
// groupKeys/peerKeys/{set,peerKeys}/chat.scrollToBottom/saveCurrentHistory/t).
export async function sendPoll({
  newMessageId, displayName, cryptoReady, peerKeys, peerPqKeys,
  groupKeys, activeChat, activeChatType, currentGroup,
  setSending, chat, scrollToBottom, saveCurrentHistory, t,
}, question, options) {
  const opts = (options || []).map(o => String(o).trim()).filter(Boolean).slice(0, 10);
  question = String(question || '').trim();
  if (!question || opts.length < 2) return;
  const pollId = newMessageId();
  const pollEnv = {
    vault: 1,
    id: newMessageId(),
    type: 'poll',
    text: question, // fallback-текст для legacy-клиентов/истории
    poll: { id: pollId, question, options: opts },
    name: displayName || '',
    key: crypto.publicKey || '',
    ts: Date.now(),
  };
  try {
    if (typeof setSending === 'function') setSending(true);
    const envelope = JSON.stringify(pollEnv);
    let content = envelope;
    if (activeChatType === 'group') {
      const groupKey = (groupKeys || {})[currentGroup.id];
      if (!groupKey) { if (t) alert(t('err_group_key')); return; }
      content = await crypto.encryptWithGroupKey(envelope, groupKey);
    } else if (cryptoReady && (peerKeys || {})[activeChat]) {
      crypto.setPeerPublicKey((peerKeys || {})[activeChat], peerPqKeys && (peerPqKeys || {})[activeChat]);
      content = await crypto.encryptVault(envelope);
    }
    const pendingMsg = {
      id: pollId,
      content: question,
      from: 'me',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ts: Date.now(), encrypted: true, vault: true, status: 'sending',
      poll: parsePollEnvelope(pollEnv),
    };
    if (pendingMsg.poll) pendingMsg.poll.myVote = null;
    if (chat && typeof chat.append === 'function') chat.append(pendingMsg);
    if (typeof scrollToBottom === 'function') scrollToBottom(true);
    if (activeChatType === 'group') {
      await api.sendGroupMessage(currentGroup.id, content, { id: pollEnv.id, text: pollEnv.text });
    } else {
      await api.sendMessage(activeChat, content);
    }
    pendingMsg.status = 'sent';
    const chatKey = activeChatType === 'group'
      ? 'group:' + (currentGroup ? currentGroup.id : '')
      : activeChat;
    if (typeof saveCurrentHistory === 'function') saveCurrentHistory(chatKey);
  } catch (e) {
    console.error('[poll] send failed:', e);
    if (t) alert(t('poll_err') || 'Poll failed');
  } finally {
    if (typeof setSending === 'function') setSending(false);
  }
}

// Merge wire votes (from signal emails) into poll cards after a rebuild
// of this.messages — keeps myVote/votes alive across the 30s polling.
export function applyPollVotes(list, wirePollVotes, email) {
  if (!list) return;
  for (const m of list) {
    if (!m || !m.poll) continue;
    const votes = wirePollVotes && wirePollVotes[m.poll.id];
    if (votes) {
      for (const v of votes) m.poll.votes[v.voter] = v.option;
    }
    if (m.poll.votes[email] !== undefined) m.poll.myVote = m.poll.votes[email];
  }
}
