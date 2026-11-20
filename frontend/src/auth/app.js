/* Optional host integration:
   Set window.lexivaultAuth before this script, with async methods:
     signIn({email, password, code, remember, signal})
     signUp({email, password, code, signal})
     requestEmailCode({email, purpose, password, signal})
     requestPasswordReset({email, signal})
     confirmPasswordReset({email, code, password, signal})
   signIn/signUp may return { redirectTo: '/workspace' }.
   No password or authentication token is persisted by this page. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const V = window.LexiVaultValidation;
  const root = document.documentElement;
  const content = $('.auth-content');
  const form = $('#auth-form');
  let mode = 'login';
  let language = 'zh';
  let busy = false;
  let needsEmailVerification = false;
  let activeRequest = null;
  let toastTimer;

  const messages = {
    zh: {
      appearance:'外观', lightMode:'日间模式', darkMode:'夜间模式',
      heroLine1:'让知识彼此连接，', heroLine2:'让研究有据可循。', heroDescription:'收集文献，记录思考，与自己的知识对话。',
      artDescription:'以折页构成的 LexiVault L 与 V 品牌雕塑', principles:'产品理念', localFirst:'本地优先', sourceGrounded:'原文溯源', researchAssistant:'研究助手',
      welcome:'欢迎回到 LexiVault', welcomeDescription:'继续你的研究，让思考接着发生。', registerWelcome:'开启你的 LexiVault', registerDescription:'为文献、思考与发现，留一处安静的空间。',
      accountAccess:'账号访问', login:'登录', register:'注册', email:'邮箱', password:'密码', confirmPassword:'确认密码', passwordHint:'至少 8 个字符，包含字母与数字。',
      remember:'记住我', forgotPassword:'忘记密码？', showPassword:'显示密码', hidePassword:'隐藏密码', or:'或', useLocalVault:'使用本地仓库继续',
      localNote1:'文件与笔记保存在本地。', localNote2:'是否使用在线模型，由你决定。', consent:'继续即表示你同意', terms:'服务条款', privacy:'隐私政策', and:'与', footer:'科研，从一份可靠的证据开始。',
      close:'关闭', resetTitle:'找回密码', resetDescription:'输入注册邮箱获取验证码，再设置新密码。', resetPassword:'重置密码', newPassword:'新密码', understood:'我知道了', done:'完成', enterWorkspace:'进入工作空间',
      verificationCode:'邮箱验证码', sendCode:'发送验证码', codeFormat:'请输入 4 位数字验证码。', invalidCode:'验证码错误，请重新输入。', expiredCode:'验证码已过期，请重新获取。', codeCooldown:'请在上次发送 60 秒后重试。', codeSent:'验证码已发送，10 分钟内有效。', emailVerificationRequired:'请先获取验证码并验证邮箱。', emailAlreadyVerified:'邮箱已验证，请重新登录。', mailUnavailable:'邮件服务尚未配置。', mailDeliveryFailed:'验证码邮件发送失败，请稍后重试。', resetDone:'密码已重置，请使用新密码登录。',
      emailRequired:'请输入邮箱地址。', emailInvalid:'请输入完整有效的邮箱地址。', passwordRequired:'请输入密码。', passwordInvalid:'密码需为 8–128 个字符，并包含字母与数字。', passwordMismatch:'两次输入的密码不一致。',
      serviceUnavailable:'暂时无法连接账号服务，请启动本地服务后重试。', connectionFailed:'连接未完成，请稍后重试。', requestTimeout:'连接超时，请稍后重试。', invalidCredentials:'邮箱或密码不正确，请重新输入。', emailExists:'该邮箱已注册，请切换到登录。', rateLimited:'操作过于频繁，请稍后重试。',
      signingIn:'正在登录…', signingUp:'正在创建账号…', signedIn:'登录成功，正在进入工作空间…', registered:'账号创建成功，请登录以继续。', sending:'正在发送…', resetSent:'如果该邮箱符合条件，你将收到验证码。',
      vaultSelected:'已选择本地仓库', vaultNote:'你的文件保留在设备上，不会被此页面上传。', folderUnavailable:'无法打开此文件夹，请重试或选择其他仓库。', emptyFolder:'未检测到文件，请选择已有的本地仓库。',
      termsTitle1:'你的研究空间', termsBody1:'登录后，你可以打开本机目录作为工作空间。每个账号分别记录打开过的空间，论文和笔记保存在所选目录中。',
      termsTitle2:'内容与控制权', termsBody2:'你保留自己导入的资料与撰写笔记的控制权。使用在线服务时，以该服务提供方的实际条款为准。',
      privacyTitle1:'文件保留在本地', privacyBody1:'论文和笔记保存在本地工作空间。注册与登录会将账号信息提交给本地账号服务，密码仅以加盐哈希保存。',
      privacyTitle2:'账号与设备偏好', privacyBody2:'浏览器保存外观、语言和你选择记住的邮箱，账号服务保存用户偏好与登录会话。密码不会写入浏览器存储；在线模型由你主动选择。'
    },
    en: {
      appearance:'Appearance', lightMode:'Light mode', darkMode:'Dark mode',
      heroLine1:'Connect your knowledge.', heroLine2:'Ground your research.', heroDescription:'Collect papers, capture thoughts, and converse with your knowledge.',
      artDescription:'LexiVault L and V sculpture made from folded archival pages', principles:'Our principles', localFirst:'Local first', sourceGrounded:'Source grounded', researchAssistant:'Research assistant',
      welcome:'Welcome back to LexiVault', welcomeDescription:'Pick up your research. Keep your ideas moving.', registerWelcome:'Begin your LexiVault', registerDescription:'A quiet home for your papers, thoughts, and discoveries.',
      accountAccess:'Account access', login:'Sign in', register:'Register', email:'Email', password:'Password', confirmPassword:'Confirm password', passwordHint:'8–128 characters, including letters and numbers.',
      remember:'Remember me', forgotPassword:'Forgot password?', showPassword:'Show password', hidePassword:'Hide password', or:'or', useLocalVault:'Continue with a local vault',
      localNote1:'Your papers and notes stay on your device.', localNote2:'Online models are always your choice.', consent:'By continuing, you agree to our', terms:'Terms', privacy:'Privacy Policy', and:'and', footer:'Research begins with a reliable piece of evidence.',
      close:'Close', resetTitle:'Reset your password', resetDescription:'Request a code for your account email, then set a new password.', resetPassword:'Reset password', newPassword:'New password', understood:'Understood', done:'Done', enterWorkspace:'Enter workspace',
      verificationCode:'Email verification code', sendCode:'Send code', codeFormat:'Enter the four-digit verification code.', invalidCode:'The code is incorrect. Try again.', expiredCode:'The code expired. Request a new one.', codeCooldown:'Wait 60 seconds between requests.', codeSent:'Code sent. It expires in 10 minutes.', emailVerificationRequired:'Request a code to verify your email.', emailAlreadyVerified:'Your email is verified. Sign in again.', mailUnavailable:'Email delivery is not configured.', mailDeliveryFailed:'Unable to send the code. Try again later.', resetDone:'Password reset. Sign in with your new password.',
      emailRequired:'Enter your email address.', emailInvalid:'Enter a complete, valid email address.', passwordRequired:'Enter your password.', passwordInvalid:'Use 8–128 characters, including letters and numbers.', passwordMismatch:'The passwords do not match.',
      serviceUnavailable:'The account service is unavailable. Start the local service and try again.', connectionFailed:'Unable to connect. Please try again.', requestTimeout:'The request timed out. Please try again.', invalidCredentials:'The email or password is incorrect.', emailExists:'This email is already registered. Please sign in.', rateLimited:'Too many attempts. Please try again later.',
      signingIn:'Signing in…', signingUp:'Creating your account…', signedIn:'Signed in. Opening your workspace…', registered:'Your account is ready. Sign in to continue.', sending:'Sending…', resetSent:'If this email is eligible, you will receive a verification code.',
      vaultSelected:'Local vault selected', vaultNote:'Your files stay on your device. This page does not upload them.', folderUnavailable:'Unable to open the folder. Please try a different vault.', emptyFolder:'No files found. Please choose an existing local vault.',
      termsTitle1:'Your research space', termsBody1:'Sign in to open a local folder as a workspace. Each account keeps its own workspace history. Papers and notes are saved in the selected folder.',
      termsTitle2:'Your content, your control', termsBody2:'You retain control of the documents you import and the notes you write. Any online services you choose are subject to their providers’ own terms.',
      privacyTitle1:'Your files stay local', privacyBody1:'Papers and notes stay in the local workspace. Registration and sign-in submit account details to the local account service, which stores salted password hashes.',
      privacyTitle2:'Account and device preferences', privacyBody2:'The browser remembers appearance, language and an optional email address. The account service stores preferences and sessions. Passwords are never stored in browser storage. Online models remain your choice.'
    }
  };
  const t = key => messages[language][key] || key;
  const storage = {
    get(key) { try { return localStorage.getItem(`lexivault.${key}`); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(`lexivault.${key}`, value); } catch (_) {} },
    remove(key) { try { localStorage.removeItem(`lexivault.${key}`); } catch (_) {} }
  };

  function setTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    root.dataset.theme = next;
    $('#theme-light').setAttribute('aria-pressed', String(next === 'light'));
    $('#theme-dark').setAttribute('aria-pressed', String(next === 'dark'));
    $('meta[name="theme-color"]').content = next === 'dark' ? '#24231f' : '#f5f1e9';
    storage.set('theme', next);
  }

  function translate() {
    root.lang = language === 'zh' ? 'zh-CN' : 'en';
    $$('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    $$('[data-i18n-aria]').forEach(node => { node.setAttribute('aria-label', t(node.dataset.i18nAria)); });
    $('#language-label').textContent = language === 'zh' ? '简体中文' : 'English';
    $$('[data-language]').forEach(node => node.setAttribute('aria-checked', String(node.dataset.language === language)));
    document.title = language === 'zh' ? 'LexiVault · 登录与注册' : 'LexiVault · Sign in & Register';
    refreshModeLabels();
    $$('[data-error-key]').forEach(node => { node.textContent = t(node.dataset.errorKey); });
    $$('[data-status-key]').forEach(node => { node.textContent = t(node.dataset.statusKey); });
  }

  function refreshModeLabels() {
    $('#auth-heading').textContent = t(mode === 'login' ? 'welcome' : 'registerWelcome');
    $('#auth-subheading').textContent = t(mode === 'login' ? 'welcomeDescription' : 'registerDescription');
    $('#submit-label').textContent = t(busy ? mode === 'login' ? 'signingIn' : 'signingUp' : mode);
    $$('.password-visibility').forEach(button => {
      const visible = $(`#${button.dataset.target}`).type === 'text';
      button.dataset.i18nAria = visible ? 'hidePassword' : 'showPassword';
      button.setAttribute('aria-label', t(button.dataset.i18nAria));
    });
  }

  function setFieldError(input, error, key) {
    input.setAttribute('aria-invalid', String(Boolean(key)));
    error.hidden = !key;
    if (key) { error.dataset.errorKey = key; error.textContent = t(key); }
    else { delete error.dataset.errorKey; error.textContent = ''; }
  }
  function clearErrors() {
    setFieldError($('#email'), $('#email-error'), null);
    setFieldError($('#password'), $('#password-error'), null);
    setFieldError($('#confirm-password'), $('#confirm-error'), null);
    setFieldError($('#email-code'), $('#email-code-error'), null);
  }
  function showEmailCode() {
    $('#email-code-field').hidden = mode !== 'register' && !needsEmailVerification;
  }
  function status(node, key, kind = 'error') {
    node.hidden = !key;
    node.dataset.kind = kind;
    if (key) { node.dataset.statusKey = key; node.textContent = t(key); }
    else { node.textContent = ''; delete node.dataset.statusKey; }
  }
  function switchMode(next, focus = false) {
    if (busy || !['login', 'register'].includes(next)) return;
    mode = next;
    needsEmailVerification = false;
    $('#email-code').value = '';
    showEmailCode();
    content.dataset.mode = mode;
    $$('[data-mode]').forEach(tab => {
      const selected = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (focus && selected) tab.focus();
    });
    $('#account-panel').setAttribute('aria-labelledby', `tab-${mode}`);
    $('#confirm-field').hidden = mode !== 'register';
    $('#confirm-password').required = mode === 'register';
    $('#confirm-password').disabled = mode !== 'register';
    $('#login-options').hidden = mode !== 'login';
    $('#password-hint').hidden = mode !== 'register';
    $('#password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    // A password is never silently carried from one authentication flow to another.
    ['password', 'confirm-password'].forEach(id => { $(`#${id}`).value = ''; });
    $$('.password-visibility').forEach(button => {
      $(`#${button.dataset.target}`).type = 'password';
      button.setAttribute('aria-pressed', 'false');
      button.querySelector('use').setAttribute('href', '#i-eye');
    });
    clearErrors(); status($('#form-status'), null); refreshModeLabels();
  }

  async function callService(method, payload) {
    const adapter = window.lexivaultAuth;
    if (!adapter || typeof adapter[method] !== 'function') {
      const error = new Error('serviceUnavailable'); error.code = 'serviceUnavailable'; throw error;
    }
    const controller = new AbortController();
    activeRequest = controller;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => adapter[method]({...payload, signal: controller.signal})),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); const error = new Error('requestTimeout'); error.code = 'requestTimeout'; reject(error); }, 20000); })
      ]);
    } finally { clearTimeout(timer); if (activeRequest === controller) activeRequest = null; }
  }
  function serviceError(error) {
    return Object.hasOwn(messages[language], error?.code) ? error.code : 'connectionFailed';
  }
  function setBusy(value) {
    busy = value;
    $('#submit-button').disabled = value;
    $('#submit-button').setAttribute('aria-busy', String(value));
    $('#submit-button .button-spinner').hidden = !value;
    $$('[data-mode]').forEach(tab => { tab.disabled = value; });
    $('#email').readOnly = value; $('#password').readOnly = value; $('#confirm-password').readOnly = value;
    $('#email-code').readOnly = value;
    $('#send-email-code').disabled = value;
    refreshModeLabels();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const email = V.normalizeEmail($('#email').value);
    $('#email').value = email;
    const password = $('#password').value;
    const requiresCode = mode === 'register' || needsEmailVerification;
    const code = requiresCode ? $('#email-code').value : undefined;
    const errors = V.validate({email, password, confirmPassword: $('#confirm-password').value, mode});
    if (requiresCode && !V.validCode(code)) errors.code = 'codeFormat';
    clearErrors(); status($('#form-status'), null);
    setFieldError($('#email'), $('#email-error'), errors.email);
    setFieldError($('#password'), $('#password-error'), errors.password);
    setFieldError($('#confirm-password'), $('#confirm-error'), errors.confirm);
    setFieldError($('#email-code'), $('#email-code-error'), errors.code);
    if (Object.keys(errors).length) { form.querySelector('[aria-invalid="true"]').focus(); return; }
    setBusy(true);
    try {
      const result = await callService(mode === 'login' ? 'signIn' : 'signUp', {email, password, code, remember: mode === 'login' && $('#remember').checked});
      if (mode === 'login' && $('#remember').checked) storage.set('email', email); else storage.remove('email');
      const completedMode = mode;
      $('#password').value = ''; $('#confirm-password').value = ''; $('#email-code').value = '';
      if (completedMode === 'register') {
        setBusy(false); switchMode('login');
        status($('#form-status'), 'registered', 'success');
      } else status($('#form-status'), 'signedIn', 'success');
      document.dispatchEvent(new CustomEvent('lexivault:authenticated', {detail: {mode: completedMode, email}}));
      const redirectTo = result?.redirectTo || (completedMode === 'login' ? './home.html' : null);
      if (redirectTo) {
        const target = new URL(redirectTo, location.href);
        // Host adapters may navigate within their own application, never to an untrusted origin.
        if (target.origin === location.origin && /^https?:$/.test(target.protocol)) location.assign(target.href);
      }
    } catch (error) {
      if (error?.code === 'emailVerificationRequired' && mode === 'login') {
        needsEmailVerification = true;
        showEmailCode();
      }
      status($('#form-status'), serviceError(error));
    }
    finally { setBusy(false); }
  });

  $('#send-email-code').addEventListener('click', async () => {
    if (busy) return;
    const email = V.normalizeEmail($('#email').value);
    const key = !email ? 'emailRequired' : !V.validEmail(email) ? 'emailInvalid' : null;
    setFieldError($('#email'), $('#email-error'), key);
    if (key) { $('#email').focus(); return; }
    const purpose = mode === 'register' ? 'register' : 'verify_email';
    const password = purpose === 'verify_email' ? $('#password').value : undefined;
    if (purpose === 'verify_email' && !password) { $('#password').focus(); return; }
    setBusy(true);
    status($('#form-status'), 'sending', 'success');
    try {
      await callService('requestEmailCode', {email,purpose,password});
      $('#email-code').value = '';
      status($('#form-status'), 'codeSent', 'success');
    } catch (error) { status($('#form-status'), serviceError(error)); }
    finally { setBusy(false); }
  });
  $('#email').addEventListener('input', () => {
    needsEmailVerification = false;
    $('#email-code').value = '';
    setFieldError($('#email-code'), $('#email-code-error'), null);
    showEmailCode();
  });
  [['email','email-error'],['password','password-error'],['confirm-password','confirm-error'],['email-code','email-code-error']].forEach(([inputId,errorId]) => {
    $(`#${inputId}`).addEventListener('input', () => { setFieldError($(`#${inputId}`), $(`#${errorId}`), null); status($('#form-status'), null); });
  });
  $$('.password-visibility').forEach(button => button.addEventListener('click', () => {
    const input = $(`#${button.dataset.target}`);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    refreshModeLabels();
  }));
  $$('[data-mode]').forEach(button => button.addEventListener('click', () => switchMode(button.dataset.mode)));
  $('.auth-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); switchMode(event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' : mode === 'login' ? 'register' : 'login', true);
  });
  $('#remember').addEventListener('change', event => { if (!event.target.checked) storage.remove('email'); });
  $('#theme-light').addEventListener('click', () => setTheme('light'));
  $('#theme-dark').addEventListener('click', () => setTheme('dark'));

  const languageButton = $('#language-button');
  const languageMenu = $('#language-menu');
  function closeLanguage(returnFocus = false) { languageMenu.hidden = true; languageButton.setAttribute('aria-expanded','false'); if (returnFocus) languageButton.focus(); }
  function openLanguage() { languageMenu.hidden = false; languageButton.setAttribute('aria-expanded','true'); languageMenu.querySelector('[aria-checked="true"]').focus(); }
  languageButton.addEventListener('click', () => languageMenu.hidden ? openLanguage() : closeLanguage());
  languageButton.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) {event.preventDefault(); openLanguage();} });
  $$('[data-language]').forEach(button => button.addEventListener('click', () => { language = button.dataset.language; storage.set('language', language); translate(); closeLanguage(true); }));
  languageMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeLanguage(true); }
    if (['ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); const items = $$('[data-language]'); items[(items.indexOf(document.activeElement)+1)%items.length].focus(); }
    if (event.key === 'Tab') closeLanguage();
  });
  document.addEventListener('click', event => { if (!event.target.closest('.language-control')) closeLanguage(); });

  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  }));
  $('#forgot-password').addEventListener('click', () => {
    $('#reset-email').value = $('#email').value;
    setFieldError($('#reset-email'), $('#reset-error'), null); status($('#reset-status'), null);
    $('#reset-dialog').showModal(); $('#reset-email').focus();
  });
  function readResetEmail() {
    const email = V.normalizeEmail($('#reset-email').value);
    const key = !email ? 'emailRequired' : !V.validEmail(email) ? 'emailInvalid' : null;
    setFieldError($('#reset-email'), $('#reset-error'), key); status($('#reset-status'), null);
    if (key) $('#reset-email').focus();
    return key ? null : email;
  }
  function setResetBusy(value) {
    for (const id of ['reset-submit','reset-send-code']) $(`#${id}`).disabled = value;
    for (const input of $$('#reset-form input')) input.readOnly = value;
  }
  function clearResetSecrets() {
    for (const id of ['reset-code','reset-password','reset-confirm-password']) $(`#${id}`).value = '';
  }
  $('#reset-dialog').addEventListener('close', clearResetSecrets);
  $('#reset-send-code').addEventListener('click', async () => {
    if ($('#reset-send-code').disabled) return;
    const email = readResetEmail(); if (!email) return;
    setResetBusy(true);
    status($('#reset-status'), 'sending', 'success');
    try { await callService('requestPasswordReset', {email}); status($('#reset-status'), 'resetSent', 'success'); }
    catch (error) { status($('#reset-status'), serviceError(error)); }
    finally { setResetBusy(false); }
  });
  $('#reset-form').addEventListener('submit', async event => {
    event.preventDefault(); if ($('#reset-submit').disabled) return;
    const email = readResetEmail(); if (!email) return;
    const code = $('#reset-code').value;
    const password = $('#reset-password').value;
    if (!V.validCode(code)) { status($('#reset-status'), 'codeFormat'); $('#reset-code').focus(); return; }
    if (!V.validNewPassword(password)) { status($('#reset-status'), 'passwordInvalid'); $('#reset-password').focus(); return; }
    if (password !== $('#reset-confirm-password').value) { status($('#reset-status'), 'passwordMismatch'); $('#reset-confirm-password').focus(); return; }
    setResetBusy(true);
    try {
      await callService('confirmPasswordReset', {email,code,password});
      clearResetSecrets(); $('#reset-dialog').close(); switchMode('login'); $('#email').value = email;
      status($('#form-status'), 'resetDone', 'success'); $('#password').focus();
    } catch (error) { status($('#reset-status'), serviceError(error)); }
    finally { setResetBusy(false); }
  });

  $$('[data-legal]').forEach(button => button.addEventListener('click', () => {
    const privacy = button.dataset.legal === 'privacy';
    const prefix = privacy ? 'privacy' : 'terms';
    $('#legal-title').textContent = t(prefix);
    const container = $('#legal-content'); container.replaceChildren();
    for (let i=1; i<=2; i++) {
      const heading = document.createElement('h3'); heading.textContent = t(`${prefix}Title${i}`);
      const paragraph = document.createElement('p'); paragraph.textContent = t(`${prefix}Body${i}`);
      container.append(heading,paragraph);
    }
    $('#legal-dialog').showModal();
  }));

  window.addEventListener('pagehide', () => { activeRequest?.abort(); $('#password').value=''; $('#confirm-password').value=''; $('#email-code').value=''; clearResetSecrets(); });
  language = storage.get('language') === 'en' ? 'en' : 'zh';
  const savedEmail = storage.get('email'); if (savedEmail) $('#email').value = savedEmail;
  setTheme(root.dataset.theme); switchMode('login'); translate();
})();
