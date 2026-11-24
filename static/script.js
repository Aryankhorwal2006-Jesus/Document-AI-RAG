'use strict';
/* ---------- Config & state ---------- */
const $ = s => document.querySelector(s);
const PAGE_OFFSET = 1;      // PyPDFLoader pages are 0-based; set to 0 if your backend already returns 1-based pages
const MAX_MB = 200;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const sameOrigin = location.protocol.startsWith('http') && !['5500', '3000'].includes(location.port);
const cfg = { api: store.get('apiUrl', sameOrigin ? location.origin : 'http://127.0.0.1:8000').replace(/\/$/, '') };
let chats = store.get('chats', []);
let docs = store.get('docs', []);
let current = null, busy = false;

const el = {
  scroll: $('#scroll'), messages: $('#messages'), welcome: $('#welcome'), input: $('#input'),
  send: $('#send'), history: $('#history'), docList: $('#docList'), status: $('#status'),
  toasts: $('#toasts'), file: $('#fileInput'), drop: $('#drop'), sidebar: $('#sidebar'), scrim: $('#scrim'),
};

/* ---------- Helpers ---------- */
const icon = n => `<svg class="i"><use href="#i-${n}"/></svg>`;
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = b => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const scrollDown = () => requestAnimationFrame(() => { el.scroll.scrollTop = el.scroll.scrollHeight; });

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg; t.setAttribute('role', 'status');
  el.toasts.append(t);
  setTimeout(() => t.remove(), 5000);
}

