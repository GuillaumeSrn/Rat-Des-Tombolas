#!/usr/bin/env node
// Rat des Tombolas — détecte les tombolas en cours sur des chaînes Twitch (IRC anonyme) et prévient via une page locale.
// Node 22+, zéro dépendance. Usage : node tombola-watch.mjs [dossier-logs]   (défaut : ./watch-logs)

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join as pjoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// ───────────────────────── Chaînes et seuils ─────────────────────────
// Liste chargée au démarrage depuis l'API publique du ZEVENT : les TOP_N plus grosses cagnottes. Secours : liste figée du 5 sept. 2026.
const ZEVENT_API = 'https://zevent.fr/api/';
const TOP_N = 30;                        // nombre de chaînes gardées, classées par cagnotte
const FALLBACK_CHANS = ["mastu","mistermv","domingo","anyme023","zevent","zerator","antoinedaniel","amixem","florence","joueur_du_grenier","joyca","mcflyetcarlito","ponce","sylvainlyve","jltomy","nia_c","clemovitch","nico_la","mynthos","alphacast","enjoyphoenix","laink","theguill84","etoiles","areliann","sebjdg","shisheyu","byilhann","samueletienne","fantabobshow"];
let CHANS = [];                          // logins Twitch, sans '#'
const DISPLAY = new Map();               // login -> nom affiché par le ZEVENT
const MATCH_RX = /\btombola\b/i;

const EVAL_INTERVAL_MS = 10_000;      // fréquence d'évaluation
const WINDOW_MS = 3 * 60_000;         // fenêtre ratio / trusted
const REPEAT_WINDOW_MS = 5 * 60_000;  // fenêtre détection texte répété
const RATIO_ACTIVE = 0.03;            // ratio min pour passer ACTIVE (avec MIN_MATCHES)
const MIN_MATCHES = 12;
const TRUSTED_ACTIVE = 2;             // matches broadcaster/mod/vip/bot connu
const REPEAT_MIN = 2;                 // même texte mod/bot vu ≥ N fois
const RATIO_INACTIVE = 0.01;          // retour INACTIVE si ratio < X ET trusted = 0 ...
const INACTIVE_HOLD_MS = 5 * 60_000;  // ... pendant cette durée
const QUIET_AFTER_MS = 5 * 60_000;    // chat considéré silencieux sans message depuis X
const HTTP_PORT = Number(process.env.PORT) || 8787;
const HISTORY_MAX = 200;              // événements gardés en mémoire (les .jsonl gardent tout)
const KEEP_MODBOT_MSGS = 5;

const JOIN_BATCH = 15, JOIN_BATCH_GAP_MS = 10_000;
const CLIENT_PING_MS = 60_000, PONG_TIMEOUT_MS = 10_000, BACKOFF_MIN = 1_000, BACKOFF_MAX = 30_000;

const KNOWN_BOTS = new Set(['nightbot','streamelements','moobot','wizebot','fossabot','streamlabs','botrix','sery_bot','pokemoncommunitygame','soundalerts','kofistreambot','streamcaptainbot','tangiabot','commanderroot','lumiastream','cloudbot','phantombot','deepbot','botisimo','vivbot','wzbot']);

// ───────────────────────── Logs ─────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || pjoin(HERE, 'watch-logs');
mkdirSync(OUT, { recursive: true });
const SCORES = pjoin(OUT, 'scores.jsonl'), ALERTS = pjoin(OUT, 'alerts.jsonl');
const ts = () => new Date().toISOString();
const log = (s) => console.log(`${ts()} ${s}`);
const jsonl = (file, obj) => appendFileSync(file, JSON.stringify(obj) + '\n');

// ───────────────────────── État ─────────────────────────
// msgs: [{t, match, trusted, norm|null}] ; modbot: derniers msgs mod/bot
const chans = new Map();       // '#login' -> état, rempli par loadChans()
const newChan = () => ({ msgs: [], modbot: [], state: 'INACTIVE', lowSince: null, activeSince: null, alertId: null, lastTrustedText: null, lastTrustedRole: null, lastMsgAt: null, rate: 0, maxRatio: 0 });

