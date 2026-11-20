(function (root) {
  'use strict';
  const normalizeEmail = value => String(value || '').trim();
  const validEmail = value => {
    const email = normalizeEmail(value);
    if (email.length > 254 || /\s/.test(email)) return false;
    const parts = email.split('@');
    if (parts.length !== 2 || !parts[0] || parts[0].length > 64) return false;
    if (parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) return false;
    if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0])) return false;
    const labels = parts[1].split('.');
    return labels.length >= 2 && labels.every(label => label.length > 0 && label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)) && /^[a-zA-Z]{2,63}$/.test(labels.at(-1));
  };
  const validNewPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 128 && /\p{L}/u.test(value) && /\p{N}/u.test(value);
  const validate = ({email = '', password = '', confirmPassword = '', mode = 'login'}) => {
    const errors = {};
    if (!normalizeEmail(email)) errors.email = 'emailRequired';
    else if (!validEmail(email)) errors.email = 'emailInvalid';
    if (!password) errors.password = 'passwordRequired';
    else if (password.length > 128) errors.password = 'passwordInvalid';
    else if (mode === 'register' && !validNewPassword(password)) errors.password = 'passwordInvalid';
    if (mode === 'register' && password !== confirmPassword) errors.confirm = 'passwordMismatch';
    return errors;
  };
  const validCode = value => typeof value === 'string' && value.length === 4 && /^[0-9]{4}$/.test(value);
  const api = Object.freeze({normalizeEmail, validEmail, validNewPassword, validCode, validate});
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LexiVaultValidation = api;
})(globalThis);
