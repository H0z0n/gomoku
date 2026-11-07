import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { data, load, save, flush } from './store.js';
import { verifyInitData } from './auth.js';
import { SIZE, findWin, turnOf } from './game.js';
import { startBot } from './bot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env необязателен */ }

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || undefined;
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const MINIAPP_NAME = (process.env.MINIAPP_NAME || '').trim();
const DEV = process.env.DEV === '1';
const PUBLIC = path.join(ROOT, 'public');

if (!BOT_TOKEN && !DEV) {
  console.error('Не задан BOT_TOKEN. Скопируйте .env.example в .env и впишите токен от @BotFather.');
  console.error('Для локальной проверки без Telegram поставьте DEV=1.');
  process.exit(1);
}

load(process.env.DATA_FILE || path.join(ROOT, 'data', 'db.json'));

// ───────────────────────── Пользователи и партии ─────────────────────────

class UserError extends Error {}
const fail = (msg, extra) => { throw Object.assign(new UserError(msg), extra); };
const DAY = 86_400_000;

function upsertUser(u) {
  const name = ([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Игрок').slice(0, 40);
  const rec = (data.users[u.id] ||= { id: u.id, notify: {} });
  if (rec.name !== name || rec.username !== (u.username || null)) {
    rec.name = name;
    rec.username = u.username || null;
    save();
  }
  return rec;
}

const nameOf = (uid) => data.users[uid]?.name || 'Соперник';
const seatOf = (g, uid) => { const i = g.players.indexOf(uid); return i < 0 ? null : i; };
const pairKey = (g) => [...g.players].sort((a, b) => a - b).join(':');
const touch = (g) => { g.updatedAt = Date.now(); };

function newId() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id;
  do id = Array.from(crypto.randomBytes(7), (b) => abc[b % abc.length]).join('');
  while (data.games[id]);
  return id;
}

function newGame(players, rule, status, turnTime) {
  const now = Date.now();
  const g = {
    id: newId(), players, rule, turnTime, deadline: null, moves: [], status,
    winner: null, winLine: null, endReason: null, undoRequest: null, nextId: null,
    createdAt: now, updatedAt: now,
  };
  data.games[g.id] = g;
  return g;
}

function getGame(id) {
  const g = typeof id === 'string' ? data.games[id] : null;
  if (!g) fail('Партия не найдена — возможно, её отменили', { notFound: true });
  return g;
}

function finish(g, winner, reason, line = null) {
  Object.assign(g, { status: 'finished', winner, endReason: reason, winLine: line, undoRequest: null });
  stopClock(g);
  if (winner === 0 || winner === 1) {
    const s = (data.scores[pairKey(g)] ||= {});
    const w = g.players[winner];
    s[w] = (s[w] || 0) + 1;
  }
}

function inviteLink(id) {
  if (bot) {
    // Ссылка сразу в Mini App работает, только если он настроен в @BotFather.
    // Иначе — ссылка на бота: /start КОД, и бот пришлёт кнопку «Открыть партию».
    if (MINIAPP_NAME) return `https://t.me/${bot.username}/${MINIAPP_NAME}?startapp=${id}`;
    if (bot.hasMainApp) return `https://t.me/${bot.username}?startapp=${id}`;
    return `https://t.me/${bot.username}?start=${id}`;
  }
  return `${WEBAPP_URL}/?room=${id}`;
}

function view(g, uid) {
  const score = data.scores[pairKey(g)] || {};
  return {
    id: g.id,
    rule: g.rule,
    turnTime: g.turnTime || 0,
    timeLeft: g.deadline ? Math.max(0, g.deadline - Date.now()) : null,
    moves: g.moves,
    status: g.status,
    winner: g.winner,
    winLine: g.winLine,
    endReason: g.endReason,
    undoRequest: g.undoRequest,
    nextId: g.nextId && data.games[g.nextId] ? g.nextId : null,
    you: seatOf(g, uid),
    players: g.players.map((p) => (p == null ? null : { name: nameOf(p), online: inRoom(g.id, p) })),
    score: g.players.map((p) => (p == null ? 0 : score[p] || 0)),
    invite: inviteLink(g.id),
  };
}

function listFor(uid) {
  const rank = (s) => (s.yourTurn ? 0 : s.status === 'finished' ? 2 : 1);
  return Object.values(data.games)
    .filter((g) => g.players.includes(uid))
    .map((g) => {
      const you = seatOf(g, uid);
      const opp = g.players[1 - you];
      return {
        id: g.id,
        status: g.status,
        rule: g.rule,
        turnTime: g.turnTime || 0,
        you,
        opponent: opp != null ? nameOf(opp) : null,
        yourTurn: g.status === 'playing' && turnOf(g) === you,
        result: g.status !== 'finished' ? null : g.winner === 'draw' ? 'draw' : g.winner === you ? 'win' : 'loss',
        moves: g.moves.length,
        updatedAt: g.updatedAt,
      };
    })
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, 50);
}

