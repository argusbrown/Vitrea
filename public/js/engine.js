'use strict';

// Vitrea — core game logic. Pure state machine, no I/O.
// Runs in the host's browser (authoritative) and in Node for tests.
// All information is public, so a single snapshot is broadcast to every client.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VitreaEngine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

const COLORS = ['ruby', 'amber', 'emerald', 'sapphire', 'amethyst', 'moonstone'];
const PRISM = 'prism';

const ROWS = 5;
const COLS = 5;
const COPIES_PER_COLOR = 18;
const PRISM_COUNT = 12;

const SPECTRUM_SIZE = 6;   // a Perfect Spectrum = holding all six colours at once
// Tiered draw-phase payoff by how many distinct colours you bank. A full spectrum
// (~1 in 20) pays big; banking 4–5 colours rewards the push instead of all-or-nothing.
// Keyed by exact colour count; counts below 4 earn nothing.
const SPECTRUM_TIERS = { 4: 3, 5: 6, 6: 12 };
const MATCH_BONUS = 3;
const ROW_BONUS = 5;       // a row holds COLS shards
const COL_BONUS = 6;       // a column holds ROWS shards
const DIAG_BONUS = 8;      // a full, single-colour main/anti diagonal (square board only)
const FINISH_BONUS = 10;
const DISCARD_PENALTY = 1; // points lost per shard deliberately discarded
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

// A line of cells is monochrome when it is full and every non-prism tile shares
// one colour. Prisms are wild (skipped); an all-prism line counts as monochrome.
function isMonochrome(cells) {
  let colour = null;
  for (const cell of cells) {
    if (cell === null) return false;
    if (cell === PRISM) continue;
    if (colour === null) colour = cell;
    else if (cell !== colour) return false;
  }
  return true;
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
  // opts.startSeat picks who takes the first turn (default seat 0). The Room
  // supplies it — random for a fresh game, rotated by one on each rematch — so
  // the engine itself stays deterministic and testable. Out-of-range falls back
  // to seat 0.
  constructor(playerInfos, opts = {}) {
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
      discards: 0,
      diagScored: 0,
      finished: false,
    }));
    const n = this.players.length;
    let startSeat = opts.startSeat;
    if (!Number.isInteger(startSeat) || startSeat < 0 || startSeat >= n) startSeat = 0;
    this.startSeat = startSeat;
    this.phase = 'playing'; // 'playing' | 'finished'
    this.turnSeat = startSeat;
    this.turnPhase = 'draw'; // 'draw' | 'place'
    this.hand = []; // shards drawn this turn
    this.round = 1;
    this.finishTriggered = false;
    this.events = [];
    this.eventSeq = 0;
    this.emit('firstPlayer', { seat: startSeat, name: this.players[startSeat].name });
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

  // Distinct colours currently in hand (prisms are wild, not a colour).
  handColors(hand = this.hand) {
    return new Set(hand.filter((s) => s !== PRISM));
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

    // A clash = drawing a colour you already hold. Prisms never clash.
    const clash = shard !== PRISM && this.hand.includes(shard);
    if (clash) {
      const prismIdx = this.hand.indexOf(PRISM);
      if (prismIdx !== -1) {
        // Prism shield: sacrifice a prism to absorb the clash and keep going.
        this.hand.splice(prismIdx, 1);
        this.discardPile.push(PRISM, shard);
        this.emit('reveal', { seat: p.seat, shard, crack: false });
        this.emit('shield', { seat: p.seat, name: p.name, shard });
        return;
      }
      // No prism to spend — the glass cracks.
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
    if (this.handColors().size >= SPECTRUM_SIZE) {
      const points = SPECTRUM_TIERS[SPECTRUM_SIZE];
      p.score += points;
      p.spectrums++;
      this.emit('spectrum', { seat: p.seat, name: p.name, points, colors: SPECTRUM_SIZE });
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
    // Banking 4–5 distinct colours pays a partial-spectrum bonus (6 auto-scores in
    // draw() before you can stop, so colours here is always < SPECTRUM_SIZE).
    const colors = this.handColors().size;
    const points = SPECTRUM_TIERS[colors] || 0;
    if (points > 0) {
      p.score += points;
      this.emit('radiance', { seat: p.seat, name: p.name, points, colors });
    }
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
    // Diagonals only make sense on a square window. A diagonal scores only when
    // it is full AND every tile is the same colour; a prism is wild and matches
    // any colour. The two diagonals are scored independently — the shared centre
    // is just another cell. A diagonal becomes full exactly once (when its last
    // empty cell is filled), so checking on that placement scores it at most once.
    if (ROWS === COLS) {
      if (r === c && isMonochrome(p.window.map((row, i) => row[i]))) {
        p.diagScored++;
        p.score += DIAG_BONUS;
        this.emit('score', { seat: p.seat, points: DIAG_BONUS, reason: 'diagonal' });
      }
      if (r + c === COLS - 1 && isMonochrome(p.window.map((row, i) => row[COLS - 1 - i]))) {
        p.diagScored++;
        p.score += DIAG_BONUS;
        this.emit('score', { seat: p.seat, points: DIAG_BONUS, reason: 'diagonal' });
      }
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
    const p = this.assertTurn(playerId, 'place');
    if (handIndex < 0 || handIndex >= this.hand.length) throw new Error('Invalid shard.');
    this.discardPile.push(this.hand.splice(handIndex, 1)[0]);
    p.score -= DISCARD_PENALTY;
    p.discards++;
    this.emit('discard', { seat: p.seat, name: p.name, points: DISCARD_PENALTY });
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

  // Full internal state, so a reloaded host page can resurrect the game.
  toJSON() {
    return {
      bag: this.bag,
      discardPile: this.discardPile,
      players: this.players,
      phase: this.phase,
      startSeat: this.startSeat,
      turnSeat: this.turnSeat,
      turnPhase: this.turnPhase,
      hand: this.hand,
      round: this.round,
      finishTriggered: this.finishTriggered,
      events: this.events,
      eventSeq: this.eventSeq,
      standings: this.standings || null,
    };
  }

  static fromJSON(data) {
    const g = Object.create(Game.prototype);
    Object.assign(g, data);
    if (g.standings === null) delete g.standings;
    return g;
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
        discards: p.discards,
        finished: p.finished,
      })),
      events: this.events,
      rules: {
        rows: ROWS,
        cols: COLS,
        colors: COLORS,
        prism: PRISM,
        spectrumSize: SPECTRUM_SIZE,
        spectrumTiers: SPECTRUM_TIERS,
        matchBonus: MATCH_BONUS,
        rowBonus: ROW_BONUS,
        colBonus: COL_BONUS,
        diagBonus: DIAG_BONUS,
        finishBonus: FINISH_BONUS,
        discardPenalty: DISCARD_PENALTY,
      },
    };
  }
}

return { Game, COLORS, PRISM, ROWS, COLS };
});
