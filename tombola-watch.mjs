#!/usr/bin/env node
// tombola-watch.mjs — Node 22+, zéro dépendance.
// Détecte les tombolas en cours sur des chans Twitch (IRC anonyme) et notifie via une page locale (SSE + Notification API).
// Usage : node tombola-watch.mjs [outdir]   (défaut : ./watch-logs)

import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join as pjoin } from 'node:path';

// ───────────────────────── Seuils / constantes ─────────────────────────
const CHANS = ['domingo','zerator','anyme','etoiles','mistermv','squeezie','gotaga','kamet0','ponce','antoinedaniel','locklear','michou','inoxtag','jltomy','samueletienne','rivenzi','ultia','hortyunderscore','alphacast','aminematue','doigby','baghera','lebouseuh','xqc','kaicenat','ibai','auronplay','rubius','shroud','pokimane','jirayalecochon'];
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
const HTTP_PORT = 8787;
const REPLAY_ALERTS = 20;
const KEEP_MODBOT_MSGS = 5;

const JOIN_BATCH = 15, JOIN_BATCH_GAP_MS = 10_000;
const CLIENT_PING_MS = 60_000, PONG_TIMEOUT_MS = 10_000, BACKOFF_MIN = 1_000, BACKOFF_MAX = 30_000;

const KNOWN_BOTS = new Set(['nightbot','streamelements','moobot','wizebot','fossabot','streamlabs','botrix','sery_bot','pokemoncommunitygame','soundalerts','kofistreambot','streamcaptainbot','tangiabot','commanderroot','lumiastream','cloudbot','phantombot','deepbot','botisimo','vivbot','wzbot']);

// ───────────────────────── Logs ─────────────────────────
const OUT = process.argv[2] || 'watch-logs';
mkdirSync(OUT, { recursive: true });
const SCORES = pjoin(OUT, 'scores.jsonl'), ALERTS = pjoin(OUT, 'alerts.jsonl');
const ts = () => new Date().toISOString();
const log = (s) => console.log(`${ts()} ${s}`);
const jsonl = (file, obj) => appendFileSync(file, JSON.stringify(obj) + '\n');

// ───────────────────────── État par chan ─────────────────────────
// msgs: [{t, match, trusted, norm|null}] ; modbot: 5 derniers msgs mod/bot
const chans = new Map(CHANS.map(c => ['#' + c, { msgs: [], modbot: [], state: 'INACTIVE', lowSince: null, lastTrustedText: null, maxRatio: 0 }]));
const alerts = [];
const sseClients = new Set();

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
  if (trusted) c.lastTrustedText = text;
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
    if (ratio > c.maxRatio) c.maxRatio = ratio;
    const activeCond = (ratio >= RATIO_ACTIVE && matches >= MIN_MATCHES) || trusted >= TRUSTED_ACTIVE || repeat;
    const lowCond = ratio < RATIO_INACTIVE && trusted === 0;

    if (c.state === 'INACTIVE' && activeCond) {
      c.state = 'ACTIVE'; c.lowSince = null;
      const alert = { ts: ts(), chan, ratio: +ratio.toFixed(4), trusted, lastTrustedText: c.lastTrustedText };
      alerts.push(alert); if (alerts.length > REPLAY_ALERTS) alerts.shift();
      jsonl(ALERTS, { ...alert, transition: 'INACTIVE->ACTIVE', total, matches, repeat, lastModBotMsgs: [...c.modbot] });
      log(`ALERT ${chan} ACTIVE ratio=${(ratio * 100).toFixed(1)}% matches=${matches}/${total} trusted=${trusted} repeat=${repeat}`);
      broadcast(alert);
    } else if (c.state === 'ACTIVE') {
      if (!lowCond) c.lowSince = null;
      else if (c.lowSince == null) c.lowSince = now;
      else if (now - c.lowSince >= INACTIVE_HOLD_MS) {
        c.state = 'INACTIVE'; c.lowSince = null;
        jsonl(ALERTS, { ts: ts(), chan, transition: 'ACTIVE->INACTIVE', ratio: +ratio.toFixed(4), trusted, total, matches, lastModBotMsgs: [...c.modbot] });
        log(`${chan} -> INACTIVE`);
      }
    }
    jsonl(SCORES, { ts: ts(), chan, total, matches, ratio: +ratio.toFixed(4), trusted, repeat, state: c.state });
  }
}
setInterval(evaluate, EVAL_INTERVAL_MS);

