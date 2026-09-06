// Rat des Tombolas — logique de la page (état local, rendu, notifications). Voir core.js pour le chat Twitch et la détection.
import { createWatcher } from './core.js';
import { CHANNELS } from './channels.js';

/* ═══════════ utilitaires ═══════════ */
const $ = (id) => document.getElementById(id);
const ROLE = { broadcaster: 'le streamer', moderator: 'un modérateur', bot: 'le bot du chat' };
const twitchUrl = (login) => 'https://twitch.tv/' + login;
const donUrl = (login) => 'https://zevent.fr/don/' + login;
const hhmm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hue = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
function dur(isoStart, isoEnd) {
  const m = Math.max(0, Math.round(((isoEnd ? new Date(isoEnd) : Date.now()) - new Date(isoStart)) / 60000));
  if (m < 1) return 'à l’instant'; if (m < 60) return m + ' min'; return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
}
const who = (a) => (a.role ? 'annoncée par ' + ROLE[a.role] : 'annonce détectée') + (a.via ? ' de ' + a.via : '');
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ═══════════ état local (persistant) ═══════════ */
// history : tombolas vues sur cet appareil (24 h). Une entrée « en cours » d'une session précédente est close au chargement : le watcher repart de zéro.
let history = store.get('history', []).filter(a => Date.now() - new Date(a.ts) < 24 * 3600_000).map(a => a.endedAt ? a : { ...a, endedAt: a.ts, stale: true });
const saveHistory = () => store.set('history', history.slice(-100));
const dismissed = new Set(store.get('dismissedCards', []));            // cartes masquées à la main (clé de tombola)
const customChannels = store.get('customChannels', []);               // [{login, name}] ajoutées par l'utilisateur
const hiddenChannels = new Set(store.get('hiddenChannels', []));       // chaînes de la liste par défaut retirées par l'utilisateur
let state = null;

/* ═══════════ mesure d'usage (GoatCounter : sans cookie, sans donnée personnelle) ═══════════ */
const track = (name) => { try { window.goatcounter?.count?.({ path: 'event:' + name, title: name, event: true }); } catch {} };

/* ═══════════ message d'accueil (masquable pour de bon) ═══════════ */
const hero = $('hero');
hero.hidden = !!store.get('heroDismissed', false);
$('hero-close').onclick = () => { hero.hidden = true; store.set('heroDismissed', true); };

/* ═══════════ soutien ═══════════ */
const SUPPORT_URL = 'https://buymeacoffee.com/orsacce';   // lien Buy Me a Coffee du développeur ; vide = icône masquée
if (SUPPORT_URL) for (const id of ['coffee', 'coffee-footer']) { const c = $(id); c.href = SUPPORT_URL; c.hidden = false; }

/* ═══════════ thème ═══════════ */
const THEMES = [['auto', '◐', 'automatique'], ['dark', '☾', 'sombre'], ['light', '☀', 'clair']];
const sysLight = matchMedia('(prefers-color-scheme: light)');
function applyTheme(t) { document.documentElement.dataset.theme = t === 'auto' ? (sysLight.matches ? 'light' : 'dark') : t; const [, icon, label] = THEMES.find(x => x[0] === t); $('btn-theme').textContent = icon; $('btn-theme').title = 'Thème : ' + label; }
applyTheme(store.get('theme', 'auto'));
sysLight.addEventListener('change', () => { if (store.get('theme', 'auto') === 'auto') applyTheme('auto'); });
$('btn-theme').onclick = () => { const cur = store.get('theme', 'auto'); const next = THEMES[(THEMES.findIndex(x => x[0] === cur) + 1) % THEMES.length][0]; store.set('theme', next); applyTheme(next); };

/* ═══════════ notifications système ═══════════
   Desktop : new Notification(). Android : via le service worker (registration.showNotification), seule voie qui marche.
   L'autorisation est propre à l'origine (domaine + port). */