function prune() {
  const now = Date.now();
  for (const [id, g] of Object.entries(data.games)) {
    const age = now - g.updatedAt;
    if ((g.status === 'waiting' && age > 14 * DAY) || (g.status === 'finished' && age > 60 * DAY) || age > 365 * DAY) {
      delete data.games[id];
    }
  }
  for (const u of Object.values(data.users)) {
    for (const gid of Object.keys(u.notify || {})) if (!data.games[gid]) delete u.notify[gid];
  }
  save();
}

// ───────────────────────── Время на ход ─────────────────────────

const TURN_TIMES = [30, 60, 0]; // секунды; 0 — без ограничения
const clocks = new Map(); // gameId -> timeout

function stopClock(g) {
  clearTimeout(clocks.get(g.id));
  clocks.delete(g.id);
  g.deadline = null;
}

function scheduleClock(g) {
  clearTimeout(clocks.get(g.id));
  clocks.set(g.id, setTimeout(() => onTimeout(g.id), Math.max(0, g.deadline - Date.now()) + 50));
}

/**
 * Запускает отсчёт для того, чья сейчас очередь. Первый ход партии ждёт,
 * пока в игре окажутся оба соперника, — иначе создатель партии проиграл бы,
 * пока ещё не увидел уведомление о начале.
 */
function startClock(g) {
  stopClock(g);
  if (g.status !== 'playing' || !g.turnTime) return;
  if (!g.moves.length && !g.players.every((p) => inRoom(g.id, p))) return;
  g.deadline = Date.now() + g.turnTime * 1000;
  scheduleClock(g);
}

function onTimeout(id) {
  clocks.delete(id);
  const g = data.games[id];
  if (!g || g.status !== 'playing' || !g.deadline) return;
  if (Date.now() < g.deadline) { scheduleClock(g); return; }
  const loser = turnOf(g);
  finish(g, 1 - loser, 'timeout');
  touch(g);
  save();
  const [l, w] = [g.players[loser], g.players[1 - loser]];
  notify(w, g.id, `${nameOf(l)} не успевает сделать ход — победа за тобой! 🎉`);
  notify(l, g.id, 'Время на ход вышло — партия проиграна.');
  broadcast(g);
  refreshLists(g);
}

// ───────────────────────── Комнаты и рассылка ─────────────────────────

const rooms = new Map(); // gameId -> Set<ws>

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const roomClients = (id) => rooms.get(id) || new Set();
const inRoom = (id, uid) => [...roomClients(id)].some((ws) => ws.user.id === uid);
const userOnline = (uid) => [...wss.clients].some((ws) => ws.user?.id === uid);

function broadcast(g) {
  for (const ws of roomClients(g.id)) send(ws, { t: 'game', game: view(g, ws.user.id) });
}

/** Обновить список партий у игроков, которые сейчас на главном экране. */
function refreshLists(g) {
  for (const ws of wss.clients) {
    if (ws.user && !ws.room && g.players.includes(ws.user.id)) send(ws, { t: 'games', games: listFor(ws.user.id) });
  }
}

function joinRoom(ws, id) {
  if (ws.room !== id) {
    leaveRoom(ws);
    if (!rooms.has(id)) rooms.set(id, new Set());
    rooms.get(id).add(ws);
    ws.room = id;
  }
  const g = data.games[id];
  if (g.status === 'playing' && !g.moves.length && !g.deadline) startClock(g); // оба на месте — пошёл первый ход
  broadcast(g);
}

function leaveRoom(ws) {
  const id = ws.room;
  if (!id) return;
  ws.room = null;
  const set = rooms.get(id);
  if (set) { set.delete(ws); if (!set.size) rooms.delete(id); }
  if (data.games[id]) broadcast(data.games[id]); // соперник увидит, что мы вышли
}

// ───────────────────────── Уведомления через бота ─────────────────────────

