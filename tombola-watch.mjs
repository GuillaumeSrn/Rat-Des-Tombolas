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
const EXCLUDED_CHANS = new Set(['zevent']); // chaînes jamais surveillées (chaîne officielle de l'événement, pas un streamer)
const FALLBACK_CHANS = ["mastu","mistermv","domingo","anyme023","zevent","zerator","antoinedaniel","amixem","florence","joueur_du_grenier","joyca","mcflyetcarlito","ponce","sylvainlyve","jltomy","nia_c","clemovitch","nico_la","mynthos","alphacast","enjoyphoenix","laink","theguill84","etoiles","areliann","sebjdg","shisheyu","byilhann","samueletienne","fantabobshow"];
let CHANS = [];                          // logins Twitch, sans '#'
const DISPLAY = new Map();               // login -> nom affiché par le ZEVENT
const MATCH_RX = /\btombola\b/i;
const LOG_RX = /tombola|tirage|ticket|gagnant|\blots?\b|giveaway/i;   // plus large que la détection : sert à rejouer d'autres mots-clés hors ligne

// ── Détection : une tombola ne démarre que sur une ANNONCE OFFICIELLE (streamer, modérateur, bot connu), jamais sur le chat seul.
const STRONG_RX = /1 ?(€|euros?)|tickets?|zevent\.fr\/don|en cours/i;   // pattern d'annonce : "1€ = 1 ticket", lien de don, "tombola en cours"
const QUESTION_RX = /\?/;                                             // "à quand ta tombola ?" n'est pas une annonce
const FUTURE_RX = /prochaine|bient[ôo]t|tout [àa] l.heure|demain/i;   // "prochaine tombola à 16h30" non plus
const DEDUP_MS = 30 * 60_000;         // une même annonce ne redéclenche pas pendant ce délai (messages automatiques des bots)
const END_NO_OFFICIAL_MS = 8 * 60_000;// fin : plus aucun message officiel parlant de tombola depuis ce délai...
const END_RATIO_MAX = 0.02;           // ...et moins de 2 % du chat en parle
const COOLDOWN_MS = 10 * 60_000;      // après une fin, pas de nouvelle alerte sur la chaîne pendant ce délai
const REPLY_MEMORY_MS = 15 * 60_000;  // un message officiel qui commence par le pseudo d'un viewer récent est une réponse, pas une annonce
const EVAL_INTERVAL_MS = 10_000;      // fréquence d'évaluation (débit, fin, logs)
const WINDOW_MS = 3 * 60_000;         // fenêtre de mesure du chat
const CONTEXT_AFTER_MS = 10 * 60_000; // chat complet conservé après la fin d'une tombola
const QUIET_AFTER_MS = 5 * 60_000;    // chat considéré silencieux sans message depuis X
const HTTP_PORT = Number(process.env.PORT) || 8787;
const HISTORY_MAX = 200;              // événements gardés en mémoire (les .jsonl gardent tout)
const KEEP_MODBOT_MSGS = 5;
const REPLY_USERS_MAX = 2000;         // pseudos récents mémorisés par chaîne

const JOIN_BATCH = 15, JOIN_BATCH_GAP_MS = 10_000;
const CLIENT_PING_MS = 60_000, PONG_TIMEOUT_MS = 10_000, BACKOFF_MIN = 1_000, BACKOFF_MAX = 30_000;

const KNOWN_BOTS = new Set(['nightbot','streamelements','moobot','wizebot','fossabot','streamlabs','botrix','sery_bot','pokemoncommunitygame','soundalerts','kofistreambot','streamcaptainbot','tangiabot','commanderroot','lumiastream','cloudbot','phantombot','deepbot','botisimo','vivbot','wzbot']);

// ───────────────────────── Logs ─────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || pjoin(HERE, 'watch-logs');
mkdirSync(OUT, { recursive: true });
const SCORES = pjoin(OUT, 'scores.jsonl'), ALERTS = pjoin(OUT, 'alerts.jsonl');
const MATCHES = pjoin(OUT, 'matches.jsonl'), OFFICIAL = pjoin(OUT, 'official.jsonl'), CONTEXT = pjoin(OUT, 'context.jsonl'), FEEDBACK = pjoin(OUT, 'feedback.jsonl');
const ts = () => new Date().toISOString();
const log = (s) => console.log(`${ts()} ${s}`);
const jsonl = (file, obj) => appendFileSync(file, JSON.stringify(obj) + '\n');

// ───────────────────────── État ─────────────────────────
// msgs: fenêtre de mesure du chat ; modbot: derniers messages officiels ; users: pseudos récents (détection des réponses) ; seen: annonces déjà exploitées
const chans = new Map();       // '#login' -> état, rempli par loadChans()
const newChan = () => ({ msgs: [], modbot: [], users: new Map(), seen: new Map(), state: 'INACTIVE', activeSince: null, alertId: null, lastAlertId: null,
  lastTrustedText: null, lastTrustedRole: null, lastTrustedAt: null, lastOfficialAt: 0, lastMsgAt: null, endedAt: null, cooldownUntil: 0, rate: 0, maxRatio: 0 });

