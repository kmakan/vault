// Node-смоук features/channels-store.js — владелец состояния каналов
// (ADR-004 J.5d).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Владелец хранит посты каналов, счётчики
// непрочитанных, аватары и активный канал. До этого модуль был покрыт
// лишь ПОПУТНО (смоук фичи каналов дёргал setChannelPosts в своём стенде),
// а его собственная семантика — ЗАМЕНА постов, ПРИБАВЛЕНИЕ постов,
// обнуление счётчика, сброс всего — не проверялась нигде.
//
// ПРОВЕРЯЕМ:
//   * setChannelPosts — ЗАМЕНЯЕТ список (не дописывает);
//   * addChannelPosts — ПРИБАВЛЯЕТ к существующим (порядок сохраняется);
//   * getChannelPosts — чужой канал → [], не undefined;
//   * setUnread / clearUnread — счётчик и его обнуление;
//   * setChannelAvatar / getChannelAvatar — аватар и пустое значение;
//   * setCurrentChannel — значение и нормализация null/undefined → null;
//   * reset — полная очистка всех четырёх секций.
import { createChannelsStore } from '../src/features/channels-store.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

const s = createChannelsStore();

// ── Посты канала ────────────────────────────────────────────────────────
ok('старт: постов нет', Object.keys(s.state.channelPosts).length === 0);
s.setChannelPosts('c1', [{ ts: 1, body: 'привет' }]);
ok('setChannelPosts: пост записан', s.getChannelPosts('c1').length === 1);
ok('setChannelPosts: тело сохранено', s.getChannelPosts('c1')[0].body === 'привет');
s.setChannelPosts('c1', [{ ts: 2, body: 'замена' }]);
ok('setChannelPosts: ЗАМЕНЯЕТ (старых нет)', s.getChannelPosts('c1').length === 1, s.getChannelPosts('c1'));
ok('setChannelPosts: записано новое', s.getChannelPosts('c1')[0].body === 'замена');
ok('getChannelPosts: чужой канал → []', JSON.stringify(s.getChannelPosts('nope')) === '[]');
s.setChannelPosts('c2', []);
ok('setChannelPosts: пустой массив допустим', s.getChannelPosts('c2').length === 0);

s.setChannelPosts('c3', [{ ts: 1 }]);
s.addChannelPosts('c3', [{ ts: 2 }, { ts: 3 }]);
ok('addChannelPosts: ПРИБАВЛЯЕТ', s.getChannelPosts('c3').length === 3, s.getChannelPosts('c3'));
ok('addChannelPosts: порядок сохранён (старые первыми)',
  s.getChannelPosts('c3')[0].ts === 1 && s.getChannelPosts('c3')[2].ts === 3, s.getChannelPosts('c3'));
s.addChannelPosts('c3', []);
ok('addChannelPosts: пустой список ничего не ломает', s.getChannelPosts('c3').length === 3);
s.addChannelPosts('cNew', [{ ts: 9 }]);
ok('addChannelPosts: в новый канал создаёт запись', s.getChannelPosts('cNew').length === 1);
ok('addChannelPosts: в новый канал НЕ трогает чужие', s.getChannelPosts('c3').length === 3);

// ── Счётчик непрочитанных ───────────────────────────────────────────────
ok('старт: счётчиков нет', Object.keys(s.state.channelUnread).length === 0);
s.setUnread('c1', 5);
ok('setUnread: счётчик записан', s.state.channelUnread.c1 === 5);
s.setUnread('c1', 0);
ok('setUnread: 0 пишется как 0 (не удаляется)', s.state.channelUnread.c1 === 0);
// clearUnread — на НЕНУЛЕВОМ счётчике: проверка на нуле прошла бы и при
// сломанном clearUnread (счётчик и так 0) — проверка-декорация.
s.setUnread('c1', 7);
s.clearUnread('c1');
ok('clearUnread: НЕНУЛЕВОЙ счётчик обнулён', s.state.channelUnread.c1 === 0, s.state.channelUnread);
s.setUnread('c2', 3);
ok('clearUnread: чужой счётчик не тронут', s.state.channelUnread.c2 === 3);

// ── Аватары ─────────────────────────────────────────────────────────────
ok('старт: аватаров нет', Object.keys(s.state.channelAvatars).length === 0);
s.setChannelAvatar('c1', 'data:image/png;base64,AAA');
ok('setChannelAvatar: аватар записан', s.getChannelAvatar('c1') === 'data:image/png;base64,AAA');
ok('getChannelAvatar: чужой канал → ""', s.getChannelAvatar('nope') === '');
s.setChannelAvatar('c1', '');
ok('setChannelAvatar: пустое значение → ""', s.getChannelAvatar('c1') === '');

// ── Активный канал ──────────────────────────────────────────────────────
ok('старт: активного канала нет', s.state.currentChannel === null);
s.setCurrentChannel('c1');
ok('setCurrentChannel: значение записано', s.state.currentChannel === 'c1');
s.setCurrentChannel(null);
ok('setCurrentChannel: null нормализуется в null', s.state.currentChannel === null);
s.setCurrentChannel(undefined);
ok('setCurrentChannel: undefined → null', s.state.currentChannel === null);

// ── reset ────────────────────────────────────────────────────────────────
s.setChannelPosts('c1', [{ ts: 1 }]);
s.setUnread('c1', 2);
s.setChannelAvatar('c1', 'data:x');
s.setCurrentChannel('c1');
s.reset();
ok('reset: посты очищены', Object.keys(s.state.channelPosts).length === 0);
ok('reset: счётчики очищены', Object.keys(s.state.channelUnread).length === 0);
ok('reset: аватары очищены', Object.keys(s.state.channelAvatars).length === 0);
ok('reset: активный канал сброшен', s.state.currentChannel === null);

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