// ───────────────────────── IRC ─────────────────────────
function parse(line) {
  const m = line.match(/^(?:@(\S+) )?(?::(\S+) )?(\S+)(?: (.*))?$/); if (!m) return null;
  const [, rawTags, prefix, cmd, rest = ''] = m; const tags = {};
  if (rawTags) for (const kv of rawTags.split(';')) { const i = kv.indexOf('='); tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\'); }
  let params = rest, trailing = ''; const ti = rest.indexOf(' :');
  if (rest.startsWith(':')) { trailing = rest.slice(1); params = ''; } else if (ti >= 0) { trailing = rest.slice(ti + 2); params = rest.slice(0, ti); }
  return { tags, prefix, cmd, params: params.split(' ').filter(Boolean), trailing };
}

let ws, pingTimer, pongTimer, stopping = false, backoff = BACKOFF_MIN, nick = '';
const joined = new Set();
function connect() {
  nick = 'justinfan' + (10000 + Math.floor(Math.random() * 89999));
  ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  const send = (s) => { if (ws.readyState === 1) ws.send(s + '\r\n'); };
  ws.addEventListener('open', async () => {
    log(`IRC OPEN nick=${nick}`); backoff = BACKOFF_MIN;
    send('CAP REQ :twitch.tv/tags twitch.tv/commands'); send('PASS SCHMOOPIIE'); send(`NICK ${nick}`);
    for (let i = 0; i < CHANS.length; i += JOIN_BATCH) {
      if (i) await new Promise(r => setTimeout(r, JOIN_BATCH_GAP_MS));
      send('JOIN ' + CHANS.slice(i, i + JOIN_BATCH).map(c => '#' + c).join(','));
    }
    pingTimer = setInterval(() => {
      send(`PING :client-${Date.now()}`);
      pongTimer = setTimeout(() => { log('PONG timeout -> reconnect'); ws.close(4000, 'pong timeout'); }, PONG_TIMEOUT_MS);
    }, CLIENT_PING_MS);
  });
  ws.addEventListener('message', (e) => {
    for (const line of String(e.data).split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { send('PONG ' + line.slice(5)); continue; }
      const p = parse(line); if (!p) continue;
      switch (p.cmd) {
        case 'PONG': clearTimeout(pongTimer); break;
        case 'JOIN': if (p.prefix?.startsWith(nick + '!')) { joined.add(p.params[0] || p.trailing); if (joined.size === CHANS.length) log(`${joined.size}/${CHANS.length} chans joints`); } break;
        case 'NOTICE': log('NOTICE ' + line.slice(0, 200)); break;
        case 'RECONNECT': log('RECONNECT serveur'); ws.close(4001, 'server reconnect'); break;
        case 'PRIVMSG': case 'USERNOTICE':
          onChat(p.params[0], p.tags.login || p.prefix?.split('!')[0] || '', p.tags.badges || '', p.trailing); break;
      }
    }
  });
  ws.addEventListener('close', (e) => {
    clearInterval(pingTimer); clearTimeout(pongTimer); joined.clear();
    log(`IRC CLOSE code=${e.code} reason=${e.reason}`);
    if (stopping) return;
    log(`reconnexion dans ${backoff}ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, BACKOFF_MAX);
  });
  ws.addEventListener('error', (e) => log('IRC ERROR ' + (e.message || 'ws error')));
}

// ───────────────────────── HTTP + SSE ─────────────────────────
function broadcast(alert) { const data = `data: ${JSON.stringify(alert)}\n\n`; for (const res of sseClients) res.write(data); }
const PAGE = `<!doctype html><meta charset="utf-8"><title>tombola-watch</title>
<style>body{font:14px system-ui;margin:20px;background:#111;color:#eee}button{padding:8px 14px;font-size:14px}li{margin:6px 0}a{color:#9147ff}#perm{color:#aaa;margin-left:10px}small{color:#888}</style>
<h2>tombola-watch</h2>
<button id="btn">Autoriser les notifications</button><span id="perm"></span>
<ul id="list"></ul>
<script>
const perm=document.getElementById('perm'),list=document.getElementById('list');
const show=()=>perm.textContent='Notification: '+Notification.permission;show();
document.getElementById('btn').onclick=()=>Notification.requestPermission().then(show);
function render(a){const li=document.createElement('li');li.innerHTML='<b>'+a.ts.slice(11,19)+'</b> <a target="_blank" href="https://twitch.tv/'+a.chan.slice(1)+'">'+a.chan+'</a> — ratio '+(a.ratio*100).toFixed(1)+'% · trusted '+a.trusted+(a.lastTrustedText?'<br><small>'+a.lastTrustedText.replace(/</g,'&lt;')+'</small>':'');list.prepend(li);}
function notify(a){if(Notification.permission!=='granted')return;const n=new Notification(a.chan+' — tombola',{body:a.lastTrustedText||('ratio '+(a.ratio*100).toFixed(1)+' %'),tag:a.chan+a.ts});n.onclick=()=>{window.open('https://twitch.tv/'+a.chan.slice(1));n.close();};}
let replayed=false;const es=new EventSource('/events');
es.addEventListener('replay',e=>{JSON.parse(e.data).forEach(render);replayed=true;});
es.onmessage=e=>{const a=JSON.parse(e.data);render(a);notify(a);};
es.onerror=()=>perm.textContent='SSE déconnecté, reconnexion…';
</script>`;
const server = createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: replay\ndata: ${JSON.stringify(alerts)}\n\n`);
    sseClients.add(res); req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.url.startsWith('/test-alert')) { // mock : GET /test-alert?chan=domingo -> fausse alerte SSE, non loggée
    const chan = '#' + (new URL(req.url, 'http://x').searchParams.get('chan') || 'domingo');
    const alert = { ts: ts(), chan, ratio: 0.1234, trusted: 2, lastTrustedText: '[TEST] Tombola mock, 1€ = 1 ticket', test: true };
    broadcast(alert); log(`TEST alert ${chan} -> ${sseClients.size} client(s) SSE`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(alert));
  }
  if (req.url === '/alerts') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(alerts)); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE);
});
server.listen(HTTP_PORT, '127.0.0.1', () => log(`HTTP http://localhost:${HTTP_PORT}`));
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 30_000);

// ───────────────────────── Arrêt ─────────────────────────
function shutdown(sig) {
  stopping = true; log(`${sig}, arrêt`);
  const summary = [...chans].map(([chan, c]) => ({ chan, state: c.state, maxRatio: +(c.maxRatio * 100).toFixed(1) })).filter(x => x.maxRatio > 0 || x.state === 'ACTIVE').sort((a, b) => b.maxRatio - a.maxRatio);
  log('résumé maxRatio% par chan: ' + JSON.stringify(summary));
  try { ws?.close(1000, sig); } catch {}
  server.close(); for (const r of sseClients) r.end();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));

connect();
