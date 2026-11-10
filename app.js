'use strict';

/* ==========================================================================
   Songes — jeu d'ambiance de mots en « passe-le-téléphone »
   ========================================================================== */

const API_URL = 'https://trouve-mot.fr/api/random/';
const SAVE_KEY = 'songes.save.v1';
const NAMES_KEY = 'songes.names.v1';
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;

const ROLES = {
  luciole: {
    name: 'Luciole', plural: 'Lucioles', icon: '✨', cls: 'gold',
    goal: 'Tu gagnes 1 point par mot que le Rêveur devine. Donne des indices limpides !',
  },
  cauchemar: {
    name: 'Cauchemar', plural: 'Cauchemars', icon: '🌘', cls: 'violet',
    goal: 'Tu gagnes 1 point par mot raté ou passé. Égare le Rêveur… sans te faire démasquer.',
  },
  hibou: {
    name: 'Hibou', plural: 'Hiboux', icon: '🦉', cls: 'silver',
    goal: 'Tu gagnes si les mots devinés et ratés restent équilibrés. Aide ou brouille selon le score.',
  },
};

// Répartition des rôles selon le nombre de joueurs : [Lucioles, Cauchemars, Hiboux]
const DISTRIB = {
  4: [1, 1, 2], 5: [2, 1, 2], 6: [3, 2, 1], 7: [3, 2, 2],
  8: [4, 3, 1], 9: [4, 3, 2], 10: [5, 4, 1],
};

