// Проверка тегов версий на обоих ремоутах.
//
// ЗАЧЕМ. На GitHub с 17.09 лежал «хвостовой» тег, указывавший на старый
// коммит. Из-за этого КАЖДЫЙ следующий пуш тега версии отклонялся («метка уже
// существует») — и это сообщение выглядело как мелочь, а на деле четыре
// релиза (0.1.243/244/246/247) показывали «Source code» чужого коммита.
//
// ПРАВИЛО. Тег версии на обоих ремоутах должен указывать на ОДИН И ТОТ ЖЕ
// коммит, и этот коммит должен быть тем, из которого собраны ассеты ре��иза.
// Скрипт проверяет первое (второе проверяется сверкой sha256 ассетов).
//
// ЗАПУСК: node scripts/release-tag-check.mjs [v0.1.249 ...]
// Без аргументов проверяет все теги версий, найденные в репозитории.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REMOTES = ['github', 'gitverse'];

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

function localTagCommit(tag) {
  try {
    return git(['rev-list', '-n', '1', tag]);
  } catch (e) {
    return null;
  }
}

function remoteTagCommit(remote, tag) {
  try {
    const out = git(['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
    const lines = out.split('\n').filter(Boolean);
    // Аннотированный тег: строка без ^{} — объект тега, с ^{} — сам коммит.
    const peeled = lines.find((l) => l.includes('^{}'));
    const plain = lines.find((l) => !l.includes('^{}'));
    const sha = (peeled || plain || '').split(/\s+/)[0] || null;
    if (peeled) return sha;           // аннотированный → коммит
    if (plain) {
      // облегчённый тег: сам sha — коммит
      const t = git(['cat-file', '-t', sha]);
      return t === 'tag' ? git(['rev-list', '-n', '1', sha]) : sha;
    }
    return null;
  } catch (e) {
    return null;
  }
}

const args = process.argv.slice(2);
// Без аргументов проверяем ПОСЛЕДНИЕ 10 тегов версий: старые (v0.1.14x–17x)
// расходятся исторически — их пуши делались до текущей схемы зеркала, и
// чинить их задним числом — отдельная работа, а не повод молчать о новых.
const verOf = (t) => t.replace(/^v/, '').split('.').map(Number);
let tags = args.length ? args : git(['tag', '-l', 'v*']).split('\n').filter(Boolean);
tags = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort((a, b) => {
  const x = verOf(a), y = verOf(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
});
if (!args.length) tags = tags.slice(-10);

let bad = 0;
for (const tag of tags) {
  const local = localTagCommit(tag);
  const row = { tag, local: local ? local.slice(0, 10) : '—' };
  let okAll = true;
  for (const remote of REMOTES) {
    const rc = remoteTagCommit(remote, tag);
    row[remote] = rc ? rc.slice(0, 10) : '—';
    if (!rc || (local && rc !== local)) okAll = false;
  }
  const mark = okAll ? '✓' : '✗';
  if (!okAll) bad++;
  console.log(`  ${mark} ${row.tag.padEnd(12)} локально=${row.local}  github=${row.github}  gitverse=${row.gitverse}`);
}

if (bad) {
  console.log(`\n✗ release-tag-check: ${bad} тег(ов) расходятся или отсутствуют на ремоутах.`);
  console.log('  Что делать: на GitHub тег мог остаться со старого коммита (пуш отклоняется как');
  console.log('  «метка уже существует»). Переставить тег на текущий коммит и пересоздать релиз:');
  console.log('    git push <remote> :refs/tags/<tag> && git push <remote> <tag>');
  console.log('  затем пересоздать релиз (GitHub API), чтобы «Source code» вёл на нужный коммит.');
  process.exit(1);
}
console.log(`\n✓ release-tag-check: все ${tags.length} тег(ов) версий указывают на один и тот же коммит на обоих ремоутах.`);
