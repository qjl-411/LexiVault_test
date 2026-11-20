/* Same-origin account session and account-bound business requests. */
(() => {
  'use strict';
  if (window.lexivaultAuth) return;
  const transport = window.fetch.bind(window);
  const loginPage = document.body.classList.contains('auth-page') || /\/index\.html$/.test(location.pathname);
  let bootstrap, csrf = '', identity = null, settingsTimer, ready, locked = false;
  function endSession() {
    if (locked || loginPage) return;
    locked = true;
    window.dispatchEvent(new CustomEvent('lexivault:account-ended'));
    document.body.hidden = true;
    window.location.replace('/index.html');
  }
  async function localSession() {
    if (!bootstrap) bootstrap = transport('/api/session', { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('本地账号服务不可用。');
      return response.json();
    }).catch(error => { bootstrap = null; throw error; });
    return bootstrap;
  }
  async function request(path, { method = 'GET', body, signal } = {}, retry = true) {
    const session = await localSession();
    const headers = { 'X-LexiVault-Token': session.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-Account-CSRF'] = csrf;
    const response = await transport('/api/auth' + path, { method, headers, credentials: 'same-origin', signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && !data.code && retry) { bootstrap = null; return request(path, { method, body, signal }, false); }
      const error = new Error(data.message || '账号服务暂不可用。');
      error.code = data.code || (response.status === 429 ? 'rateLimited' : 'connectionFailed');
      throw error;
    }
    if (data.csrf_token) csrf = data.csrf_token;
    return data;
  }
  function changed() {
    try { localStorage.setItem('lexivault.account.changed', String(Date.now()) + ':' + Math.random()); } catch {}
  }
  const adapter = {
    async signIn({ email, password, remember, code, signal }) {
      await ready;
      const state = await request('/login', { method: 'POST', body: { email, password, remember: !!remember, code }, signal });
      identity = state.user; changed(); return { redirectTo: './home.html' };
    },
    async signUp({ email, password, code, signal }) {
      return request('/register', { method: 'POST', body: { email, password, code }, signal });
    },
    async requestEmailCode({ email, purpose, password, signal }) {
      return request('/email-code', { method: 'POST', body: { email, purpose, password }, signal });
    },
    async requestPasswordReset({ email, signal }) {
      return request('/password-reset', { method: 'POST', body: { email }, signal });
    },
    async confirmPasswordReset({ email, code, password, signal }) {
      const result = await request('/password-reset/confirm', { method: 'POST', body: { email, code, password }, signal });
      if (identity?.email?.toLowerCase() === email.toLowerCase()) { identity = null; csrf = ''; changed(); }
      return result;
    },
    async signOut() {
      await ready;
      if (window.LexiVaultSpace?.canLeave && !await window.LexiVaultSpace.canLeave()) return false;
      await request('/logout', { method: 'POST', body: {} });
      csrf = ''; identity = null; changed(); endSession(); await refresh(); return true;
    },
    async getCurrentUser() { return request('/me'); },
    get userId() { return identity?.id || null; },
    get locked() { return locked; }
  };
  window.lexivaultAuth = adapter;

  // Includes PDF and attachment downloads. A stale tab cannot write as a newly signed-in user.
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.pathname === '/api/session' || url.pathname.startsWith('/api/auth/')) return transport(input, options);
    await ready;
    if (locked || !identity) { endSession(); throw new Error('请先登录账号。'); }
    const headers = new Headers(options.headers || (typeof input === 'object' ? input.headers : undefined));
    if (headers.has('X-LexiVault-User') && headers.get('X-LexiVault-User') !== identity.id) {
      endSession(); throw new Error('账号已切换，请重新打开页面。');
    }
    headers.set('X-LexiVault-User', identity.id);
    const response = await transport(input, {...options, headers});
    if (response.status === 401) {
      const data = await response.clone().json().catch(() => ({}));
      if (['loginRequired','accountChanged'].includes(data.code)) endSession();
    }
    return response;
  };

  async function refresh() {
    try {
      const state = await request('/me');
      if (!loginPage && (!state.user || (identity && state.user.id !== identity.id))) { endSession(); return; }
      identity = state.user;
      const button = document.getElementById('account-button'), menu = document.getElementById('account-menu');
      if (state.user && state.settings) {
        const theme = state.settings.theme === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset.theme = theme;
        try { localStorage.setItem('lexivault.theme', theme); } catch {}
        window.LexiVaultSidebar?.setTheme(theme);
        const font = Number(state.settings.font_size);
        if (Number.isInteger(font) && font >= 12 && font <= 26) document.documentElement.style.setProperty('--reader-note-font-size', `${font}px`);
      }
      if (!button || !menu) return;
      const name = state.user?.nickname || '请登录';
      button.setAttribute('aria-label', state.user ? `账号：${state.user.email}` : '请登录'); button.title = state.user?.email || '请登录';
      const avatar = button.querySelector('.lv-avatar'); if (avatar) avatar.textContent = state.user ? name.slice(0, 2).toUpperCase() : 'LV';
      const copy = button.querySelector('.lv-account-copy');
      if (copy) { const small = document.createElement('small'); small.textContent = '资料保存在本机'; copy.replaceChildren(document.createTextNode(name), small); }
      menu.replaceChildren();
      const label = document.createElement('p'); label.textContent = state.user?.email || '未登录'; menu.append(label);
      if (state.user) {
        const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = '退出账号';
        logout.addEventListener('click', async () => {
          logout.disabled = true;
          try { if (!await adapter.signOut()) logout.disabled = false; }
          catch (error) { label.textContent = error.message; logout.disabled = false; }
        }); menu.append(logout);
      }
    } catch { if (!loginPage) endSession(); }
  }
  document.addEventListener('click', event => {
    if (!identity || locked || !event.target.closest?.('#theme-light,#theme-dark,#theme-compact')) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { if (!locked) void request('/settings', { method: 'PATCH', body: { theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light' } }).catch(() => {}); }, 250);
  });
  window.addEventListener('storage', event => { if (event.key === 'lexivault.account.changed') { if (loginPage) void refresh(); else endSession(); } });
  window.addEventListener('pageshow', event => { if (event.persisted) { if (locked) window.location.replace('/index.html'); else void refresh(); } });
  window.addEventListener('focus', () => { if (!locked) void refresh(); });
  document.addEventListener('lexivault:authenticated', () => void refresh());
  ready = refresh(); adapter.ready = ready;
  const timer = setInterval(() => { if (!locked && !document.hidden) void refresh(); }, 30000);
  window.addEventListener('pagehide', () => clearInterval(timer));
})();