let bot = null;

async function notify(uid, gameId, text, buttonText) {
  if (!bot || uid == null || uid < 0 || userOnline(uid)) return;
  const u = data.users[uid];
  if (!u) return;
  u.notify ||= {};
  try {
    const prev = u.notify[gameId];
    u.notify[gameId] = await bot.send(uid, text, gameId, buttonText);
    if (prev) bot.del(uid, prev); // в чате остаётся только свежее уведомление по партии
    save();
  } catch (e) {
    console.warn(`Не удалось уведомить ${uid}:`, e.description || e.message);
  }
}

function clearNotice(uid, gameId) {
  const u = data.users[uid];
  const msgId = u?.notify?.[gameId];
  if (!bot || !msgId) return;
  delete u.notify[gameId];
  bot.del(uid, msgId);
  save();
}

// ───────────────────────── Обработчики сообщений ─────────────────────────

const handlers = {
  list(ws) {
    leaveRoom(ws);
    send(ws, { t: 'games', games: listFor(ws.user.id) });
  },

  create(ws, m) {
    const turnTime = TURN_TIMES.includes(m.time) ? m.time : TURN_TIMES[0];
    const players = [null, null];
    players[crypto.randomInt(2)] = ws.user.id; // цвет (кто ходит первым) — случайно
    const g = newGame(players, 'free', 'waiting', turnTime);
    save();
    joinRoom(ws, g.id);
  },

  open(ws, m) {
    const g = getGame(m.id);
    const uid = ws.user.id;
    if (g.status === 'waiting' && seatOf(g, uid) == null) {
      g.players[g.players.indexOf(null)] = uid;
      g.status = 'playing';
      touch(g);
      save();
      const host = g.players.find((p) => p !== uid);
      notify(host, g.id,
        `${nameOf(uid)} принимает приглашение — партия началась!` +
        (turnOf(g) === seatOf(g, host) ? '\nТвой ход ⚫' : ''));
      refreshLists(g);
    }
    joinRoom(ws, g.id);
    if (seatOf(g, uid) != null) clearNotice(uid, g.id);
  },

  leave(ws) {
    leaveRoom(ws);
  },

  move(ws, m) {
    const g = getGame(m.id);
    const uid = ws.user.id;
    const me = seatOf(g, uid);
    if (me == null) fail('Ты не участвуешь в этой партии');
    if (g.status !== 'playing') fail('Партия уже не идёт');
    if (turnOf(g) !== me) fail('Сейчас ход соперника');
    const { x, y } = m;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE) fail('Неверный ход');
    if (g.moves.some(([a, b]) => a === x && b === y)) fail('Эта точка уже занята');

    g.moves.push([x, y]);
    g.undoRequest = null;
    touch(g);
    startClock(g);
    const opp = g.players[1 - me];
    const line = findWin(g.moves, g.rule);
    if (line) {
      finish(g, me, 'five', line);
      notify(opp, g.id, `${nameOf(uid)} выстраивает пять в ряд — партия окончена.\nСыграем ещё?`);
    } else if (g.moves.length === SIZE * SIZE) {
      finish(g, 'draw', 'full');
      notify(opp, g.id, 'Доска заполнена — ничья!');
    } else {
      notify(opp, g.id, `Твой ход! Партия с ${nameOf(uid)}, ход ${g.moves.length + 1}.`);
    }
    save();
    broadcast(g);
    refreshLists(g);
  },

  resign(ws, m) {
    const g = getGame(m.id);
    const me = seatOf(g, ws.user.id);
    if (me == null || g.status !== 'playing') fail('Сдаться сейчас нельзя');
    finish(g, 1 - me, 'resign');
    touch(g);
    save();
    notify(g.players[1 - me], g.id, `${nameOf(ws.user.id)} сдаётся — победа за тобой! 🎉`);
    broadcast(g);
    refreshLists(g);
  },

  cancel(ws, m) {
    const g = getGame(m.id);
    if (g.status !== 'waiting' || seatOf(g, ws.user.id) == null) fail('Эту партию уже нельзя отменить');
    stopClock(g);
    delete data.games[g.id];
    save();
    for (const c of roomClients(g.id)) { c.room = null; send(c, { t: 'deleted', id: g.id }); }
    rooms.delete(g.id);
  },

  undo_request(ws, m) {
    const g = getGame(m.id);
    const me = seatOf(g, ws.user.id);
    if (me == null || g.status !== 'playing') fail('Сейчас нельзя вернуть ход');
    if (!g.moves.length || (g.moves.length - 1) % 2 !== me) fail('Вернуть можно только свой последний ход, пока соперник не сходил');
    if (g.undoRequest != null) fail('Запрос уже отправлен');
    g.undoRequest = me;
    touch(g);
    save();
    notify(g.players[1 - me], g.id, `${nameOf(ws.user.id)} просит вернуть последний ход.`);
    broadcast(g);
  },

  undo_answer(ws, m) {
    const g = getGame(m.id);
    const me = seatOf(g, ws.user.id);
    if (me == null || g.undoRequest == null || g.undoRequest === me) fail('Запроса на возврат хода нет');
    if (m.accept) g.moves.pop();
    g.undoRequest = null;
    touch(g);
    startClock(g); // и при возврате, и при отказе отвечавший не теряет время на раздумья
    save();
    broadcast(g);
    refreshLists(g);
  },

  rematch(ws, m) {
    const g = getGame(m.id);
    const uid = ws.user.id;
    const me = seatOf(g, uid);
    if (me == null || g.status !== 'finished') fail('Реванш доступен после окончания партии');
    let ng = g.nextId && data.games[g.nextId];
    if (!ng) {
      ng = newGame([g.players[1], g.players[0]], g.rule, 'playing', g.turnTime || 0); // цвета меняются
      g.nextId = ng.id;
      save();
      const opp = g.players[1 - me];
      clearNotice(opp, g.id);
      notify(opp, ng.id,
        `${nameOf(uid)} предлагает реванш — цвета поменялись!` + (ng.players[0] === opp ? '\nТвой ход ⚫' : ''));
      broadcast(g); // соперник на экране итогов увидит кнопку «К реваншу»
      refreshLists(ng);
    }
    for (const c of roomClients(g.id)) if (c.user.id === uid) send(c, { t: 'goto', id: ng.id });
  },
};

