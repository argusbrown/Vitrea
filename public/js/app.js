'use strict';

/* ============================================================
   Vitrea client — single state-driven render, no frameworks.
   The host's tab also runs the authoritative room (see net.js);
   this file only ever talks the client protocol.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const SESSION_KEY = 'vitrea-session'; // {role, code, token}
const NAME_KEY = 'vitrea-name';

const ui = {
  home: $('#screen-home'),
  lobby: $('#screen-lobby'),
  game: $('#screen-game'),
  end: $('#screen-end'),
};

const state = {
  transport: null, // {send} once hosting/joined
  role: null, // 'host' | 'guest'
  you: null, // {id, token}
  room: null, // last room snapshot
  lastSeq: 0, // last animated game event
  firstSnapshot: true, // skip animating history on (re)join
  selected: null, // selected hand shard index while placing
  prevHand: [], // hand before the latest snapshot, for the shatter animation
  bustFreeze: false, // keep the shattering hand on screen briefly
  busyConnecting: false,
};

/* ---------------- session ---------------- */

function saveSession(code, token) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ role: state.role, code, token }));
}
function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}
function leaveGame() {
  localStorage.removeItem(SESSION_KEY);
  VitreaNet.clearHostRoom();
  const url = new URL(location.pathname, location.origin);
  location.replace(url.toString()); // drop ?room=… and start fresh
}

/* ---------------- connection ---------------- */

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
        localStorage.removeItem(SESSION_KEY);
        state.room = null;
        showScreen('home');
        showHomeError(msg.message);
      } else {
        toast(msg.message, true);
      }
      break;
  }
}

let lastStatusToast = 0;
function handleStatus(kind, detail) {
  if (kind === 'linking') {
    setBusyLabel('Found the game — connecting…');
    return;
  }
  const now = Date.now();
  if (now - lastStatusToast < 4000) return;
  lastStatusToast = now;
  if (kind === 'reconnecting') toast('Connection lost — reconnecting…', true);
  else if (kind === 'signal-lost') toast('Matchmaking link lost — rejoining…', true);
  else if (kind === 'error' && detail) toast(detail, true);
}

function setBusyLabel(label) {
  const btn = $('#btn-primary');
  if (btn.disabled) btn.textContent = label;
}

// Connection problems stay on screen until the next attempt — a toast is
// too short-lived to read a diagnostic.
function showHomeError(message) {
  const el = $('#home-error');
  el.textContent = message;
  el.hidden = false;
}
function clearHomeError() {
  $('#home-error').hidden = true;
}

async function startHosting(name, resume) {
  if (state.busyConnecting) return;
  state.busyConnecting = true;
  state.role = 'host';
  clearHomeError();
  setHomeBusy(true, 'Opening the workshop…');
  try {
    state.transport = await VitreaNet.host({
      name,
      resume,
      onMessage: handleMessage,
      onStatus: handleStatus,
    });
  } catch (err) {
    showHomeError(err.message);
    if (resume) leaveGame();
  } finally {
    state.busyConnecting = false;
    setHomeBusy(false);
  }
}

async function joinGame(code, { name, token } = {}) {
  if (state.busyConnecting) return;
  state.busyConnecting = true;
  state.role = 'guest';
  clearHomeError();
  setHomeBusy(true, 'Knocking on the door…');
  try {
    state.transport = await VitreaNet.join({
      code,
      name,
      token,
      onMessage: handleMessage,
      onStatus: handleStatus,
    });
  } catch (err) {
    showHomeError(err.message);
    if (token) localStorage.removeItem(SESSION_KEY);
  } finally {
    state.busyConnecting = false;
    setHomeBusy(false);
  }
}

function setHomeBusy(busy, label) {
  const btn = $('#btn-primary');
  btn.disabled = busy;
  if (busy) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = label;
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
  $('#btn-join').disabled = busy;
}

