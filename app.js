'use strict';
// Capture: send notes to Nizam's "iPhone inbox" webhook routine.
// All config lives in localStorage on the device. Nothing secret is in this file.

const LS = { cfg: 'capture.cfg', outbox: 'capture.outbox', history: 'capture.history' };
const HISTORY_MAX = 50;
const $ = s => document.querySelector(s);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const DEFAULT_CFG = { mode: 'relay', ghRepo: 'pakrashi/capture-relay', ghWorkflow: 'relay.yml', ghRef: 'main', ghToken: '',
  url: '', key: '', headerName: 'Authorization', headerPrefix: 'Bearer ' };
let cfg = { ...DEFAULT_CFG, ...load(LS.cfg, {}) };
let hint = null;
let flushing = false;

// ---------- transport ----------
class SendError extends Error { constructor(msg, { retry = true, cors = false } = {}) { super(msg); this.retry = retry; this.cors = cors; } }

function configured() {
  return cfg.mode === 'relay' ? !!(cfg.ghRepo && cfg.ghWorkflow && cfg.ghToken) : !!(cfg.url && cfg.key);
}

async function deliver(note) {
  const payload = { text: note.text, hint: note.hint, sent_at: note.sent_at, source: 'iphone', id: note.id };
  let res;
  try {
    if (cfg.mode === 'relay') {
      const url = `https://api.github.com/repos/${cfg.ghRepo.trim()}/actions/workflows/${encodeURIComponent(cfg.ghWorkflow.trim())}/dispatches`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.ghToken.trim(), 'Accept': 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: (cfg.ghRef || 'main').trim(), inputs: { payload: JSON.stringify(payload) } }),
      });
    } else {
      const headers = { 'Content-Type': 'application/json' };
      headers[(cfg.headerName || 'Authorization').trim()] = (cfg.headerPrefix ?? '') + cfg.key.trim();
      res = await fetch(cfg.url.trim(), { method: 'POST', headers, body: JSON.stringify(payload) });
    }
  } catch (e) {
    // A TypeError while online is almost always CORS (the browser hides the real reason).
    if (navigator.onLine && cfg.mode === 'direct') throw new SendError('Blocked by the browser (CORS). Switch to the GitHub relay in Settings.', { cors: true });
    throw new SendError('Offline or network error');
  }
  if (res.ok) return true;
  let detail = '';
  try { detail = (await res.text()).slice(0, 160); } catch {}
  const retry = res.status >= 500 || res.status === 429 || res.status === 408;
  const hintTxt = res.status === 401 || res.status === 403 ? 'check the key or token' :
                  res.status === 404 ? 'check the URL, repo or workflow name' :
                  res.status === 422 ? 'check the branch and the workflow input' : '';
  throw new SendError(`HTTP ${res.status}${hintTxt ? ' – ' + hintTxt : ''}${detail ? ' (' + detail + ')' : ''}`, { retry });
}

// ---------- queue ----------
function addHistory(note) {
  const h = load(LS.history, []).filter(n => n.id !== note.id);
  h.unshift(note); store(LS.history, h.slice(0, HISTORY_MAX));
}
function updateHistory(id, patch) {
  const h = load(LS.history, []); const n = h.find(x => x.id === id);
  if (n) { Object.assign(n, patch); store(LS.history, h); }
}

async function flush() {
  if (flushing) return; flushing = true;
  try {
    let outbox = load(LS.outbox, []);
    if (!outbox.length) return;
    if (!configured()) { banner('Not set up yet. Add your details in Settings. Notes are saved and will send later.'); return; }
    for (const note of [...outbox]) {
      try {
        await deliver(note);
        outbox = load(LS.outbox, []).filter(n => n.id !== note.id); store(LS.outbox, outbox);
        updateHistory(note.id, { status: 'sent', error: null, delivered_at: new Date().toISOString() });
        banner(null);
      } catch (e) {
        updateHistory(note.id, { status: 'queued', error: e.message });
        banner((e.cors || !e.retry) ? e.message : null);
        break; // keep order; try again later
      }
    }
  } finally { flushing = false; render(); }
}

// ---------- UI ----------
function banner(msg) { const b = $('#banner'); b.textContent = msg || ''; b.hidden = !msg; }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2200); }

// iOS Safari has no navigator.vibrate; toggling a hidden <input switch> gives a light haptic on iOS 18+.
const hapticEl = (() => { const l = document.createElement('label'); l.style.display = 'none';
  const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); l.appendChild(i); document.body.appendChild(l); return l; })();
function haptic() { try { if (navigator.vibrate) navigator.vibrate(15); else hapticEl.click(); } catch {} }

