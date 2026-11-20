// shared/errors.js — an error whose message is safe and helpful to show the user as-is.
export class UserError extends Error {
  constructor(message, code = 'user') {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

/** Reject if `promise` doesn't settle within `ms`. */
export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new UserError(message, 'timeout')), ms); })
  ]);
}
