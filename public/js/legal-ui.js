(() => {
  const CURRENT_TERMS_VERSION = '1.0';
  const links = [
    ['/terminos.html', 'Términos de Uso'],
    ['/privacidad.html', 'Política de Privacidad'],
    ['/aviso-legal.html', 'Aviso Legal'],
    ['/cookies.html', 'Política de Cookies'],
  ];

  if (!document.querySelector('link[data-able-legal-styles]')) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/css/legal.css?v=1';
    stylesheet.dataset.ableLegalStyles = 'true';
    document.head.appendChild(stylesheet);
  }

  if (!document.querySelector('.legal-footer')) {
    const footer = document.createElement('footer');
    footer.className = 'legal-footer';
    footer.innerHTML = `<nav aria-label="Información legal">${links
      .map(([href, label]) => `<a href="${href}">${label}</a>`)
      .join('')}</nav>`;
    document.body.appendChild(footer);
  }

  document.querySelectorAll('[data-legal-email]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      const mailbox = ['info', 'able73', 'com'];
      const email = `${mailbox[0]}${String.fromCharCode(64)}${mailbox[1]}.${mailbox[2]}`;
      const link = document.createElement('a');
      link.className = 'legal-inline-link';
      link.href = `mailto:${email}`;
      link.textContent = email;
      trigger.replaceWith(link);
    }, { once: true });
  });

  const cookieChoiceKey = 'able73_cookie_choice';
  if (!localStorage.getItem(cookieChoiceKey)) {
    const banner = document.createElement('section');
    banner.className = 'cookie-banner';
    banner.setAttribute('aria-label', 'Preferencias de cookies');
    banner.innerHTML = `
      <p>Usamos cookies técnicas necesarias para el funcionamiento de Able73. Puedes aceptar o rechazar las cookies opcionales. <a class="legal-inline-link" href="/cookies.html">Política de Cookies</a>.</p>
      <div class="cookie-actions">
        <button class="cookie-button" type="button" data-cookie-choice="rejected">Rechazar</button>
        <button class="cookie-button cookie-button--accept" type="button" data-cookie-choice="accepted">Aceptar</button>
      </div>`;
    banner.addEventListener('click', (event) => {
      const button = event.target.closest('[data-cookie-choice]');
      if (!button) return;
      localStorage.setItem(cookieChoiceKey, button.dataset.cookieChoice);
      banner.remove();
    });
    document.body.appendChild(banner);
  }

  function showTermsGate(onAccept, onLogout) {
    if (document.querySelector('.terms-gate')) return;
    const gate = document.createElement('section');
    gate.className = 'terms-gate';
    gate.innerHTML = `
      <div class="terms-gate__card" role="dialog" aria-modal="true" aria-labelledby="terms-gate-title">
        <h2 id="terms-gate-title">Términos de Uso</h2>
        <p>Antes de continuar, acepta la versión ${CURRENT_TERMS_VERSION} de los <a class="legal-inline-link" href="/terminos.html" target="_blank" rel="noopener">Términos de Uso</a>. Consulta también la <a class="legal-inline-link" href="/privacidad.html" target="_blank" rel="noopener">Política de Privacidad</a>.</p>
        <p class="terms-gate__error" role="alert"></p>
        <div class="terms-gate__actions">
          <button class="cookie-button cookie-button--accept" type="button" data-terms-accept>Aceptar y continuar</button>
          <button class="cookie-button" type="button" data-terms-logout>Cerrar sesión</button>
        </div>
      </div>`;
    gate.querySelector('[data-terms-accept]').addEventListener('click', async () => {
      try {
        await onAccept();
        gate.remove();
      } catch (error) {
        gate.querySelector('.terms-gate__error').textContent = error.message || 'No se ha podido guardar la aceptación.';
      }
    });
    gate.querySelector('[data-terms-logout]').addEventListener('click', onLogout);
    document.body.appendChild(gate);
  }

  async function backend(path, options = {}) {
    const response = await fetch(path, options);
    let data = {};
    try { data = await response.json(); } catch (_error) {}
    if (!response.ok) throw new Error(data.error || 'No se ha podido completar la operación.');
    return data;
  }

  async function csrfToken() {
    return (await backend('/api/auth/csrf')).csrfToken;
  }

  async function logout() {
    try {
      const csrf = await csrfToken();
      await fetch('/api/auth/session-logout', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
      });
    } finally {
      location.replace('/login.html');
    }
  }

  if (document.body.dataset.requireTermsCheck === 'true') {
    backend('/api/auth/terms/status')
      .then((status) => {
        if (status.accepted) return;
        showTermsGate(async () => {
          const csrf = await csrfToken();
          await backend('/api/auth/terms/accept', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': csrf,
            },
            body: JSON.stringify({
              termsAccepted: true,
              termsVersion: CURRENT_TERMS_VERSION,
            }),
          });
        }, logout);
      })
      .catch(() => {});
  }

  window.AbleLegal = { CURRENT_TERMS_VERSION, showTermsGate };
})();
