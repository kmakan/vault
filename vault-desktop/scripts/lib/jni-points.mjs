// Точки JNI-провода: что зовёт Rust из моста. Одна копия правила для
// jni-keep-gate (тексты keep-правил и деклараций) и dex-jni-check (что реально
// лежит в DEX собранного APK). Двух списков вызовов быть не должно: расхождение
// между ними и есть тот дефект, который эти меры ловят.
import fs from 'node:fs';
import path from 'node:path';

const PRIMITIVES = {
  V: 'void', Z: 'boolean', B: 'byte', S: 'short', I: 'int', J: 'long',
  F: 'float', D: 'double', C: 'char',
};

export function walk(dir, filter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['target', 'build', '.gradle', '.cxx'].includes(e.name)) continue;
      out.push(...walk(p, filter));
    } else if (filter(p)) out.push(p);
  }
  return out;
}

// «(Landroid/content/Context;Ljava/lang/String;ZZ)V» → имена типов Java
export function paramsOf(sig) {
  const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
  const out = [];
  let i = 0;
  while (i < inner.length) {
    let dims = 0;
    while (inner[i] === '[') { dims++; i++; }
    let type;
    if (inner[i] === 'L') {
      const end = inner.indexOf(';', i);
      type = inner.slice(i + 1, end).replace(/\//g, '.');
      i = end + 1;
    } else {
      type = PRIMITIVES[inner[i]] || inner[i];
      i++;
    }
    out.push(type + '[]'.repeat(dims));
  }
  return out;
}

// find_app_class(..) даёт класс, ближайший call_static_method после него — имя
// и сигнатуру. Литерал описателя («Lcom/…;») из find_class тоже понимается.
export function collectJniPoints(bridgeDir) {
  const calls = [];
  for (const file of walk(bridgeDir, (p) => p.endsWith('.rs'))) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /(?:(find_app_class|find_class)\(\s*[^;]*?"([\w./$]+)"[\s\S]{0,1500}?)call_static_method\(\s*&?[\w.]+,\s*"(\w+)",\s*"([^"]+)"/g;
    for (const m of src.matchAll(re)) {
      let cls = m[2];
      if (cls.startsWith('L')) cls = cls.slice(1).replace(/\//g, '.');
      calls.push({ cls, name: m[3], sig: m[4], params: paramsOf(m[4]), file });
    }
  }
  return calls;
}
