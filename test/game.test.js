'use strict';

// Monte-carlo exercise of the Vitrea engine: play many full games with
// random (but legal) moves and assert the invariants hold throughout.

const { Game, COLORS, PRISM, ROWS, COLS } = require('../public/js/engine');

// Derive the bag size from the engine so tuning constants can't desync the test.
const TOTAL_SHARDS = new Game([{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]).bag.length;

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
  // a live hand may hold several prisms, but never a duplicate colour
  const colors = g.hand.filter((s) => s !== PRISM);
  assert(new Set(colors).size === colors.length, `${label}: hand has duplicate colours`);
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

// spectrum: holding all six colours scores and moves to placement
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.bag.push(...COLORS.slice().reverse()); // next six pops are six unique colors
  for (let i = 0; i < 6; i++) g.draw('a');
  assert(g.players[0].score === 7, 'spectrum bonus scored');
  assert(g.players[0].spectrums === 1, 'spectrum counted');
  assert(g.turnPhase === 'place', 'spectrum forces placement');
}

// prism shield: a clash is absorbed by spending a prism instead of busting
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.hand = ['ruby', PRISM];
  g.bag.push('ruby'); // next pop clashes with the ruby in hand
  g.draw('a');
  assert(g.players[0].busts === 0, 'shield prevents a bust');
  assert(g.hand.length === 1 && g.hand[0] === 'ruby', 'prism and clash discarded, ruby kept');
  assert(g.turnSeat === 0 && g.turnPhase === 'draw', 'turn continues after a shield');
  assert(g.events.some((e) => e.type === 'shield'), 'shield event emitted');
}

// prisms never clash with each other; you may hold several
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.hand = [PRISM];
  g.bag.push(PRISM);
  g.draw('a');
  assert(g.players[0].busts === 0, 'second prism does not crack');
  assert(g.hand.filter((s) => s === PRISM).length === 2, 'two prisms held');
}

// drawing a clash with no prism still cracks
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.hand = ['ruby'];
  g.bag.push('ruby');
  g.draw('a');
  assert(g.players[0].busts === 1 && g.hand.length === 0, 'no shield -> crack');
}

// diagonal bonus on a square window
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.sockets = {};
  g.turnPhase = 'place';
  // fill the main diagonal; the last placement should award the diagonal bonus
  const diag = [[0, 0, 'ruby'], [1, 1, 'amber'], [2, 2, 'emerald'], [3, 3, 'sapphire'], [4, 4, 'amethyst']];
  for (let i = 0; i < diag.length - 1; i++) p.window[diag[i][0]][diag[i][1]] = diag[i][2];
  const diagBonus = g.snapshot().rules.diagBonus;
  const before = p.score;
  g.hand = ['amethyst'];
  g.place('a', 0, 4, 4);
  assert(p.score - before >= 1 + diagBonus, `diagonal bonus scored (got +${p.score - before})`);
  assert(g.events.some((e) => e.type === 'score' && e.reason === 'diagonal'), 'diagonal event emitted');
}

// completing BOTH diagonals: a solid centre scores one, a prism centre scores two.
function fillBothDiagonals(centerShard) {
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.sockets = {};
  g.turnPhase = 'place';
  // both diagonals share the centre (2,2); place it last
  const arms = [[0, 0], [1, 1], [3, 3], [4, 4], [0, 4], [1, 3], [3, 1], [4, 0]];
  const colours = ['ruby', 'amber', 'emerald', 'sapphire', 'amethyst', 'moonstone'];
  arms.forEach(([r, c], i) => { p.window[r][c] = colours[i % colours.length]; });
  g.events.length = 0;
  g.hand = [centerShard];
  g.place('a', 0, 2, 2);
  return g.events.filter((e) => e.type === 'score' && e.reason === 'diagonal').length;
}
{
  assert(fillBothDiagonals('emerald') === 1, 'solid centre scores only one diagonal');
  assert(fillBothDiagonals(PRISM) === 2, 'prism centre scores both diagonals');
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

// serialization round-trip mid-game keeps playing identically
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.draw('a');
  const revived = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert(revived.current().id === g.current().id, 'revived turn preserved');
  assert(JSON.stringify(revived.snapshot()) === JSON.stringify(g.snapshot()), 'revived snapshot identical');
  revived.stop('a'); // must not throw; game continues from restored state
  assert(revived.turnPhase === 'place' || revived.turnSeat === 1, 'revived game playable');
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
