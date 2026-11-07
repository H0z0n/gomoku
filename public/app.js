'use strict';

const tg = window.Telegram && window.Telegram.WebApp;
const inTg = !!(tg && tg.initData);
const SIZE = 15;
const PAD = 0.7;
const VB = SIZE - 1 + PAD * 2;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  ws: null,
  ready: false,
  fatal: false,
  me: null,
  screen: 'home',
  game: null,
  games: null,
  sel: null,          // выбранная, но ещё не подтверждённая точка
  startHandled: false,
  askedWrite: false,
  opts: { rule: 'free', first: 'me' },
};

// ───────────────────────── Telegram ─────────────────────────

const tgAtLeast = (v) => !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v));

function haptic(kind, arg) {
  try {
    const h = tg && tg.HapticFeedback;
    if (!h || !tgAtLeast('6.1')) return;
    if (kind === 'impact') h.impactOccurred(arg || 'light');
    else if (kind === 'notify') h.notificationOccurred(arg);
    else h.selectionChanged();
  } catch { /* старый клиент */ }
}

function ask(text) {
  return new Promise((resolve) => {
    if (inTg && tgAtLeast('6.2')) tg.showConfirm(text, (ok) => resolve(!!ok));
    else resolve(window.confirm(text));
  });
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

/** Комната из ссылки: ?room=… (кнопка бота) или startapp=… (прямая ссылка на Mini App). */
function startRoom() {
  const q = new URLSearchParams(location.search).get('room');
  return q || (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || null;
}

function setUrlRoom(id) {
  try {
    const url = new URL(location.href);
    if (id) url.searchParams.set('room', id); else url.searchParams.delete('room');
    history.replaceState(null, '', url);
  } catch { /* не критично */ }
}

/** Если соперник открыл игру по прямой ссылке, у бота может не быть права ему писать. */
function requestWriteAccess() {
  if (S.askedWrite || !inTg || !tgAtLeast('6.9')) return;
  S.askedWrite = true;
  const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (user && user.allows_write_to_pm) return;
  try { tg.requestWriteAccess(); } catch { /* пользователь откажется — просто не будет уведомлений */ }
}

// ───────────────────────── Соединение ─────────────────────────

let retry = 0;

function devName() {
  const q = new URLSearchParams(location.search).get('as');
  if (q) return q;
  let n = null;
  try { n = localStorage.getItem('gomoku-dev-name'); } catch { /* приватный режим */ }
  if (!n) {
    n = 'Гость ' + Math.floor(100 + Math.random() * 900);
    try { localStorage.setItem('gomoku-dev-name', n); } catch { /* ок */ }
  }
  return n;
}

function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  S.ws = ws;
  ws.onopen = () => {
    retry = 0;
    ws.send(JSON.stringify(inTg ? { t: 'hello', initData: tg.initData } : { t: 'hello', dev: { name: devName() } }));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.ready = false;
    renderConn();
    if (!S.fatal) setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
  };
}

function send(m) {
  if (S.ws && S.ws.readyState === 1 && S.ready) { S.ws.send(JSON.stringify(m)); return true; }
  toast('Нет соединения, переподключаюсь…');
  return false;
}

function onMessage(m) {
  switch (m.t) {
    case 'ready': {
      S.ready = true;
      S.me = m.me;
      renderConn();
      const room = !S.startHandled && startRoom();
      S.startHandled = true;
      if (S.game) send({ t: 'open', id: S.game.id });
      else if (room) send({ t: 'open', id: room });
      else send({ t: 'list' });
      break;
    }
    case 'games':
      S.games = m.games;
      renderHome();
      break;
    case 'game':
      onGame(m.game);
      break;
    case 'goto':
      S.sel = null;
      send({ t: 'open', id: m.id });
      break;
    case 'deleted':
      if (S.game && S.game.id === m.id) { toast('Партия отменена'); goHome(); }
      break;
    case 'error':
      haptic('notify', 'error');
      if (m.fatal) { S.fatal = true; showFatal(m.msg); return; }
      toast(m.msg);
      if (m.notFound) goHome();
      else if (S.game) send({ t: 'open', id: S.game.id }); // пересинхронизация после оптимистичного хода
      break;
  }
}

// ───────────────────────── Навигация ─────────────────────────

function showScreen(name) {
  S.screen = name;
  for (const id of ['home', 'game', 'fatal']) $('#' + id).classList.toggle('hidden', id !== name);
  $('#btn-back').classList.toggle('hidden', inTg);
  if (inTg && tgAtLeast('6.1')) {
    if (name === 'game') tg.BackButton.show(); else tg.BackButton.hide();
  }
}

function goHome() {
  if (S.ready) send({ t: 'list' });
  S.game = null;
  S.sel = null;
  setUrlRoom(null);
  showScreen('home');
  renderHome();
}

function showFatal(text) {
  $('#fatal-text').textContent = text;
  showScreen('fatal');
}

// ───────────────────────── Главный экран ─────────────────────────

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function badge(g) {
  if (g.status === 'waiting') return ['Ожидание', ''];
  if (g.status === 'playing') return g.yourTurn ? ['Твой ход', 'accent'] : ['Ход соперника', ''];
  if (g.result === 'win') return ['Победа', 'good'];
  if (g.result === 'loss') return ['Поражение', 'bad'];
  return ['Ничья', ''];
}

function renderHome() {
  const box = $('#games');
  if (!S.games) { box.innerHTML = '<div class="empty">Загрузка…</div>'; return; }
  if (!S.games.length) {
    box.innerHTML = '<div class="empty">Партий пока нет.<br>Создай новую и отправь приглашение!</div>';
    return;
  }
  box.innerHTML = S.games.map((g) => {
    const [label, cls] = badge(g);
    const title = g.opponent ? esc(g.opponent) : 'Ждём соперника';
    const rule = g.rule === 'exact' ? 'ровно 5' : '5+';
    return `<button class="item" data-id="${esc(g.id)}">
      <span class="stone ${g.you === 0 ? 'black' : 'white'}"></span>
      <span class="item-main">
        <span class="item-title">${title}</span>
        <span class="item-sub">${rule} · ходов: ${g.moves} · ${ago(g.updatedAt)}</span>
      </span>
      <span class="badge ${cls}">${label}</span>
    </button>`;
  }).join('');
}

// ───────────────────────── Партия ─────────────────────────

const turnOf = (g) => g.moves.length % 2;
const occupied = (g, x, y) => g.moves.some(([a, b]) => a === x && b === y);
const canMove = (g = S.game) => !!g && g.status === 'playing' && g.you != null && turnOf(g) === g.you;

function onGame(g) {
  const prev = S.game && S.game.id === g.id ? S.game : null;
  if (prev) {
    if (g.moves.length > prev.moves.length && (g.moves.length - 1) % 2 !== g.you) haptic('impact', 'medium');
    if (prev.status !== 'finished' && g.status === 'finished' && g.you != null) {
      haptic('notify', g.winner === g.you ? 'success' : 'warning');
    }
    if (prev.status === 'waiting' && g.status === 'playing') { toast('Соперник подключился!'); haptic('notify', 'success'); }
    if (prev.undoRequest === g.you && g.you != null && g.undoRequest == null && g.status === 'playing') {
      toast(g.moves.length < prev.moves.length ? 'Ход возвращён' : 'Соперник не разрешил вернуть ход');
    }
  } else {
    S.sel = null;
    setUrlRoom(g.id);
  }
  S.game = g;
  if (S.sel && (!canMove(g) || occupied(g, S.sel.x, S.sel.y))) S.sel = null;
  if (S.screen !== 'game') showScreen('game');
  if (g.you != null && g.status !== 'finished') requestWriteAccess();
  renderGame(prev);
}

function statusInfo(g) {
  const you = g.you;
  if (g.status === 'waiting') return ['Ждём соперника', ''];
  if (g.status === 'playing') {
    if (you == null) return [turnOf(g) === 0 ? 'Ходят чёрные' : 'Ходят белые', ''];
    return turnOf(g) === you ? ['Твой ход', 'mine'] : ['Ход соперника', ''];
  }
  if (g.winner === 'draw') return ['Ничья — доска заполнена', ''];
  if (you == null) {
    const p = g.players[g.winner];
    return [`Победа: ${p ? p.name : ''} (${g.winner === 0 ? 'чёрные' : 'белые'})`, ''];
  }
  if (g.winner === you) return [g.endReason === 'resign' ? 'Соперник сдался — победа! 🎉' : 'Пять в ряд — победа! 🎉', 'win'];
  return [g.endReason === 'resign' ? 'Партия сдана' : 'Соперник собрал пять в ряд', 'loss'];
}

function renderGame(prev) {
  const g = S.game;
  if (!g) return;

  g.players.forEach((p, i) => {
    const el = $('#p' + i);
    el.querySelector('.pname').textContent = p ? p.name : 'Свободно';
    el.querySelector('.pmeta').textContent = !p ? 'ждём…' : i === g.you ? 'это ты' : p.online ? 'в игре' : 'не в сети';
    el.classList.toggle('online', !!p && i !== g.you && p.online);
    el.classList.toggle('active', g.status === 'playing' && turnOf(g) === i);
  });
  $('#score').textContent = `${g.score[0]} : ${g.score[1]}`;

  const [text, cls] = statusInfo(g);
  const st = $('#status');
  st.textContent = text;
  st.className = 'status ' + cls;

  $('#waiting').classList.toggle('hidden', g.status !== 'waiting' || g.you == null);
  renderBoard(prev);
  renderBanner();
  renderActions();
}

function initBoard() {
  const svg = $('#board');
  svg.setAttribute('viewBox', `${-PAD} ${-PAD} ${VB} ${VB}`);
  let grid = '';
  for (let i = 0; i < SIZE; i++) {
    grid += `<line x1="0" y1="${i}" x2="${SIZE - 1}" y2="${i}"/><line x1="${i}" y1="0" x2="${i}" y2="${SIZE - 1}"/>`;
  }
  const stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.11"/>`).join('');
  svg.innerHTML = `
    <defs>
      <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ecc67f"/><stop offset="1" stop-color="#d9a657"/>
      </linearGradient>
      <radialGradient id="gb" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#6a6a6a"/><stop offset="1" stop-color="#0b0b0b"/></radialGradient>
      <radialGradient id="gw" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cdcdcd"/></radialGradient>
    </defs>
    <rect class="wood" x="${-PAD}" y="${-PAD}" width="${VB}" height="${VB}" rx="0.3"/>
    <g class="grid">${grid}</g>
    <g class="stars">${stars}</g>
    <g id="stones"></g>
    <g id="marks"></g>`;
  svg.addEventListener('click', onBoardClick);
}

function stoneSvg(x, y, white, extra = '') {
  return `<circle class="shadow" cx="${x + 0.05}" cy="${y + 0.08}" r="0.45"/>` +
         `<circle class="st ${white ? 'w' : 'b'} ${extra}" cx="${x}" cy="${y}" r="0.46"/>`;
}

function renderBoard(prev) {
  const g = S.game;
  const fresh = prev ? prev.moves.length : g.moves.length;
  let stones = '';
  g.moves.forEach(([x, y], i) => { stones += stoneSvg(x, y, i % 2 === 1, i >= fresh ? 'new' : ''); });

  let marks = '';
  if (S.sel) {
    marks += `<circle class="st ghost ${g.you === 1 ? 'w' : 'b'}" cx="${S.sel.x}" cy="${S.sel.y}" r="0.46"/>` +
             `<circle class="target" cx="${S.sel.x}" cy="${S.sel.y}" r="0.6"/>`;
  }
  const last = g.moves[g.moves.length - 1];
  if (last && !g.winLine) marks += `<circle class="last" cx="${last[0]}" cy="${last[1]}" r="0.13"/>`;
  if (g.winLine) {
    const a = g.winLine[0];
    const b = g.winLine[g.winLine.length - 1];
    marks += `<line class="winline" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  }
  $('#stones').innerHTML = stones;
  $('#marks').innerHTML = marks;
}

function onBoardClick(e) {
  const g = S.game;
  if (!g) return;
  if (!canMove(g)) {
    if (g.status === 'playing' && g.you != null) { toast('Сейчас ход соперника'); haptic('notify', 'warning'); }
    return;
  }
  const r = e.currentTarget.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * VB - PAD);
  const y = Math.round(((e.clientY - r.top) / r.height) * VB - PAD);
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || occupied(g, x, y)) return;
  if (S.sel && S.sel.x === x && S.sel.y === y) { place(); return; }
  S.sel = { x, y };
  haptic('select');
  renderBoard();
  renderActions();
}

function place() {
  const g = S.game;
  if (!S.sel || !canMove(g)) return;
  const { x, y } = S.sel;
  if (!send({ t: 'move', id: g.id, x, y })) return;
  haptic('impact', 'light');
  // Оптимистично рисуем ход сразу, сервер пришлёт подтверждённое состояние
  const prev = { ...g, moves: g.moves.slice() };
  S.sel = null;
  S.game = { ...g, moves: [...g.moves, [x, y]], undoRequest: null };
  renderGame(prev);
}

function renderBanner() {
  const g = S.game;
  const el = $('#banner');
  let html = '';
  if (g.status === 'playing' && g.you != null && g.undoRequest != null && g.undoRequest !== g.you) {
    html = `<span class="text">Соперник просит вернуть последний ход</span>
      <button class="btn primary" data-act="undo-yes">Разрешить</button>
      <button class="btn" data-act="undo-no">Нет</button>`;
  } else if (g.status === 'finished' && g.you != null && g.nextId) {
    html = '<span class="text">Соперник предлагает реванш! 🔁</span>';
  }
  el.innerHTML = html;
  el.classList.toggle('hidden', !html);
}

const btn = (act, text, cls = '', disabled = false) =>
  `<button class="btn ${cls}" data-act="${act}"${disabled ? ' disabled' : ''}>${text}</button>`;

function renderActions() {
  const g = S.game;
  let html = '';
  if (g.you == null) {
    html = '<div class="hint center" style="flex:1">Ты наблюдаешь за партией</div>';
  } else if (g.status === 'playing') {
    const lastMine = g.moves.length > 0 && (g.moves.length - 1) % 2 === g.you;
    const myRequest = g.undoRequest === g.you;
    html =
      btn('resign', 'Сдаться', 'ghost danger') +
      btn('undo', myRequest ? 'Ждём…' : 'Вернуть ход', 'ghost', !lastMine || g.undoRequest != null) +
      btn('place', canMove(g) ? 'Поставить' : 'Ход соперника', 'primary', !S.sel);
  } else if (g.status === 'finished') {
    html = btn('home', 'К партиям', 'ghost') + btn('rematch', g.nextId ? 'К реваншу' : 'Реванш', 'primary');
  }
  $('#actions').innerHTML = html;
}

async function onAction(act) {
  const g = S.game;
  if (!g) return;
  switch (act) {
    case 'place': place(); break;
    case 'undo': send({ t: 'undo_request', id: g.id }); break;
    case 'undo-yes': send({ t: 'undo_answer', id: g.id, accept: true }); break;
    case 'undo-no': send({ t: 'undo_answer', id: g.id, accept: false }); break;
    case 'resign': if (await ask('Сдаться в этой партии?')) send({ t: 'resign', id: g.id }); break;
    case 'rematch': send({ t: 'rematch', id: g.id }); break;
    case 'home': goHome(); break;
    case 'share': share(g.invite); break;
    case 'copy': copy(g.invite); break;
    case 'cancel': if (await ask('Отменить партию?')) send({ t: 'cancel', id: g.id }); break;
  }
}

// ───────────────────────── Приглашение ─────────────────────────

const INVITE_TEXT = 'Сыграем в гомоку? Пять в ряд ⚫⚪';

function share(link) {
  if (inTg) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(INVITE_TEXT)}`);
  } else if (navigator.share) {
    navigator.share({ title: 'Гомоку', text: INVITE_TEXT, url: link }).catch(() => {});
  } else {
    copy(link);
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Ссылка скопирована');
  } catch {
    window.prompt('Скопируй ссылку:', text);
  }
}

