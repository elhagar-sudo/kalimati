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
      // UK-only vowels
      case 'OH': return 'ɒ'; case 'OWX': return 'əʊ'; case 'ERX': return s === 0 ? 'ə' : 'ɜː';
      case 'IA': return 'ɪə'; case 'EA': return 'eə'; case 'UA': return 'ʊə'; case 'AYA': return 'aɪə'; case 'AWA': return 'aʊə';
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
      case 'OH': return 'o'; case 'OWX': return 'oh'; case 'ERX': return x.s === 0 ? 'uh' : 'ur';
      case 'IA': return 'eeuh'; case 'EA': return 'ehuh'; case 'UA': return 'oouh'; case 'AYA': return noOn ? 'eyeuh' : 'yuh'; case 'AWA': return 'owuh';
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
    if (x.v === 'OH') return noOn ? 'أُ' : open ? 'و' : DAMMA;
    if (x.v === 'ERX') return (noOn ? 'أ' : '') + (x.s === 0 ? FATHA : KASRA);
    const longMap = { AA: 'ا', AO: 'و', AW: 'او', AY: 'اي', EY: FATHA + 'ي', IY: 'ي', OW: 'و', OY: 'وي', UW: 'و', OWX: 'و', IA: KASRA + 'يَ', EA: FATHA + 'يَ', UA: DAMMA + 'وَ', AYA: 'ايَ', AWA: 'اوَ' };
    const startMap = { AA: 'آ', AO: 'أو', AW: 'آو', AY: 'آي', EY: 'إي', IY: 'إي', OW: 'أو', OY: 'أوي', UW: 'أو', OWX: 'أو', IA: 'إيَ', EA: 'إيَ', UA: 'أوَ', AYA: 'آيَ', AWA: 'آوَ' };
    if (x.v === 'ER') return (noOn ? 'أ' : '') + (x.s === 0 ? FATHA : KASRA) + 'ر';
    return noOn ? startMap[x.v] : longMap[x.v];
  }
  function sylAR(x, first, prev) {
    // vowel-initial syllable after a closed syllable: join to the previous one, no hamza
    if (!first && prev && prev.co.length && x.on.length === 0 && x.v) {
      const short = { AH: FATHA, AE: FATHA, EH: KASRA, IH: KASRA, UH: DAMMA, ER: (x.s === 0 ? FATHA : KASRA) + 'ر',
        AA: 'ا', AO: 'و', AW: 'او', AY: 'اي', EY: FATHA + 'ي', IY: 'ي', OW: 'و', OY: 'وي', UW: 'و',
        OH: DAMMA, ERX: x.s === 0 ? FATHA : KASRA, OWX: 'و', IA: KASRA + 'يَ', EA: FATHA + 'يَ', UA: DAMMA + 'وَ', AYA: 'ايَ', AWA: 'اوَ' };
      let v = short[x.v];
      if (x.co.length === 0 && { AH: 1, AE: 1 }[x.v]) v = 'ا';
      if (x.co.length === 0 && { EH: 1, IH: 1 }[x.v]) v = 'ي';
      if (x.co.length === 0 && x.v === 'UH') v = 'و';
      return { t: v + x.co.map(c => AR_C[c]).join(''), join: true };
    }
    return { t: x.on.map(c => AR_C[c]).join('') + (x.v ? arV(x, first) : '') + x.co.map(c => AR_C[c]).join(''), join: false };
  }

  // ---------- British (UK) version, worked out from the US phones with standard rules ----------
  const BATH = new Set(['ask','asked','asking','after','afternoon','afterwards','last','fast','faster','past','class','classes','pass','passed','passenger','path','bath','grass','glass','castle','master','task','plaster','vast','cast','mask','rather','laugh','half','calf','staff','graph','draft','craft','aircraft','branch','chance','dance','answer','example','sample','plant','grant','demand','command','advance','advantage','disaster','nasty','fasten','ghastly','basket','mast','raft','shaft','can\'t','aunt','banana','tomato','drama','pasta','vase']);
  // Words where the US dictionary sound does not show the UK vowel; kept as short lists.
  const LONG_AW = new Set(['water','waters','watery','underwater','wastewater','freshwater','seawater','groundwater','rainwater']);
  const SHORT_O = new Set(['foreign','foreigner','foreigners','forest','forests','historic','historical','historically','horrible','horror','majority','minority','minorities','authority','authorities','priority','priorities','moral','morally','morals','orange','oranges','origin','origins','correspond','corresponding','correspondent','correspondence','warrior','warriors','quarrel','quarry','corridor','corridors','coral','florist','torrent','florida','oregon','laurel','seniority','superiority','inferiority','categorical','rhetorical','metaphorical','coroner','porridge','lorry','laboratory','wallet','wallets','sausage','austria','australia','australian','laurel']);
  const FUNC_O = new Set(['what','whatever','was','wasn\'t','of','from','because','somewhat']);
  const AIR_E = new Set(['parent','parents','parenting','grandparent','grandparents']);
  // Well-known words that are said differently in the UK (written with the same sound codes).
  const UK_WORD = { schedule: 'SH EH1 D Y UW0 L', scheduled: 'SH EH1 D Y UW0 L D', vitamin: 'V IH1 T AH0 M IH0 N', vitamins: 'V IH1 T AH0 M IH0 N Z', privacy: 'P R IH1 V AH0 S IY0', leisure: 'L EH1 ZH ER0',
    either: 'AY1 DH ER0', neither: 'N AY1 DH ER0', mobile: 'M OW1 B AY2 L', missile: 'M IH1 S AY2 L', fertile: 'F ER1 T AY2 L', hostile: 'HH AA1 S T AY2 L', fragile: 'F R AE1 JH AY2 L',
    process: 'P R OW1 S EH0 S', progress: 'P R OW1 G R EH0 S', herb: 'HH ER1 B', herbs: 'HH ER1 B Z', clerk: 'K L AA1 R K', garage: 'G AE1 R AA0 ZH', advertisement: 'AH0 D V ER1 T IH0 S M AH0 N T',
    laboratory: 'L AH0 B AO1 R AH0 T R IY0', lieutenant: 'L EH0 F T EH1 N AH0 N T', z: 'Z EH1 D', ate: 'EH1 T', been: 'B IY1 N', shone: 'SH AA1 N' };
  function ukify(syl, spell) {
    const w = (spell || '').toLowerCase();
    const hasO = /o/.test(w) || /(^|[^a-z])(w|qu|wh)a/.test(w) || /^(wa|qua|wha)|[^s]wa/.test(w);
    const auSpell = /(au|aw|al(?=[lktsmwrd]|$)|ough|or|oar|oad|our|oor|ore)/.test(w) || LONG_AW.has(w);
    const out = syl.map(x => ({ ...x, on: [...x.on], co: [...x.co] }));
    if (FUNC_O.has(w)) { const f = out.find(x => ['AH', 'AA', 'AO'].includes(x.v) && (x.s >= 1 || out.length === 1)); if (f) f.v = 'OH'; }
    out.forEach((x, i) => {
      if (!x.v) return;
      const next = out[i + 1];
      const vowelNext = next && next.on.length === 0; // UK keeps r before a vowel (very, operator)
      // r between this vowel and the next one (hairy, necessary, category)
      const rCo = next && x.co.length === 1 && x.co[0] === 'R' && vowelNext;
      const rOn = next && !x.co.length && next.on.length === 1 && next.on[0] === 'R';
      if (rCo || rOn) {
        // -ary / -ory / -ery endings are weak in UK English: necessary, category
        if (i === out.length - 2 && out.length >= 3 && x.s !== 1 && (x.v === 'EH' || x.v === 'AO') && next.v === 'IY' && !next.co.length && /(ary|ory|ery)$/.test(w)) {
          x.v = 'ERX'; x.s = 0; if (rCo) { x.co = []; next.on = ['R']; } return;
        }
        if (x.v === 'EH' && x.s === 1) {
          if (/(air|aer|ary|ar(ia|io|iu|ea)|ar(ing|ed|er|es)$)/.test(w) || AIR_E.has(w)) { x.v = 'EA'; if (rCo) { x.co = []; next.on = ['R']; } return; }
          if (/arr|ar[aioe][b-df-hj-np-tv-z]/.test(w)) { x.v = 'AE'; return; }
        }
      }
      const ri = x.co.indexOf('R');
      const silentR = ri >= 0 && !(ri === x.co.length - 1 && vowelNext);
      if (x.v === 'ER') { if (!(vowelNext && !x.co.length)) x.v = 'ERX'; }
      else if (silentR) {
        x.co.splice(ri, 1);
        x.v = ({ AA: 'AA', AO: 'AO', IH: 'IA', IY: 'IA', EH: 'EA', EY: 'EA', AE: 'EA', UH: 'UA', UW: 'UA', AY: 'AYA', AW: 'AWA', AH: 'ERX', OW: 'AO' })[x.v] || x.v;
      } else if (x.v === 'OW') x.v = 'OWX';
      else if (x.v === 'AA') x.v = hasO ? 'OH' : 'AA';
      else if (x.v === 'AO') x.v = SHORT_O.has(w) ? 'OH' : auSpell ? 'AO' : 'OH';
      else if ((x.v === 'AE' || x.v === 'EY') && x.s === 1 && BATH.has(w)) x.v = 'AA';
      if (x.v === 'UW' && x.s >= 1 && x.on.length && ['T', 'D', 'N'].includes(x.on[x.on.length - 1]) && !x.on.includes('R') && /(t|d|n)(u|ew|eu)/.test(w)) x.on.push('Y');
    });
    return out;
  }

  /* Returns { words: [ { syl:[{rs, ar, stress}], ipa } ] } for an arpabet string.
     Multiple words are separated by '|'. */
  function build(arpAll, opts = {}) {
    if (!arpAll) return null;
    const spells = String(opts.spell || '').split(/[\s-]+/);
    const words = arpAll.split('|').map((a, wi) => {
      const sp = (spells[wi] || spells[0] || '').toLowerCase();
      let syl = syllabify(parse(opts.uk && UK_WORD[sp] ? UK_WORD[sp] : a));
      if (opts.uk) syl = ukify(syl, sp);
      const multi = syl.length > 1;
      return {
        ipa: wordIPA(syl),
        syl: syl.map((x, i) => {
          const a = sylAR(x, i === 0, syl[i - 1]);
          let ar = a.t;
          // UK: a final open "uh" sound is shown with ه, e.g. water -> وو-تَه
          if (opts.uk && i === syl.length - 1 && !x.co.length && /[\u064E]$/.test(ar)) ar += 'ه';
          return { rs: sylRS(x), ar, join: a.join, stress: multi ? x.s : 1 };
        })
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