/* ---------- Utilitaires ---------- */
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- Son, vibration, écran allumé ---------- */
let actx = null;
function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch { actx = null; }
}
function beep(freq, start, dur) {
  const t0 = actx.currentTime + start;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(actx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}
function alarm() {
  try { if (actx) { beep(880, 0, 0.25); beep(660, 0.3, 0.25); beep(988, 0.6, 0.5); } } catch { /* ignore */ }
  try { navigator.vibrate && navigator.vibrate([250, 120, 250, 120, 400]); } catch { /* ignore */ }
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
function releaseAwake() {
  try { wakeLock && wakeLock.release(); } catch { /* ignore */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.game) keepAwake();
});

/* ---------- État ---------- */
let S = { screen: 'home', returnTo: null, modal: null, setup: null, game: null, loadingMsg: '' };
let lastActionAt = 0;
const actionLocked = () => {
  const now = Date.now();
  if (now - lastActionAt < 450) return true; // évite les doubles taps qui valideraient le mot suivant
  lastActionAt = now;
  return false;
};

function save() {
  if (!S.game) return;
  const screen = S.screen === 'rules' ? (S.returnTo || 'home') : S.screen;
  store.set(SAVE_KEY, { screen, game: S.game });
}
function loadSave() {
  const d = store.get(SAVE_KEY);
  return d && d.game && Array.isArray(d.game.players) ? d : null;
}

function go(screen) {
  S.screen = screen;
  S.modal = null;
  save();
  render();
  window.scrollTo(0, 0);
}

/* ---------- Mots (API trouve-mot.fr + secours) ---------- */
let refilling = null;
function prettyCat(c) {
  if (!c) return '';
  const s = String(c).toLowerCase().replace(/\s+/g, ' ').trim();
  return cap(s);
}
function refill(count = 40) {
  if (refilling) return refilling;
  refilling = (async () => {
    const g = S.game;
    if (!g) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(API_URL + count, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const seen = new Set([...g.used, ...g.queue.map((w) => w.name)]);
      for (const it of Array.isArray(data) ? data : []) {
        const name = String(it?.name ?? '').trim().toLowerCase();
        if (name.length < 3 || /\d/.test(name) || seen.has(name)) continue;
        seen.add(name);
        g.queue.push({ name, cat: prettyCat(it.categorie) });
      }
      g.online = true;
    } catch {
      g.online = false;
    } finally {
      clearTimeout(timer);
      refilling = null;
      save();
    }
  })();
  return refilling;
}
function drawWord() {
  const g = S.game;
  let w = g.queue.shift();
  if (!w) {
    const used = new Set(g.used);
    const pool = window.FALLBACK_WORDS.filter((x) => !used.has(x));
    const src = pool.length ? pool : window.FALLBACK_WORDS;
    w = { name: src[Math.floor(Math.random() * src.length)], cat: '' };
  }
  g.used.push(w.name);
  if (g.queue.length < 12) refill();
  return w;
}
function unuse(word) {
  const g = S.game;
  const i = g.used.lastIndexOf(word.name);
  if (i >= 0) g.used.splice(i, 1);
  g.queue.unshift(word);
}

/* ---------- Logique de partie ---------- */
function newSetup() {
  const names = store.get(NAMES_KEY);
  const list = Array.isArray(names) && names.length >= MIN_PLAYERS ? names.slice(0, MAX_PLAYERS) : ['', '', '', ''];
  return { names: list, first: 0, duration: 120, allowReplace: true };
}

async function startGame() {
  const st = S.setup;
  const used = new Set();
  const names = st.names.map((n, i) => {
    let base = n.trim() || `Joueur ${i + 1}`;
    let name = base, k = 2;
    while (used.has(name.toLowerCase())) name = `${base} ${k++}`;
    used.add(name.toLowerCase());
    return name;
  });
  store.set(NAMES_KEY, st.names.map((n) => n.trim()));
  S.game = {
    players: names.map((name) => ({ name, score: 0, penalties: 0 })),
    first: Math.min(st.first, names.length - 1),
    round: 0,
    duration: st.duration,
    allowReplace: st.allowReplace,
    dreamer: 0, roles: {}, discarded: null,
    revealOrder: [], revealPos: 0, revealShown: false,
    queue: [], used: [], online: null,
    night: null, day: null, history: [],
  };
  unlockAudio();
  keepAwake();
  S.loadingMsg = 'Les rêves se préparent…';
  S.screen = 'loading';
  render();
  await refill(50);
  if (!S.game.online) toast('Mode hors ligne : mots de secours utilisés.', 3500);
  beginRound();
}

function beginRound() {
  const g = S.game;
  const N = g.players.length;
  g.dreamer = (g.first + g.round) % N;
  const [l, c, h] = DISTRIB[N];
  const deck = shuffle([
    ...Array(l).fill('luciole'), ...Array(c).fill('cauchemar'), ...Array(h).fill('hibou'),
  ]);
  g.roles = {};
  g.revealOrder = [];
  for (let k = 1; k < N; k++) {
    const p = (g.dreamer + k) % N;
    g.revealOrder.push(p);
    g.roles[p] = deck.pop();
  }
  g.discarded = deck.pop();
  g.revealPos = 0;
  g.revealShown = false;
  g.night = null;
  g.day = null;
  go('roundIntro');
}

function startNight() {
  const g = S.game;
  unlockAudio();
  keepAwake();
  g.night = {
    word: drawWord(), yellow: [], blue: [], pens: [], log: [],
    endsAt: Date.now() + g.duration * 1000, pausedLeft: null, timeUp: false,
  };
  go('night');
}

function nightRemaining(n) {
  if (n.pausedLeft != null) return n.pausedLeft;
  return Math.max(0, n.endsAt - Date.now());
}

function nightAdvance(entry) {
  const n = S.game.night;
  n.log.push(entry);
  n.word = drawWord();
  save();
  render();
}

function endNight(finalSide) {
  const g = S.game;
  const n = g.night;
  if (finalSide && n.word) n[finalSide].push(n.word);
  n.word = null;
  n.timeUp = true;
  g.day = { ticked: [], result: null };
  go('narration');
}

function computeRound() {
  const g = S.game;
  const Y = g.night.yellow.length;
  const B = g.night.blue.length;
  const remembered = Y > 0 && g.day.ticked.length === Y;
  const diff = Math.abs(Y - B);
  let hibouPts, hibouWhy;
  if (diff === 0) { hibouPts = Y + 2; hibouWhy = `Égalité parfaite : ${Y} + 2 de bonus`; }
  else if (diff === 1) { hibouPts = Math.max(Y, B); hibouWhy = `Écart de 1 : le plus grand nombre`; }
  else { hibouPts = Math.min(Y, B); hibouWhy = `Écart de ${diff} : le plus petit nombre`; }
  const gains = {};
  g.players.forEach((p, i) => {
    if (i === g.dreamer) gains[i] = Y + (remembered ? 2 : 0);
    else if (g.roles[i] === 'luciole') gains[i] = Y;
    else if (g.roles[i] === 'cauchemar') gains[i] = B;
    else gains[i] = hibouPts;
  });
  return { Y, B, remembered, hibouPts, hibouWhy, gains };
}

function finishDay() {
  const g = S.game;
  if (!g.day.result) {
    const r = computeRound();
    g.day.result = r;
    g.players.forEach((p, i) => { p.score += r.gains[i]; });
    g.history.push({
      round: g.round, dreamer: g.dreamer, roles: { ...g.roles },
      yellow: g.night.yellow.map((w) => w.name), blue: g.night.blue.map((w) => w.name),
      pens: g.night.pens.map((p) => ({ word: p.word.name, player: p.player })), gains: r.gains,
    });
  }
  go('reveal');
}

function totals() {
  return S.game.players.map((p, i) => ({ i, name: p.name, score: p.score, pen: p.penalties, total: p.score - p.penalties }));
}
function ranking() {
  return totals().sort((a, b) => b.total - a.total || a.pen - b.pen || a.name.localeCompare(b.name));
}

/* ---------- Rendu ---------- */
const SCREENS = {};
const DAY_SCREENS = new Set(['narration', 'reveal']);

function render() {
  document.body.classList.toggle('day', DAY_SCREENS.has(S.screen));
  const fn = SCREENS[S.screen] || SCREENS.home;
  $app.innerHTML = fn() + renderModal();
  if (S.screen === 'night') tick();
}

function topBar(title, { back = null, menu = true } = {}) {
  return `<header class="bar">
    ${back ? `<button class="icon-btn" data-action="${back}" aria-label="Retour">←</button>` : ''}
    <h2>${title}</h2>
    ${menu && S.game ? '<button class="icon-btn" data-action="openMenu" aria-label="Menu">⋯</button>' : ''}
  </header>`;
}
const roundTag = () => `Manche ${S.game.round + 1}/${S.game.players.length}`;
const pname = (i) => esc(S.game.players[i].name);

SCREENS.home = () => {
  const saved = loadSave();
  return `<main class="screen center">
    <div class="logo">🌙</div>
    <h1>Songes</h1>
    <p class="tagline">Un rêveur, des indices… et quelques esprits malicieux.</p>
    <div class="home-actions">
      ${saved ? `<button class="btn primary big" data-action="resume">Reprendre la partie</button>
                 <button class="btn" data-action="newGame">Nouvelle partie</button>`
              : `<button class="btn primary big" data-action="newGame">Nouvelle partie</button>`}
      <button class="btn ghost" data-action="showRules">Règles du jeu</button>
    </div>
    <p class="small muted" style="margin-top:18px">4 à 10 joueurs · un seul téléphone · ~30 min</p>
  </main>`;
};

SCREENS.setup = () => {
  const st = S.setup;
  const n = st.names.length;
  const d = DISTRIB[n];
  return `<main class="screen">
    ${topBar('Nouvelle partie', { back: 'home', menu: false })}
    <p class="muted">Entrez les joueurs <b>dans le sens des aiguilles d'une montre</b> autour de la table.</p>
    <ol class="players">
      ${st.names.map((name, i) => `<li>
        <span class="num">${i + 1}</span>
        <input data-input="name" data-idx="${i}" value="${esc(name)}" placeholder="Joueur ${i + 1}" maxlength="16" autocomplete="off" enterkeyhint="next" aria-label="Nom du joueur ${i + 1}">
        <button class="icon-btn" data-action="removePlayer" data-idx="${i}" ${n <= MIN_PLAYERS ? 'disabled' : ''} aria-label="Retirer le joueur ${i + 1}">✕</button>
      </li>`).join('')}
    </ol>
    <button class="btn ghost" data-action="addPlayer" ${n >= MAX_PLAYERS ? 'disabled' : ''}>+ Ajouter un joueur</button>

    <div class="panel center-text">
      <p class="small muted" style="margin-bottom:8px">Rôles en jeu à ${n} joueurs (une carte est écartée chaque manche)</p>
      <div class="distrib">
        <span class="pill gold">✨ ${d[0]}</span><span class="pill violet">🌘 ${d[1]}</span><span class="pill silver">🦉 ${d[2]}</span>
      </div>
    </div>

    <label class="field">Premier Rêveur <span class="small muted" style="font-weight:400">(traditionnellement, le plus âgé)</span>
      <select data-input="first">
        ${st.names.map((name, i) => `<option value="${i}" ${i === st.first ? 'selected' : ''}>${esc(name.trim() || `Joueur ${i + 1}`)}</option>`).join('')}
      </select>
    </label>

    <div class="field">Durée de la Nuit
      <div class="seg" role="radiogroup">
        ${[90, 120, 180].map((s) => `<label><input type="radio" name="dur" data-input="duration" value="${s}" ${st.duration === s ? 'checked' : ''}><span>${fmt(s)}</span></label>`).join('')}
      </div>
    </div>

    <label class="check"><input type="checkbox" data-input="allowReplace" ${st.allowReplace ? 'checked' : ''}>
      <span>Autoriser le bouton <b>« Mot obscur »</b> pour remplacer un mot inconnu de tous (sans effet sur le score).</span></label>

    <div class="push-bottom">
      <button class="btn primary big" data-action="startGame">Commencer</button>
    </div>
  </main>`;
};

SCREENS.loading = () => `<main class="screen center">
  <div class="loader"></div>
  <p class="muted" style="margin-top:16px">${esc(S.loadingMsg)}</p>
</main>`;

SCREENS.roundIntro = () => {
  const g = S.game;
  const d = DISTRIB[g.players.length];
  return `<main class="screen">
    ${topBar(roundTag())}
    <div class="grow center-text" style="display:flex;flex-direction:column;justify-content:center;gap:14px">
      <div class="logo">🌙</div>
      <p class="muted">Cette nuit, le Rêveur est</p>
      <div class="handoff-name" style="margin:0">${pname(g.dreamer)}</div>
      <div class="panel">
        <p><b>${pname(g.dreamer)}</b>, ne regarde pas l'écran : les autres joueurs vont découvrir leur rôle secret, chacun son tour.</p>
      </div>
      <div class="distrib">
        <span class="pill gold">✨ ${plural(d[0], 'Luciole', 'Lucioles')}</span>
        <span class="pill violet">🌘 ${plural(d[1], 'Cauchemar', 'Cauchemars')}</span>
        <span class="pill silver">🦉 ${plural(d[2], 'Hibou', 'Hiboux')}</span>
      </div>
      <p class="small muted">Une de ces cartes est écartée au hasard, face cachée.</p>
    </div>
    <div class="push-bottom">
      <button class="btn primary big" data-action="startReveal">Distribuer les rôles</button>
    </div>
  </main>`;
};

SCREENS.roleHandoff = () => {
  const g = S.game;
  const p = g.revealOrder[g.revealPos];
  const step = `${g.revealPos + 1}/${g.revealOrder.length}`;
  if (!g.revealShown) {
    return `<main class="screen">
      ${topBar(`Rôles · ${step}`)}
      <div class="grow center-text" style="display:flex;flex-direction:column;justify-content:center">
        <p class="muted">Passe le téléphone à</p>
        <div class="handoff-name">${pname(p)}</div>
        <p class="small muted">Assure-toi que personne d'autre ne regarde.</p>
      </div>
      <div class="push-bottom">
        <button class="btn primary big" data-action="showRole">Je suis ${pname(p)} — voir mon rôle</button>
      </div>
    </main>`;
  }
  const r = ROLES[g.roles[p]];
  const last = g.revealPos === g.revealOrder.length - 1;
  return `<main class="screen">
    ${topBar(`Rôles · ${step}`)}
    <div class="grow center-text" style="display:flex;flex-direction:column;justify-content:center;gap:8px">
      <p class="muted">${pname(p)}, cette nuit tu es…</p>
      <div class="role-card ${r.cls}"><div class="emoji">${r.icon}</div><div class="rname">${r.name}</div></div>
      <p class="role-goal">${r.goal}</p>
    </div>
    <div class="push-bottom">
      <button class="btn big" data-action="hideRole">${last ? "J'ai compris — cacher" : "J'ai compris — cacher et passer"}</button>
    </div>
  </main>`;
};

SCREENS.nightReady = () => {
  const g = S.game;
  const starter = (g.dreamer + 1) % g.players.length;
  return `<main class="screen">
    ${topBar(roundTag())}
    <h2>Que la Nuit commence</h2>
    <div class="panel">
      <ol class="steps">
        <li><b>${pname(g.dreamer)}</b> met un masque ou ferme les yeux. Plus aucun coup d'œil jusqu'à la fin de son récit !</li>
        <li>Posez le téléphone au milieu des autres joueurs, hors de vue du Rêveur.</li>
        <li><b>${pname(starter)}</b> commence : chacun donne <b>un seul mot</b> d'indice, dans le sens horaire. On peut faire plusieurs tours.</li>
        <li>Le Rêveur propose <b>une seule réponse</b> par mot quand il le souhaite. Touchez discrètement <b>✓</b> ou <b>✗</b> — sans rien laisser paraître.</li>
      </ol>
    </div>
    <p class="small muted">Interdit : un mot de la même famille, un mot qui « sonne pareil », ou une traduction. Pénalité : −1 point en fin de partie. On peut dire « je passe » ; plus de 5 secondes d'hésitation et le tour est passé.</p>
    <div class="push-bottom">
      <button class="btn primary big" data-action="startNight">🌙 Lancer la Nuit · ${fmt(g.duration)}</button>
    </div>
  </main>`;
};

SCREENS.night = () => {
  const g = S.game;
  const n = g.night;
  const left = Math.ceil(nightRemaining(n) / 1000);
  const w = n.word;
  return `<main class="screen night">
    <div class="night-top">
      <div class="timer ${left <= 15 ? 'low' : ''}" id="timer">${fmt(left)}</div>
      <div class="counts"><span class="chip gold">✓ ${n.yellow.length}</span><span class="chip violet">✗ ${n.blue.length}</span></div>
      <button class="icon-btn" data-action="pause" aria-label="Pause">⏸</button>
      <button class="icon-btn" data-action="openMenu" aria-label="Menu">⋯</button>
    </div>
    <div class="word-card">
      <span class="who">Rêveur : ${pname(g.dreamer)}</span>
      ${w ? `<div class="word">${esc(cap(w.name))}</div>${w.cat ? `<span class="cat">${esc(w.cat)}</span>` : ''}` : ''}
    </div>
    <div class="actions">
      <button class="btn huge primary" data-action="mark" data-side="yellow">✓ Bonne réponse</button>
      <button class="btn huge violet" data-action="mark" data-side="blue">✗ Fausse réponse / passe</button>
    </div>
    <div class="actions-row">
      <button class="btn sm ghost" data-action="undo" ${n.log.length ? '' : 'disabled'}>↶ Annuler</button>
      <button class="btn sm ghost" data-action="openPenalty">⚠ Pénalité</button>
      ${g.allowReplace ? '<button class="btn sm ghost" data-action="replace">↻ Mot obscur</button>' : ''}
    </div>
    <p class="reminder">🤫 Le Rêveur ne doit jamais savoir si sa réponse était juste.</p>
  </main>`;
};

SCREENS.narration = () => {
  const g = S.game;
  const n = g.night;
  const Y = n.yellow.length;
  const t = g.day.ticked.length;
  return `<main class="screen">
    ${topBar(roundTag())}
    <div class="sun">☀️</div>
    <h2 class="center-text">Le Jour se lève</h2>
    <div class="panel">
      <p><b>${pname(g.dreamer)}</b>, <b>garde les yeux fermés</b> et raconte ton rêve : une histoire (aussi farfelue que tu veux) qui reprend tous les mots que tu penses avoir devinés.</p>
    </div>
    <div class="panel">
      <h3>Mots devinés ✓ <span class="small muted">— touchez-les quand ils sont cités</span></h3>
      ${Y ? `<div class="word-chips">${n.yellow.map((w, i) => `<button class="word-chip ${g.day.ticked.includes(i) ? 'on' : ''}" data-action="tick" data-idx="${i}">${esc(cap(w.name))}</button>`).join('')}</div>
             <p class="small muted" style="margin-top:10px">${t}/${Y} cités ${t === Y ? '— bonus de +2 pour le Rêveur ! 🎉' : '— tous les citer rapporte +2 au Rêveur.'}</p>`
          : '<p class="muted">Aucun mot deviné cette nuit… le Rêveur peut quand même raconter !</p>'}
    </div>
    ${n.blue.length ? `<div class="panel"><h3>Mots ratés ou passés ✗</h3>
      <div class="word-chips">${n.blue.map((w) => `<span class="word-chip static">${esc(cap(w.name))}</span>`).join('')}</div></div>` : ''}
    <div class="push-bottom">
      <button class="btn primary big" data-action="finishDay">Le Rêveur a fini — il ouvre les yeux</button>
    </div>
  </main>`;
};

SCREENS.reveal = () => {
  const g = S.game;
  const r = g.day.result;
  const n = g.night;
  const order = [g.dreamer, ...g.revealOrder];
  return `<main class="screen">
    ${topBar(roundTag())}
    <h2 class="center-text">Révélation des rôles</h2>
    <div class="distrib">
      <span class="chip gold">✓ ${r.Y} ${r.Y > 1 ? 'devinés' : 'deviné'}</span>
      <span class="chip violet">✗ ${r.B} ${r.B > 1 ? 'ratés' : 'raté'}</span>
    </div>
    <ul class="result-list">
      ${order.map((i) => {
        if (i === g.dreamer) {
          return `<li><span class="ricon">🌙</span><span class="rmain"><b>${pname(i)}</b><span>Rêveur · ${r.Y} mot${r.Y > 1 ? 's' : ''}${r.remembered ? ' + 2 (tout cité)' : ''}</span></span><span class="gain">+${r.gains[i]}</span></li>`;
        }
        const role = ROLES[g.roles[i]];
        const why = g.roles[i] === 'luciole' ? 'mots devinés' : g.roles[i] === 'cauchemar' ? 'mots ratés' : r.hibouWhy;
        return `<li><span class="ricon">${role.icon}</span><span class="rmain"><b>${pname(i)}</b><span>${role.name} · ${esc(why)}</span></span><span class="gain">+${r.gains[i]}</span></li>`;
      }).join('')}
    </ul>
    <p class="small muted center-text">Carte écartée : ${ROLES[g.discarded].icon} ${ROLES[g.discarded].name}</p>
    ${n.pens.length ? `<div class="panel"><h3>Pénalités (−1 en fin de partie)</h3>
      <div class="word-chips">${n.pens.map((p) => `<span class="word-chip pen">${pname(p.player)} · ${esc(cap(p.word.name))}</span>`).join('')}</div></div>` : ''}
    <div class="push-bottom">
      <button class="btn primary big" data-action="toScores">Voir les scores</button>
    </div>
  </main>`;
};

function scoresTable(highlightDreamer) {
  const g = S.game;
  return `<table class="scores">
    <thead><tr><th>#</th><th>Joueur</th><th>Points</th><th>Pén.</th><th>Total</th></tr></thead>
    <tbody>${ranking().map((p, k) => `<tr class="${highlightDreamer && p.i === g.dreamer ? 'dreamer' : ''}">
      <td>${k + 1}</td><td>${esc(p.name)}</td><td>${p.score}</td><td class="pen">${p.pen ? `−${p.pen}` : '0'}</td><td class="total">${p.total}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

SCREENS.scores = () => {
  const g = S.game;
  const last = g.round + 1 >= g.players.length;
  const next = (g.first + g.round + 1) % g.players.length;
  return `<main class="screen">
    ${topBar(`Scores · ${roundTag()}`)}
    <div class="panel">${scoresTable(true)}</div>
    <p class="small muted center-text">Les pénalités sont retirées du total en fin de partie.</p>
    <div class="push-bottom">
      ${last ? '<button class="btn primary big" data-action="toEnd">Résultats finaux 🏆</button>'
             : `<button class="btn primary big" data-action="nextRound">Manche suivante · ${pname(next)} rêve</button>`}
    </div>
  </main>`;
};

SCREENS.end = () => {
  const rk = ranking();
  const best = rk[0];
  const winners = rk.filter((p) => p.total === best.total && p.pen === best.pen);
  return `<main class="screen">
    ${topBar('Fin de la partie', { menu: false })}
    <div class="podium">
      <div class="crown">👑</div>
      <p class="muted">${winners.length > 1 ? 'Victoire partagée !' : 'Le meilleur rêveur est'}</p>
      <div class="winner">${winners.map((w) => esc(w.name)).join(' & ')}</div>
      <p class="muted">${best.total} point${Math.abs(best.total) > 1 ? 's' : ''}</p>
    </div>
    <div class="panel">${scoresTable(false)}</div>
    <p class="small muted center-text">Égalité ? Le joueur avec le moins de pénalités l'emporte ; sinon la victoire est partagée.</p>
    <div class="push-bottom">
      <button class="btn primary big" data-action="replay">Rejouer avec les mêmes joueurs</button>
      <button class="btn ghost" data-action="quitToHome">Accueil</button>
    </div>
  </main>`;
};

SCREENS.rules = () => `<main class="screen">
  ${topBar('Règles du jeu', { back: 'closeRules', menu: false })}
  <div class="rules">
    <div class="panel">
      <h3>Le principe</h3>
      <p>Une partie compte autant de manches que de joueurs. À chaque manche, un joueur devient <b>le Rêveur</b> : les yeux fermés, il doit deviner un maximum de mots grâce aux indices — <b>un mot chacun, à tour de rôle</b> — donnés par les autres. Mais chacun d'eux a reçu un <b>rôle secret</b>…</p>
    </div>
    <div class="panel">
      <h3>Les rôles</h3>
      <ul>
        <li><b>✨ Luciole</b> : +1 point par mot deviné.</li>
        <li><b>🌘 Cauchemar</b> : +1 point par mot raté ou passé.</li>
        <li><b>🦉 Hibou</b> : compare les deux piles. Égalité → nombre de mots devinés + 2. Écart de 1 → le plus grand des deux nombres. Écart de 2 ou plus → le plus petit.</li>
        <li><b>🌙 Rêveur</b> : +1 point par mot deviné, et +2 s'il cite <b>tous</b> les mots devinés dans son récit.</li>
      </ul>
      <table class="distrib-table" style="margin-top:12px">
        <thead><tr><th>Joueurs</th>${Object.keys(DISTRIB).map((k) => `<th>${k}</th>`).join('')}</tr></thead>
        <tbody>
          <tr><td>✨</td>${Object.values(DISTRIB).map((d) => `<td>${d[0]}</td>`).join('')}</tr>
          <tr><td>🌘</td>${Object.values(DISTRIB).map((d) => `<td>${d[1]}</td>`).join('')}</tr>
          <tr><td>🦉</td>${Object.values(DISTRIB).map((d) => `<td>${d[2]}</td>`).join('')}</tr>
        </tbody>
      </table>
      <p class="small muted" style="margin-top:8px">Chaque manche, les rôles sont redistribués ; une carte reste écartée face cachée.</p>
    </div>
    <div class="panel">
      <h3>La Nuit (2 minutes)</h3>
      <p>Le Rêveur ferme les yeux. Le téléphone affiche un mot aux autres joueurs. En commençant par le joueur à gauche du Rêveur puis dans le sens horaire, chacun donne <b>un seul mot</b> d'indice. Le Rêveur peut à tout moment proposer <b>une seule réponse</b> : touchez ✓ si elle est juste, ✗ si elle est fausse ou si le Rêveur passe. Un nouveau mot apparaît.</p>
      <p><b>Le Rêveur ne doit jamais savoir si sa réponse était juste.</b> Restez impassibles !</p>
      <p>Interdit : un mot de la même famille, un mot qui sonne pareil, une traduction. Le fautif reçoit une <b>pénalité</b> (−1 en fin de partie) et le mot change — prévenez le Rêveur. Un joueur peut dire « je passe » ; s'il hésite plus de 5 secondes, son tour est passé.</p>
      <p>Quand le temps est écoulé, le Rêveur peut encore donner une dernière réponse (facultatif).</p>
    </div>
    <div class="panel">
      <h3>Le Jour</h3>
      <p>Toujours les yeux fermés, le Rêveur raconte son rêve en essayant de citer tous les mots qu'il pense avoir trouvés. Puis il ouvre les yeux, les rôles sont révélés et chacun marque ses points.</p>
    </div>
    <div class="panel">
      <h3>Fin de partie</h3>
      <p>Quand tout le monde a été Rêveur une fois, on retire 1 point par pénalité. Le plus haut total gagne ; en cas d'égalité, le joueur avec le moins de pénalités l'emporte, sinon la victoire est partagée.</p>
    </div>
    <p class="small muted center-text">Mots aléatoires fournis par l'API gratuite <a href="https://trouve-mot.fr" target="_blank" rel="noopener" style="color:inherit">trouve-mot.fr</a>.</p>
  </div>
</main>`;

function renderModal() {
  if (!S.modal) return '';
  const g = S.game;
  if (S.modal === 'penalty') {
    const others = g.players.map((p, i) => i).filter((i) => i !== g.dreamer);
    return `<div class="overlay" data-action="closeModal"><div class="sheet" data-stop>
      <h3>⚠ Pénalité</h3>
      <p class="muted">Qui a dit un mot interdit ? Le mot actuel lui est attribué (−1 en fin de partie) et un nouveau mot apparaît.</p>
      ${others.map((i) => `<button class="btn" data-action="penalty" data-idx="${i}">${pname(i)}</button>`).join('')}
      <button class="btn ghost" data-action="closeModal">Annuler</button>
    </div></div>`;
  }
  if (S.modal === 'menu') {
    return `<div class="overlay" data-action="closeModal"><div class="sheet" data-stop>
      <h3>Partie en cours · ${roundTag()}</h3>
      <div class="mini-scores">${ranking().map((p) => `<div><span>${esc(p.name)}</span><span>${p.score}${p.pen ? ` <span style="color:var(--danger)">−${p.pen}</span>` : ''}</span></div>`).join('')}</div>
      <p class="small muted"><span class="status-dot ${g.online === false ? 'off' : ''}"></span>${g.online === false ? 'Hors ligne : mots de secours' : 'Mots : trouve-mot.fr'}</p>
      <button class="btn" data-action="showRules">Règles du jeu</button>
      <button class="btn ghost" data-action="confirmQuit" style="color:var(--danger)">Abandonner la partie</button>
      <button class="btn primary" data-action="closeModal">Fermer</button>
    </div></div>`;
  }
  if (S.modal === 'confirmQuit') {
    return `<div class="overlay middle" data-action="closeModal"><div class="sheet" data-stop>
      <h3>Abandonner la partie ?</h3>
      <p class="muted">Les scores seront perdus.</p>
      <div class="row">
        <button class="btn ghost" data-action="closeModal">Non</button>
        <button class="btn violet" data-action="quitToHome">Oui, abandonner</button>
      </div>
    </div></div>`;
  }
  if (S.modal === 'pause') {
    return `<div class="overlay middle"><div class="sheet center-text" data-stop>
      <h3>⏸ Pause</h3>
      <p class="muted">Temps restant : ${fmt(Math.ceil(nightRemaining(g.night) / 1000))}</p>
      <button class="btn primary big" data-action="resumeNight">Reprendre la Nuit</button>
    </div></div>`;
  }
  if (S.modal === 'timeUp') {
    const w = g.night.word;
    return `<div class="overlay middle"><div class="sheet" data-stop>
      <h3 class="center-text">⏰ Temps écoulé !</h3>
      <p class="muted center-text">${pname(g.dreamer)} peut donner une dernière réponse (facultatif) pour :</p>
      ${w ? `<div class="final-word">${esc(cap(w.name))}</div>` : ''}
      <button class="btn primary big" data-action="final" data-side="yellow">✓ Bonne réponse</button>
      <button class="btn violet big" data-action="final" data-side="blue">✗ Fausse réponse</button>
      <button class="btn ghost" data-action="final" data-side="">Pas de réponse</button>
    </div></div>`;
  }
  return '';
}

/* ---------- Minuteur ---------- */
function tick() {
  if (S.screen !== 'night' || !S.game?.night) return;
  const n = S.game.night;
  if (n.pausedLeft != null) return;
  const left = n.endsAt - Date.now();
  if (left <= 0) {
    if (!n.timeUp) {
      n.timeUp = true;
      alarm();
      save();
    }
    if (S.modal !== 'timeUp') { S.modal = 'timeUp'; render(); }
    return;
  }
  const el = document.getElementById('timer');
  if (el) {
    const sec = Math.ceil(left / 1000);
    el.textContent = fmt(sec);
    el.classList.toggle('low', sec <= 15);
  }
}
setInterval(tick, 250);

/* ---------- Actions ---------- */
const A = {
  home: () => { S.setup = null; go('home'); },
  newGame: () => { S.setup = newSetup(); S.game = null; go('setup'); },
  resume: () => {
    const d = loadSave();
    if (!d) return go('home');
    S.game = d.game;
    const n = S.game.night;
    if (d.screen === 'night' && n && !n.timeUp && n.pausedLeft == null) {
      n.pausedLeft = Math.max(0, n.endsAt - Date.now());
      if (n.pausedLeft === 0) n.pausedLeft = null;
    }
    unlockAudio();
    keepAwake();
    S.screen = d.screen;
    S.modal = d.screen === 'night' && n?.pausedLeft != null ? 'pause' : null;
    render();
  },
  showRules: () => { S.returnTo = S.screen; S.modal = null; S.screen = 'rules'; render(); window.scrollTo(0, 0); },
  closeRules: () => { const back = S.returnTo || 'home'; S.returnTo = null; go(back); },

  addPlayer: () => { if (S.setup.names.length < MAX_PLAYERS) { S.setup.names.push(''); render(); focusLast(); } },
  removePlayer: (el) => {
    const i = +el.dataset.idx;
    if (S.setup.names.length <= MIN_PLAYERS) return;
    S.setup.names.splice(i, 1);
    if (S.setup.first >= S.setup.names.length || S.setup.first === i) S.setup.first = 0;
    else if (S.setup.first > i) S.setup.first--;
    render();
  },
  startGame: () => startGame(),

  startReveal: () => { S.game.revealPos = 0; S.game.revealShown = false; go('roleHandoff'); },
  showRole: () => { S.game.revealShown = true; save(); render(); },
  hideRole: () => {
    const g = S.game;
    g.revealShown = false;
    g.revealPos++;
    if (g.revealPos >= g.revealOrder.length) go('nightReady');
    else go('roleHandoff');
  },

  startNight: () => startNight(),
  mark: (el) => {
    if (actionLocked()) return;
    const n = S.game.night;
    if (n.timeUp || !n.word) return;
    const side = el.dataset.side;
    n[side].push(n.word);
    nightAdvance({ type: side, word: n.word });
  },
  replace: () => {
    if (actionLocked()) return;
    const n = S.game.night;
    if (n.timeUp || !n.word) return;
    nightAdvance({ type: 'replace', word: n.word });
    toast('Nouveau mot — prévenez le Rêveur.');
  },
  openPenalty: () => { S.modal = 'penalty'; render(); },
  penalty: (el) => {
    const g = S.game;
    const n = g.night;
    const p = +el.dataset.idx;
    S.modal = null;
    if (n.timeUp || !n.word) return render();
    n.pens.push({ word: n.word, player: p });
    g.players[p].penalties++;
    lastActionAt = Date.now();
    nightAdvance({ type: 'penalty', word: n.word, player: p });
    toast(`Pénalité pour ${g.players[p].name}. Dites au Rêveur que le mot a changé !`, 3500);
  },
  undo: () => {
    const g = S.game;
    const n = g.night;
    const last = n.log.pop();
    if (!last) return;
    if (n.word) unuse(n.word);
    if (last.type === 'yellow' || last.type === 'blue') n[last.type].pop();
    if (last.type === 'penalty') { n.pens.pop(); g.players[last.player].penalties--; }
    n.word = last.word;
    save();
    render();
    toast(`Retour au mot « ${cap(last.word.name)} »`);
  },
  pause: () => {
    const n = S.game.night;
    if (n.timeUp || n.pausedLeft != null) return;
    n.pausedLeft = Math.max(0, n.endsAt - Date.now());
    S.modal = 'pause';
    save();
    render();
  },
  resumeNight: () => {
    const n = S.game.night;
    unlockAudio();
    if (n.pausedLeft != null) { n.endsAt = Date.now() + n.pausedLeft; n.pausedLeft = null; }
    S.modal = null;
    save();
    render();
  },
  final: (el) => endNight(el.dataset.side || null),

  tick: (el) => {
    const i = +el.dataset.idx;
    const t = S.game.day.ticked;
    const k = t.indexOf(i);
    if (k >= 0) t.splice(k, 1); else t.push(i);
    save();
    render();
  },
  finishDay: () => finishDay(),
  toScores: () => go('scores'),
  nextRound: () => { S.game.round++; beginRound(); },
  toEnd: () => { store.del(SAVE_KEY); releaseAwake(); S.screen = 'end'; S.modal = null; render(); window.scrollTo(0, 0); },
  replay: () => {
    const g = S.game;
    S.setup = { names: g.players.map((p) => p.name), first: g.first, duration: g.duration, allowReplace: g.allowReplace };
    S.game = null;
    go('setup');
  },

  openMenu: () => { S.modal = 'menu'; render(); },
  closeModal: () => { S.modal = null; render(); },
  confirmQuit: () => { S.modal = 'confirmQuit'; render(); },
  quitToHome: () => { store.del(SAVE_KEY); releaseAwake(); S.game = null; S.setup = null; go('home'); },
};

function focusLast() {
  const inputs = $app.querySelectorAll('input[data-input="name"]');
  inputs[inputs.length - 1]?.focus();
}

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  // Un clic dans une feuille modale ne doit pas fermer l'overlay
  if (el.classList.contains('overlay') && e.target.closest('[data-stop]')) return;
  const fn = A[el.dataset.action];
  if (fn) fn(el, e);
});

$app.addEventListener('input', (e) => {
  const el = e.target;
  const key = el.dataset?.input;
  if (!key || !S.setup) return;
  if (key === 'name') {
    const i = +el.dataset.idx;
    S.setup.names[i] = el.value;
    const opt = $app.querySelector(`select[data-input="first"] option[value="${i}"]`);
    if (opt) opt.textContent = el.value.trim() || `Joueur ${i + 1}`;
  }
});

$app.addEventListener('change', (e) => {
  const el = e.target;
  const key = el.dataset?.input;
  if (!key || !S.setup) return;
  if (key === 'first') S.setup.first = +el.value;
  if (key === 'duration') S.setup.duration = +el.value;
  if (key === 'allowReplace') S.setup.allowReplace = el.checked;
});

$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.dataset?.input !== 'name') return;
  e.preventDefault();
  const inputs = [...$app.querySelectorAll('input[data-input="name"]')];
  const k = inputs.indexOf(e.target);
  if (k < inputs.length - 1) inputs[k + 1].focus();
  else e.target.blur();
});

render();
