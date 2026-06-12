'use strict';

// Monte-carlo exercise of the Vitrea engine: play many full games with
// random (but legal) moves and assert the invariants hold throughout.

const { Game, COLORS, PRISM, ROWS, COLS } = require('../server/game');

const TOTAL_SHARDS = COLORS.length * 16 + 8;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

function shardsOnWindows(g) {
  let n = 0;
  for (const p of g.players) {
    for (const row of p.window) for (const cell of row) if (cell !== null) n++;
  }
  return n;
}

function checkInvariants(g, label) {
  const inPlay = g.bag.length + g.discardPile.length + g.hand.length + shardsOnWindows(g);
  assert(inPlay === TOTAL_SHARDS, `${label}: shard conservation (${inPlay} != ${TOTAL_SHARDS})`);
  for (const p of g.players) {
    assert(p.score >= 0, `${label}: non-negative score`);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const s = p.window[r][c];
        if (!s || s === PRISM) continue;
        if (c + 1 < COLS) assert(p.window[r][c + 1] !== s, `${label}: adjacency violated`);
        if (r + 1 < ROWS) assert(p.window[r + 1][c] !== s, `${label}: adjacency violated`);
      }
    }
  }
  // no duplicate colors in a live hand
  assert(new Set(g.hand).size === g.hand.length, `${label}: hand has duplicates`);
}

function playRandomGame(numPlayers, seedTag) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const g = new Game(players);
  let safety = 20000;

  while (g.phase === 'playing' && safety-- > 0) {
    const cur = g.current();
    if (g.turnPhase === 'draw') {
      // draw with 65% probability, otherwise stop
      if (Math.random() < 0.65) g.draw(cur.id);
      else g.stop(cur.id);
    } else {
      assert(g.hand.length > 0, `${seedTag}: place phase never has an empty hand`);
      const shard = g.hand[0];
      const spots = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (g.canPlace(cur, shard, r, c)) spots.push([r, c]);
        }
      }
      if (spots.length === 0 || Math.random() < 0.1) {
        g.discardShard(cur.id, 0);
      } else {
        const [r, c] = spots[Math.floor(Math.random() * spots.length)];
        g.place(cur.id, 0, r, c);
      }
    }
    checkInvariants(g, seedTag);
  }
  assert(g.phase === 'finished', `${seedTag}: game terminated`);
  assert(Array.isArray(g.standings) && g.standings.length === numPlayers, `${seedTag}: standings`);
  JSON.stringify(g.snapshot()); // snapshot must serialize
  return g;
}

// --- targeted unit checks -------------------------------------------------

// turn rejection
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  let threw = false;
  try { g.draw('b'); } catch { threw = true; }
  assert(threw, 'off-turn draw rejected');
}

// bust mechanics: force a duplicate
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.hand = ['ruby'];
  g.bag.push('ruby'); // next pop is ruby -> bust
  g.draw('a');
  assert(g.hand.length === 0, 'bust clears hand');
  assert(g.turnSeat === 1, 'bust passes turn');
  assert(g.players[0].busts === 1, 'bust counted');
  assert(g.events.some((e) => e.type === 'bust'), 'bust event emitted');
}

// spectrum: six unique draws scores and moves to placement
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.bag.push(...COLORS.slice().reverse()); // next six pops are six unique colors
  for (let i = 0; i < 6; i++) g.draw('a');
  assert(g.players[0].score === 7, 'spectrum bonus scored');
  assert(g.turnPhase === 'place', 'spectrum forces placement');
}

// prism ignores adjacency; same colors may not touch
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.window[0][0] = 'ruby';
  assert(!g.canPlace(p, 'ruby', 0, 1), 'same color adjacency blocked');
  assert(g.canPlace(p, 'ruby', 1, 1), 'diagonal is fine');
  assert(g.canPlace(p, PRISM, 0, 1), 'prism placeable anywhere empty');
  assert(!g.canPlace(p, PRISM, 0, 0), 'occupied cell blocked');
}

// socket + row scoring
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.sockets = { '0,0': 'ruby' };
  g.turnPhase = 'place';
  g.hand = ['ruby'];
  g.place('a', 0, 0, 0);
  assert(p.score === 1 + 3, `socket match scores (got ${p.score})`);
}

// --- monte carlo -----------------------------------------------------------

let totalRounds = 0;
let finishes = 0;
const GAMES = 400;
for (let i = 0; i < GAMES; i++) {
  const n = 2 + (i % 5); // 2..6 players
  const g = playRandomGame(n, `game#${i}(${n}p)`);
  totalRounds += g.round;
  if (g.finishTriggered) finishes++;
}

console.log(`ok — ${GAMES} random games completed`);
console.log(`   avg rounds: ${(totalRounds / GAMES).toFixed(1)}, window-finish endings: ${finishes}/${GAMES}`);