function md(src) {
  const blocks = [];
  const t = esc(src).replace(/```\w*\n([\s\S]*?)```/g, (_, c) => { blocks.push(`<pre><code>${c}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>');
  const out = []; let list = null;
  const flush = () => { if (list) { out.push(`<${list.t}>${list.i.join('')}</${list.t}>`); list = null; } };
  for (const line of t.split('\n')) {
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)/))) { flush(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list?.t !== 'ul') { flush(); list = { t: 'ul', i: [] }; } list.i.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list?.t !== 'ol') { flush(); list = { t: 'ol', i: [] }; } list.i.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) flush();
    else if (/^\u0000\d+\u0000$/.test(line.trim())) { flush(); out.push(line.trim()); }
    else { flush(); out.push(`<p>${inline(line)}</p>`); }
  }
  flush();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { const a = document.createElement('textarea'); a.value = text; document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); }
  const s = btn.querySelector('span'), old = s.textContent;
  s.textContent = 'Copied'; setTimeout(() => (s.textContent = old), 1500);
}

/* ---------- API ---------- */
async function api(path, opts = {}, ms = 60000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(cfg.api + path, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}
async function httpError(r) {
  let d = ''; try { d = (await r.json()).detail; } catch {}
  return new Error(`The backend returned an error (${r.status})${d ? ': ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '.'}`);
}
function friendly(e) {
  if (e.name === 'AbortError') return 'The request took too long. Try again in a moment.';
  if (e instanceof TypeError) return `Can't reach the backend at ${cfg.api}. Check that FastAPI is running and that CORS allows this page.`;
  return e.message || 'Something went wrong. Please try again.';
}
async function checkHealth() {
  let ok = false, label = 'Backend offline';
  try { const r = await api('/health', {}, 5000); ok = r.ok; label = ok ? 'Backend online' : `Backend error (${r.status})`; } catch {}
  el.status.className = 'status ' + (ok ? 'online' : 'offline');
  el.status.title = cfg.api; el.status.querySelector('span').textContent = label;
}

/* ---------- Messages ---------- */
function sourcesEl(list) {
  const w = document.createElement('div'); w.className = 'sources';
  w.innerHTML = '<h4>Sources</h4>';
  list.forEach(s => {
    const c = document.createElement('div'); c.className = 'src';
    c.innerHTML = `<button class="src-h" aria-expanded="false">${icon('file')}<span class="src-n"></span><span class="src-p"></span>${icon('chevron')}</button><p class="src-b" hidden></p>`;
    const [h, b] = [c.firstChild, c.lastChild];
    h.querySelector('.src-n').textContent = (s.source || 'Unknown document').split(/[\\/]/).pop();
    h.querySelector('.src-p').textContent = Number.isInteger(s.page) ? `Page ${s.page + PAGE_OFFSET}` : '';
    b.textContent = s.snippet || '';
    h.onclick = () => { const open = h.getAttribute('aria-expanded') === 'true'; h.setAttribute('aria-expanded', !open); b.hidden = open; };
    w.append(c);
  });
  return w;
}

function reveal(node, text, done) {
  let i = 0; const step = Math.max(3, Math.ceil(text.length / 90));
  const t = setInterval(() => {
    i += step; node.innerHTML = md(text.slice(0, i)); scrollDown();
    if (i >= text.length) { clearInterval(t); node.innerHTML = md(text); done(); }
  }, 16);
}

function renderMessage(m, animate = false) {
  const a = document.createElement('article');
  a.className = `msg ${m.role}${m.error ? ' err' : ''}`;
  a.innerHTML = '<div class="bubble"><div class="body"></div></div>';
  const bubble = a.firstChild, body = bubble.firstChild;
  const finish = () => {
    if (m.role !== 'ai' || m.error) return;
    const bar = document.createElement('div'); bar.className = 'actions';
    bar.innerHTML = `<button class="btn ghost sm">${icon('copy')}<span>Copy answer</span></button>`;
    bar.firstChild.onclick = e => copy(m.content, e.currentTarget);
    bubble.append(bar);
    if (m.sources?.length) bubble.append(sourcesEl(m.sources));
    scrollDown();
  };
  if (m.role === 'user' || m.error) { body.textContent = m.content; finish(); }
  else if (animate) reveal(body, m.content, finish);
  else { body.innerHTML = md(m.content); finish(); }
  return a;
}

/* ---------- Chats ---------- */
const saveChats = () => store.set('chats', chats.slice(0, 50));
function startChat() { current = { id: Date.now().toString(36), title: 'New chat', messages: [] }; renderAll(); el.input.focus(); }
function renderAll() {
  el.messages.innerHTML = '';
  current.messages.forEach(m => el.messages.append(renderMessage(m)));
  el.welcome.hidden = current.messages.length > 0;
  renderHistory(); scrollDown();
}
function renderHistory() {
  el.history.innerHTML = '';
  if (!chats.length) el.history.innerHTML = '<li class="empty">Your conversations will appear here.</li>';
  chats.forEach(c => {
    const li = document.createElement('li'); li.className = 'item' + (c === current ? ' on' : '');
    li.innerHTML = `<button class="grow"></button><button class="x" aria-label="Delete chat">${icon('x')}</button>`;
    li.firstChild.textContent = c.title;
    li.firstChild.onclick = () => { current = c; renderAll(); closeSide(); };
    li.lastChild.onclick = () => { chats = chats.filter(x => x !== c); saveChats(); if (c === current) startChat(); else renderHistory(); };
    el.history.append(li);
  });
}
function clearChat() {
  if (!current.messages.length) return toast('This chat is already empty.');
  chats = chats.filter(c => c !== current); saveChats(); startChat();
}

async function send() {
  if (busy) return;
  const q = el.input.value.trim();
  if (!q) return toast('Type a question first.', 'error');
  const chat = current; busy = true; updateSend();
  if (!chats.includes(chat)) { chat.title = q.length > 38 ? q.slice(0, 38) + '…' : q; chats.unshift(chat); }
  const um = { role: 'user', content: q }; chat.messages.push(um);
  el.welcome.hidden = true; el.messages.append(renderMessage(um));
  el.input.value = ''; autosize(); renderHistory();
  const typing = document.createElement('article'); typing.className = 'msg ai';
  typing.innerHTML = '<div class="bubble"><div class="dots" aria-label="AI is thinking"><i></i><i></i><i></i></div></div>';
  el.messages.append(typing); scrollDown();
  let am;
  try {
    const r = await api('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
    if (!r.ok) throw await httpError(r);
    const d = await r.json();
    am = { role: 'ai', content: d.answer || 'The backend returned an empty answer.', sources: d.sources || [] };
  } catch (e) { am = { role: 'ai', error: true, content: friendly(e) }; checkHealth(); }
  typing.remove();
  if (!am.error) chat.messages.push(am);
  saveChats();
  if (current === chat) el.messages.append(renderMessage(am, !am.error));
  busy = false; updateSend();
}

/* ---------- Documents ---------- */
const persistDocs = () => store.set('docs', docs.filter(d => d.status === 'ready' || (d.status === 'processing' && d.jobId)));
function renderDocs() {
  el.docList.innerHTML = '';
  if (!docs.length) el.docList.innerHTML = '<li class="empty">No documents yet.</li>';
  docs.forEach(d => {
    const label = { uploading: 'Uploading', processing: 'Processing', ready: 'Ready', error: 'Failed' }[d.status] + (d.status === 'processing' && d.pct != null ? ' ' + d.pct + '%' : '');
    const pending = d.status === 'uploading' || d.status === 'processing';
    const li = document.createElement('li'); li.className = 'doc';
    li.innerHTML = `${icon('file')}<div class="grow"><b></b><small>${fmtSize(d.size)}</small><span class="chip ${d.status}">${label}</span>${d.error ? '<small class="bad"></small>' : ''}${pending ? `<div class="bar ${d.status === 'processing' && d.pct == null ? 'indet' : ''}" style="--p:${d.status === 'processing' ? (d.pct || 0) / 100 : d.progress}"><i></i></div>` : ''}</div><button class="x" aria-label="Remove document">${icon('x')}</button>`;
    li.querySelector('b').textContent = d.name; li.querySelector('b').title = d.name;
    if (d.error) li.querySelector('.bad').textContent = d.error;
    li.querySelector('.x').onclick = () => { docs = docs.filter(x => x !== d); persistDocs(); renderDocs(); toast('Removed from this list. The backend index is unchanged.'); };
    el.docList.append(li);
  });
}
async function validate(f) {
  if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return 'Only PDF files are supported.';
  if (!f.size) return 'The file is empty.';
  if (f.size > MAX_MB * 1048576) return `The file is larger than ${MAX_MB} MB.`;
  if ((await f.slice(0, 5).text()) !== '%PDF-') return 'This is not a valid PDF.';
}
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('POST', cfg.api + '/upload');
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x.responseText) : reject({ status: x.status }));
    x.onerror = () => reject({ network: true });
    x.ontimeout = () => reject({ timeout: true }); x.timeout = 900000;
    const fd = new FormData(); fd.append('file', file); x.send(fd);
  });
}
async function waitForJob(id, d) {
  let fails = 0;
  for (;;) {
    await new Promise(r => setTimeout(r, 1000));
    let r;
    try { r = await api(`/upload/${id}`, {}, 10000); fails = 0; }
    catch { if (++fails >= 5) throw { jobError: `Lost connection to ${cfg.api}.` }; continue; }
    if (r.status === 404) throw { jobError: 'The server restarted while processing. Please upload again.' };
    if (!r.ok) throw { status: r.status };
    const s = await r.json();
    d.status = 'processing'; d.pct = s.total ? Math.round((s.done / s.total) * 100) : null;
    renderDocs();
    if (s.status === 'ready') return;
    if (s.status === 'error') throw { jobError: s.error || 'Processing failed.' };
  }
}
async function resumeJob(d) {   // after a page reload, keep following the backend job
  try { await waitForJob(d.jobId, d); d.status = 'ready'; toast(`${d.name} is ready.`, 'ok'); }
  catch (e) { d.status = 'error'; d.error = e.jobError || 'Processing failed.'; toast(`${d.name}: ${d.error}`, 'error'); }
  persistDocs(); renderDocs();
}
async function handleFiles(files) {
  for (const f of files) {
    const bad = await validate(f);
    if (bad) { toast(`${f.name}: ${bad}`, 'error'); continue; }
    const d = { name: f.name, size: f.size, status: 'uploading', progress: 0 };
    docs.unshift(d); renderDocs();
    try {
      const res = await uploadFile(f, p => { d.progress = p; if (p >= 1) d.status = 'processing'; renderDocs(); });
      let job = null; try { job = JSON.parse(res); } catch {}
      if (job && job.job_id) { d.jobId = job.job_id; persistDocs(); await waitForJob(job.job_id, d); }   // backend indexes in the background
      d.status = 'ready'; toast(`${f.name} is ready.`, 'ok');   // only after a 2xx from the backend
    } catch (e) {
      d.status = 'error';
      d.error = e.jobError || (e.network ? `Can't reach ${cfg.api}.` : e.timeout ? 'Upload timed out.'
        : e.status === 413 ? `The file is larger than ${MAX_MB} MB.` : (e.status === 404 || e.status === 405) ? 'The backend has no /upload endpoint yet.' : `Upload failed (${e.status}).`);
      toast(`${f.name}: ${d.error}`, 'error');
    }
    persistDocs(); renderDocs();
  }
  el.file.value = '';
}

