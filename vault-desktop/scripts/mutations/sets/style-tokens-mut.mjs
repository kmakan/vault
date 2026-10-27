// Набор мутаций: style-tokens-mut
// Цель: убедиться, что themes-smoke.mjs ЛОВИТ поломки в дизайн-токенах. Если
// мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// ЗАЧЕМ МЕРА ИМЕННО ЗДЕСЬ. CSS-переменные — единственный канал, которым тема
// доходит до компонентов: `applyTheme` пишет набор переменных выбранной темы в
// documentElement, а остальное оформление живёт в `.vue`. Мутовать `.vue`
// нечем — там нет ветвления, смоук читает их как данные. А вот объявление
// токена — это решение: токен, который вызовут без запасного значения
// (`var(--accent)`), обязан быть объявлен в глобальной базе или во всех темах.
// Класс регресса уже был: `--radius-*`, `--shadow-sm` и `--font-sans`
// использовались так же, и у элементов пропадали скругления, тень и шрифт.
// `--accent` и три мёртвых имени в компонентах (`--border`, `--border-color`,
// `--accent-hover`) — те же грабли, найденные проверкой 27.10.
//
// Файлы тут разные (style.css, App.vue, три компонента): набор про правило
// токенов, а не про один файл — мутации бьют по своему месту через `file`.
// В плотность ратчета (gate:mutation-density) эти 12 НЕ попадают: он считает
// мутации по `.js`/`.rs`, а `.css`/`.vue` вне его области. См. ADR-005 §6
// (партия 5l) — дыра задокументирована, а не замазана.

export default {
  id: 'style-tokens-mut',
  file: 'src/style.css',
  smoke: 'themes-smoke.mjs',
  mutations: [
    // ── токен объявлен, но не работает ──
    { name: 'акцент потерян из базы (кнопки без фона там, где тема его не задаёт)',
      pattern: '  --accent: var(--accent-primary, #6366f1);\n',
      replacement: '' },
    { name: 'акцент застывает литералом (тема на него больше не влияет)',
      pattern: '  --accent: var(--accent-primary, #6366f1);',
      replacement: '  --accent: #6366f1;' },
    { name: 'акцент цепляется на фон вместо акцента (кнопка цвета фона)',
      pattern: '  --accent: var(--accent-primary, #6366f1);',
      replacement: '  --accent: var(--bg-primary, #0a0a1a);' },
    { name: 'акцент объявлен пустым значением (правило невалидно)',
      pattern: '  --accent: var(--accent-primary, #6366f1);',
      replacement: '  --accent: ;' },
    // ── база второй половины дизайн-системы — в глобальном <style> App.vue ──
    { name: 'цвет «в сети» теряет базу (индикатор присутствия невидим)',
      file: 'src/App.vue',
      pattern: '  --status-online: #22c55e;\n',
      replacement: '' },
    { name: 'длительность быстрых переходов теряет базу (анимаций нет)',
      file: 'src/App.vue',
      pattern: '  --transition-fast: 150ms ease;\n',
      replacement: '' },
    { name: 'база токенов уезжает в scoped-блок (правило не матчит документ)',
      file: 'src/App.vue',
      pattern: '<style>',
      replacement: '<style scoped>' },
    // ── мёртвые имена в компонентах: вызов токена, которого нет ни в базе, ни в темах ──
    { name: 'ContactList снова зовёт --border (рамка секции групп пропадает)',
      file: 'src/components/ContactList.vue',
      pattern: 'var(--border-subtle, rgba(255, 255, 255, 0.06))',
      replacement: 'var(--border)' },
    { name: 'LanguageSelector снова зовёт --border-color (рамка селекта пропадает)',
      file: 'src/components/LanguageSelector.vue',
      pattern: 'var(--border-subtle, rgba(255, 255, 255, 0.06))',
      replacement: 'var(--border-color)' },
    { name: 'CipherTool снова зовёт --accent-hover (наведение на кнопку молчит)',
      file: 'src/components/CipherTool.vue',
      pattern: 'var(--accent-secondary, #818cf8)',
      replacement: 'var(--accent-hover)' },
    // ── отступы под системную навигацию ──
    { name: 'нижний отступ перестаёт следить за навбаром (0px вместо env)',
      pattern: '  --safe-bottom: env(safe-area-inset-bottom, 0px);',
      replacement: '  --safe-bottom: 0px;' },
    { name: 'боковой отступ в ландшафте перестаёт следить за навбаром',
      pattern: '  --safe-left: env(safe-area-inset-left, 0px);',
      replacement: '  --safe-left: 0px;' },
  ],
};
