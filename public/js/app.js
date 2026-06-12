'use strict';

/* ============================================================
   Vitrea client — single state-driven render, no frameworks.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const SESSION_KEY = 'vitrea-session';
const NAME_KEY = 'vitrea-name';

const ui = {
  home: $('#screen-home'),
  lobby: $('#screen-lobby'),
  game: $('#screen-game'),
  end: $('#screen-end'),
};

const state = {
  ws: null,
  connected: false,
  retryMs: 500,
  you: null, // {id, token}
  room: null, // last server snapshot
  lastSeq: 0, // last animated game event
  firstSnapshot: true, // skip animating history on (re)join
  selected: null, // selected hand shard index while placing
  prevHand: [], // hand before the latest snapshot, for the shatter animation
  bustFreeze: false, // keep the shattering hand on screen briefly
};

/* ---------------- session ---------------- */

function saveSession(code, token) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ code, token }));
}
function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/* ---------------- websocket ---------------- */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    state.retryMs = 500;
    const session = loadSession();
    if (session && session.code && session.token) {
      send({ type: 'rejoin', code: session.code, token: session.token });
    }
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    state.connected = false;
    setTimeout(connect, state.retryMs);
    state.retryMs = Math.min(state.retryMs * 2, 8000);
  };
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      state.you = msg.you;
      state.firstSnapshot = true;
      saveSession(msg.code, msg.you.token);
      break;
    case 'state':
      applyState(msg);
      break;
    case 'error':
      if (msg.fatal) {
        clearSession();
        state.room = null;
        showScreen('home');
      }
      toast(msg.message, true);
      break;
  }
}

function applyState(room) {
  const prevGame = state.room && state.room.game;
  state.prevHand = prevGame ? prevGame.hand.slice() : [];
  state.room = room;

  if (room.game) {
    const maxSeq = room.game.events.reduce((m, ev) => Math.max(m, ev.seq), 0);
    if (state.firstSnapshot || maxSeq < state.lastSeq) {
      state.lastSeq = maxSeq; // joined mid-game or a fresh game began
    } else {
      processEvents(room.game.events.filter((ev) => ev.seq > state.lastSeq));
      state.lastSeq = maxSeq;
    }
  } else {
    state.lastSeq = 0;
  }
  state.firstSnapshot = false;

  if (!myTurnPlacing()) state.selected = null;
  render();
}

/* ---------------- helpers ---------------- */

function me() {
  return state.room && state.you
    ? state.room.players.find((p) => p.id === state.you.id)
    : null;
}
function game() {
  return state.room && state.room.game;
}
function myGamePlayer() {
  const g = game();
  return g && state.you ? g.players.find((p) => p.id === state.you.id) : null;
}
function activePlayer() {
  const g = game();
  return g ? g.players[g.turnSeat] : null;
}
function isMyTurn() {
  const a = activePlayer();
  return !!(a && state.you && a.id === state.you.id);
}
function myTurnPlacing() {
  const g = game();
  return g && g.phase === 'playing' && isMyTurn() && g.turnPhase === 'place';
}
function amHost() {
  return !!(state.room && state.you && state.room.hostId === state.you.id);
}
function colorName(shard) {
  return shard.charAt(0).toUpperCase() + shard.slice(1);
}

function canPlace(player, shard, r, c, rules) {
  if (player.window[r][c] !== null) return false;
  if (shard === rules.prism) return true;
  const around = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
  return around.every(([nr, nc]) => {
    if (nr < 0 || nr >= rules.rows || nc < 0 || nc >= rules.cols) return true;
    return player.window[nr][nc] !== shard;
  });
}

function legalCells(player, shard, rules) {
  const out = [];
  for (let r = 0; r < rules.rows; r++) {
    for (let c = 0; c < rules.cols; c++) {
      if (canPlace(player, shard, r, c, rules)) out.push(`${r},${c}`);
    }
  }
  return out;
}

