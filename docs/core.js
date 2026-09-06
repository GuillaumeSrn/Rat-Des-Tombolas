// Rat des Tombolas — cœur navigateur : connexion anonyme au chat Twitch + détection des tombolas.
// Module sans dépendance ni DOM, utilisable aussi sous Node 22 pour les tests.

export const RULES = {
  MATCH_RX: /\btombola\b|1 ?(€|euros?|e)\s*(=|→|->|:)\s*1 ?(tickets?|chances?|participations?|entr[ée]es?|billets?)/i,   // « tombola », ou « 1€ = 1 ticket / 1 chance » (annonces sans le mot)
  STRONG_RX: /1 ?(€|euros?)|tickets?|zevent\.fr\/don|en cours/i,          // annonce sûre (humains et bots)
  MEDIUM_RX: /particip|à gagner|remporter|\ben tombola\b|mise en jeu|faites (vos|des|un) dons?|plus que \d+ ?min|pseudo/i, // humains uniquement
  QUESTION_RX: /\?/,
  FUTURE_RX: /prochaine|bient[ôo]t|tout [àa] l.heure|demain/i,
  DEDUP_MS: 30 * 60_000,          // une même annonce ne redéclenche pas pendant ce délai
  END_NO_OFFICIAL_MS: 8 * 60_000, // fin : plus de message officiel depuis ce délai…
  END_RATIO_MAX: 0.02,            // …et moins de 2 % du chat en parle
  COOLDOWN_MS: 10 * 60_000,       // répit après une fin
  REPLY_MEMORY_MS: 15 * 60_000,   // un message officiel commençant par un pseudo récent est une réponse
  WINDOW_MS: 3 * 60_000,
  EVAL_MS: 10_000,
  QUIET_AFTER_MS: 5 * 60_000,
};
export const KNOWN_BOTS = new Set(['nightbot','streamelements','moobot','wizebot','fossabot','streamlabs','botrix','sery_bot','pokemoncommunitygame','soundalerts','kofistreambot','streamcaptainbot','tangiabot','commanderroot','lumiastream','cloudbot','phantombot','deepbot','botisimo','vivbot','wzbot']);
const OFFICIAL = new Set(['broadcaster', 'moderator', 'bot']);
const JOIN_BATCH = 15, JOIN_GAP_MS = 10_000, PING_MS = 60_000, PONG_TIMEOUT_MS = 10_000, BACKOFF_MIN = 1_000, BACKOFF_MAX = 30_000;

