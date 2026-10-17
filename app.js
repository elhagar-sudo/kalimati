/* Kalimati — private English–Arabic dictionary. Plain JS, no build step. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 86400000;
const DEFAULT_TAGS = ['Work', 'Daily life', 'Travel'];
const POS_NAMES = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', prep: 'preposition', conj: 'conjunction', pron: 'pronoun', det: 'determiner', int: 'expression', num: 'number' };

/* ---------------- storage (IndexedDB with memory fallback) ---------------- */
const DB = (() => {
  let db = null, mem = { words: new Map(), meta: new Map() };
  function open() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('kalimati', 1);
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('words', { keyPath: 'id' }); d.createObjectStore('meta'); };
        r.onsuccess = () => { db = r.result; res(true); };
        r.onerror = () => res(false);
      } catch (e) { res(false); }
    });
  }
  function tx(store, mode, fn) {
    if (!db) return Promise.resolve(fn(null));
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const s = t.objectStore(store);
      const out = fn(s); t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); t.onerror = () => rej(t.error);
    });
  }
  return {
    open,
    async all() { if (!db) return [...mem.words.values()]; return tx('words', 'readonly', s => s.getAll()); },
    async put(w) { if (!db) { mem.words.set(w.id, w); return; } return tx('words', 'readwrite', s => { s.put(w); }); },
    async putMany(arr) { if (!db) { arr.forEach(w => mem.words.set(w.id, w)); return; } return tx('words', 'readwrite', s => { arr.forEach(w => s.put(w)); }); },
    async del(id) { if (!db) { mem.words.delete(id); return; } return tx('words', 'readwrite', s => { s.delete(id); }); },
    async getMeta(k) { if (!db) return mem.meta.get(k); return tx('meta', 'readonly', s => s.get(k)); },
    async setMeta(k, v) { if (!db) { mem.meta.set(k, v); return; } return tx('meta', 'readwrite', s => { s.put(v, k); }); },
    get ok() { return !!db; }
  };
})();

/* ---------------- state ---------------- */
const S = {
  core: [], coreMap: new Map(), lex: null, lexLoading: null,
  mine: new Map(), irrBack: new Map(),
  settings: { online: true, accent: 'en-US', slow: 0.6, dir: 'en-ar', mode: 'card', goal: 10, remindAt: '19:00', pronInReview: 'tap', theme: 'system', tags: [...DEFAULT_TAGS], autoplay: true },
  tab: 'search', query: '', mineFilter: { tag: '', sort: 'new', q: '' }, review: null, log: {}
};
const PACKS = { oilgas: { name: 'Oil & gas and process', short: 'Oil & gas', ar: 'النفط والغاز والعمليات' } };

/* ---------------- daily log, streak ---------------- */
const dayKey = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function logAct(kind, n = 1) { const k = dayKey(); const e = S.log[k] || (S.log[k] = { rev: 0, add: 0 }); e[kind] = (e[kind] || 0) + n; DB.setMeta('log', S.log); }
function streak() {
  let n = 0, t = Date.now();
  if (!(S.log[dayKey(t)]?.rev)) t -= DAY; // today not done yet: count up to yesterday
  while (S.log[dayKey(t)]?.rev) { n++; t -= DAY; }
  return n;
}
function addedThisWeek() { let n = 0; for (let i = 0; i < 7; i++) n += S.log[dayKey(Date.now() - i * DAY)]?.add || 0; return n; }

/* ---------------- text helpers ---------------- */
const isAr = s => /[؀-ۿ]/.test(s);
function normAr(s) {
  return String(s || '').replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').trim();
}
const normEn = s => String(s || '').toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z' -]/g, '').replace(/\s+/g, ' ').trim();
const idOf = w => normEn(w);
function lemmas(w) {
  const out = [w];
  if (S.irrBack.has(w)) out.push(S.irrBack.get(w));
  const r = [['ies', 'y'], ['ied', 'y'], ['es', ''], ['s', ''], ['ing', ''], ['ing', 'e'], ['ed', ''], ['ed', 'e'], ['d', ''], ['er', ''], ['est', ''], ['ly', ''], ['ily', 'y']];
  for (const [suf, rep] of r) if (w.endsWith(suf) && w.length > suf.length + 2) {
    const b = w.slice(0, -suf.length) + rep; out.push(b);
    if (/(.)\1$/.test(b)) out.push(b.slice(0, -1)); // stopped -> stopp -> stop
  }
  return [...new Set(out)];
}
function posText(p) { return String(p || '').split(',').map(x => POS_NAMES[x.trim()] || x.trim()).filter(Boolean).join(', '); }

/* ---------------- pronunciation ---------------- */
function arpOf(word) {
  const w = normEn(word); if (!w) return null;
  const c = S.coreMap.get(w); if (c && c.c) return c.c;
  if (S.lex && S.lex[w] && S.lex[w][1]) return S.lex[w][1];
  // phrase: build from parts
  const parts = w.split(' ');
  if (parts.length > 1) {
    const a = parts.map(p => (S.coreMap.get(p) || {}).c || (S.lex && S.lex[p] && S.lex[p][1]) || null);
    if (a.every(Boolean)) return a.join('|');
  }
  return null;
}
function pronHTML(rec, opts = {}) {
  // rec: { w, c?, pr? (manual override {rs, ar, ipa}) }
  const arp = rec.c || arpOf(rec.w);
  const p = arp ? Pron.build(arp) : null;
  const manual = rec.pr || {};
  const sylSpan = (field) => p.words.map(w => w.syl.map((s, i) => {
    const sep = i && !(field === 'ar' && s.join) ? '<span class="sep">-</span>' : '';
    const txt = field === 'rs' && s.stress === 1 ? s.rs.toUpperCase() : s[field];
    return sep + `<span class="syl${s.stress === 1 ? ' st' : ''}">${esc(txt)}</span>`;
  }).join('')).join(' ');
  const rs = manual.rs ? esc(manual.rs) : p ? sylSpan('rs') : '';
  const ar = manual.ar ? esc(manual.ar) : p ? sylSpan('ar') : '';
  const ipa = manual.ipa ? esc(manual.ipa) : p ? esc(Pron.ipaText(p)) : '';
  if (!rs && !ar && !ipa) return opts.compact ? '' : `<div class="pron"><span class="src">No written pronunciation for this word yet. Tap Edit to add one.</span></div>`;
  return `<div class="pron">
    ${rs ? `<div class="line"><span class="lbl">Say it</span><span class="rs">${rs}</span></div>` : ''}
    ${ar ? `<div class="line"><span class="lbl">بالعربي</span><span class="arp">${ar}</span></div>` : ''}
    ${ipa ? `<div class="line ipa-line" ${opts.showIpa ? '' : 'hidden'}><span class="lbl">IPA (US)</span><span class="ipa">${ipa}</span></div>
    ${opts.showIpa ? '' : '<button class="more" data-act="ipa">Show IPA</button>'}` : ''}
  </div>`;
}

/* ---------------- speech ---------------- */
let voices = [];
function loadVoices() { try { voices = speechSynthesis.getVoices(); } catch (e) { voices = []; } }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function pickVoice(lang) {
  const l = lang.toLowerCase();
  return voices.find(v => v.lang.toLowerCase().replace('_', '-') === l && /google|natural|enhanced/i.test(v.name))
    || voices.find(v => v.lang.toLowerCase().replace('_', '-') === l)
    || voices.find(v => v.lang.toLowerCase().startsWith(l.slice(0, 2)));
}
function speak(text, { lang, slow } = {}) {
  if (!('speechSynthesis' in window)) { toast('Speech is not available on this device.'); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || S.settings.accent;
    const v = pickVoice(u.lang); if (v) u.voice = v;
    u.rate = slow ? S.settings.slow : 0.95;
    speechSynthesis.speak(u);
  } catch (e) { toast('Could not play the sound.'); }
}
const ICON_SPEAK = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>';
const ICON_SLOW = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
const ICON_REC = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>';

/* ---------------- voice typing (speech recognition) ---------------- */
const Recog = window.SpeechRecognition || window.webkitSpeechRecognition;
function listen(lang, { alts = 1 } = {}) {
  return new Promise((res, rej) => {
    if (!Recog) return rej(new Error('unsupported'));
    let r; try { r = new Recog(); } catch (e) { return rej(e); }
    r.lang = lang; r.interimResults = false; r.maxAlternatives = alts; r.continuous = false;
    let done = false;
    r.onresult = e => { done = true; res([...e.results[0]].map(a => a.transcript.trim())); };
    r.onerror = e => { if (!done) { done = true; rej(new Error(e.error || 'error')); } };
    r.onend = () => { if (!done) { done = true; res([]); } };
    try { r.start(); } catch (e) { rej(e); }
  });
}
function micError(e) {
  const m = String(e && e.message);
  toast(m === 'unsupported' ? 'Voice typing is not available in this browser. Use Chrome on Android.'
    : /not-allowed|denied|service-not-allowed/.test(m) ? 'Allow the microphone for Kalimati to use voice typing.'
    : m === 'network' ? 'Voice typing needs an internet connection.' : 'Did not catch that. Try again.');
}
async function micInto(btn, input, lang, after) {
  btn.classList.add('live');
  try {
    const t = await listen(lang);
    if (t[0]) { input.value = lang.startsWith('en') ? t[0].toLowerCase() : t[0]; input.dispatchEvent(new Event('input')); after && after(t[0]); }
    else toast('Did not catch that. Try again.');
  } catch (e) { micError(e); }
  btn.classList.remove('live');
}

