/* Pronunciation helpers: convert CMU ARPAbet to IPA, simple respelling and Arabic letters.
   Works in the browser (window.Pron) and in Node (module.exports). */
(function (root) {
  const VOWELS = new Set(['AA','AE','AH','AO','AW','AY','EH','ER','EY','IH','IY','OW','OY','UH','UW']);
  const ONSETS = new Set([
    'P R','P L','B R','B L','T R','D R','K R','K L','G R','G L','F R','F L','TH R','SH R',
    'S P','S T','S K','S M','S N','S L','S W','S P R','S T R','S K R','S P L','S K W',
    'T W','D W','K W','G W','TH W','P Y','B Y','F Y','M Y','K Y','V Y','HH Y','N Y','L Y','G Y','S F'
  ]);

  function parse(arp) {
    return arp.trim().split(/\s+/).filter(Boolean).map(t => {
      const m = t.match(/^([A-Z]+)([012])?$/);
      return m ? { p: m[1], s: m[2] === undefined ? null : +m[2] } : null;
    }).filter(Boolean);
  }

  // Split one word (array of phones) into syllables using maximal legal onset.
  function syllabify(ph) {
    const vIdx = ph.map((x, i) => VOWELS.has(x.p) ? i : -1).filter(i => i >= 0);
    if (!vIdx.length) return [{ on: ph.map(x => x.p), v: null, co: [], s: 0 }];
    const syl = vIdx.map(i => ({ on: [], v: ph[i].p, s: ph[i].s || 0, co: [] }));
    // leading consonants go to first onset
    syl[0].on = ph.slice(0, vIdx[0]).map(x => x.p);
    for (let k = 0; k < vIdx.length - 1; k++) {
      const cl = ph.slice(vIdx[k] + 1, vIdx[k + 1]).map(x => x.p);
      let split = cl.length; // index where onset starts
      for (let j = 0; j <= cl.length; j++) {
        const on = cl.slice(j);
        if (on.length === 0 || on.length === 1 && on[0] !== 'NG' || ONSETS.has(on.join(' '))) { split = j; break; }
      }
      syl[k].co = cl.slice(0, split);
      syl[k + 1].on = cl.slice(split);
      // stressed short (lax) vowels do not end a syllable in English: "pres-sure" -> "presh-er"
      const lax = ['AE','EH','IH','UH'].includes(syl[k].v) || (syl[k].v === 'AH' && syl[k].s >= 1);
      if (lax && syl[k].s >= 1 && syl[k].co.length === 0 && syl[k + 1].on.length > 0 && syl[k + 1].on[0] !== 'W' && syl[k + 1].on[0] !== 'Y') {
        const rest = syl[k + 1].on.slice(1);
        if (rest.length === 0 || rest.length === 1 || ONSETS.has(rest.join(' '))) {
          syl[k].co = [syl[k + 1].on[0]];
          syl[k + 1].on = rest;
        }
      }
    }
    syl[syl.length - 1].co = ph.slice(vIdx[vIdx.length - 1] + 1).map(x => x.p);
    return syl;
  }

  // ---------- IPA ----------
  const IPA_C = { B:'b',CH:'tʃ',D:'d',DH:'ð',F:'f',G:'ɡ',HH:'h',JH:'dʒ',K:'k',L:'l',M:'m',N:'n',NG:'ŋ',P:'p',R:'r',S:'s',SH:'ʃ',T:'t',TH:'θ',V:'v',W:'w',Y:'j',Z:'z',ZH:'ʒ' };
  function ipaV(v, s) {
    switch (v) {
      case 'AA': return 'ɑː'; case 'AE': return 'æ'; case 'AH': return s === 0 ? 'ə' : 'ʌ';
      case 'AO': return 'ɔː'; case 'AW': return 'aʊ'; case 'AY': return 'aɪ'; case 'EH': return 'e';
      case 'ER': return s === 0 ? 'ər' : 'ɜːr'; case 'EY': return 'eɪ'; case 'IH': return 'ɪ';
      case 'IY': return s === 0 ? 'i' : 'iː'; case 'OW': return 'oʊ'; case 'OY': return 'ɔɪ';
      case 'UH': return 'ʊ'; case 'UW': return s === 0 ? 'u' : 'uː';
    }
    return '';
  }
  function wordIPA(syl) {
    const multi = syl.length > 1;
    return syl.map(x => {
      const mark = multi ? (x.s === 1 ? 'ˈ' : x.s === 2 ? 'ˌ' : '') : '';
      return mark + x.on.map(c => IPA_C[c]).join('') + (x.v ? ipaV(x.v, x.s) : '') + x.co.map(c => IPA_C[c]).join('');
    }).join('');
  }

  // ---------- Simple respelling ----------
  const RS_C = { B:'b',CH:'ch',D:'d',DH:'th',F:'f',G:'g',HH:'h',JH:'j',K:'k',L:'l',M:'m',N:'n',NG:'ng',P:'p',R:'r',S:'s',SH:'sh',T:'t',TH:'th',V:'v',W:'w',Y:'y',Z:'z',ZH:'zh' };
  function rsV(x) {
    const open = x.co.length === 0, noOn = x.on.length === 0;
    switch (x.v) {
      case 'AA': return 'ah'; case 'AE': return 'a'; case 'AH': return 'uh'; case 'AO': return 'aw';
      case 'AW': return 'ow'; case 'AY': return noOn ? 'eye' : 'y'; case 'EH': return open ? 'eh' : 'e';
      case 'ER': return x.s === 0 ? 'er' : 'ur'; case 'EY': return 'ay'; case 'IH': return open ? 'ih' : 'i';
      case 'IY': return 'ee'; case 'OW': return 'oh'; case 'OY': return 'oy'; case 'UH': return 'uu'; case 'UW': return 'oo';
    }
    return '';
  }
  function sylRS(x) {
    let s = x.on.map(c => RS_C[c]).join('') + (x.v ? rsV(x) : '') + x.co.map(c => RS_C[c]).join('');
    // "y" vowel directly followed by consonant y-sound is fine; "AY" after onset ending in y (rare)
    return s;
  }

  // ---------- Arabic letters ----------
  const AR_C = { B:'ب',CH:'تش',D:'د',DH:'ذ',F:'ف',G:'گ',HH:'ه',JH:'ج',K:'ك',L:'ل',M:'م',N:'ن',NG:'نْگ',P:'پ',R:'ر',S:'س',SH:'ش',T:'ت',TH:'ث',V:'ڤ',W:'و',Y:'ي',Z:'ز',ZH:'ژ' };
  const FATHA = 'َ', KASRA = 'ِ', DAMMA = 'ُ';
  function arV(x, first) {
    const open = x.co.length === 0;
    const noOn = x.on.length === 0;
    const short = { AH: FATHA, AE: FATHA, EH: KASRA, IH: KASRA, UH: DAMMA };
    if (short[x.v] !== undefined) {
      if (noOn) {
        // syllable starts with the vowel: carrier alif with hamza
        const carrier = (x.v === 'EH' || x.v === 'IH') ? 'إ' : 'أ';
        if (x.v === 'AE') return 'آ';
        return carrier + short[x.v];
      }
      if (x.v === 'AE') return 'ا';
      if (open) return { AH: 'ا', EH: 'ي', IH: 'ي', UH: 'و' }[x.v];
      return short[x.v];
    }
    const longMap = { AA: 'ا', AO: 'و', AW: 'او', AY: 'اي', EY: FATHA + 'ي', IY: 'ي', OW: 'و', OY: 'وي', UW: 'و' };
    const startMap = { AA: 'آ', AO: 'أو', AW: 'آو', AY: 'آي', EY: 'إي', IY: 'إي', OW: 'أو', OY: 'أوي', UW: 'أو' };
    if (x.v === 'ER') return (noOn ? 'أ' : '') + (x.s === 0 ? FATHA : KASRA) + 'ر';
    return noOn ? startMap[x.v] : longMap[x.v];
  }
  function sylAR(x, first, prev) {
    // vowel-initial syllable after a closed syllable: join to the previous one, no hamza
    if (!first && prev && prev.co.length && x.on.length === 0 && x.v) {
      const short = { AH: FATHA, AE: FATHA, EH: KASRA, IH: KASRA, UH: DAMMA, ER: (x.s === 0 ? FATHA : KASRA) + 'ر',
        AA: 'ا', AO: 'و', AW: 'او', AY: 'اي', EY: FATHA + 'ي', IY: 'ي', OW: 'و', OY: 'وي', UW: 'و' };
      let v = short[x.v];
      if (x.co.length === 0 && { AH: 1, AE: 1 }[x.v]) v = 'ا';
      if (x.co.length === 0 && { EH: 1, IH: 1 }[x.v]) v = 'ي';
      if (x.co.length === 0 && x.v === 'UH') v = 'و';
      return { t: v + x.co.map(c => AR_C[c]).join(''), join: true };
    }
    return { t: x.on.map(c => AR_C[c]).join('') + (x.v ? arV(x, first) : '') + x.co.map(c => AR_C[c]).join(''), join: false };
  }

  /* Returns { words: [ { syl:[{rs, ar, stress}], ipa } ] } for an arpabet string.
     Multiple words are separated by '|'. */
  function build(arpAll) {
    if (!arpAll) return null;
    const words = arpAll.split('|').map(a => {
      const syl = syllabify(parse(a));
      const multi = syl.length > 1;
      return {
        ipa: wordIPA(syl),
        syl: syl.map((x, i) => { const a = sylAR(x, i === 0, syl[i - 1]); return { rs: sylRS(x), ar: a.t, join: a.join, stress: multi ? x.s : 1 }; })
      };
    });
    return { words };
  }

  function respellText(p) {
    return p.words.map(w => w.syl.map(s => s.stress === 1 ? s.rs.toUpperCase() : s.rs).join('-')).join(' ');
  }
  function arabicText(p) { return p.words.map(w => w.syl.map((s, i) => (i && !s.join ? '-' : '') + s.ar).join('')).join(' '); }
  function ipaText(p) { return '/' + p.words.map(w => w.ipa).join(' ') + '/'; }

  const api = { build, respellText, arabicText, ipaText, syllabify, parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Pron = api;
})(typeof self !== 'undefined' ? self : this);
