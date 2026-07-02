'use strict';

// Vitrea balance simulator — measures LUCK vs SKILL in the current engine.
//
//   node test/balance.sim.js [--games N] [--seed S] [--patch KEY=VALUE ...]
//
// Two experiments, both 2-player unless --players is given:
//   MIRROR : the same strategy plays itself. Any score margin is pure luck.
//            We want the margin small relative to the mean score.
//   SKILL  : an odds-aware bot vs a naive one. We want the skilled bot to win
//            often — that head-room is what makes the game feel skill-based.
//
// --patch rewrites an engine tuning constant in a temp copy before loading,
// e.g. --patch FINISH_BONUS=5 --patch 'SPECTRUM_TIERS={4:2,5:4,6:8}'
// so designs can be compared without editing engine.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// CLI
const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
const GAMES = parseInt(argVal('--games', '2000'), 10);
const SEED = parseInt(argVal('--seed', '1'), 10);
const PLAYERS = parseInt(argVal('--players', '2'), 10);
const patches = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--patch') patches.push(args[i + 1]);
}

// ---------------------------------------------------------------------------
// Deterministic RNG so runs are comparable across designs.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Load the engine, optionally with tuning constants patched.
function loadEngine() {
  const srcPath = path.join(__dirname, '..', 'public', 'js', 'engine.js');
  if (patches.length === 0) return require(srcPath);
  let src = fs.readFileSync(srcPath, 'utf8');
  for (const p of patches) {
    const eq = p.indexOf('=');
    const key = p.slice(0, eq);
    const val = p.slice(eq + 1);
    const re = new RegExp(`(const ${key} = )[^;]+(;)`);
    if (!re.test(src)) throw new Error(`--patch: constant ${key} not found`);
    src = src.replace(re, `$1${val}$2`);
  }
  const tmp = path.join(os.tmpdir(), `vitrea-engine-${process.pid}.js`);
  fs.writeFileSync(tmp, src);
  const mod = require(tmp);
  fs.unlinkSync(tmp);
  return mod;
}

const { Game, PRISM, ROWS, COLS } = loadEngine();
// Rules are constant per engine build; grab them once for the bots.
const RULES = new Game([{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]).snapshot().rules;

// ---------------------------------------------------------------------------
// Bots. They only look at information a real player has on screen: their own
// window/sockets, the shared hand, and the public bag counts.

// How many shards in the draw pool would crack the current hand right now.
function bustProb(g) {
  if (g.hand.includes(PRISM)) return 0; // a prism absorbs the next clash
  const colors = new Set(g.hand.filter((s) => s !== PRISM));
  if (colors.size === 0) return 0;
  const pool = g.bag.length > 0 ? g.bag : g.discardPile;
  if (pool.length === 0) return 0;
  let clash = 0;
  for (const s of pool) if (colors.has(s)) clash++;
  return clash / pool.length;
}

function emptyCells(p) {
  let n = 0;
  for (const row of p.window) for (const cell of row) if (cell === null) n++;
  return n;
}

// Hypothetical chain points if `shard` were placed at (r,c) on p's window.
function chainPts(g, p, r, c) {
  if (!RULES.chainScoring) return 1;
  let h = 1;
  for (let cc = c - 1; cc >= 0 && p.window[r][cc] !== null; cc--) h++;
  for (let cc = c + 1; cc < COLS && p.window[r][cc] !== null; cc++) h++;
  let v = 1;
  for (let rr = r - 1; rr >= 0 && p.window[rr][c] !== null; rr--) v++;
  for (let rr = r + 1; rr < ROWS && p.window[rr][c] !== null; rr++) v++;
  const pts = h > 1 && v > 1 ? h + v : Math.max(h, v);
  return Math.min(pts, RULES.chainCap || 99);
}

// SMART: draws while the expected value of one more draw is positive, then
// places each shard where it scores the most (chains + sockets), protecting
// socket cells for their colour.
const smartBot = {
  draw(g) {
    const p = g.current();
    const room = emptyCells(p);
    if (room === 0) return 'stop';
    if (g.hand.length === 0) return 'draw'; // first draw can never crack
    if (g.hand.length >= room) return 'stop'; // extra shards are forced discards
    const T = RULES.spectrumTiers || {};
    const pBust = bustProb(g);
    const colors = new Set(g.hand.filter((s) => s !== PRISM)).size;
    const tierNow = T[colors] || 0;
    const handValue = g.hand.length * 2 + tierNow; // ~2 pts/shard placed well
    const lossOnBust = handValue + (RULES.bustPenalty || 0);
    // Chance the next shard is a NEW colour, and what the tier jump pays.
    const pool = g.bag.length > 0 ? g.bag : g.discardPile;
    let fresh = 0;
    const held = new Set(g.hand.filter((s) => s !== PRISM));
    for (const s of pool) if (s !== PRISM && !held.has(s)) fresh++;
    const pNew = pool.length ? fresh / pool.length : 0;
    const tierNext = T[colors + 1] || 0;
    const evDraw = -pBust * lossOnBust + (1 - pBust) * (2 + pNew * (tierNext - tierNow));
    return evDraw > 0 ? 'draw' : 'stop';
  },
  place(g) {
    const p = g.current();
    let best = null; // {kind, i, r, c, value}
    for (let i = 0; i < g.hand.length; i++) {
      const shard = g.hand[i];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (!g.canPlace(p, shard, r, c)) continue;
          let v = chainPts(g, p, r, c);
          const socket = p.sockets[`${r},${c}`];
          if (socket) {
            if (shard === socket || shard === PRISM) v += RULES.matchBonus;
            else v -= 2.5; // don't waste a socket on the wrong colour
          }
          if (best === null || v > best.value) best = { kind: 'place', i, r, c, value: v };
        }
      }
    }
    if (best) return best;
    return { kind: 'discard', i: 0 };
  },
};

