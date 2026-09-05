// ui.js — заменяет нативные alert/confirm/prompt кастомными элементами,
// чтобы в WebKitGTK (Tauri) не отображался системный заголовок
// "javascript - tauri://localhost" и не светилась внутренняя технология.
//
// - window.alert  -> toast (авто-скрытие, не блокирует)
// - window.confirm -> модалка подтверждения (Promise<boolean>)
// - window.prompt  -> модалка с полем ввода (Promise<string|null>)
//
// Импортируется первым в main.js (до монтирования Vue).

function ensureRoot() {
  let root = document.getElementById('vault-ui-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'vault-ui-root';
    document.body.appendChild(root);
  }
  return root;
}

function toast(msg) {
  const root = ensureRoot();
  const el = document.createElement('div');
  el.className = 'vault-toast';
  el.textContent = String(msg);
  root.appendChild(el);
  // Разрешить reflow, чтобы сработал transition появления
  requestAnimationFrame(() => el.classList.add('vault-toast-show'));
  setTimeout(() => {
    el.classList.remove('vault-toast-show');
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// Единая модалка: title, message, optional input, ok/cancel.
// resolve(value) — по ОК (для prompt — строка, иначе true), resolve(null/false) — по отмене.
function dialog(opts) {
  return new Promise(resolve => {
    const root = ensureRoot();
    const overlay = document.createElement('div');
    overlay.className = 'vault-dialog-overlay';

    const card = document.createElement('div');
    card.className = 'vault-dialog';

    if (opts.title) {
      const title = document.createElement('div');
      title.className = 'vault-dialog-title';
      title.textContent = opts.title;
      card.appendChild(title);
    }

    const msg = document.createElement('div');
    msg.className = 'vault-dialog-msg';
    msg.textContent = opts.message || '';
    card.appendChild(msg);

    let inputEl = null;
    if (opts.input) {
      inputEl = document.createElement('input');
      inputEl.className = 'vault-dialog-input';
      inputEl.type = 'text';
      inputEl.value = opts.inputValue || '';
      inputEl.placeholder = opts.placeholder || '';
      card.appendChild(inputEl);
    }

    const buttons = document.createElement('div');
    buttons.className = 'vault-dialog-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'vault-dialog-cancel';
    cancelBtn.textContent = opts.cancelText || 'Отмена';
    cancelBtn.addEventListener('click', () => finish(null));

    const okBtn = document.createElement('button');
    okBtn.className = 'vault-dialog-ok';
    okBtn.textContent = opts.okText || 'ОК';
    okBtn.addEventListener('click', () => finish(inputEl ? inputEl.value : true));

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    card.appendChild(buttons);
    overlay.appendChild(card);
    root.appendChild(overlay);

    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }

    function onKey(e) {
      if (e.key === 'Escape') finish(inputEl ? null : false);
      if (e.key === 'Enter' && inputEl) finish(inputEl.value);
    }

    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) finish(inputEl ? null : false);
    });
    document.addEventListener('keydown', onKey);

    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    } else {
      okBtn.focus();
    }
  });
}

// --- Глобальные замены ---
window.alert = function (msg) {
  toast(String(msg));
};

window.confirm = function (msg) {
  return dialog({ title: 'Подтверждение', message: msg, okText: 'ОК', cancelText: 'Отмена' });
};

window.prompt = function (msg, def) {
  return dialog({ title: '', message: msg, input: true, inputValue: def, okText: 'ОК', cancelText: 'Отмена' });
};