/* ---------- UI wiring ---------- */
function autosize() { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px'; }
function updateSend() { el.send.disabled = busy || !el.input.value.trim(); el.send.classList.toggle('loading', busy); }
function setTheme(t) {
  document.documentElement.dataset.theme = t; store.set('theme', t);
  $('#themeBtn').innerHTML = `${icon(t === 'dark' ? 'sun' : 'moon')}<span>${t === 'dark' ? 'Light mode' : 'Dark mode'}</span>`;
}
const closeSide = () => { el.sidebar.classList.remove('open'); el.scrim.classList.remove('show'); };

el.input.addEventListener('input', () => { autosize(); updateSend(); });
el.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
el.send.onclick = send;
$('#newChat').onclick = () => { startChat(); closeSide(); };
$('#clearChat').onclick = clearChat;
$('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
$('#menuBtn').onclick = () => { el.sidebar.classList.add('open'); el.scrim.classList.add('show'); };
el.scrim.onclick = closeSide;
['#browse', '#addPdf'].forEach(s => ($(s).onclick = e => { e.stopPropagation(); el.file.click(); }));
el.drop.onclick = () => el.file.click();
el.drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); } };
el.file.onchange = () => handleFiles([...el.file.files]);
['dragenter', 'dragover'].forEach(n => el.drop.addEventListener(n, e => { e.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(n => el.drop.addEventListener(n, e => { e.preventDefault(); el.drop.classList.remove('over'); }));
el.drop.addEventListener('drop', e => handleFiles([...e.dataTransfer.files]));
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

const dlg = $('#settings');
$('#settingsBtn').onclick = () => { $('#apiUrl').value = cfg.api; dlg.showModal(); closeSide(); };
$('#cancelSettings').onclick = () => dlg.close();
$('#saveSettings').onclick = () => {
  const v = $('#apiUrl').value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(v)) return toast('Enter a URL that starts with http:// or https://', 'error');
  cfg.api = v; store.set('apiUrl', v); dlg.close(); checkHealth(); toast('Backend URL saved.', 'ok');
};

/* ---------- Init ---------- */
setTheme(store.get('theme', 'dark'));
docs = docs.filter(d => d.status === 'ready' || (d.status === 'processing' && d.jobId));
renderDocs(); startChat(); updateSend(); checkHealth();
docs.filter(d => d.status === 'processing').forEach(resumeJob);
setInterval(checkHealth, 20000);