const hasNotif = 'Notification' in window;
const UA = navigator.userAgent, isAndroid = /Android/i.test(UA), isIOS = /iPhone|iPad|iPod/i.test(UA), isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const HINTS = {
  default: isAndroid ? 'Sur Android : Paramètres du téléphone → Notifications → ton navigateur (Chrome…) → Autoriser. Puis reviens ici et touche à nouveau « Activer ».' : 'Autorise les notifications dans la fenêtre qui s’ouvre.',
  denied: isAndroid ? 'Sur Android : Paramètres du téléphone → Notifications → ton navigateur (Chrome…) → Autoriser. Puis, dans le navigateur, menu ⚙️ Paramètres → Paramètres du site → Notifications → Autoriser, et recharge.' : 'Bloquées pour ce site : clique l’icône à gauche de l’adresse → Notifications → Autoriser, puis recharge.',
  unsupported: isIOS && !isStandalone ? 'Sur iPhone : Partager → « Sur l’écran d’accueil », puis ouvre la page depuis l’icône. Les notifications marchent seulement dans cette version.' : 'Ton navigateur ne gère pas les notifications.',
};
let swReg = null;
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('./sw.js').then(r => swReg = r).catch(() => {});
function notifStatus() { return !hasNotif ? 'unsupported' : Notification.permission; }   // 'granted' | 'denied' | 'default' | 'unsupported'
function refreshNotif() {
  const st = notifStatus(), pill = $('notif-pill'), dot = $('notif-dot'), txt = $('notif-text'), hint = $('notif-hint'), btn = $('btn-notif');
  const map = { granted: ['good', 'ok', 'Notifications activées'], default: ['bad', 'warn', 'Notifications à activer'], denied: ['bad', 'warn', 'Notifications bloquées'], unsupported: ['bad', '', 'Notifications non gérées'] };
  const [cls, dcls, label] = map[st]; pill.className = 'pill ' + cls; dot.className = 'dot ' + dcls; txt.textContent = label;
  hero.classList.toggle('granted', st === 'granted');
  btn.disabled = st === 'denied' || st === 'unsupported';
  hint.textContent = st === 'denied' ? HINTS.denied : st === 'unsupported' ? HINTS.unsupported : (asked && st === 'default') ? HINTS.default : '';
}
let asked = false;
async function askNotif() {
  if (!hasNotif) { toast('Notifications non disponibles', HINTS.unsupported); return; }
  asked = true;
  try { await Notification.requestPermission(); } catch {}
  refreshNotif();
  const st = notifStatus();
  if (st === 'granted') { track('notifications-activees'); $('hero').hidden = true; toast('Notifications activées', 'Tu seras prévenu dès qu’une tombola est annoncée. Garde cet onglet ouvert.'); }
  else toast(st === 'denied' ? 'Notifications bloquées' : 'Autorisation en attente', HINTS[st]);
}
$('btn-notif').onclick = askNotif; $('notif-pill').onclick = askNotif;
refreshNotif();
async function notify(a) {
  if (notifStatus() !== 'granted') return false;
  const title = `Tombola sur ${a.name}`, opts = { body: a.text || 'Annonce détectée dans le chat.', tag: a.id, data: { url: twitchUrl(a.login) } };
  try {
    if (swReg?.showNotification) { await swReg.showNotification(title, opts); return true; }
    const n = new Notification(title, opts); n.onclick = () => { window.open(twitchUrl(a.login)); n.close(); }; return true;
  } catch (e) { console.warn('notification impossible :', e); return false; }
}
function toast(a, text) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<span class="dot live"></span><div class="b"><b>${esc(text ? a : 'Tombola sur ' + a.name)}</b><span>${esc(text || a.text || who(a))}</span></div>`;
  if (!text) el.onclick = () => window.open(twitchUrl(a.login));
  $('toasts').appendChild(el); setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 8000);
}

/* ═══════════ rendu ═══════════ */
const cardKey = (c) => c.alertId || (c.chan + '@' + c.activeSince);
function renderConn() {
  const c = state?.conn; if (!c) return;
  const map = { connected: ['ok', c.joined < c.total ? `Connexion · ${c.joined}/${c.total} chaînes` : `Connecté · ${c.total} chaînes`], connecting: ['warn', 'Connexion à Twitch…'], reconnecting: ['warn', 'Reconnexion…'], idle: ['', '—'], stopped: ['', 'Arrêté'] };
  const [cls, label] = map[c.status] || ['', c.status]; $('conn-dot').className = 'dot ' + cls; $('conn-text').textContent = label;
}
function cardHTML(c) {
  return `<div class="top"><div class="avatar" style="background:hsl(${hue(c.login)} 55% 45%)">${esc(c.name[0])}</div>
      <div><div class="name">${esc(c.name)}</div><div class="since"><span class="dot live"></span>depuis <b data-since="${esc(c.activeSince)}">${dur(c.activeSince)}</b></div></div></div>
    <p class="quote"></p>
    <div class="foot"><span class="rate"></span><span class="spacer"></span>
      <a href="${twitchUrl(c.login)}" target="_blank" rel="noopener"><button>Voir le stream</button></a>
      <a href="${donUrl(c.login)}" target="_blank" rel="noopener"><button class="primary">Participer</button></a>
      <button class="ghost" data-end="${esc(c.alertId)}" title="Je vois sur le stream que c’est terminé">Terminée</button></div>`;
}
function updateCard(el, c) {
  const q = el.querySelector('.quote'), html = c.text ? `${esc(c.text)}<small>${esc(ROLE[c.role] || '')}</small>` : '';
  if (q.innerHTML !== html) q.innerHTML = html; el.querySelector('.rate').textContent = `${c.rate} msg/min`;
}
function renderLive() {
  const live = (state?.chans || []).filter(c => c.state === 'ACTIVE' && !dismissed.has(cardKey(c))).sort((a, b) => new Date(b.activeSince) - new Date(a.activeSince));
  $('live-count').textContent = live.length ? `${live.length} tombola${live.length > 1 ? 's' : ''}` : '';
  const box = $('live');
  if (!live.length) { if (!box.querySelector('.empty')) box.innerHTML = `<div class="empty"><span class="rat">🐀</span><p>Aucune tombola en cours. Le rat veille.</p></div>`; return; }
  let grid = box.querySelector('.cards'); if (!grid) { box.innerHTML = '<div class="cards"></div>'; grid = box.firstChild; }
  const keep = new Set();
  for (const c of live) {
    keep.add(c.chan); let el = grid.querySelector(`[data-chan="${CSS.escape(c.chan)}"]`);
    if (!el || el.dataset.alert !== cardKey(c)) { el?.remove(); el = document.createElement('article'); el.className = 'card'; el.dataset.chan = c.chan; el.dataset.alert = cardKey(c); el.innerHTML = cardHTML(c); }
    updateCard(el, c); grid.appendChild(el);
  }
  for (const el of [...grid.children]) if (!keep.has(el.dataset.chan)) el.remove();
}
function renderChans() {
  const list = [...(state?.chans || [])].sort((a, b) => (b.state === 'ACTIVE') - (a.state === 'ACTIVE') || a.quiet - b.quiet || b.rate - a.rate || a.name.localeCompare(b.name));
  $('chan-count').textContent = `${list.length} chaînes · ${list.filter(c => !c.quiet).length} avec du chat`;
  const grid = $('chans'), keep = new Set();
  for (const c of list) {
    keep.add(c.chan); let el = grid.querySelector(`[data-chan="${CSS.escape(c.chan)}"]`);
    if (!el) { el = document.createElement('div'); el.dataset.chan = c.chan; el.innerHTML = `<span class="dot"></span><a class="n" href="${twitchUrl(c.login)}" target="_blank" rel="noopener">${esc(c.name)}</a><span class="r"></span><button class="x" title="Ne plus surveiller cette chaîne" data-remove="${esc(c.login)}">✕</button>`; }
    el.className = 'chip ' + (c.state === 'ACTIVE' ? 'active' : c.quiet ? 'quiet' : '') + (c.custom ? ' custom' : ''); el.title = c.quiet ? 'Chat silencieux' : c.rate + ' messages par minute';
    el.firstChild.className = 'dot ' + (c.state === 'ACTIVE' ? 'live' : c.quiet ? '' : 'ok'); el.querySelector('.r').textContent = c.quiet ? '' : c.rate + '/min'; grid.appendChild(el);
  }
  for (const el of [...grid.children]) if (!keep.has(el.dataset.chan)) el.remove();
  const r = $('restore'); r.hidden = !hiddenChannels.size; r.textContent = `Rétablir les ${hiddenChannels.size} chaîne${hiddenChannels.size > 1 ? 's' : ''} retirée${hiddenChannels.size > 1 ? 's' : ''}`;
}
function renderHistory() {
  const items = [...history].reverse();
  $('hist-count').textContent = items.length ? `${items.length} tombola${items.length > 1 ? 's' : ''}` : 'rien pour l’instant';
  $('btn-clear').hidden = !items.length;
  $('history').innerHTML = items.map(a => `
    <div class="row" data-id="${esc(a.id)}"><span class="t">${hhmm(a.ts)}</span>
      <div class="m"><div class="l1">${a.test ? `<b>${esc(a.name)}</b>` : `<a href="${twitchUrl(a.login)}" target="_blank" rel="noopener">${esc(a.name)}</a>`}
        ${a.test ? '<span class="tag test">test</span>' : a.endedAt ? `<span class="tag">${a.stale ? 'session précédente' : dur(a.ts, a.endedAt) + (a.userEnded ? '' : ' env.')}</span>` : '<span class="tag live">en cours</span>'}
        <span class="tag">${esc(who(a))}</span></div>
      <div class="l2" title="${esc(a.text || '')}">${esc(a.text || '')}</div></div>
      <span class="x"><button class="ghost icon" title="Retirer cette ligne" data-del="${esc(a.id)}">✕</button></span></div>`).join('');
}
function renderAll() { renderConn(); renderLive(); renderChans(); renderHistory(); }
setInterval(() => { document.querySelectorAll('[data-since]').forEach(el => el.textContent = dur(el.dataset.since)); if (state) $('updated').textContent = 'Mis à jour ' + dur(state.ts).replace(/^(\d)/, 'il y a $1'); }, 5000);

/* ═══════════ watcher ═══════════ */
const watcher = createWatcher({ channels: [...CHANNELS.filter(c => !hiddenChannels.has(c.login)), ...customChannels.map(c => ({ ...c, custom: true }))], on: {
  state: (s) => { state = s; renderConn(); renderLive(); renderChans(); $('updated').textContent = 'Mis à jour à l’instant'; },
  alert: (a) => { history.push(a); saveHistory(); renderHistory(); toast(a); notify(a); track('alerte-tombola'); },
  end: (a) => { const i = history.findIndex(x => x.id === a.id); if (i >= 0) history[i] = { ...history[i], endedAt: a.endedAt, userEnded: a.userEnded }; saveHistory(); renderHistory(); },
  log: (m) => console.log(new Date().toISOString(), m),
  conn: (status, info) => { if (status === 'reconnecting' && info.reconnects === 3) track('twitch-reconnexions'); },
} });
watcher.start();
document.addEventListener('visibilitychange', () => { if (!document.hidden) watcher.evaluate(); });

/* ═══════════ actions ═══════════ */
function endTombola(alertId) { watcher.endByUser(alertId); }   // le callback end() met l'historique à jour
$('live').addEventListener('click', (e) => {
  const id = e.target.dataset.end; if (!id) return;
  e.target.closest('.card').classList.add('leaving'); setTimeout(() => endTombola(id), 250);
});
$('history').addEventListener('click', (e) => {
  const id = e.target.dataset.del; if (!id) return;
  const a = history.find(x => x.id === id); if (a && !a.endedAt) endTombola(id);   // retirer une tombola en cours = la clore
  history = history.filter(x => x.id !== id); saveHistory(); renderHistory();
});
$('btn-clear').onclick = () => { if (!confirm('Effacer tout l’historique ?')) return; for (const a of history) if (!a.endedAt) endTombola(a.id); history = []; saveHistory(); renderHistory(); };
$('btn-test').onclick = async () => {
  if (notifStatus() === 'default') await askNotif();
  const a = { id: 'test-' + Date.now(), ts: new Date().toISOString(), login: 'twitch', name: 'Chaîne de test', text: 'Test : tombola fictive, 1€ = 1 ticket', role: 'moderator', endedAt: new Date().toISOString(), test: true };
  history.push(a); saveHistory(); renderHistory(); toast(a);
  const ok = await notify(a);
  if (!ok) toast('Pas de notification système', HINTS[notifStatus()] || 'Autorisation non accordée.');
};
const ADD_HELP = 'Le nom, c’est ce qui suit twitch.tv/ dans l’adresse de la chaîne. Tu peux coller l’adresse entière.';
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const input = $('add-input'), hint = $('add-hint'), btn = e.target.querySelector('button');
  const login = watcher.addChannel(input.value);
  if (!login) { hint.textContent = 'Pseudo invalide ou chaîne déjà surveillée. ' + ADD_HELP; return; }
  btn.disabled = true; hint.textContent = `Vérification de « ${login} » auprès de Twitch…`;
  const ok = await watcher.awaitChannel(login);
  btn.disabled = false;
  if (!ok) { watcher.removeChannel(login); hint.textContent = ADD_HELP; toast('Chaîne introuvable', `Twitch ne connaît pas « ${login} ». ` + ADD_HELP); return; }
  customChannels.push({ login, name: login }); store.set('customChannels', customChannels); input.value = ''; track('chaine-ajoutee');
  hint.textContent = `${login} ajoutée et surveillée. Les chaînes ajoutées (✦) sont mémorisées sur cet appareil.`; toast('Chaîne ajoutée', `${login} est maintenant surveillée.`);
});
$('chans').addEventListener('click', (e) => {
  const login = e.target.dataset.remove; if (!login) return;
  watcher.removeChannel(login);
  const i = customChannels.findIndex(c => c.login === login);
  if (i >= 0) { customChannels.splice(i, 1); store.set('customChannels', customChannels); }
  else { hiddenChannels.add(login); store.set('hiddenChannels', [...hiddenChannels]); }
  toast('Chaîne retirée', `${login} n’est plus surveillée sur cet appareil.`);
});
$('restore').onclick = () => {
  for (const login of hiddenChannels) { const c = CHANNELS.find(x => x.login === login); if (c) watcher.addChannel(c.login, c.name, false); }
  hiddenChannels.clear(); store.set('hiddenChannels', []); renderChans();
};
renderAll();