export function parseLine(line) {
  const m = line.match(/^(?:@(\S+) )?(?::(\S+) )?(\S+)(?: (.*))?$/); if (!m) return null;
  const [, rawTags, prefix, cmd, rest = ''] = m; const tags = {};
  if (rawTags) for (const kv of rawTags.split(';')) { const i = kv.indexOf('='); tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\'); }
  let params = rest, trailing = ''; const ti = rest.indexOf(' :');
  if (rest.startsWith(':')) { trailing = rest.slice(1); params = ''; } else if (ti >= 0) { trailing = rest.slice(ti + 2); params = rest.slice(0, ti); }
  return { tags, prefix, cmd, params: params.split(' ').filter(Boolean), trailing };
}
export function roleOf(badges, login) {
  if (KNOWN_BOTS.has(login)) return 'bot';
  if (badges.includes('broadcaster/')) return 'broadcaster';
  if (badges.includes('moderator/')) return 'moderator';
  if (badges.includes('vip/')) return 'vip';
  return 'viewer';
}
const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const uid = () => (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now());

/**
 * channels : [{login, name}]
 * on : { alert(a), end(a), state(snapshot), conn(status, info), log(msg) }
 */
export function createWatcher({ channels, on = {}, now = () => Date.now(), WebSocketImpl = globalThis.WebSocket, rules = RULES }) {
  const R = rules;
  const newChan = (c) => ({
    login: c.login, name: c.name, custom: !!c.custom, exists: false, msgs: [], users: new Map(), seen: new Map(), state: 'INACTIVE', activeSince: null, alert: null,
    lastText: null, lastRole: null, lastOfficialAt: 0, lastMsgAt: null, endedAt: 0, cooldownUntil: 0, rate: 0,
  });
  const chans = new Map(channels.map(c => ['#' + c.login, newChan(c)]));
  const conn = { status: 'idle', joined: 0, reconnects: 0, nick: '' };
  const emit = (k, ...a) => { try { on[k]?.(...a); } catch (e) { on.log?.('erreur callback ' + k + ': ' + e.message); } };
  const log = (m) => emit('log', m);

  function onChat(chan, login, badges, text, replyTo) {
    const c = chans.get(chan); if (!c) return;
    const t = now(), r = roleOf(badges, login), match = R.MATCH_RX.test(text), official = OFFICIAL.has(r);
    c.msgs.push({ t, match }); c.lastMsgAt = t;
    if (!official) { c.users.set(login, t); if (c.users.size > 2000) c.users.delete(c.users.keys().next().value); }
    if (!official || !match) return;
    c.lastOfficialAt = t;
    const firstWord = text.replace(/^@/, '').split(/[\s,:]/)[0].toLowerCase();
    const isReply = !!replyTo || text.startsWith('@') || (c.users.has(firstWord) && t - c.users.get(firstWord) < R.REPLY_MEMORY_MS);
    if (isReply || R.QUESTION_RX.test(text) || R.FUTURE_RX.test(text)) return;
    const donLogin = (text.match(/zevent\.fr\/don\/([a-z0-9_]+)/i) || [])[1]?.toLowerCase();
    const target = donLogin && chans.has('#' + donLogin) ? '#' + donLogin : chan, tc = chans.get(target);
    tc.lastText = text; tc.lastRole = r; if (target !== chan) tc.lastOfficialAt = t;
    if (tc.state === 'ACTIVE' || t < tc.cooldownUntil) return;
    const n = normalize(text).slice(0, 80);
    if (tc.seen.has(n) && t - tc.seen.get(n) < R.DEDUP_MS) return;
    const via = target !== chan ? c.name : null;
    if (R.STRONG_RX.test(text) || (r !== 'bot' && R.MEDIUM_RX.test(text))) start(target, tc, n, via);
  }
  function measure(c, t) {
    const from = t - R.WINDOW_MS; let total = 0, matches = 0;
    for (const m of c.msgs) { if (m.t < from) continue; total++; if (m.match) matches++; }
    return { total, matches, ratio: total ? matches / total : 0 };
  }
  function start(chan, c, n, via) {
    const t = now(); c.state = 'ACTIVE'; c.activeSince = t; c.seen.set(n, t);
    for (const [k, ts] of c.seen) if (t - ts > R.DEDUP_MS) c.seen.delete(k);
    c.alert = { id: uid(), ts: new Date(t).toISOString(), chan, login: c.login, name: c.name, text: c.lastText, role: c.lastRole, via, endedAt: null };
    log(`ALERTE ${chan}${via ? ' (relayée par ' + via + ')' : ''} ${c.lastRole} : ${c.lastText.slice(0, 100)}`);
    emit('alert', { ...c.alert }); emit('state', snapshot());
  }
  function end(c, reason) {
    const t = now(); c.state = 'INACTIVE'; c.activeSince = null; c.endedAt = t; c.cooldownUntil = t + R.COOLDOWN_MS;
    if (c.alert) { c.alert.endedAt = new Date(t).toISOString(); c.alert.userEnded = reason === 'utilisateur'; emit('end', { ...c.alert }); }
    log(`${c.login} : tombola terminée (${reason})`); c.alert = null;
  }
  function evaluate() {
    const t = now(), from = t - R.WINDOW_MS;
    for (const c of chans.values()) {
      c.msgs = c.msgs.filter(m => m.t >= from);
      const { ratio, total } = measure(c, t); c.rate = Math.round(total / (R.WINDOW_MS / 60_000));
      if (c.state === 'ACTIVE' && t - c.lastOfficialAt > R.END_NO_OFFICIAL_MS && ratio < R.END_RATIO_MAX) end(c, 'silence');
    }
    emit('state', snapshot());
  }
  function snapshot() {
    const t = now();
    return { ts: new Date(t).toISOString(), conn: { ...conn, total: chans.size }, chans: [...chans.values()].map(c => ({
      chan: '#' + c.login, login: c.login, name: c.name, custom: c.custom, state: c.state, alertId: c.alert?.id || null, activeSince: c.activeSince ? new Date(c.activeSince).toISOString() : null,
      rate: c.rate, quiet: !c.lastMsgAt || t - c.lastMsgAt > R.QUIET_AFTER_MS, text: c.state === 'ACTIVE' ? c.lastText : null, role: c.state === 'ACTIVE' ? c.lastRole : null,
    })) };
  }

  // ── IRC ──
  let ws, pingTimer, pongTimer, evalTimer, stopping = false, backoff = BACKOFF_MIN; const joined = new Set();
  const sendRaw = (s) => { if (ws?.readyState === 1) ws.send(s + '\r\n'); };
  const setConn = (status) => { conn.status = status; conn.joined = joined.size; emit('conn', status, { ...conn }); emit('state', snapshot()); };
  function connect() {
    conn.nick = 'justinfan' + (10000 + Math.floor(Math.random() * 89999)); setConn('connecting');
    ws = new WebSocketImpl('wss://irc-ws.chat.twitch.tv:443');
    const send = (s) => { if (ws.readyState === 1) ws.send(s + '\r\n'); };
    ws.addEventListener('open', async () => {
      log('connecté au chat Twitch'); backoff = BACKOFF_MIN; setConn('connected');
      send('CAP REQ :twitch.tv/tags twitch.tv/commands'); send('PASS SCHMOOPIIE'); send(`NICK ${conn.nick}`);
      const logins = [...chans.values()].map(c => c.login);
      for (let i = 0; i < logins.length; i += JOIN_BATCH) { if (i) await new Promise(r => setTimeout(r, JOIN_GAP_MS)); if (ws.readyState === 1) send('JOIN ' + logins.slice(i, i + JOIN_BATCH).map(l => '#' + l).join(',')); }
      pingTimer = setInterval(() => { send(`PING :client-${Date.now()}`); pongTimer = setTimeout(() => { log('pas de PONG, reconnexion'); ws.close(4000, 'pong timeout'); }, PONG_TIMEOUT_MS); }, PING_MS);
    });
    ws.addEventListener('message', (e) => {
      for (const line of String(e.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { send('PONG ' + line.slice(5)); continue; }
        const p = parseLine(line); if (!p) continue;
        switch (p.cmd) {
          case 'PONG': clearTimeout(pongTimer); break;
          case 'JOIN': if (p.prefix?.startsWith(conn.nick + '!')) { joined.add(p.params[0] || p.trailing); conn.joined = joined.size; if (joined.size === chans.size) { log(`${joined.size} chaînes rejointes`); setConn('connected'); } } break;
          case 'ROOMSTATE': { const c = chans.get(p.params[0]); if (c && !c.exists) { c.exists = true; emit('exists', c.login); } break; }
          case 'RECONNECT': log('reconnexion demandée par Twitch'); ws.close(4001, 'server reconnect'); break;
          case 'PRIVMSG': case 'USERNOTICE': onChat(p.params[0], p.tags.login || p.prefix?.split('!')[0] || '', p.tags.badges || '', p.trailing, p.tags['reply-parent-user-login']); break;
        }
      }
    });
    ws.addEventListener('close', (e) => {
      clearInterval(pingTimer); clearTimeout(pongTimer); joined.clear();
      log(`chat fermé (code ${e.code})`); if (stopping) return setConn('stopped');
      conn.reconnects++; setConn('reconnecting'); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, BACKOFF_MAX);
    });
    ws.addEventListener('error', () => log('erreur de connexion au chat'));
  }
  return {
    start() { stopping = false; connect(); evalTimer = setInterval(evaluate, R.EVAL_MS); },
    stop() { stopping = true; clearInterval(evalTimer); try { ws?.close(1000, 'stop'); } catch {} },
    endByUser(alertId) { for (const c of chans.values()) if (c.alert?.id === alertId) { end(c, 'utilisateur'); emit('state', snapshot()); return true; } return false; },
    /** Ajoute une chaîne à chaud (login Twitch). Retourne false si déjà présente ou invalide. */
    addChannel(login, name, custom = true) {
      login = String(login || '').trim().toLowerCase().replace(/^@|^#|^https?:\/\/(www\.)?twitch\.tv\//, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9_]{3,25}$/.test(login) || chans.has('#' + login)) return false;
      chans.set('#' + login, newChan({ login, name: name || login, custom })); sendRaw('JOIN #' + login); emit('state', snapshot()); return login;
    },
    /** Attend la confirmation que la chaîne existe (ROOMSTATE de Twitch). Résout false après timeoutMs. */
    awaitChannel(login, timeoutMs = 6000) {
      const c = chans.get('#' + login); if (!c) return Promise.resolve(false); if (c.exists) return Promise.resolve(true);
      return new Promise(resolve => { const t0 = Date.now(); const timer = setInterval(() => { if (c.exists) { clearInterval(timer); resolve(true); } else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(false); } }, 200); });
    },
    removeChannel(login) {
      const c = chans.get('#' + login); if (!c) return false;
      if (c.state === 'ACTIVE') end(c, 'utilisateur');
      chans.delete('#' + login); joined.delete('#' + login); sendRaw('PART #' + login); emit('state', snapshot()); return true;
    },
    snapshot, evaluate, _onChat: onChat,
  };
}
