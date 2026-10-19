# Гейт `this.*` в компонентах (`[E4]`)

Живёт внутри `vault-desktop/scripts/check-template.cjs` (класс проблем `[E4]`),
запускается в `npm run build` первым шагом. Отдельным скриптом не сделан
намеренно: там уже есть AST (`@babel/parser`), `bindings` из `compileScript`
(data/computed/methods/props/setup) и живое разрешение спредов фич
(`resolveStateSpreads`) — дублировать это значило бы разойтись с `E1`.

Тикет: `t_ddc24f52`. Разбор класса: `docs/design/module-separation-open-items.md` §4.

## Зачем

`this.X` в методе компонента не проверял никто:

| Проверка | Почему не видит |
|---|---|
| `ctx-coupling-gate` | считает ссылки, а не существование членов |
| `check-template` (E1) | смотрит шаблон и bindings, а не `<script>` |
| смоуки | не открывают компонент |
| `boot-smoke` | ловит падение **на загрузке**, а не при клике |

Класс уже срабатывал вживую: `this.alertMsg(...)` в `copyText` (метода нет
вовсе) и `this.uiStore` в `showToast` (метод есть, но не в инстансе) — оба
раза сборка была зелёной, ошибка ждала нажатия у человека.

## Что проверяется

Каждый `this.X` в `<script>` компонента с Options API и в **выражениях**
шаблона (`{{ }}`, `:attr`, `@event`, `v-*`) обязан быть:

1. в `bindings` — то есть в `data`/`computed`/`methods`/`props`/`setup`(+ спреды
   фич вида `...foldersState()`, ключи которых резолвит живой импорт); либо
2. присвоен где-то как `this.X = ...` (ad-hoc нереактивное поле); либо
3. начинаться с `$` (прокси Vue: `$refs`, `$emit`, `$nextTick`, `$route`, ...).

Иначе — `[E4]`: `TypeError при вызове`, и только у живого человека.

## Чего гейт намеренно НЕ проверяет

- **`this.X = ...` (ad-hoc поля).** В проекте так живут нереактивные хендлы
  (`this._unlistenMediaConnected`, `this._nextInviteTimer`, `this.onWindowResize`,
  `this._pendingBackup`). Они не в `data()` — и это не поломка. Правило
  «присвоено = объявлено» получено ручной сверкой: без него гейт ругался на
  34 существующих места, а такой гейт отключают целиком вместе с настоящей
  проверкой.
- **Реактивность.** Ad-hoc поле не попадает в рендер, но это отдельный класс
  (`connected` в `App.vue` присваивается и нигде не читается — найдено сверкой,
  к `[E4]` отношения не имеет).
- **`this['x']`** — имя динамическое, статически не проверяется.
- **`this.X` в комментариях и строках.** Скан идёт по AST, поэтому
  пояснения вида «`this.sessionStore.login()` (App.vue)» не дают ложных
  срабатываний. `this.X` в литеральном атрибуте (текст справки) — тоже не
  выражение, и тоже не считается.
- **`mixins` / `extends`** — члены оттуда в bindings не видны, поэтому гейт
  сообщает `[E4-mixins]` (fail-closed) вместо ложного «нет в data».
- **`<script setup>`** — `this` там не существует по определению, проверять
  нечего.

## Самопроверка (обязательна при правках гейта)

```bash
cd vault-desktop
node scripts/check-template.cjs                                        # чистое дерево → код 0
# подставляем несуществующий вызов и ждём код 1 с точным адресом:
#   src/components/EmailInbox.vue, в methods{} →
#     selfCheckBroken() { this.definitelyMissingMethod(); }
node scripts/check-template.cjs                                        # → код 1
#   EmailInbox.vue:79: [E4] this.definitelyMissingMethod — нет в
#   data/computed/methods/props/setup и нигде не присвоен: TypeError при вызове
# и обратная сторона (не должно краснеть):
#     selfCheckOk() { this._adhocTimer = setTimeout(() => { this._adhocTimer = null; }, 10); }
node scripts/check-template.cjs                                        # → код 0
```

Выполнено 19.10.2026: 0 / 1 / 0, тексты совпали.

## Что гейт нашёл на первом прогоне

`this.channelsStore` в `App.vue` (2 места). `channelsStore` — модульный импорт,
в инстанс через `setup()` не отдаётся → `undefined`:

- `selectChannel` — клик по каналу в списке падал с `TypeError`;
- `loadChannels` — исключение **внутри цикла** обрывало его, а ловилось общим
  `catch` рядом: посты и счётчик непрочитанного грузились только для первого
  канала.

Починено голым именем модуля (как он и читается в `computed` рядом); проверено
живьём на телефоне (см. комментарий `t_ddc24f52`).
