// popup/dom.js — tiny DOM helpers. No innerHTML with untrusted data anywhere in the popup.
export const $ = (id) => document.getElementById(id);

/** h('div', {class:'x', onclick}, child, 'text') — safe element builder. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function show(el, on = true) { (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on); }

export function setStatus(id, msg, type = 'info') {
  const el = $(id);
  if (!msg) { el.className = 'status hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className = `status status-${type}`;
}

let toastTimer;
export function toast(msg, type = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

export function setSegmented(groupId, attr, value) {
  document.querySelectorAll(`#${groupId} .seg`).forEach(b => {
    const on = b.dataset[attr] === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
}

/** Arrow-key navigation for segmented radio groups (a11y). */
export function wireSegmentedKeys(groupId) {
  const group = $(groupId);
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const segs = [...group.querySelectorAll('.seg')];
    const i = segs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = segs[(i + (e.key === 'ArrowRight' ? 1 : segs.length - 1)) % segs.length];
    next.focus();
    next.click();
    e.preventDefault();
  });
}

export function relativeTime(t, now = Date.now()) {
  if (!t) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 3600e3) return rtf.format(Math.round(diff / 60e3), 'minute');
  if (abs < 86400e3) return rtf.format(Math.round(diff / 3600e3), 'hour');
  return rtf.format(Math.round(diff / 86400e3), 'day');
}

export async function copyText(text, fallbackEl) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    if (fallbackEl) { fallbackEl.select(); return document.execCommand('copy'); }
    return false;
  }
}

export function download(filename, text, mime = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