function crackRisk(g) {
  if (g.hand.length === 0 || g.bagCount === 0) return 0;
  let danger = 0;
  for (const shard of new Set(g.hand)) danger += g.bagCounts[shard] || 0;
  return Math.round((danger / g.bagCount) * 100);
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

/* ---------------- events → theatre ---------------- */

function processEvents(events) {
  const g = game();
  for (const ev of events) {
    const mine = state.you && g.players[ev.seat] && g.players[ev.seat].id === state.you.id;
    switch (ev.type) {
      case 'bust':
        playBustAnimation();
        banner('Crack!', 'b-crack');
        vibrate([60, 40, 120]);
        if (!mine) toast(`${ev.name}'s glass shattered`);
        break;
      case 'spectrum':
        banner('Perfect Spectrum +' + ev.points, 'b-spectrum');
        vibrate([30, 30, 30, 30, 90]);
        if (!mine) toast(`${ev.name} drew a Perfect Spectrum!`);
        break;
      case 'score': {
        const what = ev.reason === 'socket' ? 'socket matched'
          : ev.reason === 'row' ? 'row complete'
          : 'column complete';
        toast(`+${ev.points} ${what} — ${g.players[ev.seat].name}`);
        break;
      }
      case 'finish':
        banner(`${mine ? 'You' : ev.name} finished! +${ev.points}`, 'b-gold');
        toast('Final turns — the round plays out');
        break;
      case 'turn':
        if (mine) {
          banner('Your turn', 'b-gold');
          vibrate(40);
        }
        break;
      case 'skipped':
        toast(`${ev.name}'s turn was skipped`);
        break;
      case 'pass':
        if (!mine) toast(`${ev.name} passed`);
        break;
    }
  }
}

// Briefly re-show the pre-bust hand so the shards can visibly shatter.
function playBustAnimation() {
  state.bustFreeze = true;
  const lostHand = state.prevHand;
  const row = $('#hand-row');
  row.innerHTML = '';
  for (const shard of lostHand) row.appendChild(shardEl(shard, 'shatter'));
  $('#kiln').classList.add('crack-shake');
  setTimeout(() => {
    $('#kiln').classList.remove('crack-shake');
    state.bustFreeze = false;
    render();
  }, 750);
}

function banner(text, cls) {
  const el = $('#banner');
  const span = $('#banner-text');
  el.hidden = true;
  span.textContent = text;
  span.className = cls;
  void span.offsetWidth; // restart animation
  el.hidden = false;
  clearTimeout(banner._t);
  banner._t = setTimeout(() => { el.hidden = true; }, 1900);
}

function toast(text, isError = false) {
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

/* ---------------- rendering ---------------- */

function showScreen(name) {
  for (const key of Object.keys(ui)) ui[key].hidden = key !== name;
}

function render() {
  const room = state.room;
  if (!room) {
    showScreen('home');
    return;
  }
  if (room.phase === 'lobby') {
    showScreen('lobby');
    renderLobby();
  } else if (room.phase === 'playing') {
    showScreen('game');
    renderGame();
  } else {
    showScreen('end');
    renderEnd();
  }
}

const GEM_COLORS = ['ruby', 'amber', 'emerald', 'sapphire', 'amethyst', 'moonstone'];

function gemDot(i, size = 16) {
  const dot = document.createElement('span');
  const color = GEM_COLORS[i % GEM_COLORS.length];
  dot.className = 'gem-dot';
  dot.style.width = dot.style.height = size + 'px';
  dot.style.color = `var(--${color})`;
  dot.style.background = `linear-gradient(160deg, var(--${color}-hi), var(--${color}) 60%, var(--${color}-lo))`;
  return dot;
}

function renderLobby() {
  const room = state.room;
  $('#lobby-code').textContent = room.code;
  $('#lobby-qr').src = room.qrDataUrl;
  $('#lobby-url').textContent = room.joinUrl;

  const list = $('#lobby-players');
  list.innerHTML = '';
  room.players.forEach((p, i) => {
    const li = document.createElement('li');
    if (!p.connected) li.classList.add('away');
    li.appendChild(gemDot(i));
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === state.you.id ? ' (you)' : '');
    li.appendChild(name);
    if (p.id === room.hostId) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'host';
      li.appendChild(tag);
    }
    list.appendChild(li);
  });

  const host = amHost();
  $('#btn-start').hidden = !host;
  $('#btn-start').disabled = room.players.length < 2;
  $('#btn-start').textContent =
    room.players.length < 2 ? 'Waiting for players…' : 'Begin the game';
  $('#lobby-wait').hidden = host;
}

function shardEl(shard, extraClass = '') {
  const el = document.createElement('div');
  el.className = `shard c-${shard}` + (extraClass ? ` ${extraClass}` : '');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', colorName(shard) + ' shard');
  return el;
}