async function loadChans() {
  let list = null;
  try {
    const ctrl = AbortSignal.timeout(8000);
    const r = await fetch(ZEVENT_API, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) ratdestombola/1.0' }, signal: ctrl });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const live = (await r.json()).live;
    list = live.slice().sort((a, b) => b.donationAmount.number - a.donationAmount.number).slice(0, TOP_N).map(s => s.twitch.toLowerCase());
    for (const s of live) DISPLAY.set(s.twitch.toLowerCase(), s.display);
    log(`liste ZEVENT chargée : top ${list.length} cagnottes sur ${live.length} participants`);
  } catch (e) {
    list = FALLBACK_CHANS; log(`API ZEVENT indisponible (${e.message}), liste de secours : ${list.length} chaînes`);
  }
  CHANS = list;
  for (const c of CHANS) chans.set('#' + c, newChan());
}
const history = [];            // événements (alertes), plus récent en dernier
const sseClients = new Set();
const conn = { status: 'connecting', since: Date.now(), nick: '', joined: 0, reconnects: 0 };

const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function role(badges, login) {
  if (KNOWN_BOTS.has(login)) return 'bot';
  if (badges.includes('broadcaster/')) return 'broadcaster';
  if (badges.includes('moderator/')) return 'moderator';
  if (badges.includes('vip/')) return 'vip';
  return 'viewer';
}
const TRUSTED_ROLES = new Set(['broadcaster', 'moderator', 'vip', 'bot']);
const MODBOT_ROLES = new Set(['broadcaster', 'moderator', 'bot']);

function onChat(chan, login, badges, text) {
  const c = chans.get(chan); if (!c) return;
  const r = role(badges, login), match = MATCH_RX.test(text), trusted = match && TRUSTED_ROLES.has(r), modbot = MODBOT_ROLES.has(r);
  c.msgs.push({ t: Date.now(), match, trusted, norm: match && modbot ? normalize(text) : null });
  c.lastMsgAt = Date.now();
  if (trusted) { c.lastTrustedText = text; c.lastTrustedRole = r; }
  if (modbot) { c.modbot.push({ ts: ts(), user: login, role: r, text }); if (c.modbot.length > KEEP_MODBOT_MSGS) c.modbot.shift(); }
}

function evaluate() {
  const now = Date.now(), wStart = now - WINDOW_MS, rStart = now - REPEAT_WINDOW_MS;
  for (const [chan, c] of chans) {
    c.msgs = c.msgs.filter(m => m.t >= rStart);
    let total = 0, matches = 0, trusted = 0; const seen = new Map(); let repeat = false;
    for (const m of c.msgs) {
      if (m.norm) { const n = (seen.get(m.norm) || 0) + 1; seen.set(m.norm, n); if (n >= REPEAT_MIN) repeat = true; }
      if (m.t < wStart) continue;
      total++; if (m.match) matches++; if (m.trusted) trusted++;
    }
    const ratio = total ? matches / total : 0;
    c.rate = Math.round(total / (WINDOW_MS / 60_000));
    if (ratio > c.maxRatio) c.maxRatio = ratio;
    const byRatio = ratio >= RATIO_ACTIVE && matches >= MIN_MATCHES, byTrusted = trusted >= TRUSTED_ACTIVE;
    const activeCond = byRatio || byTrusted || repeat;
    const lowCond = ratio < RATIO_INACTIVE && trusted === 0;

    if (c.state === 'INACTIVE' && activeCond) {
      c.state = 'ACTIVE'; c.lowSince = null; c.activeSince = now;
      const trigger = repeat ? 'repeat' : byTrusted ? 'trusted' : 'ratio';
      const alert = { id: randomUUID(), ts: ts(), chan, display: DISPLAY.get(chan.slice(1)) || chan.slice(1), ratio: +ratio.toFixed(4), trusted, trigger, lastTrustedText: c.lastTrustedText, lastTrustedRole: c.lastTrustedRole, endedAt: null };
      c.alertId = alert.id; pushHistory(alert);
      jsonl(ALERTS, { ...alert, transition: 'INACTIVE->ACTIVE', total, matches, repeat, lastModBotMsgs: [...c.modbot] });
      log(`ALERTE ${chan} tombola (ratio=${(ratio * 100).toFixed(1)}% matches=${matches}/${total} trusted=${trusted} repeat=${repeat})`);
      broadcast('alert', alert);
    } else if (c.state === 'ACTIVE') {
      if (!lowCond) c.lowSince = null;
      else if (c.lowSince == null) c.lowSince = now;
      else if (now - c.lowSince >= INACTIVE_HOLD_MS) {
        c.state = 'INACTIVE'; c.lowSince = null;
        const ended = history.find(a => a.id === c.alertId);
        if (ended) { ended.endedAt = ts(); broadcast('alert-update', ended); }
        c.activeSince = null; c.alertId = null;
        jsonl(ALERTS, { ts: ts(), chan, transition: 'ACTIVE->INACTIVE', ratio: +ratio.toFixed(4), trusted, total, matches, lastModBotMsgs: [...c.modbot] });
        log(`${chan} : tombola terminée`);
      }
    }
    jsonl(SCORES, { ts: ts(), chan, total, matches, ratio: +ratio.toFixed(4), trusted, repeat, state: c.state });
  }
  broadcast('state', snapshot());
}
setInterval(evaluate, EVAL_INTERVAL_MS);

