// Загрузка и приведение аватаров к виду (ADR-003 Этап 3, партия 12).
//
// ТРИ копии одной и той же последовательности — «проверить 500КБ → прочитать
// файл → загрузить картинку → обрезать по центру в квадрат → отдать dataURL»:
//   · components/AvatarUpload.vue       — аватар профиля, 256×256 PNG
//   · components/GroupSettings.vue      — аватар группы,     128×128 JPEG 0.8
//   · App.vue::onNewGroupAvatarSelected — ЧЕРНОВИК аватара группы, 128×128 JPEG 0.8
//
// ЧЕРНОВИК ПРОТИВ СОХРАНЁННОГО — ГЛАВНАЯ ПРИЧИНА, А НЕ ДЛИНА.
//
// Черновик показывается пользователю как «вот что получится», и он обязан
// совпадать с тем, что реально сохранится. Сейчас совпадает — но совпадение это
// случайность двух написанных вручную копий, а не свойство кода. Стоит кому-то
// поменять формат в GroupSettings (например, PNG ради резкости), и черновик
// останется JPEG 0.8: пользователь увидит смазанное превью, нажмёт «создать» и
// получит резкую картинку. Или наоборот. Никто этого не заметит, пока кто-то не
// сравнит два изображения глазами.
//
// Пресеты поэтому общие, и черновик и сохранение берут ОДИН и тот же GROUP_AVATAR.
// Случай «черновик отличается от результата» после этого структурно невозможен.

export const AVATAR_MAX_BYTES = 500 * 1024;

// Аватар профиля: 256×256 PNG. Без quality — качество JPEG здесь неприменимо,
// и передавать его в toDataURL значило бы делать вид, что параметр что-то решает.
export const PROFILE_AVATAR = { size: 256, mime: 'image/png' };

// Аватар группы: 128×128 JPEG 0.8. Сжимается потому, что рассылается
// участникам письмами под шифром — в конверте размер заметен.
export const GROUP_AVATAR = { size: 128, mime: 'image/jpeg', quality: 0.8 };

// Предел одинаков для всех трёх мест. Проверка строгая на «больше»: ровно
// 500·1024 проходит. Менять здесь, а не в вызывающих.
export function avatarTooBig(size) {
  return size > AVATAR_MAX_BYTES;
}

// Прямоугольник центральной обрезки в ИСХОДНЫХ координатах.
//
// Смещения могут быть ДРОБНЫМИ: на картинке 101×100 в 128 берётся 100×100 со
// смещением 0.5 по X. Это не баг, а требование canvas — он сам округлит. Но
// округлять надо один раз и явно, а не полагаться на то, что браузер это
// сделает одинаково везде.
export function squareCropRect(srcW, srcH, dstSize) {
  const size = Math.min(srcW, srcH);
  return { sx: (srcW - size) / 2, sy: (srcH - size) / 2, size, dstSize };
}

// Рисует обрезанное в canvas и отдаёт dataURL. Чистый относительно файлов:
// нужен только уже загруженный <img>.
export function renderSquareCrop(img, preset) {
  const { sx, sy, size } = squareCropRect(img.width, img.height, preset.size);
  const canvas = document.createElement('canvas');
  canvas.width = preset.size;
  canvas.height = preset.size;
  canvas.getContext('2d').drawImage(img, sx, sy, size, size, 0, 0, preset.size, preset.size);
  return canvas.toDataURL(preset.mime, preset.quality);
}

// Файл → dataURL нужного вида.
//
// ОТКАЗЫ ЗАДЕКЛАРИРОВАНЫ, и это не косметика. В копиях обработчиков на
// img.onload/readAsDataURL не было ни одного, поэтому битый файл приводил не к
// ошибке, а к ЗАВИСШЕМУ ПРОМЕСУ: img.onload не наступает, колёсико «загрузка»
// крутится вечно, и ничто об этом не сообщает. Теперь onerror → reject, и
// вызывающий может сказать человеку, что файл не читается.
//
// Загрузка большого файла отдаёт event.target.result, а не reader.result:
// так было в исходниках, и результат одинаковый — здесь важно не менять
// поведение без нужды.
export function fileToAvatarDataUrl(file, preset) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        try {
          resolve(renderSquareCrop(img, preset));
        } catch (e) {
          reject(e);
        }
      };
      // Без этого битая картинка вешала бы промес навсегда.
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}