/* ---------------- record my voice ---------------- */
const Rec = { url: null, word: null, mr: null };
async function recordVoice(seconds = 3) {
  if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return new Promise(res => {
    const chunks = []; const mr = new MediaRecorder(stream); Rec.mr = mr;
    mr.ondataavailable = e => e.data.size && chunks.push(e.data);
    mr.onstop = () => { stream.getTracks().forEach(t => t.stop()); Rec.mr = null; if (Rec.url) URL.revokeObjectURL(Rec.url); Rec.url = URL.createObjectURL(new Blob(chunks, { type: mr.mimeType })); res(Rec.url); };
    mr.start(); setTimeout(() => mr.state === 'recording' && mr.stop(), seconds * 1000);
  });
}
function playUrl(u) { try { new Audio(u).play(); } catch (e) { } }

/* ---------------- spaced repetition ---------------- */
function newSrs() { return { reps: 0, iv: 0, ef: 2.5, due: Date.now(), lapses: 0, last: 0 }; }
function nextSrs(s, g) {
  s = { ...newSrs(), ...s }; const now = Date.now();
  if (g === 'forgot') { s.reps = 0; s.iv = 0; s.ef = Math.max(1.3, s.ef - 0.2); s.lapses++; s.due = now + 10 * 60000; }
  else if (g === 'hard') { s.iv = s.reps === 0 ? 1 : Math.max(1, Math.round(s.iv * 1.2)); s.ef = Math.max(1.3, s.ef - 0.15); s.reps++; s.due = now + s.iv * DAY; }
  else { s.iv = s.reps === 0 ? 2 : s.reps === 1 ? 5 : Math.round(Math.max(s.iv, 1) * s.ef); s.ef = Math.min(3, s.ef + 0.05); s.reps++; s.due = now + s.iv * DAY; }
  s.last = now; return s;
}
function ivLabel(s, g) { const n = nextSrs(s, g); if (g === 'forgot') return '10 min'; return n.iv === 1 ? '1 day' : n.iv < 31 ? n.iv + ' days' : n.iv < 365 ? Math.round(n.iv / 30) + ' mo' : (n.iv / 365).toFixed(1) + ' yr'; }
function status(rec) { const s = rec.srs || {}; if (!s.last) return 'new'; return s.iv >= 21 ? 'known' : 'learning'; }
const STATUS_TXT = { new: 'New', learning: 'Learning', known: 'Known' };
function dueList() { const now = Date.now(); return [...S.mine.values()].filter(r => (r.srs?.due ?? 0) <= now).sort((a, b) => a.srs.due - b.srs.due); }
function updateBadge() { const n = dueList().length; const b = $('#dueBadge'); b.hidden = !n; b.textContent = n > 99 ? '99+' : n; }

/* ---------------- lookup & search ---------------- */
function loadLex() {
  if (S.lex || S.lexLoading) return S.lexLoading;
  S.lexLoading = fetch('data/lex.json').then(r => r.json()).then(j => { S.lex = j; return j; }).catch(() => { S.lex = {}; });
  return S.lexLoading;
}
function lookup(word) {
  const w = normEn(word); if (!w) return null;
  for (const l of lemmas(w)) {
    if (S.mine.has(l)) return { src: 'mine', rec: S.mine.get(l), lemma: l };
    if (S.coreMap.has(l)) return { src: 'core', rec: S.coreMap.get(l), lemma: l };
  }
  if (S.lex) for (const l of lemmas(w)) if (S.lex[l] && S.lex[l][0]) return { src: 'lex', rec: { w: l, a: S.lex[l][0], c: S.lex[l][1] }, lemma: l };
  return null;
}
function searchEn(q) {
  const res = [], seen = new Set();
  const add = (rec, src) => { if (!seen.has(rec.w)) { seen.add(rec.w); res.push({ rec, src }); } };
  for (const l of lemmas(q)) { if (S.mine.has(l)) add(S.mine.get(l), 'mine'); if (S.coreMap.has(l)) add(S.coreMap.get(l), 'core'); }
  for (const r of S.mine.values()) if (r.w.startsWith(q)) add(r, 'mine');
  const pre = S.core.filter(e => e.w.startsWith(q)).sort((a, b) => a.r - b.r);
  pre.slice(0, 40).forEach(e => add(S.mine.get(e.w) || e, S.mine.has(e.w) ? 'mine' : 'core'));
  const sug = [];
  if (S.lex && res.length < 25) {
    for (const l of lemmas(q)) if (S.lex[l] && S.lex[l][0] && !seen.has(l)) { sug.push({ w: l, a: S.lex[l][0], c: S.lex[l][1] }); seen.add(l); }
    if (q.length >= 3) for (const k in S.lex) { if (sug.length >= 12) break; if (k.startsWith(q) && S.lex[k][0] && !seen.has(k)) { sug.push({ w: k, a: S.lex[k][0], c: S.lex[k][1] }); seen.add(k); } }
  }
  return { res, sug };
}
/* Arabic -> English: word-by-word search over my words, built-in list and the large open list */
const AR_STOP = new Set(['في', 'من', 'الي', 'الى', 'على', 'علي', 'عن', 'مع', 'او', 'و', 'ل', 'لـ', 'ب', 'ما', 'لا', 'ان', 'هو', 'هي', 'ذلك', 'هذا', 'هذه', 'التي', 'الذي', 'بدون', 'اختصار', 'نوع', 'شيء', 'شخص', 'او', 'ثم', 'قد', 'كل', 'بعض', 'غير', 'عند']);
function arTokens(s) {
  const out = [];
  for (let t of normAr(s).replace(/[^ء-ي\s]/g, ' ').split(/\s+/)) {
    if (!t) continue;
    if (t.startsWith('ال') && t.length > 3) t = t.slice(2);
    else if (/^(وال|بال|كال|فال|لل)/.test(t) && t.length > 4) t = t.slice(t.startsWith('لل') ? 2 : 3);
    if (t.length < 2 || AR_STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}
let arIndex = null; // token -> array of [word, source]
function buildArIndex() {
  if (arIndex || !S.lex) return arIndex;
  const idx = new Map();
  const add = (w, a, src) => { for (const t of new Set(arTokens(a))) { let l = idx.get(t); if (!l) idx.set(t, l = []); l.push(w); } };
  for (const e of S.core) add(e.w, e.a, 'core');
  for (const w in S.lex) { const a = S.lex[w][0]; if (a) add(w, a, 'lex'); }
  arIndex = idx; return idx;
}
function recFor(w) {
  if (S.mine.has(w)) return { rec: S.mine.get(w), src: 'mine' };
  if (S.coreMap.has(w)) return { rec: S.coreMap.get(w), src: 'core' };
  if (S.lex && S.lex[w] && S.lex[w][0]) return { rec: { w, a: S.lex[w][0], c: S.lex[w][1] }, src: 'lex' };
  return null;
}
function searchAr(q, limit = 60) {
  const toks = arTokens(q); const nq = normAr(q).replace(/^ال/, '');
  if (!toks.length && !nq) return { res: [], sug: [] };
  const score = new Map();
  const bump = (w, n) => score.set(w, (score.get(w) || 0) + n);
  // my words: also allow prefix match on tokens
  for (const r of S.mine.values()) {
    const rt = arTokens(r.a); let n = 0;
    for (const t of toks) if (rt.includes(t)) n += 1; else if (t.length > 2 && rt.some(x => x.startsWith(t))) n += 0.6;
    if (n) bump(r.w, n + 3);
  }
  const idx = buildArIndex();
  if (idx) for (const t of toks) for (const w of (idx.get(t) || [])) bump(w, 1);
  else for (const e of S.core) { const rt = arTokens(e.a); let n = 0; for (const t of toks) if (rt.includes(t)) n++; if (n) bump(e.w, n); }
  const out = [];
  for (const [w, n] of score) {
    const r = recFor(w); if (!r) continue;
    let s = n + 2 * n / Math.max(1, toks.length);
    const na = normAr(r.rec.a);
    const parts = na.split(/[،؛,;]+/).map(x => x.trim().replace(/^ال/, ''));
    if (parts.includes(nq)) s += 3; else if (na.includes(nq)) s += 1;
    if (r.src === 'core') s += 1.2 - Math.min(r.rec.r || 30000, 30000) / 30000;
    if (r.src === 'lex' && w.includes(' ')) s -= 0.3;
    s -= Math.max(0, arTokens(r.rec.a).length - toks.length) * 0.08; // prefer meanings close to what was typed
    out.push({ ...r, s });
  }
  out.sort((x, y) => y.s - x.s);
  const res = out.filter(x => x.src !== 'lex').slice(0, limit);
  const sug = out.filter(x => x.src === 'lex').slice(0, 15).map(x => x.rec);
  const lexFirst = sug.length && (!res.length || out[0].src === 'lex' && out[0].s > res[0].s + 1);
  return { res, sug, all: out.slice(0, limit), lexFirst };
}

/* ---------------- online lookup (MyMemory translation + Free Dictionary API) ---------------- */
const onlineCache = new Map();
const onlineOK = () => S.settings.online !== false && navigator.onLine !== false;
async function getJSON(url, ms = 7000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } finally { clearTimeout(t); }
}
async function translateOnline(text, from, to) {
  const key = from + to + ':' + text;
  if (onlineCache.has(key)) return onlineCache.get(key);
  const j = await getJSON('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 200)) + '&langpair=' + from + '|' + to);
  if (!j) return [];
  const want = to === 'ar' ? /[؀-ۿ]/ : /[a-z]/i;
  const cand = new Map();
  const push = (s, q) => {
    for (let p of String(s || '').split(/\s*[;؛|\/]\s*|\s*،\s*(?=\S)/)) {
      p = p.replace(/[‏‎"“”«»]/g, '').replace(/^[\s.,:\-–]+|[\s.,:\-–]+$/g, '').trim();
      if (!p || !want.test(p) || p.length > 45) continue;
      if (to === 'en') { if (/[؀-ۿ]/.test(p)) continue; p = p.toLowerCase(); }
      if (to === 'ar' && /[a-z]/i.test(p)) continue;
      const k = to === 'ar' ? normAr(p).replace(/^ال/, '') : p;
      const old = cand.get(k); cand.set(k, { t: old ? old.t : p, q: (old ? old.q : 0) + q });
    }
  };
  push(j.responseData && j.responseData.translatedText, 60);
  for (const m of (j.matches || [])) push(m.translation, (+m.quality || 10) / 2 + 10);
  const out = [...cand.values()].sort((a, b) => b.q - a.q).map(x => x.t).slice(0, 8);
  onlineCache.set(key, out); return out;
}
async function defineOnline(word) {
  const key = 'def:' + word; if (onlineCache.has(key)) return onlineCache.get(key);
  const j = await getJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
  let out = null;
  if (Array.isArray(j) && j.length) {
    const e = j[0]; const m = (e.meanings || [])[0] || {}; const d = (m.definitions || [])[0] || {};
    let ex = ''; for (const mm of e.meanings || []) for (const dd of mm.definitions || []) if (!ex && dd.example) ex = dd.example;
    const ipa = e.phonetic || ((e.phonetics || []).find(p => p.text) || {}).text || '';
    const audio = ((e.phonetics || []).find(p => p.audio) || {}).audio || '';
    out = { pos: m.partOfSpeech || '', def: d.definition || '', ex, ipa, audio };
  }
  onlineCache.set(key, out); return out;
}
const POS_CODE = { noun: 'n', verb: 'v', adjective: 'adj', adverb: 'adv', preposition: 'prep', conjunction: 'conj', pronoun: 'pron', interjection: 'int', determiner: 'det', numeral: 'num' };

/* ---------------- UI helpers ---------------- */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400); }
function setTitle(t, info = '') { $('#viewTitle').textContent = t; $('#topInfo').textContent = info; }
function rowHTML(rec, src) {
  const st = src === 'mine' ? status(rec) : null;
  const tags = (rec.tags || []).slice(0, 2).map(t => `<span class="tagmini">${esc(t)}</span>`).join('') + (src !== 'mine' && rec.k && PACKS[rec.k] ? `<span class="tagmini pk">${esc(PACKS[rec.k].short)}</span>` : '');
  return `<li class="row">
    <button class="main" data-open="${esc(rec.w)}">
      <div class="w">${esc(rec.w)}${src === 'mine' ? ' <span class="star" title="In my words">★</span>' : ''}</div>
      <div class="m">${esc(rec.a || '')}</div>
      ${st || tags ? `<div class="meta">${st ? `<span class="dot ${st}"></span><span class="src">${STATUS_TXT[st]}</span>` : ''}${tags}</div>` : ''}
    </button>
    <button class="say" data-say="${esc(rec.w)}" aria-label="Pronounce ${esc(rec.w)}">${ICON_SPEAK}</button>
  </li>`;
}
function bindRows(root) {
  $$('[data-open]', root).forEach(b => b.onclick = () => openWord(b.dataset.open));
  $$('[data-say]', root).forEach(b => b.onclick = e => { e.stopPropagation(); speak(b.dataset.say); });
}
function sheet(title, html, { right = '' } = {}) {
  const sh = $('#sheet');
  sh.innerHTML = `<div class="bar"><button data-act="close">‹ Back</button><strong>${esc(title)}</strong><span>${right}</span></div><div class="body">${html}</div>`;
  sh.hidden = false; sh.scrollTop = 0;
  $('[data-act=close]', sh).onclick = closeSheet;
  if (!history.state || !history.state.sheet) history.pushState({ sheet: 1 }, '');
  return $('.body', sh);
}
function closeSheet(fromPop) { const sh = $('#sheet'); if (sh.hidden) return; sh.hidden = true; sh.innerHTML = ''; if (fromPop !== true && history.state && history.state.sheet) history.back(); render(); }
window.addEventListener('popstate', () => closeSheet(true));

/* ---------------- views ---------------- */
function render() {
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === S.tab));
  updateBadge();
  const v = $('#view');
  ({ search: viewSearch, mine: viewMine, review: viewReview, settings: viewSettings })[S.tab](v);
}

