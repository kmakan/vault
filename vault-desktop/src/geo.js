// Геолокация для отправки «я здесь» (ADR-003 Этап 3, партия 13).
//
// Здесь тестируема не «логика», а ТАЙМИНГ, а именно он в этом коде и был
// источником неприятного.
//
// navigator.geolocation — единственный API, который разрешается когда угодно,
// включая «никогда». Отсюда обёртка с таймаутом и флагом done: без него поздний
// ответ геолокации разрешал бы промес ПОСЛЕ того, как пользователю уже показали
// «Геолокация недоступна», и запись в поле ввода произошла бы сама, без
// спроса. Флаг done делает первый ответ победителем, а clearTimeout снимает
// таймер, чтобы он не держал событийный цикл.
//
// Широта и долгота печатаются с пятью знаками. Меньше — в пределах квартала,
// больше — в письме выглядит как координаты, выдуманные с точностью до
// сантиметра.

export const GEO_TIMEOUT_MS = 8000;
// Сколько живёт позиция, прежде чем считать её устаревшей: 300 секунд —
// перемещение за это время не меняет того, где человек «сейчас».
export const GEO_MAX_AGE_MS = 300000;
export const GEO_ZOOM = 17;

export function formatCoords(lat, lon) {
  return `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
}

// Ссылка на карту. Часть после #map= та же самая координата: OSM показывает
// метку по ней, а не по mlat/mlon в запросе.
export function buildMapUrl(coords) {
  const [lat, lon] = String(coords).split(',').map((x) => x.trim());
  return 'https://www.openstreetmap.org/?mlat=' + lat
    + '&mlon=' + lon + '#map=' + GEO_ZOOM + '/' + lat + '/' + lon;
}

export function buildGeoMessage(label, coords) {
  return label + ' ' + coords + ' — ' + buildMapUrl(coords);
}

// Промис координат. Разрешается null при любой неудаче — вызывающему важно
// РЕШИТЬ, показать тост или нет, а не разбирать четыре разных отказа.
//
// ЗАЧЕМ ВООБЩЕ ФЛАГ done. Первая версия комментария здесь утверждала, что без
// него «поздний ответ разрешит промес ПОСЛЕ того, как показано "недоступна", и
// запишет поле ввода сам». Это НЕВЕРНО, и проверка такая поломка не ловила:
// промес нельзя перезаписать (гарантия языка), а вызывающий после тоста делает
// return. Заявлять защиту от того, что невозможно, — значит врать в комментарии
// и тестировать пустоту.
//
// ЧТО ФЛАГ ДЕЛАЕТ НА САМОМ ДЕЛЕ:
//   1. clearTimeout — главное. Без него таймер на 8 секунд продолжал бы висеть
//      после мгновенного успеха, удерживая событийный цикл. В приложении это
//      незаметно, в тестах и на узлах — падение процесса с задержкой.
//   2. Не даёт вызвать resolve/clearTimeout повторно — косметика.
//
// navigator.geolocation может и бросить синхронно (в некоторых сборках при
// отсутствии разрешения), поэтому вызов обёрнут в try.
export function resolveCurrentCoords({
  timeoutMs = GEO_TIMEOUT_MS,
  maxAgeMs = GEO_MAX_AGE_MS,
  geo = (typeof navigator !== 'undefined' ? navigator.geolocation : null),
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(c);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      if (!geo || typeof geo.getCurrentPosition !== 'function') {
        finish(null);
        return;
      }
      geo.getCurrentPosition(
        (pos) => finish(formatCoords(pos.coords.latitude, pos.coords.longitude)),
        () => finish(null),
        { timeout: timeoutMs - 1000, maximumAge: maxAgeMs },
      );
    } catch (e) {
      finish(null);
    }
  });
}

// Отправить своё местоположение: подставляем в поле ввода готовое сообщение.
// Если геолокация недоступна — честно говорим об этом, а не молчим.
export async function sendGeoMessage(deps) {
  const coords = await resolveCurrentCoords(deps.geoDeps());
  if (!coords) {
    deps.toast(deps.tr('geo_err') || 'Геолокация недоступна', 3000);
    return;
  }
  deps.setNewMessage(buildGeoMessage(deps.tr('geo_im_here') || 'Я здесь:', coords));
  deps.focusMessageInput();
}