// NAIVE: pushes to a fixed hand size with no odds awareness, then drops each
// shard on the first legal cell it scans, blind to sockets and chains.
const naiveBot = {
  draw(g) {
    const p = g.current();
    if (emptyCells(p) === 0) return 'stop';
    return g.hand.length < 5 ? 'draw' : 'stop';
  },
  place(g) {
    const p = g.current();
    const shard = g.hand[0];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (g.canPlace(p, shard, r, c)) return { kind: 'place', i: 0, r, c };
      }
    }
    return { kind: 'discard', i: 0 };
  },
};

// ---------------------------------------------------------------------------
// Game runner
function playGame(bots, startSeat) {
  const infos = bots.map((_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const g = new Game(infos, { startSeat });
  let safety = 50000;
  while (g.phase === 'playing' && safety-- > 0) {
    const cur = g.current();
    const bot = bots[cur.seat];
    if (g.turnPhase === 'draw') {
      if (bot.draw(g) === 'draw') g.draw(cur.id);
      else g.stop(cur.id);
    } else {
      const a = bot.place(g);
      if (a.kind === 'place') g.place(cur.id, a.i, a.r, a.c);
      else g.discardShard(cur.id, a.i);
    }
  }
  if (g.phase !== 'finished') throw new Error('game did not terminate');
  return g;
}

function summarize(label, results) {
  const n = results.length;
  const margins = results.map((r) => Math.abs(r.scores[0] - r.scores[1]));
  const meanScore = results.reduce((a, r) => a + r.scores.reduce((x, y) => x + y, 0) / r.scores.length, 0) / n;
  const meanMargin = margins.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(margins.reduce((a, m) => a + (m - meanMargin) ** 2, 0) / n);
  const winsBySeat = results.map(() => 0);
  let wins0 = 0, starterWins = 0, finisherWins = 0, finishes = 0;
  for (const r of results) {
    if (r.winner === 0) wins0++;
    if (r.winner === r.startSeat) starterWins++;
    if (r.finishSeat >= 0) {
      finishes++;
      if (r.winner === r.finishSeat) finisherWins++;
    }
  }
  const meanRounds = results.reduce((a, r) => a + r.rounds, 0) / n;
  const placedDiff = results.map((r) => Math.abs(r.placed[0] - r.placed[1]));
  const meanPlacedDiff = placedDiff.reduce((a, b) => a + b, 0) / n;
  const evenGames = results.filter((r, i) => placedDiff[i] === 0);
  const evenMargin = evenGames.length
    ? evenGames.reduce((a, r) => a + Math.abs(r.scores[0] - r.scores[1]), 0) / evenGames.length
    : NaN;
  const meanBusts = results.reduce((a, r) => a + r.busts, 0) / n;
  const meanSpectrums = results.reduce((a, r) => a + r.spectrums, 0) / n;
  const big = margins.filter((m) => m >= meanScore * 0.35).length;
  console.log(`\n== ${label} (${n} games) ==`);
  console.log(`  mean score/player   ${meanScore.toFixed(1)}`);
  console.log(`  margin mean±sd      ${meanMargin.toFixed(1)} ± ${sd.toFixed(1)}  (${(100 * meanMargin / meanScore).toFixed(0)}% of mean score)`);
  console.log(`  blowouts (margin ≥35% of score)  ${(100 * big / n).toFixed(0)}%`);
  console.log(`  P0 win rate         ${(100 * wins0 / n).toFixed(1)}%`);
  console.log(`  starter win rate    ${(100 * starterWins / n).toFixed(1)}%`);
  console.log(`  first-finisher wins ${finishes ? (100 * finisherWins / finishes).toFixed(1) : '—'}%  (finished: ${(100 * finishes / n).toFixed(0)}%)`);
  console.log(`  rounds ${meanRounds.toFixed(1)}   busts/game ${meanBusts.toFixed(1)}   spectrums/game ${meanSpectrums.toFixed(2)}`);
  console.log(`  |placed diff| mean  ${meanPlacedDiff.toFixed(1)} shards; margin when placement even: ${evenMargin.toFixed(1)} (${evenGames.length} games)`);
  return { meanScore, meanMargin, sd, winRate0: wins0 / n };
}

function runSeries(label, bots, games) {
  const results = [];
  for (let i = 0; i < games; i++) {
    const startSeat = i % bots.length; // alternate the opener fairly
    const g = playGame(bots, startSeat);
    const scores = g.players.map((p) => p.score);
    const winner = g.standings[0];
    const placed = g.players.map((p) => {
      let n = 0;
      for (const row of p.window) for (const cell of row) if (cell !== null) n++;
      return n;
    });
    results.push({
      scores,
      winner,
      startSeat,
      rounds: g.round,
      placed,
      finishSeat: g.finishTriggered ? g.players.findIndex((p) => p.finished) : -1,
      busts: g.players.reduce((a, p) => a + p.busts, 0),
      spectrums: g.players.reduce((a, p) => a + p.spectrums, 0),
    });
  }
  return summarize(label, results);
}

// ---------------------------------------------------------------------------
Math.random = mulberry32(SEED);
if (patches.length) console.log('patched:', patches.join('  '));

const mirrorBots = Array.from({ length: PLAYERS }, () => smartBot);
runSeries('MIRROR smart vs smart — margin is pure luck', mirrorBots, GAMES);

Math.random = mulberry32(SEED + 7);
const skillBots = [smartBot, naiveBot];
const skill = runSeries('SKILL smart(P0) vs naive(P1)', skillBots, GAMES);
console.log(`\n  >>> skill signal: smart bot wins ${(100 * skill.winRate0).toFixed(1)}% of games`);