async function loadChans() {
  let list = null;
  try {
    const ctrl = AbortSignal.timeout(8000);
    const r = await fetch(ZEVENT_API, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) ratdestombola/1.0' }, signal: ctrl });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const live = (await r.json()).live;
    list = live.slice().sort((a, b) => b.donationAmount.number - a.donationAmount.number).map(s => s.twitch.toLowerCase()).filter(l => !EXCLUDED_CHANS.has(l)).slice(0, TOP_N);
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
const OFFICIAL_ROLES = new Set(['broadcaster', 'moderator', 'bot']);   // les VIP sont des viewers avec un badge

function onChat(chan, login, badges, text, replyTo) {
  const c = chans.get(chan); if (!c) return;
  const now = Date.now(), r = role(badges, login), match = MATCH_RX.test(text), official = OFFICIAL_ROLES.has(r);
  c.msgs.push({ t: now, match, u: match ? login : null });
  c.lastMsgAt = now;
  if (!official) { c.users.set(login, now); if (c.users.size > REPLY_USERS_MAX) c.users.delete(c.users.keys().next().value); }
  if (official) { c.modbot.push({ ts: ts(), user: login, role: r, text }); if (c.modbot.length > KEEP_MODBOT_MSGS) c.modbot.shift(); }
  // ── logs bruts pour le réglage hors ligne ──
  const rec = { ts: ts(), chan, user: login, role: r, text };
  if (LOG_RX.test(text)) jsonl(MATCHES, { ...rec, match });
  if (official) jsonl(OFFICIAL, { ...rec, replyTo: replyTo || undefined });
  if (c.state === 'ACTIVE' || (c.endedAt && now - c.endedAt < CONTEXT_AFTER_MS)) jsonl(CONTEXT, { ...rec, match, alertId: c.alertId || c.lastAlertId });
  if (!official || !match) return;

  // ── message officiel parlant de tombola ──
  c.lastOfficialAt = now;                                              // maintient la tombola « en cours », même si c'est une réponse à un viewer
  const firstWord = text.replace(/^@/, '').split(/[\s,:]/)[0].toLowerCase();
  const isReply = !!replyTo || text.startsWith('@') || (c.users.has(firstWord) && now - c.users.get(firstWord) < REPLY_MEMORY_MS);
  if (isReply || QUESTION_RX.test(text) || FUTURE_RX.test(text)) return;
  // Un lien de don désigne la vraie chaîne de la tombola (un mod peut relayer celle d'un autre streamer)
  const donLogin = (text.match(/zevent\.fr\/don\/([a-z0-9_]+)/i) || [])[1]?.toLowerCase();
  const target = donLogin && chans.has('#' + donLogin) ? '#' + donLogin : chan, tc = chans.get(target);
  tc.lastTrustedText = text; tc.lastTrustedRole = r; tc.lastTrustedAt = now; if (target !== chan) tc.lastOfficialAt = now;
  if (tc.state === 'ACTIVE' || now < tc.cooldownUntil) return;
  const n = normalize(text).slice(0, 80);
  if (tc.seen.has(n) && now - tc.seen.get(n) < DEDUP_MS) return;       // même annonce déjà exploitée (timer de bot)
  if (STRONG_RX.test(text)) startTombola(target, tc, 'announce', n, target !== chan ? chan : null);   // sans pattern d'annonce, on ne déclenche pas
}

function startTombola(chan, c, trigger, n, via = null) {
  const now = Date.now();
  c.state = 'ACTIVE'; c.activeSince = now; c.seen.set(n, now);
  for (const [k, t] of c.seen) if (now - t > DEDUP_MS) c.seen.delete(k);
  const { total, matches, ratio } = measure(c, now);
  const alert = { id: randomUUID(), ts: ts(), chan, display: DISPLAY.get(chan.slice(1)) || chan.slice(1), ratio: +ratio.toFixed(4), trigger, lastTrustedText: c.lastTrustedText, lastTrustedRole: c.lastTrustedRole, via: via ? DISPLAY.get(via.slice(1)) || via.slice(1) : null, endedAt: null };
  c.alertId = alert.id; pushHistory(alert);
  jsonl(ALERTS, { ...alert, transition: 'INACTIVE->ACTIVE', total, matches, lastModBotMsgs: [...c.modbot] });
  log(`ALERTE ${chan} tombola (${trigger}${via ? ', relayée par ' + via : ''}) ${c.lastTrustedRole} : ${c.lastTrustedText.slice(0, 100)}`);
  broadcast('alert', alert); broadcast('state', snapshot());
}

function endTombola(chan, c, reason) {
  const now = Date.now();
  c.state = 'INACTIVE'; c.activeSince = null; c.lastAlertId = c.alertId; c.alertId = null; c.endedAt = now; c.cooldownUntil = now + COOLDOWN_MS;
  const ended = history.find(a => a.id === c.lastAlertId);
  if (ended && !ended.endedAt) { ended.endedAt = ts(); broadcast('alert-update', ended); }
  const { total, matches, ratio } = measure(c, now);
  jsonl(ALERTS, { ts: ts(), chan, transition: 'ACTIVE->INACTIVE', reason, ratio: +ratio.toFixed(4), total, matches, lastModBotMsgs: [...c.modbot] });
  log(`${chan} : tombola terminée (${reason})`);
}

function measure(c, now) {
  const wStart = now - WINDOW_MS; let total = 0, matches = 0; const authors = new Set();
  for (const m of c.msgs) { if (m.t < wStart) continue; total++; if (m.match) { matches++; authors.add(m.u); } }
  return { total, matches, authors: authors.size, ratio: total ? matches / total : 0 };
}

function evaluate() {
  const now = Date.now(), wStart = now - WINDOW_MS;
  for (const [chan, c] of chans) {
    c.msgs = c.msgs.filter(m => m.t >= wStart);
    const { total, matches, authors, ratio } = measure(c, now);
    c.rate = Math.round(total / (WINDOW_MS / 60_000));
    if (ratio > c.maxRatio) c.maxRatio = ratio;
    const sinceOfficial = c.lastOfficialAt ? now - c.lastOfficialAt : null;
    if (c.state === 'ACTIVE' && sinceOfficial > END_NO_OFFICIAL_MS && ratio < END_RATIO_MAX) endTombola(chan, c, 'silence');
    jsonl(SCORES, { ts: ts(), chan, total, matches, authors, ratio: +ratio.toFixed(4), sinceOfficialS: sinceOfficial == null ? null : Math.round(sinceOfficial / 1000), state: c.state });
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
      quiet: !c.lastMsgAt || now - c.lastMsgAt > QUIET_AFTER_MS,
      lastTrustedText: c.state === 'ACTIVE' ? c.lastTrustedText : null, lastTrustedRole: c.state === 'ACTIVE' ? c.lastTrustedRole : null,
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
          onChat(p.params[0], p.tags.login || p.prefix?.split('!')[0] || '', p.tags.badges || '', p.trailing, p.tags['reply-parent-user-login']); break;
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
const PAGE = readFileSync(pjoin(HERE, 'public', 'index.html'));   // lue une fois : la page servie correspond toujours au serveur qui tourne

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
    const kept = history.filter(a => !a.endedAt); history.length = 0; history.push(...kept);   // les tombolas en cours restent
    broadcast('history-cleared', { kept: kept.map(a => a.id) }); return json(res, 200, { ok: true, kept: kept.length });
  }
  if (url.pathname.startsWith('/history/') && req.method === 'DELETE') {
    const id = url.pathname.slice('/history/'.length), i = history.findIndex(a => a.id === id);
    if (i < 0) return json(res, 404, { error: 'inconnu' });
    if (!history[i].endedAt) return json(res, 409, { error: 'tombola en cours : marque-la terminée d’abord' });
    history.splice(i, 1); broadcast('history-removed', { id }); return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith('/history/') && url.pathname.endsWith('/feedback') && req.method === 'POST') {   // vérité terrain saisie dans la page
    const id = url.pathname.split('/')[2], a = history.find(x => x.id === id); if (!a) return json(res, 404, { error: 'inconnu' });
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const verdict = (() => { try { return JSON.parse(body).verdict; } catch { return null; } })();
      if (!['true', 'false', 'ended'].includes(verdict)) return json(res, 400, { error: 'verdict attendu : true | false | ended' });
      const c = chans.get(a.chan);
      if (verdict === 'ended') {
        a.endedAt = a.endedAt || ts(); a.userEnded = true;
        if (c && c.alertId === a.id) endTombola(a.chan, c, 'utilisateur');
      } else a.verdict = verdict;
      jsonl(FEEDBACK, { ts: ts(), id, chan: a.chan, verdict, alertTs: a.ts, trigger: a.trigger, detectedEnd: verdict === 'ended' ? null : a.endedAt, text: a.lastTrustedText });
      log(`retour utilisateur ${a.chan} : ${verdict}`); broadcast('alert-update', a); if (verdict === 'ended') broadcast('state', snapshot());
      json(res, 200, a);
    });
    return;
  }
  if (url.pathname === '/test-alert') {                                    // fausse alerte pour tester la chaîne de notification, non loggée
    const chan = '#' + (url.searchParams.get('chan') || 'domingo');
    const alert = { id: randomUUID(), ts: ts(), chan, display: DISPLAY.get(chan.slice(1)) || chan.slice(1), ratio: 0.1234, trigger: 'announce', lastTrustedText: 'Test : tombola fictive, 1€ = 1 ticket', lastTrustedRole: 'moderator', endedAt: null, test: true };
    const c = chans.get(chan);                                              // la chaîne passe aussi "en cours" pour tester la carte (fin automatique au silence)
    if (c && c.state === 'INACTIVE') { c.state = 'ACTIVE'; c.activeSince = Date.now(); c.alertId = alert.id; c.lastTrustedText = alert.lastTrustedText; c.lastTrustedRole = 'moderator'; c.lastTrustedAt = Date.now(); c.lastOfficialAt = Date.now(); }
    pushHistory(alert); broadcast('alert', alert); broadcast('state', snapshot()); log(`alerte de test ${chan} → ${sseClients.size} client(s)`);
    return json(res, 200, alert);
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE);
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