// ───────────────────────── Создание партии ─────────────────────────

function openSheet() {
  $('#sheet').classList.remove('hidden');
  haptic('select');
}
function closeSheet() { $('#sheet').classList.add('hidden'); }

function renderConn() {
  $('#conn').textContent = S.ready || S.fatal ? '' : 'Подключение…';
}

// ───────────────────────── Запуск ─────────────────────────

function init() {
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (tgAtLeast('7.7')) tg.disableVerticalSwipes(); // чтобы свайп по доске не закрывал приложение
      if (tgAtLeast('6.1')) {
        tg.setHeaderColor('bg_color');
        tg.BackButton.onClick(goHome);
      }
    } catch { /* старый клиент */ }
  }

  initBoard();

  $('#btn-new').addEventListener('click', openSheet);
  $('#btn-sheet-close').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#btn-create').addEventListener('click', () => {
    if (send({ t: 'create', rule: S.opts.rule, first: S.opts.first })) closeSheet();
  });
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      S.opts[seg.dataset.key] = b.dataset.v;
      haptic('select');
    });
  });

  $('#games').addEventListener('click', (e) => {
    const item = e.target.closest('.item[data-id]');
    if (item) send({ t: 'open', id: item.dataset.id });
  });
  $('#btn-back').addEventListener('click', goHome);
  for (const sel of ['#actions', '#banner', '#waiting']) {
    $(sel).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b && !b.disabled) onAction(b.dataset.act);
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.screen === 'home' && S.ready) send({ t: 'list' });
  });
  setInterval(() => { if (S.screen === 'home' && S.games) renderHome(); }, 60_000); // «N мин назад»

  showScreen('home');
  renderHome();
  renderConn();
  connect();
}

init();