let searchSeq = 0;
function viewSearch(v) {
  const hr = new Date().getHours();
  setTitle('Kalimati', hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening');
  v.innerHTML = `<div class="searchbox"><input id="q" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search English or عربي" value="${esc(S.query)}" aria-label="Search"><button class="clear" aria-label="Clear" ${S.query ? '' : 'hidden'}>×</button><button class="mic" aria-label="Speak to search">${ICON_MIC}</button></div>
    <div class="miclang" hidden><span class="src">Speak in</span><button class="chip" data-ml="${esc(S.settings.accent)}">English</button><button class="chip ar" data-ml="ar-SA">عربي</button></div><div id="results"></div>`;
  const inp = $('#q', v);
  const run = () => {
    S.query = inp.value; $('.clear', v).hidden = !S.query;
    const q = S.query.trim(); const out = $('#results', v);
    inp.dir = isAr(q) ? 'rtl' : 'ltr';
    if (!q) {
      const recent = [...S.mine.values()].sort((a, b) => b.added - a.added).slice(0, 8);
      out.innerHTML = `<div class="homestats"><button data-go="review"><b>${streak()}</b><small>Day streak</small></button><button data-go="review"><b>${dueList().length}</b><small>Due today</small></button><button data-go="mine"><b>${S.mine.size}</b><small>My words</small></button></div><p class="hint">Type a word in English or Arabic. Tap a word to hear it, see how to say it, and save it to your words.</p>` +
        (recent.length ? `<div class="group-h">Recently added</div><ul class="list">${recent.map(r => rowHTML(r, 'mine')).join('')}</ul>` :
          `<div class="empty"><p>Your dictionary is empty. Add the first word you heard today.</p><button class="btn primary" data-act="add">Add a word</button></div>`);
      out.insertAdjacentHTML('beforeend', Object.entries(PACKS).map(([k, p]) => `<div class="group-h">Word packs</div><button class="pack" data-pack="${k}"><span><b>${esc(p.name)}</b><br><span class="ar">${esc(p.ar)}</span></span><span class="src">${S.core.filter(e => e.k === k).length} terms ›</span></button>`).join(''));
      $$('[data-pack]', out).forEach(b => b.onclick = () => openPack(b.dataset.pack));
      $$('[data-go]', out).forEach(b => b.onclick = () => { S.tab = b.dataset.go; render(); window.scrollTo(0, 0); });
      const b = $('[data-act=add]', out); if (b) b.onclick = () => openAdd();
      bindRows(out); return;
    }
    const { res, sug } = isAr(q) ? searchAr(q) : searchEn(normEn(q));
    let html = '';
    const found = isAr(q) ? searchAr(q) : null;
    const resHTML = res.length ? `<ul class="list">${res.map(x => rowHTML(x.rec, x.src)).join('')}</ul>` : '';
    const sugHTML = sug.length ? `<div class="group-h">More words (open dictionary — meaning not checked)</div><ul class="list">${sug.map(r => rowHTML(r, 'lex')).join('')}</ul>` : '';
    html += found && found.lexFirst ? sugHTML + (resHTML ? '<div class="group-h">Built-in list</div>' + resHTML : '') : resHTML + sugHTML;
    if (!isAr(q) && !S.lex) html += `<p class="hint">Loading the larger word list…</p>`;
    if (!res.length && !sug.length && (S.lex || isAr(q))) html += `<div class="empty"><p>“${esc(q)}” is not in the dictionary yet.</p></div>`;
    if (!isAr(q) && !S.mine.has(normEn(q))) html += `<div class="actions"><button class="btn primary wide" data-act="addq">Add “${esc(q)}” to my words</button></div>`;
    else if (isAr(q)) html += `<div class="actions"><button class="btn wide" data-act="addar">Add a new word with this meaning</button></div>`;
    const wantOnline = onlineOK() && res.length + sug.length < 3 && (isAr(q) ? q.length > 1 : normEn(q).length > 1);
    if (wantOnline) html += `<div id="onl"><div class="group-h">Online</div><p class="src">Looking online…</p></div>`;
    out.innerHTML = html; bindRows(out);
    if (wantOnline) {
      const my = ++searchSeq; const ar = isAr(q);
      translateOnline(ar ? q : normEn(q), ar ? 'ar' : 'en', ar ? 'en' : 'ar').then(list => {
        const box = $('#onl', out); if (!box || my !== searchSeq) return;
        if (ar) list = [...new Set(list.map(normEn).filter(Boolean))];
        box.innerHTML = list.length ? `<div class="group-h">Online translation — tap to add to my words</div><ul class="list">${list.map(x => `<li class="row"><button class="main" data-onl="${esc(x)}">
            <div class="w">${esc(ar ? x : normEn(q))}</div><div class="m">${esc(ar ? q : x)}</div></button>
            <button class="say" data-say="${esc(ar ? x : normEn(q))}" aria-label="Pronounce">${ICON_SPEAK}</button></li>`).join('')}</ul>` : '<p class="src">Nothing found online.</p>';
        bindRows(box);
        $$('[data-onl]', box).forEach(b => b.onclick = () => openAdd(ar ? { w: b.dataset.onl, a: q } : { w: normEn(q), a: b.dataset.onl }));
      });
    }
    const a1 = $('[data-act=addq]', out); if (a1) a1.onclick = () => openAdd({ w: q });
    const a2 = $('[data-act=addar]', out); if (a2) a2.onclick = () => openAdd({ a: q });
  };
  let st; inp.oninput = () => { clearTimeout(st); st = setTimeout(run, 200); }; $('.clear', v).onclick = () => { inp.value = ''; run(); inp.focus(); };
  const ml = $('.miclang', v), mic = $('.mic', v);
  mic.onclick = () => { ml.hidden = !ml.hidden; };
  $$('[data-ml]', v).forEach(b => b.onclick = () => { ml.hidden = true; micInto(mic, inp, b.dataset.ml); });
  run();
  if (!S.lex) loadLex().then(() => { if (S.tab === 'search' && S.query) run(); });
}

function viewMine(v) {
  const all = [...S.mine.values()];
  const n = { new: 0, learning: 0, known: 0 }; all.forEach(r => n[status(r)]++);
  setTitle('My words', `${all.length} words`);
  const f = S.mineFilter;
  const tags = [...new Set([...S.settings.tags, ...all.flatMap(r => r.tags || [])])];
  v.innerHTML = `<div class="stats"><div class="stat"><b>${n.new}</b><span>New</span></div><div class="stat"><b>${n.learning}</b><span>Learning</span></div><div class="stat"><b>${n.known}</b><span>Known</span></div></div>
    <div class="searchbox"><input id="mq" type="search" placeholder="Filter my words" value="${esc(f.q)}" aria-label="Filter my words"></div>
    <div class="chips scroll" id="tagf"><button class="chip ${!f.tag ? 'on' : ''}" data-tag="">All</button>${tags.map(t => `<button class="chip ${f.tag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <div class="chips" style="margin-bottom:12px"><span class="src" style="align-self:center">Sort:</span>${[['new', 'Newest'], ['az', 'A–Z'], ['due', 'Due first']].map(([k, l]) => `<button class="chip ${f.sort === k ? 'on' : ''}" data-sort="${k}">${l}</button>`).join('')}</div>
    <div id="mlist"></div>`;
  const draw = () => {
    let list = all.filter(r => !f.tag || (r.tags || []).includes(f.tag));
    const q = f.q.trim();
    if (q) list = list.filter(r => isAr(q) ? normAr(r.a).includes(normAr(q)) : r.w.includes(normEn(q)));
    list.sort(f.sort === 'az' ? (a, b) => a.w.localeCompare(b.w) : f.sort === 'due' ? (a, b) => a.srs.due - b.srs.due : (a, b) => b.added - a.added);
    $('#mlist', v).innerHTML = list.length ? `<ul class="list">${list.map(r => rowHTML(r, 'mine')).join('')}</ul>` :
      `<div class="empty"><p>${all.length ? 'No words match this filter.' : 'Words you add or save from the dictionary will appear here.'}</p>${all.length ? '' : '<button class="btn primary" data-act="add">Add a word</button>'}</div>`;
    bindRows($('#mlist', v)); const b = $('[data-act=add]', v); if (b) b.onclick = () => openAdd();
  };
  $('#mq', v).oninput = e => { f.q = e.target.value; draw(); };
  $$('[data-tag]', v).forEach(b => b.onclick = () => { f.tag = b.dataset.tag; viewMine(v); });
  $$('[data-sort]', v).forEach(b => b.onclick = () => { f.sort = b.dataset.sort; viewMine(v); });
  draw();
}

/* ---------- word detail ---------- */
function openWord(w) {
  const id = normEn(w);
  const mine = S.mine.get(id);
  const core = S.coreMap.get(id);
  const lexE = !mine && !core && S.lex && S.lex[id] ? { w: id, a: S.lex[id][0], c: S.lex[id][1] } : null;
  const rec = mine || core || lexE || { w: id, a: '' };
  const src = mine ? 'mine' : core ? 'core' : 'lex';
  const forms = (core && core.f) || (mine && mine.f) || (S.coreMap.get(id)?.f);
  const body = sheet(src === 'mine' ? 'My word' : 'Dictionary', `
    <div class="detail">
      <div class="word">${esc(rec.w)}</div>
      <div class="pos">${esc(posText(rec.p))}</div>
      <div class="sayrow">
        <button class="say big" data-act="say" aria-label="Pronounce">${ICON_SPEAK}</button>
        <button class="say slow" data-act="slow" aria-label="Pronounce slowly">${ICON_SLOW}<span>Slow</span></button>
        ${S.settings.accent === 'en-US' ? '<button class="chip" data-act="uk">Hear UK</button>' : '<button class="chip" data-act="us">Hear US</button>'}
      </div>
      ${pronHTML(rec)}
      ${rec.a ? `<div class="meaning">${esc(rec.a)}</div>` : '<div class="warnbox">No Arabic meaning yet. Tap Edit to add it.</div>'}
      ${src === 'lex' ? '<div class="warnbox">This meaning comes from an open dictionary and is not checked. Correct it when you save the word.</div>' : ''}
      ${forms ? `<div class="section"><h3>Verb forms</h3><div class="forms">${esc(rec.w)} · ${esc(forms[0])} · ${esc(forms[1])}</div></div>` : ''}
      <div class="section practice"><h3>Practise saying it</h3>
        <div class="chips"><button class="chip ico" data-act="check">${ICON_MIC}Check my pronunciation</button>
        <button class="chip ico" data-act="rec">${ICON_REC}Record myself</button>
        <button class="chip" data-act="playmine" hidden>Play mine</button><button class="chip" data-act="playmodel" hidden>Play correct</button></div>
        <div class="pout"></div></div>
      ${mine && mine.ex ? `<div class="section"><h3>Example</h3><div class="note" style="font-family:var(--en);font-size:17px">${esc(mine.ex)}</div></div>` : ''}
      ${mine && mine.note ? `<div class="section"><h3>Where I met it</h3><div class="note">${esc(mine.note)}</div></div>` : ''}
      ${mine && (mine.tags || []).length ? `<div class="section"><h3>Tags</h3><div class="chips">${mine.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>` : ''}
      ${mine ? `<div class="section src">${STATUS_TXT[status(mine)]} · added ${new Date(mine.added).toLocaleDateString()}${mine.srs.last ? ` · next review ${new Date(mine.srs.due).toLocaleDateString()}` : ''}</div>` : ''}
      <div class="actions">
        ${mine ? `<button class="btn primary" data-act="edit">Edit</button><button class="btn danger" data-act="del">Remove from my words</button>`
        : `<button class="btn primary wide" data-act="save">Save to my words</button>`}
      </div>
    </div>`);
  $('[data-act=say]', body).onclick = () => speak(rec.w);
  $('[data-act=slow]', body).onclick = () => speak(rec.w, { slow: true });
  const uk = $('[data-act=uk]', body); if (uk) uk.onclick = () => speak(rec.w, { lang: 'en-GB' });
  const us = $('[data-act=us]', body); if (us) us.onclick = () => speak(rec.w, { lang: 'en-US' });
  bindIpa(body);
  const ed = $('[data-act=edit]', body); if (ed) ed.onclick = () => openAdd(mine, true);
  const sv = $('[data-act=save]', body); if (sv) sv.onclick = () => openAdd({ w: rec.w, a: rec.a, p: rec.p, c: rec.c });
  const dl = $('[data-act=del]', body); if (dl) dl.onclick = async () => {
    if (!dl.dataset.sure) { dl.dataset.sure = '1'; dl.textContent = 'Tap again to remove (review history will be lost)'; return; }
    await DB.del(mine.id); S.mine.delete(mine.id); toast(`Removed “${rec.w}”`); closeSheet();
  };
  bindPractice(body, rec.w);
  if (S.settings.autoplay) setTimeout(() => speak(rec.w), 250);
}
function bindPractice(body, word) {
  const out = $('.pout', body); const chk = $('[data-act=check]', body), rb = $('[data-act=rec]', body);
  const pm = $('[data-act=playmine]', body), pc = $('[data-act=playmodel]', body);
  const say = (cls, html) => { out.className = 'pout ' + cls; out.innerHTML = html; };
  chk.onclick = async () => {
    speechSynthesis && speechSynthesis.cancel();
    chk.classList.add('live'); say('', 'Listening… say the word now.');
    try {
      const alts = await listen(S.settings.accent, { alts: 5 });
      const target = normEn(word);
      const ok = alts.some(t => normEn(t) === target || (' ' + normEn(t) + ' ').includes(' ' + target + ' '));
      if (!alts.length) say('', 'Nothing heard. Hold the phone closer and try again.');
      else if (ok) { say('good', `<b>Clear.</b> The phone understood “${esc(word)}”.`); logAct('say'); }
      else say('bad', `The phone heard “${esc(alts[0])}”. Listen with Slow, watch the highlighted part, and try again.`);
    } catch (e) { say('', ''); micError(e); }
    chk.classList.remove('live');
  };
  rb.onclick = async () => {
    if (Rec.mr) { Rec.mr.stop(); return; }
    rb.classList.add('live'); say('', 'Recording for 3 seconds… say the word.');
    try { await recordVoice(3); Rec.word = word; pm.hidden = pc.hidden = false; say('', 'Now compare: play yours, then the correct one.'); playUrl(Rec.url); }
    catch (e) { say('', ''); toast(/NotAllowed|denied/i.test(e.name + e.message) ? 'Allow the microphone for Kalimati to record your voice.' : 'Recording is not available on this device.'); }
    rb.classList.remove('live');
  };
  pm.onclick = () => Rec.url && playUrl(Rec.url);
  pc.onclick = () => speak(word, { slow: true });
}

/* ---------- word packs ---------- */
function openPack(k) {
  const p = PACKS[k]; const words = S.core.filter(e => e.k === k).sort((a, b) => a.w.localeCompare(b.w));
  const notMine = () => words.filter(e => !S.mine.has(e.w));
  const body = sheet(p.short + ' words', `
    <p class="hint">${esc(p.name)} — ${words.length} terms with Arabic meanings. Save the ones you use, or save all and review about 10 new terms a day.</p>
    <div class="searchbox"><input id="pq" type="search" placeholder="Filter this pack" aria-label="Filter this pack"></div>
    <div class="actions" style="margin:0 0 14px"><button class="btn primary wide" data-act="all">Save all ${notMine().length} to my words</button></div>
    <div id="plist"></div>`);
  const draw = () => {
    const q = $('#pq', body).value.trim();
    const list = words.filter(e => !q || (isAr(q) ? normAr(e.a).includes(normAr(q)) : e.w.includes(normEn(q))));
    $('#plist', body).innerHTML = `<ul class="list">${list.map(e => rowHTML(S.mine.get(e.w) || e, S.mine.has(e.w) ? 'mine' : 'core')).join('')}</ul>`;
    bindRows($('#plist', body));
  };
  $('#pq', body).oninput = draw; draw();
  const all = $('[data-act=all]', body);
  if (!notMine().length) all.hidden = true;
  all.onclick = async () => {
    if (!all.dataset.sure) { all.dataset.sure = 1; all.textContent = `Tap again: add ${notMine().length} words, about 10 new a day`; return; }
    const now = Date.now(); const batch = notMine().map((e, i) => {
      const r = { ...newRecBase(e.w), a: e.a, p: e.p, c: e.c || '', tags: ['Work'], src: 'pack', pk: k, added: now, edited: now, srs: { ...newSrs(), due: now + Math.floor(i / 10) * DAY } };
      S.mine.set(r.id, r); return r;
    });
    await DB.putMany(batch); logAct('add', batch.length);
    toast(`Saved ${batch.length} words. About 10 will come up for review each day.`); all.hidden = true; draw(); updateBadge();
  };
}
function bindIpa(root) { $$('[data-act=ipa]', root).forEach(b => b.onclick = () => { const l = $('.ipa-line', b.parentElement); l.hidden = false; b.remove(); }); }

/* ---------- add / edit ---------- */
function openAdd(pre = {}, editing = false) {
  const d = { w: '', a: '', p: '', tags: [], note: '', ex: '', pr: null, ...pre };
  const allTags = [...new Set([...S.settings.tags, ...(d.tags || [])])];
  const body = sheet(editing ? 'Edit word' : 'Add a word', `
    <form id="addForm" autocomplete="off">
      <div class="field"><label for="fw">English word or phrase</label>
        <div class="inline"><input id="fw" class="en" value="${esc(d.w)}" autocapitalize="off" spellcheck="false" required ${editing ? 'readonly' : ''}>
        <button type="button" class="say" id="fmic" aria-label="Speak the English word">${ICON_MIC}</button>
        <button type="button" class="say" id="fsay" aria-label="Pronounce">${ICON_SPEAK}</button></div>
        <div id="fsrc" class="suggest"></div></div>
      <div id="fpron"></div>
      <div class="field"><label for="fa">Arabic meaning</label>
        <div class="inline"><textarea id="fa" class="ar" rows="2" dir="rtl" style="flex:1">${esc(d.a)}</textarea>
        <button type="button" class="say" id="famic" aria-label="Speak the Arabic meaning">${ICON_MIC}</button></div>
        <div id="fmeans" class="suggest"></div><div id="farsug" class="suggest"></div></div>
      <div class="field"><label>Tags</label><div class="chips" id="ftags">${allTags.map(t => `<button type="button" class="chip ${d.tags.includes(t) ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}
        <button type="button" class="chip" id="newtag">+ New tag</button></div></div>
      <div class="field"><label for="fn">Where did you meet it? <span class="sub">(optional)</span></label>
        <input id="fn" value="${esc(d.note)}" placeholder="e.g. heard in the HAZOP meeting"></div>
      <div class="field"><label for="fe">Example sentence <span class="sub">(optional)</span></label>
        <textarea id="fe" rows="2" style="font-family:var(--en);font-size:17px">${esc(d.ex)}</textarea></div>
      <details id="fprd" ${d.pr ? 'open' : ''}><summary class="src" style="margin-bottom:10px">Write the pronunciation myself</summary>
        <div class="field"><label for="prs">Say it (stressed part in CAPITALS)</label><input id="prs" value="${esc(d.pr?.rs || '')}" placeholder="e.g. THROO-put"></div>
        <div class="field"><label for="par">بالعربي</label><input id="par" class="ar" dir="rtl" value="${esc(d.pr?.ar || '')}" placeholder="مثال: ثرو-پُت"></div>
        <div class="field"><label for="pip">IPA</label><input id="pip" value="${esc(d.pr?.ipa || '')}" placeholder="/ˈθruːpʊt/"></div>
        <p class="src">Leave empty to use the automatic pronunciation.</p></details>
      <div class="actions"><button class="btn primary wide" type="submit">${editing ? 'Save changes' : 'Save to my words'}</button></div>
    </form>`);
  const fw = $('#fw', body), fa = $('#fa', body);
  let auto = { a: d.a, p: d.p, c: d.c };
  const showPron = () => { const w = normEn(fw.value); $('#fpron', body).innerHTML = w ? pronHTML({ w, c: auto.c || arpOf(w), pr: !(auto.c || arpOf(w)) && auto.ipa ? { ipa: auto.ipa } : null }, { compact: true, showIpa: !(auto.c || arpOf(w)) }) : ''; bindIpa(body); };
  let seq = 0;
  const chipsHTML = (items, attr, label) => items.length ? `<div class="sugrow"><span class="src">${label}</span><div class="chips">${items.map(x => `<button type="button" class="chip${x.on ? ' online' : ''}" ${attr}="${esc(x.v)}">${esc(x.t || x.v)}</button>`).join('')}</div></div>` : '';
  const setMeaning = v => {
    if (!fa.value.trim()) fa.value = v;
    else if (!normAr(fa.value).includes(normAr(v))) fa.value = fa.value.trim() + '، ' + v;
    fa.dataset.auto = '0';
  };
  const onWord = async () => {
    const my = ++seq;
    const w = normEn(fw.value); const src = $('#fsrc', body); const means = $('#fmeans', body);
    means.innerHTML = '';
    if (!w) { src.textContent = ''; showPron(); return; }
    if (!S.lex) await loadLex();
    if (my !== seq) return;
    if (!editing && S.mine.has(w)) { src.innerHTML = `<span class="warnbox" style="display:block">“${esc(w)}” is already in your words. Saving will update it.</span>`; }
    const hit = lookup(w);
    if (hit) {
      auto = { a: hit.rec.a, p: hit.rec.p, c: hit.lemma === w ? hit.rec.c : arpOf(w) };
      if (!fa.value.trim() || fa.dataset.auto === '1') { fa.value = hit.rec.a || ''; fa.dataset.auto = '1'; }
      if (!(S.mine.has(w) && !editing)) src.innerHTML = hit.src === 'lex' ? 'Suggested meaning from the open dictionary — please check it.' :
        hit.lemma !== w ? `Meaning filled from “${esc(hit.lemma)}”. Edit it if needed.` : hit.src === 'core' ? 'Meaning filled from the built-in list. Edit it if needed.' : '';
    } else { auto = { c: arpOf(w) }; if (fa.dataset.auto === '1') { fa.value = ''; } if (!S.mine.has(w)) src.textContent = 'Not in the phone dictionary.'; }
    showPron();
    if (editing || !onlineOK()) { if (!hit && !S.mine.has(w)) src.textContent = 'New word — write the Arabic meaning.'; return; }
    means.innerHTML = '<span class="src">Looking online…</span>';
    const [tr, df] = await Promise.all([translateOnline(w, 'en', 'ar'), defineOnline(w)]);
    if (my !== seq) return;
    if (!hit && !fa.value.trim() && tr[0]) { fa.value = tr[0]; fa.dataset.auto = '1'; src.textContent = 'Meaning from online translation — please check it, or tap another option.'; }
    const have = normAr(fa.value);
    const opts = tr.filter(t => !have.split(/[،,؛]\s*/).map(x => x.replace(/^ال/, '')).includes(normAr(t).replace(/^ال/, ''))).map(t => ({ v: t, on: 1 }));
    let html = chipsHTML(opts, 'data-mean', 'Online meanings (tap to add):');
    if (df) {
      if (!auto.p && df.pos) auto.p = POS_CODE[df.pos] || '';
      if (!auto.c && df.ipa) { auto.ipa = df.ipa; showPron(); }
      html += `<div class="endef"><span class="src">English meaning${df.pos ? ` (${esc(df.pos)})` : ''}:</span> ${esc(df.def)}</div>`;
      if (df.ex && !$('#fe', body).value.trim()) html += `<button type="button" class="chip" data-ex="${esc(df.ex)}">Use example: “${esc(df.ex.length > 70 ? df.ex.slice(0, 70) + '…' : df.ex)}”</button>`;
    }
    if (!tr.length && !df) html = '<span class="src">Nothing found online. Write the meaning yourself.</span>';
    means.innerHTML = html;
    $$('[data-mean]', means).forEach(b => b.onclick = () => { setMeaning(b.dataset.mean); b.remove(); });
    $$('[data-ex]', means).forEach(b => b.onclick = () => { $('#fe', body).value = b.dataset.ex; b.remove(); });
  };
  let t; fw.oninput = () => { clearTimeout(t); t = setTimeout(onWord, 350); };
  let ta, aseq = 0;
  const onArabic = async () => {
    const my = ++aseq;
    const q = fa.value.trim(); const box = $('#farsug', body);
    if (normEn(fw.value) || !isAr(q) || q.length < 2) { box.innerHTML = ''; return; }
    if (!S.lex) { box.innerHTML = '<span class="src">Loading the word list…</span>'; await loadLex(); if (my !== aseq) return; }
    const r = searchAr(q, 10);
    const off = r.all.slice(0, 10).map(x => ({ v: x.rec.w }));
    box.innerHTML = chipsHTML(off, 'data-pick', 'English words with this meaning:') + (onlineOK() ? '<div class="sugrow"><span class="src">Looking online…</span></div>' : '');
    bindPick(box);
    if (!onlineOK()) { if (!off.length) box.innerHTML = '<span class="src">No match on the phone. Write the English word yourself.</span>'; return; }
    const on = await translateOnline(q, 'ar', 'en');
    if (my !== aseq || normEn(fw.value)) return;
    const offSet = new Set(off.map(x => x.v));
    const onl = on.map(x => normEn(x)).filter(x => x && !offSet.has(x)).map(x => ({ v: x, on: 1 }));
    box.innerHTML = chipsHTML(off, 'data-pick', 'English words with this meaning:') + chipsHTML(onl, 'data-pick', 'Online translation:')
      + (!off.length && !onl.length ? '<span class="src">Nothing found. Write the English word yourself.</span>' : '');
    bindPick(box);
  };
  const bindPick = box => $$('[data-pick]', box).forEach(b => b.onclick = () => { fw.value = b.dataset.pick; box.innerHTML = ''; fa.dataset.auto = '0'; onWord(); });
  fa.oninput = () => { fa.dataset.auto = '0'; clearTimeout(ta); ta = setTimeout(onArabic, 450); };
  $('#fsay', body).onclick = () => fw.value.trim() && speak(fw.value.trim());
  const fm = $('#fmic', body); if (editing) fm.hidden = true;
  fm.onclick = () => micInto(fm, fw, S.settings.accent, () => onWord());
  $('#famic', body).onclick = () => micInto($('#famic', body), fa, 'ar-SA');
  $$('#ftags [data-t]', body).forEach(b => b.onclick = () => b.classList.toggle('on'));
  $('#newtag', body).onclick = () => {
    const nb = $('#newtag', body);
    if (!$('#tagname', body)) {
      nb.insertAdjacentHTML('afterend', '<span class="inline" style="width:100%"><input id="tagname" placeholder="New tag, e.g. Medical" style="padding:8px 12px;border-radius:12px;border:1.5px solid var(--line);background:var(--card)"><button type="button" class="chip on" id="tagok">Add</button></span>');
      const ti = $('#tagname', body); ti.focus();
      ti.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#tagok', body).click(); } };
      $('#tagok', body).onclick = () => { addTag(ti.value); ti.parentElement.remove(); };
    }
  };
  const addTag = raw => {
    const name = (raw || '').trim(); if (!name) return;
    if (!S.settings.tags.includes(name)) { S.settings.tags.push(name); saveSettings(); }
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip on'; b.dataset.t = name; b.textContent = name;
    b.onclick = () => b.classList.toggle('on'); $('#newtag', body).before(b);
  };
  $('#addForm', body).onsubmit = async e => {
    e.preventDefault();
    const w = normEn(fw.value); const a = fa.value.trim();
    if (!w) { toast('Write the English word first.'); fw.focus(); return; }
    if (!a) { toast('Write the Arabic meaning.'); fa.focus(); return; }
    const old = S.mine.get(w);
    const pr = { rs: $('#prs', body).value.trim(), ar: $('#par', body).value.trim(), ipa: $('#pip', body).value.trim() };
    const rec = {
      id: w, w, a, p: auto.p || old?.p || d.p || '', c: auto.c || old?.c || arpOf(w) || '',
      tags: $$('#ftags .chip.on[data-t]', body).map(b => b.dataset.t),
      note: $('#fn', body).value.trim(), ex: $('#fe', body).value.trim(),
      pr: (pr.rs || pr.ar || pr.ipa) ? pr : (!(auto.c || arpOf(w)) && auto.ipa ? { ipa: auto.ipa } : null),
      src: old?.src || (S.coreMap.has(w) ? 'core' : 'user'),
      added: old?.added || Date.now(), edited: Date.now(), srs: old?.srs || newSrs()
    };
    if (S.coreMap.get(w)?.f) rec.f = S.coreMap.get(w).f;
    await DB.put(rec); S.mine.set(w, rec); if (!old) logAct('add');
    toast(old ? `Updated “${w}”` : `Saved “${w}” to my words`);
    closeSheet();
  };
  if (d.w) onWord(); else { showPron(); setTimeout(() => (d.a ? fw : fw).focus(), 50); }
  if (d.a && !d.w) fa.dispatchEvent(new Event('input'));
}

/* ---------- review ---------- */
const MODES = [['card', 'Flashcards'], ['listen', 'Listen & choose'], ['spell', 'Listen & spell'], ['all', 'Mixed']];
function lev(a, b) {
  const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function statsHTML() {
  const today = S.log[dayKey()]?.rev || 0, goal = S.settings.goal || 10, st = streak();
  return `<div class="stats"><div class="stat"><b>${st}</b><span>Day streak</span></div>
    <div class="stat"><b>${today}<small>/${goal}</small></b><span>Reviewed today</span></div>
    <div class="stat"><b>${addedThisWeek()}</b><span>Added this week</span></div></div>
    <div class="progress goal" title="Daily goal"><i style="width:${Math.min(100, Math.round(100 * today / goal))}%"></i></div>`;
}
function viewReview(v) {
  const due = dueList();
  const all = S.mine.size;
  setTitle('Review', all ? `${due.length} due today` : '');
  if (S.review && S.review.queue.length) return drawCard(v);
  if (S.review && S.review.done) {
    const r = S.review; S.review = null;
    const today = S.log[dayKey()]?.rev || 0;
    v.innerHTML = statsHTML() + `<div class="empty"><p style="font:600 24px/1.3 var(--en);color:var(--text)">Session done</p>
      <p>You reviewed ${r.done} cards. Remembered: ${r.good}. Forgotten: ${r.forgot}.</p>
      ${today >= (S.settings.goal || 10) ? '<p>Daily goal reached.</p>' : ''}
      ${dueList().length ? `<button class="btn primary" data-act="go">Review ${dueList().length} more</button>` : '<p>No more words due today. Come back tomorrow.</p>'}</div>`;
    const g = $('[data-act=go]', v); if (g) g.onclick = () => startReview(v);
    return;
  }
  if (!all) { v.innerHTML = `<div class="empty"><p>Review uses the words you save. Add or save a few words first.</p><button class="btn primary" data-act="add">Add a word</button></div>`; $('[data-act=add]', v).onclick = () => openAdd(); return; }
  const next = [...S.mine.values()].sort((a, b) => a.srs.due - b.srs.due)[0];
  const mode = S.settings.mode || 'card';
  v.innerHTML = statsHTML() + `
    <div class="group-h">How to review</div>
    <div class="chips" style="margin-bottom:10px">${MODES.map(([k, l]) => `<button class="chip ${mode === k ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>
    ${mode === 'card' || mode === 'all' ? `<div class="chips" style="margin-bottom:6px"><span class="src" style="align-self:center">Cards:</span>${[['en-ar', 'English → Arabic'], ['ar-en', 'Arabic → English'], ['mix', 'Both']].map(([k, l]) => `<button class="chip ${S.settings.dir === k ? 'on' : ''}" data-dir="${k}">${l}</button>`).join('')}</div>` : ''}
    <p class="src">${{ card: 'See the word, remember the meaning, then check.', listen: 'Hear the word and pick its meaning from four choices.', spell: 'Hear the word and type it. Good for spelling.', all: 'A mix of all three.' }[mode]}</p>
    ${due.length ? `<div class="empty" style="padding-top:8px"><p style="font:600 48px/1 var(--en);color:var(--text)">${due.length}</p><p>words are ready to review.</p>
      <button class="btn primary" data-act="go">Start review</button></div>`
    : `<div class="empty" style="padding-top:8px"><p>Nothing to review now.</p><p>Next review: ${new Date(next.srs.due).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
      <button class="btn" data-act="extra">Practise 10 random words anyway</button></div>`}`;
  $$('[data-dir]', v).forEach(b => b.onclick = () => { S.settings.dir = b.dataset.dir; saveSettings(); viewReview(v); });
  $$('[data-mode]', v).forEach(b => b.onclick = () => { S.settings.mode = b.dataset.mode; saveSettings(); viewReview(v); });
  const g = $('[data-act=go]', v); if (g) g.onclick = () => startReview(v);
  const x = $('[data-act=extra]', v); if (x) x.onclick = () => startReview(v, true);
}
function startReview(v, extra = false) {
  let q = extra ? [...S.mine.values()].sort(() => Math.random() - 0.5).slice(0, 10) : dueList().slice(0, 50);
  S.review = { queue: q.map(r => r.id), total: q.length, done: 0, good: 0, forgot: 0, extra, shown: false, m: null };
  drawCard(v);
}
function distractors(rec, n = 3) {
  const pos = String(rec.p || '').split(',')[0];
  const pool = [...S.mine.values(), ...S.core.filter(e => e.r < 4000)];
  const used = new Set([normAr(rec.a)]); const out = [];
  for (let tries = 0; out.length < n && tries < 400; tries++) {
    const e = pool[Math.floor(Math.random() * pool.length)];
    if (!e || !e.a || e.w === rec.w) continue;
    if (tries < 250 && pos && String(e.p || '').split(',')[0] !== pos) continue;
    const k = normAr(e.a); if (used.has(k)) continue; used.add(k); out.push(e.a);
  }
  return out;
}
function drawCard(v) {
  const R = S.review; const rec = S.mine.get(R.queue[0]);
  if (!rec) { R.queue.shift(); return R.queue.length ? drawCard(v) : viewReview(v); }
  if (!R.m) {
    const mode = S.settings.mode || 'card';
    R.m = mode === 'all' ? ['card', 'listen', 'spell'][Math.floor(Math.random() * 3)] : mode;
    R.dir = S.settings.dir === 'mix' ? (Math.random() < 0.5 ? 'en-ar' : 'ar-en') : S.settings.dir;
    if (R.m === 'listen') { const o = [rec.a, ...distractors(rec)]; R.opts = o.sort(() => Math.random() - 0.5); }
    R.result = null; R.pick = null; R.typed = '';
  }
  const pct = Math.round(100 * R.done / Math.max(1, R.total + R.forgot));
  const head = `<div class="progress"><i style="width:${pct}%"></i></div>`;
  const foot = `<p class="src" style="text-align:center;margin-top:14px">${R.queue.length} left · <button class="chip" data-act="stop" style="font-size:13px;padding:3px 10px">End session</button></p>`;
  const grades = R.result === 'wrong' ? `<div class="actions"><button class="btn primary wide" data-g="forgot">Next — I will see it again soon</button></div>`
    : R.result === 'almost' ? `<div class="actions"><button class="btn primary wide" data-g="hard">Next</button></div>`
    : `<div class="grade">${R.result ? '' : `<button class="g-forgot" data-g="forgot">Forgot<small>${ivLabel(rec.srs, 'forgot')}</small></button>`}
      <button class="g-hard" data-g="hard">Hard<small>${ivLabel(rec.srs, 'hard')}</small></button>
      <button class="g-easy" data-g="easy">Easy<small>${ivLabel(rec.srs, 'easy')}</small></button></div>`;
  let card = '', below = '';
  const sayBtn = `<button class="say big" data-act="say" aria-label="Pronounce">${ICON_SPEAK}</button>`;
  const slowBtn = `<button class="say slow" data-act="slow" aria-label="Pronounce slowly">${ICON_SLOW}<span>Slow</span></button>`;
  if (R.m === 'card') {
    const enFront = R.dir === 'en-ar';
    const showPron = R.shown || S.settings.pronInReview === 'show';
    card = enFront ? `<div class="q">${esc(rec.w)}</div>${sayBtn}${showPron ? pronHTML(rec, { compact: true }) : '<button class="chip" data-act="pron">Show how to say it</button>'}`
      : `<div class="q ar">${esc(rec.a)}</div>${rec.note ? `<div class="src">${esc(rec.note)}</div>` : ''}`;
    if (R.shown) card += `<hr>${enFront ? `<div class="a">${esc(rec.a)}</div>${rec.ex ? `<div class="src" style="font-family:var(--en);font-size:16px">${esc(rec.ex)}</div>` : ''}`
      : `<div class="a en">${esc(rec.w)}</div>${sayBtn}${pronHTML(rec, { compact: true })}`}`;
    below = R.shown ? grades : `<div class="actions"><button class="btn primary wide" data-act="show">Show answer</button></div>`;
  } else if (R.m === 'listen') {
    card = `<p class="src">Listen. What does it mean?</p><div class="sayrow" style="justify-content:center">${sayBtn}${slowBtn}</div>`;
    if (R.shown) card += `<hr><div class="a en">${esc(rec.w)}</div>${pronHTML(rec, { compact: true })}`;
    below = `<div class="opts">${R.opts.map((o, i) => {
      const cls = !R.shown ? '' : o === rec.a ? 'right' : i === R.pick ? 'wrong' : 'dim';
      return `<button class="opt ${cls}" data-opt="${i}" ${R.shown ? 'disabled' : ''}>${esc(o)}</button>`;
    }).join('')}</div>` + (R.shown ? grades : '');
  } else {
    card = `<p class="src">Listen and type the word.</p><div class="sayrow" style="justify-content:center">${sayBtn}${slowBtn}</div>`;
    if (!R.shown) card += `<form id="spellf" style="width:100%"><input id="spell" class="spell" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type what you hear" aria-label="Type the word"></form>`;
    else card += `<div class="spellres ${R.result}">${R.result === 'ok' ? 'Correct' : R.result === 'almost' ? 'Almost' : 'Not quite'}${R.typed ? ` — you wrote “${esc(R.typed)}”` : ''}</div>
      <div class="a en">${esc(rec.w)}</div>${pronHTML(rec, { compact: true })}<div class="a">${esc(rec.a)}</div>`;
    below = R.shown ? grades : `<div class="actions"><button class="btn primary" data-act="check" style="flex:1">Check</button><button class="btn" data-act="idk">I don't know</button></div>`;
  }
  v.innerHTML = head + `<div class="card">${card}</div>` + below + foot;
  $$('[data-act=say]', v).forEach(b => b.onclick = () => speak(rec.w));
  $$('[data-act=slow]', v).forEach(b => b.onclick = () => speak(rec.w, { slow: true }));
  const p = $('[data-act=pron]', v); if (p) p.onclick = () => { p.outerHTML = pronHTML(rec, { compact: true }); bindIpa(v); };
  bindIpa(v);
  const sh = $('[data-act=show]', v); if (sh) sh.onclick = () => { R.shown = true; drawCard(v); if (R.dir !== 'en-ar') speak(rec.w); };
  $$('[data-opt]', v).forEach(b => b.onclick = () => { R.pick = +b.dataset.opt; R.shown = true; R.result = R.opts[R.pick] === rec.a ? 'ok' : 'wrong'; drawCard(v); });
  const doCheck = idk => {
    const t = idk ? '' : normEn($('#spell', v).value); const target = normEn(rec.w);
    R.typed = idk ? '' : $('#spell', v).value.trim();
    R.result = t === target ? 'ok' : (t && lev(t, target) <= (target.length > 6 ? 2 : 1)) ? 'almost' : 'wrong';
    R.shown = true; drawCard(v);
  };
  const sf = $('#spellf', v); if (sf) { sf.onsubmit = e => { e.preventDefault(); doCheck(false); }; setTimeout(() => $('#spell', v)?.focus(), 50); }
  const ck = $('[data-act=check]', v); if (ck) ck.onclick = () => doCheck(false);
  const idk = $('[data-act=idk]', v); if (idk) idk.onclick = () => doCheck(true);
  $('[data-act=stop]', v).onclick = () => { R.queue = []; if (!R.done) S.review = null; viewReview(v); };
  $$('[data-g]', v).forEach(b => b.onclick = async () => {
    const g = b.dataset.g;
    if (!R.extra || g === 'forgot') { rec.srs = nextSrs(rec.srs, g); await DB.put(rec); }
    logAct('rev');
    R.queue.shift(); R.done++; R.shown = false; R.m = null;
    if (g === 'forgot') { R.forgot++; R.queue.push(rec.id); } else R.good++;
    if (!R.queue.length) { viewReview(v); updateBadge(); return; }
    drawCard(v); updateBadge();
  });
  if (R.shown && R.m !== 'card') setTimeout(() => { const g = $('.grade, .actions', v); g && g.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, 60);
  const autoplay = !R.shown && (R.m !== 'card' || (R.dir === 'en-ar' && S.settings.autoplay));
  if (autoplay) setTimeout(() => speak(rec.w), 250);
}

/* ---------- settings ---------- */
function seg(key, opts) { return `<div class="seg">${opts.map(([k, l]) => `<button data-k="${key}" data-v="${k}" class="${String(S.settings[key]) === String(k) ? 'on' : ''}">${l}</button>`).join('')}</div>`; }
function viewSettings(v) {
  setTitle('Settings');
  v.innerHTML = `
    <section class="set"><h2>Sound</h2>
      <div class="opt"><span>Accent</span>${seg('accent', [['en-US', 'US'], ['en-GB', 'UK']])}</div>
      <div class="opt"><span>Slow speed</span>${seg('slow', [['0.5', 'Very slow'], ['0.6', 'Slow'], ['0.75', 'A bit slow']])}</div>
      <div class="opt"><span>Play word when opened</span>${seg('autoplay', [['true', 'On'], ['false', 'Off']])}</div>
      <div class="opt"><button class="btn" data-act="test">Test the voice</button><span class="src" id="vinfo"></span></div>
    </section>
    <section class="set"><h2>Online lookup</h2>
      <div class="opt"><span>Look up words online when the phone has no meaning</span>${seg('online', [['true', 'On'], ['false', 'Off']])}</div>
      <p class="about">Uses MyMemory (translation) and Free Dictionary (English meaning, example, pronunciation). Only the word you type is sent. Your saved words stay on the phone.</p>
    </section>
    <section class="set"><h2>Review</h2>
      <div class="opt"><span>Card direction</span>${seg('dir', [['en-ar', 'EN→AR'], ['ar-en', 'AR→EN'], ['mix', 'Both']])}</div>
      <div class="opt"><span>Daily goal (reviews)</span>${seg('goal', [['5', '5'], ['10', '10'], ['20', '20'], ['30', '30']])}</div>
      <div class="opt"><span>Written pronunciation</span>${seg('pronInReview', [['tap', 'On tap'], ['show', 'Always']])}</div>
    </section>
    <section class="set"><h2>Daily reminder</h2>
      <div class="opt"><label for="remt">Reminder time</label><input id="remt" type="time" value="${esc(S.settings.remindAt)}" style="padding:8px;border-radius:10px;border:1.5px solid var(--line);background:var(--card)"></div>
      <div class="opt"><span>Add a repeating daily reminder to your phone calendar</span><button class="btn" data-act="ics">Add</button></div>
      <p class="about">This makes a calendar file. Open it with Google Calendar and tap Save; the calendar will alert you every day at this time.</p>
    </section>
    <section class="set"><h2>Look</h2>
      <div class="opt"><span>Theme</span>${seg('theme', [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>
    </section>
    <section class="set"><h2>Backup</h2>
      <div class="opt"><span>Send backup to Google Drive, email or WhatsApp</span><button class="btn primary" data-act="share">Share</button></div>
      <div class="opt"><span>Full backup file (to restore later)</span><button class="btn" data-act="exjson">Export</button></div>
      <div class="opt"><span>Excel / CSV list</span><button class="btn" data-act="excsv">Export</button></div>
      <div class="opt"><span>Restore backup or import CSV<br><span class="src">CSV columns: word, meaning, tags, note</span></span><button class="btn" data-act="imp">Import</button></div>
      <input type="file" id="impfile" accept=".json,.csv,text/csv,application/json" hidden>
      <p class="about">${S.mine.size} words saved on this phone${DB.ok ? '' : ' (temporary storage — export a backup)'}. Export a backup from time to time, and before changing phone.</p>
    </section>
    <section class="set"><h2>About</h2>
      <p class="about">Kalimati (كلماتي) — your private English–Arabic dictionary. Version 2.3.<br>
      Built-in list: ${S.core.length.toLocaleString()} words with checked Arabic meanings — ${S.core.filter(e => !e.k).length.toLocaleString()} common English words and ${S.core.filter(e => e.k).length} oil &amp; gas and process terms, written for this app.<br>
      Extra suggested meanings (not checked): FreeDict / Arabeyes English–Arabic word list (GPL), about 85,000 words.<br>
      Online lookup (when on): MyMemory for translations, Free Dictionary API for English meanings, examples and pronunciation.<br>
      Written pronunciation: CMU Pronouncing Dictionary (US English). Sound: your phone's text-to-speech voices.</p>
    </section>`;
  $$('[data-k]', v).forEach(b => b.onclick = () => {
    const k = b.dataset.k; let val = b.dataset.v;
    if (k === 'slow') val = parseFloat(val); if (k === 'autoplay' || k === 'online') val = val === 'true'; if (k === 'goal') val = parseInt(val, 10);
    S.settings[k] = val; saveSettings(); applyTheme(); viewSettings(v);
  });
  $('[data-act=test]', v).onclick = () => { speak('Hello. This is how your words will sound.'); const vo = pickVoice(S.settings.accent); $('#vinfo', v).textContent = vo ? vo.name : 'Default voice'; };
  $('[data-act=exjson]', v).onclick = exportJSON;
  $('[data-act=share]', v).onclick = shareBackup;
  $('#remt', v).onchange = e => { S.settings.remindAt = e.target.value || '19:00'; saveSettings(); };
  $('[data-act=ics]', v).onclick = () => calendarReminder(S.settings.remindAt);
  $('[data-act=excsv]', v).onclick = exportCSV;
  $('[data-act=imp]', v).onclick = () => $('#impfile', v).click();
  $('#impfile', v).onchange = e => importFile(e.target.files[0]);
}
async function saveSettings() { try { localStorage.setItem('kalimati-settings', JSON.stringify(S.settings)); } catch (e) { } await DB.setMeta('settings', S.settings); }
function applyTheme() { const t = S.settings.theme; if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; }

/* ---------- backup ---------- */
function download(name, text, type) {
  const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
function backupText() { return JSON.stringify({ app: 'kalimati', v: 2, exported: new Date().toISOString(), settings: S.settings, log: S.log, words: [...S.mine.values()] }); }
async function shareBackup() {
  const name = `kalimati-backup-${stamp()}.json`;
  try {
    const file = new File([backupText()], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Kalimati backup', text: `${S.mine.size} words` }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  download(name, backupText(), 'application/json'); toast('Sharing is not available here. The backup file was saved instead.');
}
function calendarReminder(hm) {
  const [h, m] = (hm || '19:00').split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1);
  const f = t => t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = new Date(d.getTime() + 10 * 60000);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kalimati//EN', 'BEGIN:VEVENT', `UID:kalimati-daily-${Date.now()}@kalimati`, `DTSTAMP:${f(new Date())}`,
    `DTSTART:${f(d)}`, `DTEND:${f(end)}`, 'RRULE:FREQ=DAILY', 'SUMMARY:Kalimati — review my words', `DESCRIPTION:Open Kalimati and review today's words. ${location.href.split('?')[0]}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Review my words', 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  download('kalimati-daily-reminder.ics', ics, 'text/calendar'); toast('Calendar file ready. Open it and tap Save.');
}
function exportJSON() { download(`kalimati-backup-${stamp()}.json`, backupText(), 'application/json'); toast('Backup file exported'); }
function csvCell(s) { s = String(s ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportCSV() {
  const rows = [['word', 'meaning', 'tags', 'note', 'example', 'part of speech', 'pronunciation', 'status', 'added']];
  for (const r of [...S.mine.values()].sort((a, b) => a.w.localeCompare(b.w))) {
    const arp = r.c || arpOf(r.w); const p = arp ? Pron.build(arp) : null;
    rows.push([r.w, r.a, (r.tags || []).join('; '), r.note, r.ex, posText(r.p), r.pr?.rs || (p ? Pron.respellText(p) : ''), STATUS_TXT[status(r)], new Date(r.added).toISOString().slice(0, 10)]);
  }
  download(`kalimati-words-${stamp()}.csv`, '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  toast('Word list exported');
}
function parseCSV(t) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function importFile(file) {
  if (!file) return;
  const text = (await file.text()).replace(/^﻿/, '');
  let incoming = [];
  try {
    if (/^\s*[{[]/.test(text)) {
      const j = JSON.parse(text); incoming = (j.words || j).filter(x => x && x.w);
      if (j.log) { for (const [k, e] of Object.entries(j.log)) { const c = S.log[k] || (S.log[k] = { rev: 0, add: 0 }); c.rev = Math.max(c.rev || 0, e.rev || 0); c.add = Math.max(c.add || 0, e.add || 0); } DB.setMeta('log', S.log); }
    } else {
      const rows = parseCSV(text); if (rows.length && /word/i.test(rows[0][0])) rows.shift();
      incoming = rows.filter(r => r[0] && r[1]).map(r => ({ w: r[0], a: r[1], tags: (r[2] || '').split(/[;|]/).map(s => s.trim()).filter(Boolean), note: r[3] || '', ex: r[4] || '' }));
    }
  } catch (e) { toast('This file could not be read. Use a Kalimati backup (.json) or a CSV file.'); return; }
  let added = 0, updated = 0; const batch = [];
  for (const x of incoming) {
    const id = normEn(x.w); if (!id) continue;
    const old = S.mine.get(id);
    if (old && (old.edited || 0) >= (x.edited || 0) && x.srs) continue;
    const rec = { ...newRecBase(id), ...old, ...x, id, w: id, srs: x.srs || old?.srs || newSrs(), added: x.added || old?.added || Date.now(), edited: x.edited || Date.now() };
    if (!rec.c) rec.c = arpOf(id) || '';
    old ? updated++ : added++; batch.push(rec); S.mine.set(id, rec);
  }
  await DB.putMany(batch);
  toast(`Import done: ${added} added, ${updated} updated`); render();
}
function newRecBase(id) { return { id, w: id, a: '', p: (S.coreMap.get(id) || {}).p || '', tags: [], note: '', ex: '', pr: null, src: S.coreMap.has(id) ? 'core' : 'user' }; }

/* ---------------- start ---------------- */
async function init() {
  try { const s = JSON.parse(localStorage.getItem('kalimati-settings') || 'null'); if (s) Object.assign(S.settings, s); } catch (e) { }
  applyTheme();
  $('#view').innerHTML = '<p class="hint">Loading…</p>';
  await DB.open();
  const [core, words, ms, lg] = await Promise.all([fetch('data/core.json').then(r => r.json()), DB.all(), DB.getMeta('settings').catch(() => null), DB.getMeta('log').catch(() => null)]);
  if (ms) Object.assign(S.settings, ms);
  if (lg && typeof lg === 'object' && !(lg instanceof IDBRequest)) S.log = lg;
  applyTheme();
  S.core = core; core.forEach(e => { S.coreMap.set(e.w, e); if (e.f) e.f.forEach(f => f.split(' / ').forEach(x => { if (!S.irrBack.has(x)) S.irrBack.set(x, e.w); })); });
  words.forEach(w => S.mine.set(w.id, w));
  $$('.tab').forEach(t => t.onclick = () => {
    if (t.dataset.tab === 'add') return openAdd();
    if (S.tab === t.dataset.tab && t.dataset.tab === 'review' && S.review) return;
    S.tab = t.dataset.tab; render(); window.scrollTo(0, 0);
  });
  render();
  // shared text or ?add= link opens the add form
  const u = new URL(location.href); const shared = u.searchParams.get('text') || u.searchParams.get('title') || u.searchParams.get('add');
  if (shared) {
    const w = shared.replace(/https?:\/\/\S+/g, '').trim().split(/\s+/).slice(0, 4).join(' ').replace(/[^\p{L}' -]/gu, '');
    history.replaceState(null, '', u.pathname);
    if (w) openAdd(isAr(w) ? { a: w } : { w });
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
  setTimeout(loadLex, 1500);
}
init();
