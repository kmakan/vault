// Настройки: почтовый провайдер, иконка приложения, эксперименты — ADR-005 W3.
//
// Четыре маленьких обработчика, которые жили в компоненте. Собраны здесь по
// смыслу: это «ручки настроек», и у них общий контракт — значение меняется,
// затем сохраняется.
//
// ПОЧТОВЫЙ ПРОВАЙДЕР. «Другой (вручную)» очищает поля для ручного ввода —
// иначе в форме остались бы серверы предыдущего провайдера, и пользователь
// вводил бы ручные настройки, а подключался к чужому серверу.
//
// ИКОНКА ПРИЛОЖЕНИЯ. Выбор сохраняется в localStorage (переживает перезапуск)
// и применяется к favicon и к нативному окну (waybar/dock).
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами.
import api from '../api.js';
import { findProvider, CUSTOM_PROVIDER_ID } from '../mailProviders.js';

// Имена хранимых тумблеров (один словарь на фронт; правило — в Rust).
export const EXP_CALLS_FLAG = 'exp-calls';
export const EXP_VIDEO_FLAG = 'exp-video';

export function applyMailProvider(deps, id) {
  deps.setMailProvider(id);
  const p = findProvider(id);
  if (!p) return; // 'custom' или пусто — поля остаются как есть
  deps.setImapServer(p.imap_server);
  deps.setImapPort(String(p.imap_port));
  deps.setSmtpServer(p.smtp_server);
  deps.setSmtpPort(String(p.smtp_port));
}

// Обработчик селекта: «Другой (вручную)» очищает поля для ручного ввода.
export function onMailProviderChange(deps) {
  if (deps.mailProvider() === CUSTOM_PROVIDER_ID) {
    deps.setImapServer('');
    deps.setImapPort('');
    deps.setSmtpServer('');
    deps.setSmtpPort('');
  } else {
    applyMailProvider(deps, deps.mailProvider());
  }
}

export function onAppIconChanged(deps, id) {
  deps.setAppIconId(id);
  // Persist so the chosen icon survives restarts and is reflected everywhere.
  deps.storage().setItem('vault-icon', id);
  const favicon = deps.document().querySelector("link[rel='icon']");
  if (favicon) favicon.href = `/icons/vault-${id}.svg`;
  // Update the native window icon (waybar/dock).
  api.setAppIcon(id).catch(() => { /* ignore window icon failures */ });
}

export async function onExperimentsCalls(deps, on) {
  deps.setExpCalls(!!on);
  await api.settingsFlagSet(EXP_CALLS_FLAG, !!on);
}

export async function onExperimentsVideo(deps, on) {
  deps.setExpVideo(!!on);
  await api.settingsFlagSet(EXP_VIDEO_FLAG, !!on);
}

// Стартовое состояние тумблеров. Дефолт «пользователь не выбирал» считает
// Rust (vault-core::settings), фронт лишь перекладывает ответ в состояние:
// раньше он был продублирован в data компонента и в перечитывании kv, и смена
// решения (звонки — по умолчанию) обязывала помнить обе строки.
export async function loadExperimentFlags(deps) {
  const calls = await api.settingsFlag(EXP_CALLS_FLAG);
  if (calls !== null) deps.setExpCalls(calls);
  const video = await api.settingsFlag(EXP_VIDEO_FLAG);
  if (video !== null) deps.setExpVideo(video);
  return { calls: deps.expCalls(), video: deps.expVideo() };
}