function pushHistory(alert) { history.push(alert); if (history.length > HISTORY_MAX) history.shift(); }
function snapshot() {
  const now = Date.now();
  return {
    ts: ts(), conn: { ...conn },
    chans: [...chans].map(([chan, c]) => ({
      chan, display: DISPLAY.get(chan.slice(1)) || chan.slice(1), state: c.state, alertId: c.alertId, activeSince: c.activeSince ? new Date(c.activeSince).toISOString() : null, rate: c.rate,
      quiet: !c.lastMsgAt || now - c.lastMsgAt > QUIET_AFTER_MS, lastTrustedText: c.lastTrustedText, lastTrustedRole: c.lastTrustedRole,
    })),
  };
}

// ───────────────────────── IRC ─────────────────────────
function parse(line) {
  const m = line.match(/^(?:@(\S+) )?(?::(\S+) )?(\S+)(?: (.*))?$/); if (!m) return null;
  const [, rawTags, prefix, cmd, rest = ''] = m; const tags = {};
  if (rawTags) for (const kv of rawTags.split(';')) { const i = kv.indexOf('='); tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\'); }
  let params = rest, trailing = ''; const ti = rest.indexOf(' :');
  if (rest.startsWith(':')) { trailing = rest.slice(1); params = ''; } else if (ti >= 0) { trailing = rest.slice(ti + 2); params = rest.slice(0, ti); }
  return { tags, prefix, cmd, params: params.split(' ').filter(Boolean), trailing };
}

let ws, pingTimer, pongTimer, stopping = false, backoff = BACKOFF_MIN;
const joined = new Set();
function setConn(status) { conn.status = status; conn.since = Date.now(); conn.joined = joined.size; broadcast('state', snapshot()); }
function connect() {
  conn.nick = 'justinfan' + (10000 + Math.floor(Math.random() * 89999));
  setConn('connecting');
  ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  const send = (s) => { if (ws.readyState === 1) ws.send(s + '\r\n'); };
  ws.addEventListener('open', async () => {
    log(`IRC connecté (${conn.nick})`); backoff = BACKOFF_MIN; setConn('connected');
    send('CAP REQ :twitch.tv/tags twitch.tv/commands'); send('PASS SCHMOOPIIE'); send(`NICK ${conn.nick}`);
    for (let i = 0; i < CHANS.length; i += JOIN_BATCH) {
      if (i) await new Promise(r => setTimeout(r, JOIN_BATCH_GAP_MS));
      send('JOIN ' + CHANS.slice(i, i + JOIN_BATCH).map(c => '#' + c).join(','));
    }
    pingTimer = setInterval(() => {
      send(`PING :client-${Date.now()}`);
      pongTimer = setTimeout(() => { log('pas de PONG en 10 s, reconnexion'); ws.close(4000, 'pong timeout'); }, PONG_TIMEOUT_MS);
    }, CLIENT_PING_MS);
  });
  ws.addEventListener('message', (e) => {
    for (const line of String(e.data).split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { send('PONG ' + line.slice(5)); continue; }
      const p = parse(line); if (!p) continue;
      switch (p.cmd) {
        case 'PONG': clearTimeout(pongTimer); break;
        case 'JOIN': if (p.prefix?.startsWith(conn.nick + '!')) { joined.add(p.params[0] || p.trailing); conn.joined = joined.size; if (joined.size === CHANS.length) log(`${joined.size}/${CHANS.length} chaînes rejointes`); } break;
        case 'NOTICE': log('NOTICE ' + line.slice(0, 200)); break;
        case 'RECONNECT': log('RECONNECT demandé par Twitch'); ws.close(4001, 'server reconnect'); break;
        case 'PRIVMSG': case 'USERNOTICE':
          onChat(p.params[0], p.tags.login || p.prefix?.split('!')[0] || '', p.tags.badges || '', p.trailing); break;
      }
    }
  });
  ws.addEventListener('close', (e) => {
    clearInterval(pingTimer); clearTimeout(pongTimer); joined.clear();
    log(`IRC fermé (code ${e.code}${e.reason ? ', ' + e.reason : ''})`);
    if (stopping) return;
    conn.reconnects++; setConn('reconnecting');
    log(`reconnexion dans ${backoff / 1000} s`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, BACKOFF_MAX);
  });
  ws.addEventListener('error', (e) => log('IRC erreur ' + (e.message || 'ws error')));
}

// ───────────────────────── HTTP + SSE ─────────────────────────
function broadcast(event, data) { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of sseClients) res.write(s); }
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const PAGE_PATH = pjoin(HERE, 'public', 'index.html');

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: init\ndata: ${JSON.stringify({ state: snapshot(), history })}\n\n`);
    sseClients.add(res); req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/state') return json(res, 200, snapshot());
  if (url.pathname === '/history' && req.method === 'GET') return json(res, 200, history);
  if (url.pathname === '/history' && req.method === 'DELETE') {          // efface l'historique en mémoire (les .jsonl sont conservés)
    history.length = 0; broadcast('history-cleared', {}); return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith('/history/') && req.method === 'DELETE') {
    const id = url.pathname.slice('/history/'.length), i = history.findIndex(a => a.id === id);
    if (i < 0) return json(res, 404, { error: 'inconnu' });
    history.splice(i, 1); broadcast('history-removed', { id }); return json(res, 200, { ok: true });
  }
  if (url.pathname === '/test-alert') {                                    // fausse alerte pour tester la chaîne de notification, non loggée
    const chan = '#' + (url.searchParams.get('chan') || 'domingo');
    const alert = { id: randomUUID(), ts: ts(), chan, display: DISPLAY.get(chan.slice(1)) || chan.slice(1), ratio: 0.1234, trusted: 2, trigger: 'trusted', lastTrustedText: 'Test : tombola fictive, 1€ = 1 ticket', lastTrustedRole: 'moderator', endedAt: null, test: true };
    const c = chans.get(chan);                                              // la chaîne passe aussi "en cours" pour tester la carte (retour au calme automatique)
    if (c && c.state === 'INACTIVE') { c.state = 'ACTIVE'; c.activeSince = Date.now(); c.alertId = alert.id; c.lastTrustedText = alert.lastTrustedText; c.lastTrustedRole = 'moderator'; }
    pushHistory(alert); broadcast('alert', alert); broadcast('state', snapshot()); log(`alerte de test ${chan} → ${sseClients.size} client(s)`);
    return json(res, 200, alert);
  }
  if (url.pathname === '/') {
    try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(readFileSync(PAGE_PATH)); }
    catch { return json(res, 500, { error: 'public/index.html introuvable' }); }
  }
  json(res, 404, { error: 'not found' });
});
server.on('error', (e) => { log(`HTTP : ${e.code === 'EADDRINUSE' ? `port ${HTTP_PORT} déjà utilisé (un autre watcher tourne ?)` : e.message}`); process.exit(1); });
server.listen(HTTP_PORT, '127.0.0.1', () => log(`Page : http://localhost:${HTTP_PORT}`));
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 30_000);

// ───────────────────────── Arrêt ─────────────────────────
function shutdown(sig) {
  stopping = true; log(`${sig}, arrêt`);
  const top = [...chans].map(([chan, c]) => ({ chan, state: c.state, maxRatio: +(c.maxRatio * 100).toFixed(1) })).filter(x => x.maxRatio > 0 || x.state === 'ACTIVE').sort((a, b) => b.maxRatio - a.maxRatio);
  log('ratio max % par chaîne : ' + JSON.stringify(top));
  try { ws?.close(1000, sig); } catch {}
  server.close(); for (const r of sseClients) r.end();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));

await loadChans();
connect();