function hello(ws, m) {
  let tgUser = null;
  if (m.initData && BOT_TOKEN) tgUser = verifyInitData(m.initData, BOT_TOKEN);
  else if (DEV && m.dev?.name) {
    const name = String(m.dev.name).slice(0, 32);
    const hash = parseInt(crypto.createHash('sha1').update(name).digest('hex').slice(0, 8), 16);
    tgUser = { id: -(hash + 1), first_name: name }; // отрицательный id — «ненастоящий» пользователь
  }
  if (!tgUser) {
    send(ws, { t: 'error', fatal: true, msg: 'Открой игру через бота в Telegram' });
    ws.close();
    return;
  }
  const rec = upsertUser(tgUser);
  ws.user = { id: rec.id };
  send(ws, { t: 'ready', me: { id: rec.id, name: rec.name } });
}

// ───────────────────────── HTTP + WebSocket ─────────────────────────

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { pathname = '/'; }
  if (pathname === '/health') { res.end('ok'); return; }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(PUBLIC, path.normalize(pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!ws.user) { if (m.t === 'hello') hello(ws, m); return; }
    const h = Object.hasOwn(handlers, m.t) ? handlers[m.t] : null;
    if (!h) return;
    try {
      h(ws, m);
    } catch (e) {
      if (e instanceof UserError) send(ws, { t: 'error', msg: e.message, notFound: !!e.notFound });
      else { console.error(e); send(ws, { t: 'error', msg: 'Ошибка сервера' }); }
    }
  });
  ws.on('close', () => leaveRoom(ws));
});

// Отключаем «мёртвые» соединения, чтобы статус «в игре» был честным
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

prune();
setInterval(prune, 6 * 3600_000).unref();

// Пока сервер был выключен, ходить было нельзя — после запуска даём полное время заново
for (const g of Object.values(data.games)) if (g.status === 'playing' && g.turnTime) startClock(g);

if (BOT_TOKEN) {
  bot = await startBot({
    token: BOT_TOKEN,
    webappUrl: WEBAPP_URL,
    onUser: upsertUser,
    getInviteInfo: (room) => {
      const g = data.games[room];
      if (!g) return null;
      const host = g.players.find((p) => p != null);
      return { status: g.status, host: nameOf(host) };
    },
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Гомоку запущено: http://localhost:${PORT}${DEV ? '  [DEV: можно открыть в браузере, ?as=Имя]' : ''}`);
});

const shutdown = () => {
  flush();
  bot?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
