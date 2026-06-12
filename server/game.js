'use strict';

// Vitrea — core game logic. Pure state machine, no I/O.
// All information is public, so a single snapshot is broadcast to every client.

const COLORS = ['ruby', 'amber', 'emerald', 'sapphire', 'amethyst', 'moonstone'];
const PRISM = 'prism';

const ROWS = 5;
const COLS = 4;
const COPIES_PER_COLOR = 16;
const PRISM_COUNT = 8;

const SPECTRUM_SIZE = 6;
const SPECTRUM_BONUS = 7;
const MATCH_BONUS = 3;
const ROW_BONUS = 4; // a row holds COLS shards
const COL_BONUS = 6; // a column holds ROWS shards
const FINISH_BONUS = 10;
const MAX_ROUNDS = 30;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function freshBag() {
  const bag = [];
  for (const c of COLORS) {
    for (let i = 0; i < COPIES_PER_COLOR; i++) bag.push(c);
  }
  for (let i = 0; i < PRISM_COUNT; i++) bag.push(PRISM);
  return shuffle(bag);
}

// One bonus socket per row, in a random column, each requiring a distinct color.
function makePattern() {
  const colors = shuffle(COLORS.slice()).slice(0, ROWS);
  const sockets = {};
  for (let r = 0; r < ROWS; r++) {
    const c = Math.floor(Math.random() * COLS);
    sockets[`${r},${c}`] = colors[r];
  }
  return sockets;
}

class Game {
  constructor(playerInfos) {
    this.bag = freshBag();
    this.discardPile = [];
    this.players = playerInfos.map((p, seat) => ({
      id: p.id,
      name: p.name,
      seat,
      window: Array.from({ length: ROWS }, () => Array(COLS).fill(null)),
      sockets: makePattern(),
      score: 0,
      spectrums: 0,
      busts: 0,
      finished: false,
    }));
    this.phase = 'playing'; // 'playing' | 'finished'
    this.turnSeat = 0;
    this.turnPhase = 'draw'; // 'draw' | 'place'
    this.hand = []; // shards drawn this turn
    this.round = 1;
    this.finishTriggered = false;
    this.events = [];
    this.eventSeq = 0;
  }

  emit(type, data = {}) {
    this.events.push({ seq: ++this.eventSeq, type, ...data });
    if (this.events.length > 30) this.events.splice(0, this.events.length - 30);
  }

  current() {
    return this.players[this.turnSeat];
  }

  byId(id) {
    return this.players.find((p) => p.id === id);
  }

  assertTurn(playerId, phase) {
    if (this.phase !== 'playing') throw new Error('The game is over.');
    const p = this.current();
    if (p.id !== playerId) throw new Error('It is not your turn.');
    if (this.turnPhase !== phase) {
      throw new Error(phase === 'draw' ? 'You are placing shards now.' : 'You are still drawing.');
    }
    return p;
  }

  drawShard() {
    if (this.bag.length === 0) {
      this.bag = shuffle(this.discardPile);
      this.discardPile = [];
    }
    return this.bag.pop() || null;
  }

  // How many shards in the bag would crack the current hand. Public info,
  // shown to players as a risk hint.
  bagCounts() {
    const counts = {};
    for (const s of this.bag) counts[s] = (counts[s] || 0) + 1;
    return counts;
  }

  draw(playerId) {
    const p = this.assertTurn(playerId, 'draw');
    const shard = this.drawShard();
    if (shard === null) {
      // Every shard is on a window or in hand; place what we have, or pass.
      if (this.hand.length > 0) this.turnPhase = 'place';
      else this.advanceTurn();
      return;
    }
    if (this.hand.includes(shard)) {
      this.hand.push(shard);
      this.emit('reveal', { seat: p.seat, shard, crack: true });
      this.discardPile.push(...this.hand);
      this.hand = [];
      p.busts++;
      this.emit('bust', { seat: p.seat, name: p.name });
      this.advanceTurn();
      return;
    }
    this.hand.push(shard);
    this.emit('reveal', { seat: p.seat, shard, crack: false });
    if (this.hand.length >= SPECTRUM_SIZE) {
      p.score += SPECTRUM_BONUS;
      p.spectrums++;
      this.emit('spectrum', { seat: p.seat, name: p.name, points: SPECTRUM_BONUS });
      this.turnPhase = 'place';
    }
  }

  stop(playerId) {
    const p = this.assertTurn(playerId, 'draw');
    if (this.hand.length === 0) {
      // Passing without drawing is allowed; the turn simply ends.
      this.emit('pass', { seat: p.seat, name: p.name });
      this.advanceTurn();
      return;
    }
    this.turnPhase = 'place';
    this.emit('stopped', { seat: p.seat, name: p.name, kept: this.hand.length });
  }