function windowEl(player, rules, { mini = false, interactive = false } = {}) {
  const arch = document.createElement('div');
  arch.className = 'window-arch' + (mini ? ' window-mini' : '');
  const grid = document.createElement('div');
  grid.className = 'window-grid';
  grid.style.gridTemplateColumns = `repeat(${rules.cols}, var(--cell))`;

  const legal =
    interactive && state.selected !== null && game().hand[state.selected] !== undefined
      ? new Set(legalCells(player, game().hand[state.selected], rules))
      : null;

  for (let r = 0; r < rules.rows; r++) {
    for (let c = 0; c < rules.cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const shard = player.window[r][c];
      const socket = player.sockets[`${r},${c}`];
      if (socket) {
        cell.style.setProperty('--socket-c', `var(--${socket})`);
        if (!shard) cell.classList.add('socket');
      }
      if (shard) {
        cell.classList.add('filled', `c-${shard}`);
        if (socket && (shard === rules.prism || shard === socket)) {
          cell.classList.add('socket-matched');
        }
      }
      if (legal && legal.has(`${r},${c}`)) {
        cell.classList.add('legal');
        cell.addEventListener('click', () => {
          send({ type: 'place', i: state.selected, r, c });
          state.selected = null;
        });
      }
      grid.appendChild(cell);
    }
  }
  arch.appendChild(grid);
  return arch;
}

