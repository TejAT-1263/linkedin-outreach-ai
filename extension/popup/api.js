// popup/api.js — typed-ish wrapper around runtime messaging to the background.
export { ACTIONS } from '../shared/constants.js';

export class RequestError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * @param {string} action one of ACTIONS
 * @param {object} [payload]
 */
export function call(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new RequestError('The extension restarted — please reopen it.', 'runtime'));
      if (!response) return reject(new RequestError('No response from the extension. Please reopen it.', 'no_response'));
      if (!response.success) return reject(new RequestError(response.error || 'Something went wrong.', response.code));
      resolve(response.data);
    });
  });
}