function fmt(iso) {
  const d = new Date(iso), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
}
function render() {
  const ul = $('#recent'); ul.textContent = '';
  for (const n of load(LS.history, [])) {
    const li = document.createElement('li');
    const t = document.createElement('div'); t.className = 't'; t.textContent = n.text;
    const m = document.createElement('div'); m.className = 'm';
    const st = document.createElement('span'); st.className = 'st-' + n.status;
    st.textContent = n.status === 'sent' ? '✓ Sent' : '⏳ Queued';
    if (n.error && n.status !== 'sent') st.title = n.error;
    m.append(st, Object.assign(document.createElement('span'), { textContent: fmt(n.sent_at) }));
    if (n.hint) m.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: n.hint }));
    li.append(t, m); ul.append(li);
  }
  const q = load(LS.outbox, []).length;
  $('#queueInfo').textContent = q ? `${q} waiting to send` : '';
  const len = $('#note').value.length; $('#count').textContent = len ? len + '' : '';
}

async function send() {
  const text = $('#note').value.trim();
  if (!text) { $('#note').focus(); return; }
  stopMic();
  const note = { id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)),
                 text, hint, sent_at: new Date().toISOString(), status: 'queued' };
  store(LS.outbox, [...load(LS.outbox, []), note]);   // persist first, so nothing is ever lost
  addHistory(note);
  $('#note').value = ''; setHint(null); render();
  haptic();
  const btn = $('#send'); btn.disabled = true;
  await flush();
  btn.disabled = false;
  const sent = load(LS.history, []).find(n => n.id === note.id)?.status === 'sent';
  if (sent) { btn.classList.add('ok'); btn.textContent = '✓ Sent'; haptic(); }
  else { btn.textContent = 'Saved – will retry'; toast('Saved on phone. It will send when it can.'); }
  setTimeout(() => { btn.classList.remove('ok'); btn.textContent = 'Send'; }, 1500);
}

function setHint(h) {
  hint = h;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.hint === h));
}

// ---------- mic (Web Speech API, where Safari supports it) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, baseText = '';
function stopMic() { if (rec) { try { rec.stop(); } catch {} } }
if (SR) {
  $('#mic').hidden = false;
  $('#mic').addEventListener('click', () => {
    if (rec) return stopMic();
    rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = true;
    const ta = $('#note'); baseText = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
    rec.onresult = e => {
      let finalT = '', interim = '';
      for (let i = 0; i < e.results.length; i++) (e.results[i].isFinal ? (finalT += e.results[i][0].transcript) : (interim += e.results[i][0].transcript));
      ta.value = baseText + finalT + interim; render();
    };
    rec.onerror = e => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Mic: ' + e.error + '. Use the keyboard mic instead.'); };
    rec.onend = () => { rec = null; $('#mic').classList.remove('on'); };
    try { rec.start(); $('#mic').classList.add('on'); haptic(); } catch { rec = null; toast('Mic unavailable. Use the keyboard mic.'); }
  });
}

// ---------- settings ----------
const FIELDS = ['mode', 'ghRepo', 'ghWorkflow', 'ghRef', 'ghToken', 'url', 'key', 'headerName', 'headerPrefix'];
function showModeSections() { document.querySelectorAll('[data-mode]').forEach(s => s.hidden = s.dataset.mode !== $('#mode').value); }
function openSettings() {
  FIELDS.forEach(f => $('#' + f).value = cfg[f] ?? '');
  showModeSections(); $('#settingsMsg').textContent = '';
  $('#home').hidden = true; $('#settings').hidden = false; scrollTo(0, 0);
}
function saveSettings() {
  FIELDS.forEach(f => cfg[f] = $('#' + f).value.replace(/[\r\n]/g, '')); // strip stray newlines from pasted keys
  if (!cfg.headerName.trim()) cfg.headerName = 'Authorization';
  store(LS.cfg, cfg);
  $('#settingsMsg').textContent = 'Saved on this phone.';
}
$('#openSettings').onclick = openSettings;
$('#closeSettings').onclick = () => { $('#settings').hidden = true; $('#home').hidden = false; render(); flush(); };
$('#mode').onchange = showModeSections;
$('#save').onclick = () => { saveSettings(); flush(); };
$('#test').onclick = async () => {
  saveSettings(); const m = $('#settingsMsg'); m.textContent = 'Sending test…';
  try { await deliver({ id: 'test-' + Date.now(), text: 'Test from Capture app – please ignore.', hint: 'Test', sent_at: new Date().toISOString() });
        m.textContent = '✓ Test accepted. Check chat for Nizam\'s reply.'; haptic(); }
  catch (e) { m.textContent = '✗ ' + e.message; }
};
$('#retryNow').onclick = () => { flush(); toast('Retrying…'); };
$('#clearHistory').onclick = () => { if (confirm('Clear the recent list? Queued notes stay queued.')) { store(LS.history, load(LS.history, []).filter(n => n.status !== 'sent')); render(); } };

// ---------- wire up ----------
document.querySelectorAll('.chip').forEach(c => c.onclick = () => { setHint(hint === c.dataset.hint ? null : c.dataset.hint); haptic(); });
$('#send').onclick = send;
$('#note').addEventListener('input', render);
$('#note').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });
setInterval(() => { if (!document.hidden && load(LS.outbox, []).length) flush(); }, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!configured()) banner('Open Settings (top right) to connect. Notes typed now are saved and sent later.');
render(); flush();
