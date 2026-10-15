// Рассылка meta-писем группы (ADR-003 Этап 3, партия 11).
//
// ДО СЕЙ ЧАС ОДНО И ТО ЖЕ БЫЛО В ДВУХ МЕТОДАХ App.vue: onGroupRename и
// onGroupAvatarUpdate кажда собирала payload, шифровала групповым ключом и
// слала через api.sendGroupMeta. Две копии правила догрузки ключа разошлись,
// и это стоило дефекта — см. «ДОГРУЗКА КЛЮЧА» ниже.
//
// ПРАВИЛО ПРО ВЫБОР ПОЛЕЙ. Meta-письмо — это { meta: 1, ...поля }. Получатель
// (group-meta.js::syncGroupAvatarsFromMeta) читает obj.avatar и obj.name, а
// остальное игнорирует. Поэтому ts кладут только там, где он уже был: в
// rename. Добавление ts в аватарку изменило бы форму письма без нужды, а форма
// письма — это контракт с уже выпущенными клиентами.

import api, { db } from '../api.js';
import crypto from '../crypto.js';

// ПОЛЯ ДЛЯ ПЕРЕИМЕНОВАНИЯ. Правило одно и оно неочевидно:
//
//   ПУСТОЙ АВАТАР В ПИСЬМО НИКОГДА НЕ КЛАДЁМ. Письмо разбирает получатель по
//   правилу «if (obj.avatar && текущий !== obj.avatar) → записать». Пустая
//   строка была бы ложью «у группы аватар отсутствует» и затерела бы у
//   получателя ТОТ аватар, который у него есть. Поэтому `avatar` в payload
//   попадает только когда он реально есть.
//
// Имя при этом не фильтруется: пустое имя — осмысленное действие админа
// (снять имя), и получатель это примет.
export function buildRenameMetaFields(name, currentAvatar, ts = Date.now()) {
  return currentAvatar
    ? { name, avatar: currentAvatar, ts }
    : { name, ts };
}

// ДОГРУЗКА КЛЮЧА — ПРИЧИНА, ПОЧЕМУ МОДУЛЬ СУЩЕСТВУЕТ ВООБЩЕ.
//
// В onGroupAvatarUpdate стоял такой комментарий (он сохранён ниже дословно):
//
//   «Ключ группы мог быть ещё не загружен (настройки открыты без чата) —
//    тогда `if (!groupKey) return` МОЛЧА пропускал рассылку и у участников
//    аватар не появлялся никогда. Догружаем ключ (как в selectGroup)».
//
// Дефект был один — а правил два. onGroupRename остался со старым
// `if (!groupKey) return`, и переименование группы из настроек БЕЗ открытия
// чата не рассылалось вообще: имя менялось у себя, участники не узнавали о нём
// никогда, и узнать не могли — мета-письма не было. Тот же баг, тот же экран
// настроек, соседний метод. Правило теперь одно, и оно здесь.
//
// `cryptoReady` — необходимое условие: без расшифрованного хранилища
// getMyGroupKey отдаст мусор, и из него получится заведомо нерабочий ключ.
async function resolveGroupKey(groupId, groupKeys, cryptoReady) {
  let groupKey = groupKeys[groupId];
  if (!groupKey && cryptoReady) {
    try {
      const kd = await api.getMyGroupKey(groupId);
      if (kd && kd.group_key) {
        // Ключ кладём В ТОТ ЖЕ кэш компонента: он понадобится следующим
        // отправлятелям, и повторно догружать его каждый раз — лишний запрос.
        groupKeys[groupId] = kd.group_key;
        groupKey = kd.group_key;
      }
    } catch (e) {
      console.warn('[group] group key not loadable for meta broadcast:', e);
    }
  }
  return groupKey;
}

// Рассылает meta-письмо участникам группы.
//
// ВОЗВРАЩАЕТ ФАКТ, А НЕ БРОСАЕТ: { sent, reason }. Ошибка шифрования или
// отправки — рабочая ситуация (сеть, чужой клиент), а не повод ронять
// обработчик: локальное имя уже применено вызывающим, и ломать ему
// управление из-за неудачной рассылки незачем. Вызывающий сам решает, что
// записать в журнал.
// groupKeys передаётся ЯВНО, а не весь компонент: модулю нужны ровно две вещи —
// словарь ключей и признак готовности хранилища. Просить ради этого `this` значит
// связать модуль с компонентом целиком (гейт ctx-coupling это видит).
export async function broadcastGroupMeta(groupId, fields, { groupKeys, cryptoReady }) {
  const groupKey = await resolveGroupKey(groupId, groupKeys, cryptoReady);
  if (!groupKey) return { sent: false, reason: 'no-group-key' };
  try {
    const payload = JSON.stringify({ meta: 1, ...fields });
    const content = await crypto.encryptWithGroupKey(payload, groupKey);
    await api.sendGroupMeta(groupId, content);
    return { sent: true, reason: '' };
  } catch (e) {
    return { sent: false, reason: 'send-failed', error: e };
  }
}

// Аватар для рассылки переименования берётся из kv тем же путём, что и раньше:
// это ТО ЖЕ значение, что видит отправитель. Отдельный экспорт — чтобы
// вызывающий не собирал ключ kv руками в трёх местах.
export async function loadGroupAvatar(groupId) {
  return db.kvGet('anon', 'group-avatar:' + groupId);
}