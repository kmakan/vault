// Инвентарь App.vue: сколько методов и сколько из них — просто делегаты.
//
// ИСТОЧНИК ПРАВДЫ ОДИН: scripts/lib/arch-metrics.mjs (тот же код, что считает
// audit-arch и ратчет js-logic-ratchet). Раньше инвентарь считал делегаты по
// своему правилу («тело — ровно один вызов return <модуль>.<фн>(...)»), а
// audit-arch — по другому, и числа расходились (39 против 0 «методов с
// логикой»). Два числа об одном и том же — значит обоим перестаёшь верить.
//
// Инвентарь остаётся полезным как СВОДКА: сколько методов, сколько делегатов
// и — если что-то осталось с логикой — сколько this.* надо передать.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { appVueInventory } from './lib/arch-metrics.mjs';

const P = path.resolve(import.meta.dirname, '..', 'src', 'App.vue');
const src = readFileSync(P, 'utf8');
const inv = appVueInventory(src);

if (!inv.found) {
  console.log('App.vue: блок methods не найден — метрика ADR-005 не считается (проверь структуру файла)');
  process.exit(1);
}

const pct = inv.methods ? Math.round((inv.delegates / inv.methods) * 100) : 0;
console.log(`методов всего ${inv.methods}, делегатов ${inv.delegates} (${pct}%), ` +
            `со своей логикой ${inv.own}`);

if (!inv.own) {
  console.log('\n✓ App.vue — только вызовы: своей логики не осталось (цель ADR-005 §5).');
  process.exit(0);
}

console.log('\nсо своей логикой: ' + inv.ownNames.join(', '));
console.log('\nстрок в методах со своей логикой: блок methods занимает ' + inv.blockLines + ' строк');