  canPlace(p, shard, r, c) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return false;
    if (p.window[r][c] !== null) return false;
    if (shard === PRISM) return true;
    const neighbors = [
      [r - 1, c],
      [r + 1, c],
      [r, c - 1],
      [r, c + 1],
    ];
    for (const [nr, nc] of neighbors) {
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      if (p.window[nr][nc] === shard) return false;
    }
    return true;
  }

  place(playerId, handIndex, r, c) {
    const p = this.assertTurn(playerId, 'place');
    if (handIndex < 0 || handIndex >= this.hand.length) throw new Error('Invalid shard.');
    const shard = this.hand[handIndex];
    if (!this.canPlace(p, shard, r, c)) throw new Error('That shard cannot go there.');

    this.hand.splice(handIndex, 1);
    p.window[r][c] = shard;
    p.score += 1;

    const socket = p.sockets[`${r},${c}`];
    if (socket && (shard === PRISM || shard === socket)) {
      p.score += MATCH_BONUS;
      this.emit('score', { seat: p.seat, points: MATCH_BONUS, reason: 'socket' });
    }
    if (p.window[r].every((cell) => cell !== null)) {
      p.score += ROW_BONUS;
      this.emit('score', { seat: p.seat, points: ROW_BONUS, reason: 'row' });
    }
    if (p.window.every((row) => row[c] !== null)) {
      p.score += COL_BONUS;
      this.emit('score', { seat: p.seat, points: COL_BONUS, reason: 'column' });
    }
    this.emit('placed', { seat: p.seat, shard, r, c });

    if (p.window.every((row) => row.every((cell) => cell !== null)) && !p.finished) {
      p.finished = true;
      if (!this.finishTriggered) {
        this.finishTriggered = true;
        p.score += FINISH_BONUS;
        this.emit('finish', { seat: p.seat, name: p.name, points: FINISH_BONUS });
      }
    }
    if (this.hand.length === 0) this.advanceTurn();
  }

  discardShard(playerId, handIndex) {
    this.assertTurn(playerId, 'place');
    if (handIndex < 0 || handIndex >= this.hand.length) throw new Error('Invalid shard.');
    this.discardPile.push(this.hand.splice(handIndex, 1)[0]);
    if (this.hand.length === 0) this.advanceTurn();
  }

  // Host action for when the active player has dropped off the network.
  forceEndTurn() {
    if (this.phase !== 'playing') return;
    this.discardPile.push(...this.hand);
    this.hand = [];
    this.emit('skipped', { seat: this.turnSeat, name: this.current().name });
    this.advanceTurn();
  }

  advanceTurn() {
    this.hand = [];
    this.turnPhase = 'draw';
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const seat = (this.turnSeat + step) % n;
      const wrapped = this.turnSeat + step >= n;
      if (wrapped) {
        if (this.finishTriggered || this.round >= MAX_ROUNDS) {
          this.endGame();
          return;
        }
        this.round++;
      }
      if (!this.players[seat].finished) {
        this.turnSeat = seat;
        this.emit('turn', { seat, name: this.players[seat].name });
        return;
      }
    }
    this.endGame(); // every window is full
  }

  endGame() {
    this.phase = 'finished';
    const standings = this.players
      .slice()
      .sort((a, b) => b.score - a.score || a.seat - b.seat)
      .map((p) => p.seat);
    this.standings = standings;
    this.emit('gameOver', { standings });
  }

  snapshot() {
    return {
      phase: this.phase,
      round: this.round,
      maxRounds: MAX_ROUNDS,
      turnSeat: this.turnSeat,
      turnPhase: this.turnPhase,
      hand: this.hand,
      bagCount: this.bag.length,
      discardCount: this.discardPile.length,
      bagCounts: this.bagCounts(),
      finishTriggered: this.finishTriggered,
      standings: this.standings || null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        window: p.window,
        sockets: p.sockets,
        score: p.score,
        spectrums: p.spectrums,
        busts: p.busts,
        finished: p.finished,
      })),
      events: this.events,
      rules: {
        rows: ROWS,
        cols: COLS,
        colors: COLORS,
        prism: PRISM,
        spectrumSize: SPECTRUM_SIZE,
        spectrumBonus: SPECTRUM_BONUS,
        matchBonus: MATCH_BONUS,
        rowBonus: ROW_BONUS,
        colBonus: COL_BONUS,
        finishBonus: FINISH_BONUS,
      },
    };
  }
}

module.exports = { Game, COLORS, PRISM, ROWS, COLS };
