// Закрепление сообщения: форма сигнального письма (ADR-003 Этап 3, партия 13).
//
// ЗАЧЕМ ЭТОТ МОДУЛЬ, ЕСЛИ ОБЕ СТОРОНЫ И ТАК РАБОТАЮТ.
//
// Отправитель писал форму в App.vue, приёмник читал её в features/groups.js.
// Два файла, две рукописные копии, общий контракт — и НИ ОДНОЙ проверки, что
// они согласованы.
//
// Расхождение здесь не «сломается», а ЗАМЕНИТСЯ ТИХО. Приёмник спрашивает
// `obj.action === 'unpin'`. Переименуют в отправителе `action` в `op` — и любой
// unpin станет pin: проверка вернёт ложь, ветка unpin не выполнится, сообщение
// останется закреплённым. Ни исключения, ни записи в журнал: человек нажал
// «открепить» и по-прежнему видит закреплённым. Худший вид поломки — тот, что
// выглядит как «не сработало», а не как «сломано».
//
// Поэтому форма объявлена ОДИН раз, а читает её тоже один: parsePinWire. Если
// отправитель изменит поле, сломается сборка или тест, а не чужая рассылка.
//
// ПРЕДУПРЕЖДЕНИЕ О ТИПЕ ДЕЙСТВИЯ. Любое значение, кроме 'unpin', приёмник
// трактует как pin — это осознанно (старые клиенты не присылали action вовсе, и
// их pin должен работать). Значит ОПЕЧАТКА В ИМЕНИ ДЕЙСТВИЯ НЕВИДИМА. Поэтому
// набор действий здесь константа, и он импортируется обеими сторонами.

export const PIN_WIRE_VERSION = 1;
export const PIN_ACTION = { PIN: 'pin', UNPIN: 'unpin' };

// Превью закреплённого: однострочный обрывок. Пробелы схлопываются, чтобы
// многострочное сообщение не превратило превью в кашу, и режется до 140
// символов — в письме оно идёт рядом с телом, и длинное делает конверт тяжёлым.
export const PIN_PREVIEW_MAX = 140;

export function buildPinPreview(content) {
  return String(content || '').replace(/\s+/g, ' ').trim().slice(0, PIN_PREVIEW_MAX);
}

// Решение: закрепить или открепить. Повторное нажатие на УЖЕ закреплённом
// сообщении открепляет — поэтому сравнение по msg_id, а не по наличию записи:
// переключение видно на том самом сообщении, на котором нажали.
export function buildPinDecision(msg, currentlyPinned, ts = Date.now()) {
  const pinning = !(currentlyPinned && currentlyPinned.msg_id === msg.id);
  return {
    msg_id: msg.id,
    action: pinning ? PIN_ACTION.PIN : PIN_ACTION.UNPIN,
    preview: buildPinPreview(msg.content),
    ts,
  };
}

// Сборка письма на отправке.
export function buildPinWirePayload(decision) {
  return {
    pin: PIN_WIRE_VERSION,
    msg_id: decision.msg_id,
    action: decision.action,
    preview: decision.preview,
    ts: decision.ts,
  };
}

// ЕДИНСТВЕННОЕ место, где форма письма ЧИТАЕТСЯ.
//
// Возвращает null, если это не pin-письмо, — вызывающий обязан продолжить
// разбор конверта. fallbackTs подставляется, когда письмо пришло без ts:
// авторитетно письмо, а не дата отправки, но у старых клиентов ts не было.
export function parsePinWire(obj, fallbackTs = 0) {
  if (!obj || obj.pin !== PIN_WIRE_VERSION || !obj.msg_id) return null;
  return {
    msg_id: obj.action === PIN_ACTION.UNPIN ? null : obj.msg_id,
    preview: obj.preview || '',
    ts: obj.ts || fallbackTs || 0,
  };
}