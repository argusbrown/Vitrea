'use strict';

// Vitrea — chance-vs-skill analysis harness (dev-only, not shipped).
//
//   node test/skill.sim.js [scale]
//
// The engine's only randomness is the bag shuffle + the socket pattern, both
// drawn from the global Math.random. We swap Math.random for a seeded PRNG so a
// "shoe" (one seed) is perfectly reproducible. That lets us:
//   A. hold SKILL constant and vary luck   -> the luck floor
//   B. hold LUCK varied and vary skill      -> the skill ladder (win-rate matrix)
//   C. decompose score variance into the two, plus a per-decision regret pass.
//
// Bots only ever issue legal intents through the public engine API, exactly as a
// real client would, so nothing here can produce a state the real game can't.

const { Game, COLORS, PRISM, ROWS, COLS } = require('../public/js/engine');

// ---- seeded RNG installed over Math.random -------------------------------
// mulberry32: one 32-bit word of state, so we can snapshot/restore it to give
// every counterfactual branch the *same* future draws (see the regret pass).
let _rng = 1;
function setSeed(s) { _rng = s >>> 0; }
function snapshotRNG() { return _rng; }
function restoreRNG(s) { _rng = s >>> 0; }
Math.random = function () {
  _rng = (_rng + 0x6D2B79F5) | 0;
  let t = Math.imul(_rng ^ (_rng >>> 15), 1 | _rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- engine tuning, mirrored for the bots' EV math -----------------------
// (engine.js doesn't export these; keep them in sync if you retune.)
const SPECTRUM_SIZE = 6;
const SPECTRUM_TIERS = { 4: 3, 5: 6, 6: 12 };
const MATCH_BONUS = 3, DIAG_BONUS = 8; // row/col bonuses removed — runs reward lines
const tier = (k) => SPECTRUM_TIERS[k] || 0;

// Read straight from the engine (via a throwaway game's rules snapshot) so this
// can never desync from the live rule. When on, a placement scores the length of
// the contiguous horizontal+vertical runs it joins (Azul-style) instead of a flat
// +1, so the bots value WHERE they place, not just THAT they place.
const CHAIN_SCORING = !!new Game([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }])
  .snapshot().rules.chainScoring;
// Length of the contiguous filled run through (r,c) if a shard were placed there.
function placementBase(me, r, c) {
  if (!CHAIN_SCORING) return 1;
  let h = 1;
  for (let cc = c - 1; cc >= 0 && me.window[r][cc] !== null; cc--) h++;
  for (let cc = c + 1; cc < COLS && me.window[r][cc] !== null; cc++) h++;
  let v = 1;
  for (let rr = r - 1; rr >= 0 && me.window[rr][c] !== null; rr--) v++;
  for (let rr = r + 1; rr < ROWS && me.window[rr][c] !== null; rr++) v++;
  return (h > 1 && v > 1) ? h + v : Math.max(h, v);
}

// ---- helpers -------------------------------------------------------------
function cloneGame(g) {
  return Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
}

function isMono(cells) {
  let colour = null;
  for (const cell of cells) {
    if (cell === null) return false;
    if (cell === PRISM) continue;
    if (colour === null) colour = cell;
    else if (cell !== colour) return false;
  }
  return true;
}

// Immediate points a placement would score — computed analytically (no clone)
// so it's cheap enough to call inside rollouts.
function placementDelta(me, shard, r, c) {
  let d = placementBase(me, r, c);
  const socket = me.sockets[`${r},${c}`];
  if (socket && (shard === PRISM || shard === socket)) d += MATCH_BONUS;
  if (ROWS === COLS) {
    if (r === c) {
      const diag = me.window.map((row, i) => (i === r ? shard : row[i]));
      if (isMono(diag)) d += DIAG_BONUS;
    }
    if (r + c === COLS - 1) {
      const anti = me.window.map((row, i) => (i === r ? shard : row[COLS - 1 - i]));
      if (isMono(anti)) d += DIAG_BONUS;
    }
  }
  return d;
}

function legalPlacements(g, me) {
  const out = [];
  for (let h = 0; h < g.hand.length; h++) {
    const shard = g.hand[h];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (g.canPlace(me, shard, r, c)) out.push({ handIndex: h, r, c });
      }
    }
  }
  return out;
}

// ---- the skill ladder ----------------------------------------------------
// Each policy answers two questions: keep drawing? and where to place?
// Placement is shared (greedy-by-immediate-points); the rungs differ mainly in
// the press-your-luck DRAW call, which is the heart of the game.