function send(msg) {
  if (state.transport) state.transport.send(msg);
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

// Which diagonals actually score (square boards only). A diagonal scores only
// when it is full AND a single colour; a prism is wild and matches any colour.
// The two diagonals are scored independently — the shared centre is just a cell.
function scoredDiagonals(player, rules) {
  if (rules.rows !== rules.cols) return { main: false, anti: false };
  const w = player.window;
  const n = rules.rows;
  const monochrome = (cells) => {
    let colour = null;
    for (const cell of cells) {
      if (cell === null) return false;
      if (cell === rules.prism) continue;
      if (colour === null) colour = cell;
      else if (cell !== colour) return false;
    }
    return true;
  };
  const main = [];
  const anti = [];
  for (let i = 0; i < n; i++) { main.push(w[i][i]); anti.push(w[i][n - 1 - i]); }
  return { main: monochrome(main), anti: monochrome(anti) };
}

// Completed lines and matched sockets on a window — for the end-of-game breakdown.
function lineBreakdown(player, rules) {
  const w = player.window;
  let rows = 0;
  let cols = 0;
  let sockets = 0;
  for (let r = 0; r < rules.rows; r++) if (w[r].every((x) => x !== null)) rows++;
  for (let c = 0; c < rules.cols; c++) {
    let full = true;
    for (let r = 0; r < rules.rows; r++) if (w[r][c] === null) { full = false; break; }
    if (full) cols++;
  }
  for (const key in player.sockets) {
    const [r, c] = key.split(',').map(Number);
    const s = w[r][c];
    if (s && (s === rules.prism || s === player.sockets[key])) sockets++;
  }
  const d = scoredDiagonals(player, rules);
  return { rows, cols, diags: (d.main ? 1 : 0) + (d.anti ? 1 : 0), sockets };
}


function crackRisk(g) {
  if (g.hand.length === 0 || g.bagCount === 0) return 0;
  const prism = g.rules.prism;
  let danger = 0;
  for (const shard of new Set(g.hand)) {
    if (shard === prism) continue;
    danger += g.bagCounts[shard] || 0;
  }
  return Math.round((danger / g.bagCount) * 100);
}

function hasShield(g) {
  return g.hand.includes(g.rules.prism);
}

// How many distinct colours (prisms are wild, not a colour) are in hand, what
// banking now would score under the tiered spectrum rules, and the next tier up.
function spectrumBank(g) {
  const tiers = g.rules.spectrumTiers || {};
  const colors = new Set(g.hand.filter((s) => s !== g.rules.prism)).size;
  const bonus = tiers[colors] || 0;
  let next = null;
  for (const k of Object.keys(tiers).map(Number).sort((a, b) => a - b)) {
    if (k > colors) { next = { colors: k, bonus: tiers[k] }; break; }
  }
  return { colors, bonus, next };
}

// Spectrum-zone name for a distinct-colour count (null below the first tier).
// Mirrors the labels shown on the radiance/spectrum banners.
function zoneName(colors) {
  return colors >= 6 ? 'Perfect Spectrum'
    : colors === 5 ? 'Radiance'
    : colors === 4 ? 'Glimmer'
    : null;
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

/* ---------------- events → theatre ---------------- */

function processEvents(events) {
  const g = game();
  for (const ev of events) {
    const mine = state.you && g.players[ev.seat] && g.players[ev.seat].id === state.you.id;

    // Sound: single map-driven dispatch (binding lives in sfx.js SOUND_MAP).
    if (ev.type === 'reveal') {
      // A busting draw is silent — the 'bust' event plays the shatter.
      // crackRisk reads the post-draw hand, so the pitch tracks rising risk.
      if (!ev.crack) VitreaSfx.play('reveal', { mine, intensity: crackRisk(g) / 100 });
    } else {
      VitreaSfx.play(ev.type, { mine });
    }

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
      case 'radiance': {
        const label = ev.colors === 5 ? 'Radiance' : 'Glimmer';
        banner(`${label} +${ev.points}`, 'b-spectrum');
        vibrate([20, 30, 60]);
        if (!mine) toast(`${ev.name} banked ${ev.colors} colours (+${ev.points})`);
        break;
      }
      case 'shield':
        if (mine) {
          banner('Prism shield!', 'b-spectrum');
          vibrate([20, 30, 60]);
        } else {
          toast(`${ev.name} spent a prism to survive a clash`);
        }
        break;
      case 'score': {
        const what = ev.reason === 'socket' ? 'socket matched'
          : ev.reason === 'row' ? 'row complete'
          : ev.reason === 'diagonal' ? 'diagonal complete'
          : 'column complete';
        toast(`+${ev.points} ${what} — ${g.players[ev.seat].name}`);
        break;
      }
      case 'discard':
        toast(`${mine ? 'You' : ev.name} discarded a shard −${ev.points}`);
        break;
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
  if (isError) el.style.animationDuration = '5.5s'; // errors deserve reading time
  box.appendChild(el);
  setTimeout(() => el.remove(), isError ? 5600 : 2700);
}

/* ---------------- QR rendering ---------------- */

function renderQr(canvas, text) {
  if (canvas.dataset.encoded === text) return;
  canvas.dataset.encoded = text;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = 10;
  const quiet = 2;
  canvas.width = canvas.height = (n + quiet * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4ead8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1b1430';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
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
  renderQr($('#lobby-qr'), room.joinUrl);
  $('#lobby-url').textContent = room.joinUrl.replace(/^https?:\/\//, '');

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
  $('#lobby-host-note').hidden = !host;
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

  const diag = scoredDiagonals(player, rules);

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
        if ((diag.main && r === c) || (diag.anti && r + c === rules.cols - 1)) {
          cell.classList.add('diag-line');
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
  const riskText = hasShield(g)
    ? `<b class="shielded">prism shield ready</b> · clash risk ~${risk}%`
    : `crack risk ~<b class="${risk >= 40 ? 'risk-hot' : ''}">${risk}%</b>`;

  // Live spectrum-zone readout: shows the bonus banked right now and the next
  // milestone, so players see they're entering Glimmer/Radiance before stopping.
  const bank = spectrumBank(g);
  let zoneText = '';
  if (g.hand.length > 0) {
    const zone = zoneName(bank.colors);
    if (zone) {
      zoneText = `<b class="zone">✦ ${zone} +${bank.bonus} banked</b>`;
      if (bank.next) zoneText += ` · +${bank.next.bonus} at ${bank.next.colors}`;
    } else if (bank.next) {
      const need = bank.next.colors - bank.colors;
      zoneText = `${bank.colors} colour${bank.colors === 1 ? '' : 's'} · `
        + `${need} more for ${zoneName(bank.next.colors)} (+${bank.next.bonus})`;
    }
  }
  const zoneLine = zoneText ? `${zoneText}<br>` : '';

  if (g.turnPhase === 'draw') {
    if (myTurn) {
      title.innerHTML = '<em>Your turn</em> — draw from the kiln';
      hint.innerHTML = g.hand.length === 0 ? 'first draw is always safe' : zoneLine + riskText;
      actions.appendChild(actionButton('Draw a shard', 'btn-gold', () => send({ type: 'draw' })));
      const keepLabel = g.hand.length === 0
        ? 'Pass'
        : `Keep ${g.hand.length} shard${g.hand.length > 1 ? 's' : ''}${bank.bonus > 0 ? ` · +${bank.bonus}` : ''}`;
      actions.appendChild(actionButton(keepLabel, '', () => send({ type: 'stop' })));
    } else {
      title.innerHTML = `<em>${active.name}</em> is drawing…`;
      hint.innerHTML = g.hand.length > 0 ? zoneLine + riskText : '';
    }
  } else {
    // placing
    if (myTurn) {
      title.innerHTML = '<em>Set your glass</em>';
      if (state.selected !== null && g.hand[state.selected] !== undefined) {
        const shard = g.hand[state.selected];
        const spots = legalCells(my, shard, rules).length;
        const penalty = rules.discardPenalty || 0;
        hint.textContent =
          spots > 0
            ? `tap a glowing cell for the ${colorName(shard).toLowerCase()} shard`
            : `no legal cell for this shard — discard it (−${penalty})`;
        actions.appendChild(
          actionButton(`Discard shard (−${penalty})`, 'btn-danger', () => {
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

// Game-screen exit: the host ends the game for everyone, a guest just leaves.
function openQuit() {
  const host = amHost();
  $('#quit-title').textContent = host ? 'End the game?' : 'Leave the game?';
  $('#quit-msg').textContent = host
    ? 'This stops play for everyone and shows the final standings.'
    : 'You will return to the home screen. You can rejoin with the room code while the game is open.';
  const confirm = $('#btn-quit-confirm');
  confirm.textContent = host ? 'End game' : 'Leave';
  confirm.onclick = () => {
    $('#overlay-quit').hidden = true;
    if (host) {
      send({ type: 'endGame' });
    } else {
      send({ type: 'leave' });
      leaveGame();
    }
  };
  $('#overlay-quit').hidden = false;
}

function openPeek(gamePlayer, rules) {
  $('#peek-title').textContent =
    gamePlayer.id === state.you.id ? 'Your window' : `${gamePlayer.name}'s window`;
  const mount = $('#peek-window');
  mount.innerHTML = '';
  mount.appendChild(windowEl(gamePlayer, rules, { mini: true }));
  $('#peek-stats').textContent = `${gamePlayer.score} points`;

  const b = lineBreakdown(gamePlayer, rules);
  const parts = [
    `${b.rows} row${b.rows === 1 ? '' : 's'}`,
    `${b.cols} column${b.cols === 1 ? '' : 's'}`,
    `${b.diags} diagonal${b.diags === 1 ? '' : 's'}`,
    `${b.sockets} socket${b.sockets === 1 ? '' : 's'}`,
    `${gamePlayer.spectrums} spectrum${gamePlayer.spectrums === 1 ? '' : 's'}`,
    `${gamePlayer.busts} crack${gamePlayer.busts === 1 ? '' : 's'}`,
    `${gamePlayer.discards} discard${gamePlayer.discards === 1 ? '' : 's'}`,
  ];
  $('#peek-breakdown').textContent = parts.join(' · ');
  $('#overlay-peek').hidden = false;
}

function renderEnd() {
  const room = state.room;
  const g = room.game;
  if (!g || !g.standings) return;

  $('#toasts').innerHTML = ''; // clear leftover score toasts so they don't cover the standings

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
    li.setAttribute('role', 'button');
    li.innerHTML = `<span class="rank">${i + 1}.</span><span class="s-name"></span><span class="s-pts">${p.score}</span>`;
    li.querySelector('.s-name').textContent = p.name + (state.you && p.id === state.you.id ? ' (you)' : '');
    li.addEventListener('click', () => openPeek(p, g.rules));
    list.appendChild(li);
  });

  $('#btn-again').hidden = !amHost();
  $('#end-wait').hidden = amHost();
}

/* ---------------- home screen wiring ---------------- */

function setupHome() {
  const v = window.VITREA_VERSION || {};
  const build = !v.build || v.build === '__BUILD__' ? 'dev' : v.build;
  $('#version-line').textContent = `v${v.semver || '?'} · ${build}`;

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
    VitreaSfx.ensureAudio(); // unlock audio inside the user gesture (iOS)
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    localStorage.setItem(NAME_KEY, name);
    localStorage.removeItem(SESSION_KEY);
    VitreaNet.clearHostRoom();
    if (roomFromUrl) joinGame(roomFromUrl, { name });
    else startHosting(name);
  });

  $('#btn-join').addEventListener('click', () => {
    VitreaSfx.ensureAudio(); // unlock audio inside the user gesture (iOS)
    const name = nameInput.value.trim();
    const code = $('#code-input').value.trim().toUpperCase();
    if (!name) return nameInput.focus();
    if (code.length !== 4) return $('#code-input').focus();
    localStorage.setItem(NAME_KEY, name);
    localStorage.removeItem(SESSION_KEY);
    VitreaNet.clearHostRoom();
    joinGame(code, { name });
  });
}

// Pick up where we left off: a host page reload resurrects the whole room,
// a guest reconnects with their token.
function resumeIfPossible() {
  const session = loadSession();
  if (!session) return;
  if (session.role === 'host') {
    const saved = VitreaNet.savedHostRoom();
    if (saved && saved.code === session.code) {
      state.role = 'host';
      startHosting(null, saved);
    }
  } else if (session.role === 'guest' && session.code && session.token) {
    state.role = 'guest';
    joinGame(session.code, { token: session.token });
  }
}

let netTestRunning = false;
async function runConnectionCheck() {
  $('#overlay-nettest').hidden = false;
  if (netTestRunning) return;
  netTestRunning = true;
  document.querySelectorAll('.nettest-list .nt-status').forEach((el) => {
    el.textContent = '…';
    el.className = 'nt-status';
  });
  $('#nettest-verdict').textContent = 'Testing this network…';
  const verdict = await VitreaNetTest.run((rowId, status) => {
    const el = document.querySelector(`.nettest-list li[data-row="${rowId}"] .nt-status`);
    if (!el) return;
    if (status === 'testing') {
      el.textContent = 'testing…';
      el.className = 'nt-status';
    } else {
      el.textContent = status === 'ok' ? '✓' : '✗';
      el.className = 'nt-status ' + (status === 'ok' ? 'ok' : 'bad');
    }
  });
  $('#nettest-verdict').textContent = verdict;
  netTestRunning = false;
}

/* ---------------- global wiring ---------------- */

function setup() {
  setupHome();
  $('#btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('#btn-again').addEventListener('click', () => send({ type: 'playAgain' }));
  $('#btn-game-help').addEventListener('click', () => { $('#overlay-help').hidden = false; });
  $('#btn-game-quit').addEventListener('click', openQuit);
  $('#btn-lobby-help').addEventListener('click', () => { $('#overlay-help').hidden = false; });
  $('#btn-home-help').addEventListener('click', () => { $('#overlay-help').hidden = false; });
  $('#btn-leave-lobby').addEventListener('click', leaveGame);
  $('#btn-leave-end').addEventListener('click', leaveGame);
  $('#btn-nettest').addEventListener('click', runConnectionCheck);

  // Sound mute toggle — static buttons (home + in-game), wired once here.
  ['#btn-mute', '#btn-game-mute'].forEach((sel) => {
    const b = $(sel);
    if (b) b.addEventListener('click', () => {
      VitreaSfx.ensureAudio();
      VitreaSfx.toggleMute();
      updateMuteUI();
    });
  });
  updateMuteUI();

  // Arm audio on the first gesture anywhere — covers an auto-rejoined player
  // who lands mid-game without tapping Host/Join/mute. iOS needs a gesture.
  const armAudio = () => {
    VitreaSfx.ensureAudio();
    document.removeEventListener('pointerdown', armAudio);
  };
  document.addEventListener('pointerdown', armAudio);

  document.querySelectorAll('.overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.hidden = true;
    });
  });

  resumeIfPossible();
}

function updateMuteUI() {
  const m = VitreaSfx.isMuted();
  const home = $('#btn-mute');
  if (home) home.textContent = m ? '🔇 Sound off' : '🔊 Sound on';
  const game = $('#btn-game-mute');
  if (game) {
    game.textContent = m ? '🔇' : '🔊';
    game.setAttribute('aria-pressed', String(m));
  }
}

setup();