function actionButton(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderGame() {
  const room = state.room;
  const g = room.game;
  const rules = g.rules;
  const my = myGamePlayer();
  const active = activePlayer();
  const myTurn = isMyTurn();

  $('#round-label').textContent = `Round ${g.round} · kiln holds ${g.bagCount}`;

  // --- players strip ---
  const strip = $('#players-strip');
  strip.innerHTML = '';
  for (const p of g.players) {
    const roomP = room.players.find((rp) => rp.id === p.id);
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    if (p.seat === g.turnSeat && g.phase === 'playing') chip.classList.add('active');
    if (state.you && p.id === state.you.id) chip.classList.add('me');
    if (roomP && !roomP.connected) chip.classList.add('away');

    const score = document.createElement('div');
    score.className = 'chip-score';
    score.textContent = p.score;
    const name = document.createElement('div');
    name.className = 'chip-name';
    name.textContent = p.name;
    const fill = document.createElement('div');
    fill.className = 'chip-fill';
    const bar = document.createElement('i');
    const placed = p.window.flat().filter(Boolean).length;
    bar.style.width = `${(placed / (rules.rows * rules.cols)) * 100}%`;
    fill.appendChild(bar);

    chip.append(score, name, fill);
    chip.addEventListener('click', () => openPeek(p, rules));
    strip.appendChild(chip);
  }

  // --- kiln ---
  const title = $('#kiln-title');
  const hint = $('#kiln-hint');
  const actions = $('#kiln-actions');
  actions.innerHTML = '';

  if (!state.bustFreeze) {
    const row = $('#hand-row');
    row.innerHTML = '';
    if (g.hand.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'hand-empty';
      empty.textContent = 'the kiln waits…';
      row.appendChild(empty);
    } else {
      g.hand.forEach((shard, i) => {
        const el = shardEl(shard, myTurnPlacing() && state.selected === i ? 'sel' : '');
        if (myTurnPlacing()) {
          el.addEventListener('click', () => {
            state.selected = state.selected === i ? null : i;
            render();
          });
        }
        row.appendChild(el);
      });
    }
  }

  const risk = crackRisk(g);
  const riskText = `crack risk ~<b class="${risk >= 40 ? 'risk-hot' : ''}">${risk}%</b>`;

  if (g.turnPhase === 'draw') {
    if (myTurn) {
      title.innerHTML = '<em>Your turn</em> — draw from the kiln';
      hint.innerHTML = g.hand.length === 0 ? 'first draw is always safe' : riskText;
      actions.appendChild(actionButton('Draw a shard', 'btn-gold', () => send({ type: 'draw' })));
      actions.appendChild(
        actionButton(
          g.hand.length === 0 ? 'Pass' : `Keep ${g.hand.length} shard${g.hand.length > 1 ? 's' : ''}`,
          '',
          () => send({ type: 'stop' })
        )
      );
    } else {
      title.innerHTML = `<em>${active.name}</em> is drawing…`;
      hint.innerHTML = g.hand.length > 0 ? riskText : '';
    }
  } else {
    // placing
    if (myTurn) {
      title.innerHTML = '<em>Set your glass</em>';
      if (state.selected !== null && g.hand[state.selected] !== undefined) {
        const shard = g.hand[state.selected];
        const spots = legalCells(my, shard, rules).length;
        hint.textContent =
          spots > 0
            ? `tap a glowing cell for the ${colorName(shard).toLowerCase()} shard`
            : 'no legal cell for this shard — discard it';
        actions.appendChild(
          actionButton('Discard shard', 'btn-danger', () => {
            send({ type: 'discard', i: state.selected });
            state.selected = null;
          })
        );
      } else {
        hint.textContent = 'tap a shard, then a glowing cell · same colours never touch';
      }
    } else {
      title.innerHTML = `<em>${active.name}</em> is setting ${g.hand.length} shard${g.hand.length === 1 ? '' : 's'}`;
      hint.textContent = '';
    }
  }

  // host rescue: skip a disconnected player's turn
  if (!myTurn && amHost() && g.phase === 'playing') {
    const activeRoomP = room.players.find((p) => p.id === active.id);
    if (activeRoomP && !activeRoomP.connected) {
      actions.appendChild(
        actionButton(`Skip ${active.name}'s turn`, 'btn-ghost', () => send({ type: 'skipTurn' }))
      );
    }
  }

  // --- my window ---
  const mount = $('#my-window');
  const fresh = windowEl(my, rules, { interactive: myTurnPlacing() });
  fresh.id = 'my-window';
  mount.replaceWith(fresh);

  $('#board-caption').textContent = my.finished
    ? 'your window is complete'
    : g.finishTriggered
      ? 'final turns — make them count'
      : 'your window';
}

function openPeek(gamePlayer, rules) {
  $('#peek-title').textContent =
    gamePlayer.id === state.you.id ? 'Your window' : `${gamePlayer.name}'s window`;
  const mount = $('#peek-window');
  mount.innerHTML = '';
  mount.appendChild(windowEl(gamePlayer, rules, { mini: true }));
  $('#peek-stats').textContent =
    `${gamePlayer.score} points · ${gamePlayer.spectrums} spectrum${gamePlayer.spectrums === 1 ? '' : 's'} · ${gamePlayer.busts} crack${gamePlayer.busts === 1 ? '' : 's'}`;
  $('#overlay-peek').hidden = false;
}

function renderEnd() {
  const room = state.room;
  const g = room.game;
  if (!g || !g.standings) return;

  const winner = g.players[g.standings[0]];
  const mine = state.you && winner.id === state.you.id;
  $('#end-title').textContent = mine ? 'Your window shines brightest' : `${winner.name} wins`;

  const mount = $('#winner-window');
  mount.innerHTML = '';
  mount.appendChild(windowEl(winner, g.rules, { mini: true }));

  const list = $('#standings');
  list.innerHTML = '';
  g.standings.forEach((seat, i) => {
    const p = g.players[seat];
    const li = document.createElement('li');
    if (i === 0) li.classList.add('first');
    li.innerHTML = `<span class="rank">${i + 1}.</span><span class="s-name"></span><span class="s-pts">${p.score}</span>`;
    li.querySelector('.s-name').textContent = p.name + (state.you && p.id === state.you.id ? ' (you)' : '');
    list.appendChild(li);
  });

  $('#btn-again').hidden = !amHost();
  $('#end-wait').hidden = amHost();
}

/* ---------------- home screen wiring ---------------- */

function setupHome() {
  const params = new URLSearchParams(location.search);
  const roomFromUrl = (params.get('room') || '').toUpperCase().trim();
  const nameInput = $('#name-input');
  nameInput.value = localStorage.getItem(NAME_KEY) || '';

  if (roomFromUrl) {
    $('#join-banner').hidden = false;
    $('#join-banner-code').textContent = roomFromUrl;
    $('#btn-primary').textContent = 'Join the game';
    $('#home-divider').hidden = true;
    $('#join-row').hidden = true;
  }

  $('#home-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    localStorage.setItem(NAME_KEY, name);
    clearSession();
    if (roomFromUrl) {
      send({ type: 'join', code: roomFromUrl, name });
    } else {
      send({ type: 'create', name });
    }
  });

  $('#btn-join').addEventListener('click', () => {
    const name = nameInput.value.trim();
    const code = $('#code-input').value.trim().toUpperCase();
    if (!name) return nameInput.focus();
    if (code.length !== 4) return $('#code-input').focus();
    localStorage.setItem(NAME_KEY, name);
    clearSession();
    send({ type: 'join', code, name });
  });
}

/* ---------------- global wiring ---------------- */

function setup() {
  setupHome();
  $('#btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('#btn-again').addEventListener('click', () => send({ type: 'playAgain' }));
  $('#btn-game-help').addEventListener('click', () => { $('#overlay-help').hidden = false; });
  $('#btn-lobby-help').addEventListener('click', () => { $('#overlay-help').hidden = false; });

  document.querySelectorAll('.overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.hidden = true;
    });
  });

  connect();
}

setup();