function bestPlacement(g, me, setupBonus) {
  const legals = legalPlacements(g, me);
  if (legals.length === 0) return { kind: 'discard', handIndex: 0 };
  let best = null, bestV = -Infinity;
  for (const l of legals) {
    let v = placementDelta(me, g.hand[l.handIndex], l.r, l.c);
    if (setupBonus) {
      // planner: nudge toward cells that leave a row/col one-away, and toward
      // unfilled sockets, to set up future bonuses.
      const rowFill = me.window[l.r].filter((x) => x !== null).length;
      const colFill = me.window.filter((row) => row[l.c] !== null).length;
      v += 0.15 * (rowFill + colFill);
      if (me.sockets[`${l.r},${l.c}`]) v += 0.3;
    }
    if (v > bestV) { bestV = v; best = l; }
  }
  return { kind: 'place', ...best };
}

// EV of drawing one more shard vs. banking now. conservatism shifts the stop
// threshold (higher = more cautious).
function evSaysDraw(g, me, conservatism) {
  const hand = g.hand;
  const bagCount = g.bag.length;
  if (bagCount === 0) return false;
  const counts = g.bagCounts();
  const held = g.handColors();           // distinct non-prism colours in hand
  const distinct = held.size;
  const hasPrism = hand.includes(PRISM);
  let matching = 0;
  for (const col of held) matching += counts[col] || 0;
  const prisms = counts[PRISM] || 0;
  const unheld = bagCount - matching - prisms;
  const pBust = hasPrism ? 0 : matching / bagCount;     // prism shields one clash
  const pSafe = 1 - pBust;
  const pNewColour = unheld / bagCount;
  const marginalSpectrum = tier(Math.min(distinct + 1, SPECTRUM_SIZE)) - tier(distinct);
  const gainIfSafe = 1 + pNewColour * marginalSpectrum;
  const lossIfBust = hand.length + tier(distinct);      // shards lost + forgone radiance
  const ev = pSafe * gainIfSafe - pBust * lossIfBust;
  return ev > conservatism;
}

const POLICIES = {
  // coin-flip draw, random legal placement: the no-skill baseline.
  random: {
    draw: (g) => Math.random() < 0.5,
    place: (g, me) => {
      const legals = legalPlacements(g, me);
      if (legals.length === 0) return { kind: 'discard', handIndex: 0 };
      return { kind: 'place', ...legals[Math.floor(Math.random() * legals.length)] };
    },
  },
  // bank two shards and run: almost never busts, but leaves spectrum on the table.
  greedy: {
    draw: (g) => g.hand.length < 2,
    place: (g, me) => bestPlacement(g, me, false),
  },
  // EV-driven press-your-luck: the real game's core decision, played well.
  pushluck: {
    draw: (g, me) => evSaysDraw(g, me, 0),
    place: (g, me) => bestPlacement(g, me, false),
  },
  // pushluck + placement that also sets up rows/cols/sockets.
  planner: {
    draw: (g, me) => evSaysDraw(g, me, 0),
    place: (g, me) => bestPlacement(g, me, true),
  },
  // identical EV draw to pushluck, but places at RANDOM. Pairing this against
  // pushluck isolates PLACEMENT skill with draw skill held equal.
  evdumb: {
    draw: (g, me) => evSaysDraw(g, me, 0),
    place: (g, me) => {
      const legals = legalPlacements(g, me);
      if (legals.length === 0) return { kind: 'discard', handIndex: 0 };
      return { kind: 'place', ...legals[Math.floor(Math.random() * legals.length)] };
    },
  },
};
const LADDER = ['random', 'greedy', 'pushluck', 'planner'];

// ---- driver --------------------------------------------------------------
function applyAction(g, me, a) {
  if (a.kind === 'draw') g.draw(me.id);
  else if (a.kind === 'stop') g.stop(me.id);
  else if (a.kind === 'place') g.place(me.id, a.handIndex, a.r, a.c);
  else g.discardShard(me.id, a.handIndex);
}

function chooseAction(pol, g, me) {
  if (g.turnPhase === 'draw') {
    return pol.draw(g, me) ? { kind: 'draw' } : { kind: 'stop' };
  }
  return pol.place(g, me);
}

function step(g, pols) {
  const me = g.current();
  applyAction(g, me, chooseAction(pols[me.seat], g, me));
}

function playToEnd(g, pols) {
  let guard = 0;
  while (g.phase === 'playing') {
    step(g, pols);
    if (++guard > 100000) throw new Error('runaway game');
  }
}

// One full 2-player game on a given shoe. pols = [seat0policyName, seat1policyName].
function playGame(seed, pols) {
  setSeed(seed);
  const g = new Game([{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
  const policies = pols.map((n) => POLICIES[n]);
  playToEnd(g, policies);
  return [g.players[0].score, g.players[1].score];
}

// Head-to-head over N shoes, seat-swapped so first-player/seat bias cancels.
// Returns win-rate of policy `a` and the mean score margin (a - b).
function headToHead(a, b, seeds) {
  let aWins = 0, decided = 0, marginSum = 0;
  for (const s of seeds) {
    const [s0, s1] = playGame(s, [a, b]);   // a in seat 0
    marginSum += s0 - s1;
    if (s0 !== s1) { decided++; if (s0 > s1) aWins++; }
    const [t0, t1] = playGame(s, [b, a]);   // a in seat 1 (swap)
    marginSum += t1 - t0;
    if (t0 !== t1) { decided++; if (t1 > t0) aWins++; }
  }
  return { winRate: aWins / decided, margin: marginSum / (2 * seeds.length), decided };
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function variance(xs) { const m = mean(xs); return mean(xs.map((x) => (x - m) ** 2)); }
function stdev(xs) { return Math.sqrt(variance(xs)); }
function pct(x) { return (100 * x).toFixed(1) + '%'; }

// ====================================================================== //
const scale = Math.max(0.1, parseFloat(process.argv[2] || '1'));
const N_A = Math.round(3000 * scale);   // luck-floor shoes
const N_B = Math.round(1000 * scale);   // shoes per ladder pairing (x2 for swap)
const N_C = Math.round(300 * scale);    // shoes for the variance decomposition
const N_REGRET = Math.max(6, Math.round(14 * scale)); // games for the regret pass
const seedsA = Array.from({ length: N_A }, (_, i) => i * 2654435761 + 7);
const seedsB = Array.from({ length: N_B }, (_, i) => i * 40503 + 101);
const seedsC = Array.from({ length: N_C }, (_, i) => i * 2246822519 + 13);

console.log('Vitrea — chance vs. skill, 2-player head-to-head');
console.log(`(scale ${scale}: ${N_A} luck shoes, ${N_B}×2 per ladder pair, ${N_C} ANOVA shoes, ${N_REGRET} regret games)\n`);

// ---- A. luck floor: same policy on both seats ---------------------------
// Both players are equally skilled, so 100% of the outcome is chance. We report
// how *large* that chance swing is, and any residual seat advantage.
console.log('A. LUCK FLOOR  (identical policy vs. itself — every result is pure luck)');
for (const pol of ['greedy', 'pushluck']) {
  let s0wins = 0, decided = 0;
  const margins = [], scores = [];
  for (const s of seedsA) {
    const [a, b] = playGame(s, [pol, pol]);
    margins.push(Math.abs(a - b));
    scores.push(a, b);
    if (a !== b) { decided++; if (a > b) s0wins++; }
  }
  const avgScore = mean(scores);
  console.log(
    `   ${pol.padEnd(9)} avg score ${avgScore.toFixed(1)} | ` +
    `luck swings the margin ±${mean(margins).toFixed(1)} pts (${pct(mean(margins) / avgScore)} of a score) | ` +
    `seat-0 win ${pct(s0wins / decided)} (50% = seat-fair)`
  );
}
console.log('   -> In an evenly-matched game, this is how much luck alone decides.\n');

// ---- B. skill ladder: win-rate matrix -----------------------------------
console.log('B. SKILL LADDER  (win-rate of ROW policy vs. COLUMN policy)');
const header = '   ' + 'vs'.padEnd(10) + LADDER.map((p) => p.padStart(9)).join('');
console.log(header);
for (const a of LADDER) {
  let line = '   ' + a.padEnd(10);
  for (const b of LADDER) {
    if (a === b) { line += '       -- '; continue; }
    const { winRate } = headToHead(a, b, seedsB);
    line += pct(winRate).padStart(9) + ' ';
  }
  console.log(line);
}
const planVsRand = headToHead('planner', 'random', seedsB);
const pushVsGreedy = headToHead('pushluck', 'greedy', seedsB);
const placeSkill = headToHead('pushluck', 'evdumb', seedsB);
console.log(`   -> best (planner) vs. worst (random): ${pct(planVsRand.winRate)} ` +
  `(50% = pure chance, 100% = pure skill)`);
console.log(`   -> the press-your-luck read alone (pushluck vs. greedy): ${pct(pushVsGreedy.winRate)}`);
console.log(`   -> PLACEMENT skill alone (same EV draw, smart vs. random placement): ` +
  `${pct(placeSkill.winRate)}  [chain scoring: ${CHAIN_SCORING ? 'ON' : 'off'}]\n`);

// ---- C1. variance decomposition (two-way) -------------------------------
// scores[shoe][policy] = margin when `policy` (seat 0) faces a fixed greedy
// (seat 1) on that shoe. Variance across shoes = luck; across policies = skill.
console.log('C. VARIANCE DECOMPOSITION  (margin vs. a fixed greedy opponent)');
const M = seedsC.map((s) => LADDER.map((p) => {
  const [a, b] = playGame(s, [p, 'greedy']);
  return a - b;
}));
const colMean = LADDER.map((_, j) => mean(M.map((row) => row[j])));  // per-policy
const rowMean = M.map((row) => mean(row));                            // per-shoe
const skillVar = variance(colMean);
const luckVar = variance(rowMean);
const skillShare = skillVar / (skillVar + luckVar);
console.log(`   skill variance (policy effect): ${skillVar.toFixed(1)}`);
console.log(`   luck  variance (shoe effect):   ${luckVar.toFixed(1)}`);
console.log(`   -> SKILL SHARE ≈ ${pct(skillShare)} of explained outcome variance ` +
  `(rest is the shoe).\n`);

// ---- C2. per-decision regret -------------------------------------------
// On a sample of planner-vs-planner games, at every decision we replay each
// legal action to game-end under the *same* future draws (RNG snapshot/restore)
// and measure the best-vs-worst score swing that decision controlled. That's the
// raw leverage skill has, separated from the luck of the draw.
console.log('D. DECISION LEVERAGE  (points a single choice controls, same future held fixed)');
const leverages = [];
let regretSum = 0, decisions = 0, games = 0;
for (let gi = 0; gi < N_REGRET; gi++) {
  setSeed(seedsC[gi % seedsC.length] ^ 0x9e3779b9);
  const g = new Game([{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
  const pols = [POLICIES.planner, POLICIES.planner];
  let guard = 0;
  while (g.phase === 'playing') {
    const me = g.current();
    const phase = g.turnPhase;
    let actions;
    if (phase === 'draw') actions = [{ kind: 'draw' }, { kind: 'stop' }];
    else {
      const legals = legalPlacements(g, me);
      actions = legals.length ? legals.map((l) => ({ kind: 'place', ...l }))
        : [{ kind: 'discard', handIndex: 0 }];
    }
    const snap = snapshotRNG();
    let outcomes;
    if (actions.length > 1) {
      outcomes = actions.map((a) => {
        restoreRNG(snap);
        const c = cloneGame(g);
        applyAction(c, c.current(), a);
        playToEnd(c, pols);
        return c.players[me.seat].score;
      });
    }
    const chosen = chooseAction(pols[me.seat], g, me);
    restoreRNG(snap);             // re-sync the real line to the branch we keep
    if (actions.length > 1) {
      const ci = actions.findIndex((a) => a.kind === chosen.kind &&
        a.handIndex === chosen.handIndex && a.r === chosen.r && a.c === chosen.c);
      const best = Math.max(...outcomes), worst = Math.min(...outcomes);
      leverages.push(best - worst);
      regretSum += best - outcomes[ci < 0 ? 0 : ci];
      decisions++;
    }
    applyAction(g, me, chosen);
    if (++guard > 100000) throw new Error('runaway regret game');
  }
  games++;
}
leverages.sort((a, b) => a - b);
const median = leverages[Math.floor(leverages.length / 2)];
const pivotal = leverages.filter((x) => x >= 10).length / leverages.length;
const trivial = leverages.filter((x) => x === 0).length / leverages.length;
console.log(`   median decision leverage:   ${median.toFixed(1)} pts (best vs. worst legal choice, final score)`);
console.log(`   avg regret of the planner:  ${(regretSum / decisions).toFixed(2)} pts left on the table per decision`);
console.log(`   pivotal decisions (≥10 pts): ${pct(pivotal)}   |   forced/no-choice: ${pct(trivial)}`);
console.log(`   -> most choices barely matter; a minority swing the game — the signature of`);
console.log(`      a press-your-luck game (the bust/stop calls are where skill concentrates).\n`);

console.log('Read it together: B says skill clearly beats chance head-to-head;');
console.log('A & C say a single even game still swings a lot on the shoe; D says how');
console.log('many points good decisions are worth. Retune constants in engine.js to move them.');
