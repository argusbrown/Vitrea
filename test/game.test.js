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
    // Score can dip below zero — each deliberate discard costs points.
    assert(Number.isInteger(p.score), `${label}: integer score`);
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
  const penalty = g.snapshot().rules.bustPenalty;
  g.hand = ['ruby'];
  g.bag.push('ruby'); // next pop is ruby -> bust
  g.draw('a');
  assert(g.hand.length === 0, 'bust clears hand');
  assert(g.turnSeat === 1, 'bust passes turn');
  assert(g.players[0].busts === 1, 'bust counted');
  assert(g.players[0].score === -penalty, `bust costs ${penalty} points (got ${g.players[0].score})`);
  const bustEv = g.events.find((e) => e.type === 'bust');
  assert(bustEv && bustEv.points === penalty, 'bust event carries the penalty');
}

// chain scoring is capped: a junction never pays more than CHAIN_CAP
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.sockets = {};
  g.turnPhase = 'place';
  // full row arm + full column arm meeting at (0,4): uncapped h+v would be 10
  for (let c = 0; c < 4; c++) p.window[0][c] = PRISM;
  for (let r = 1; r < 5; r++) p.window[r][4] = PRISM;
  const cap = g.snapshot().rules.chainCap;
  const before = p.score;
  g.hand = ['ruby'];
  g.place('a', 0, 0, 4);
  assert(p.score - before === cap, `junction capped at ${cap} (got +${p.score - before})`);
}

// every player drafts onto the SAME socket pattern
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  const first = JSON.stringify(g.players[0].sockets);
  assert(g.players.every((p) => JSON.stringify(p.sockets) === first), 'sockets identical across players');
  assert(g.players[0].sockets !== g.players[1].sockets, 'each player still owns a copy');
  assert(g.snapshot().rules.sharedSockets === true, 'sharedSockets exposed in rules');
}

// equal turns: when the STARTER (a non-zero seat) finishes, every other seat
// still gets its equalizing turn before the game ends (the old wrap-at-seat-0
// logic ended the game immediately).
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { startSeat: 1 });
  const p = g.players[1];
  // fill B's window except one cell, then let B (the starter) finish
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) p.window[r][c] = PRISM;
  p.window[0][0] = null;
  g.turnPhase = 'place';
  g.hand = [PRISM];
  g.place('b', 0, 0, 0);
  assert(g.finishTriggered, 'finish triggered');
  assert(g.phase === 'playing', 'game does not end before seat 0 has an equal turn');
  assert(g.turnSeat === 0, 'seat 0 gets the equalizing turn');
  g.stop('a'); // seat 0 passes — now the round has truly wrapped
  assert(g.phase === 'finished', 'game ends once all seats had equal turns');
}

// discarding a shard costs a point and is tallied
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.hand = ['ruby', 'amber'];
  g.turnPhase = 'place';
  g.discardShard('a', 0);
  assert(g.players[0].score === -1, 'discard penalises score');
  assert(g.players[0].discards === 1, 'discard counted');
  assert(g.hand.length === 1 && g.hand[0] === 'amber', 'only the chosen shard is discarded');
  assert(g.turnSeat === 0 && g.turnPhase === 'place', 'turn continues while shards remain');
  assert(g.events.some((e) => e.type === 'discard'), 'discard event emitted');
  g.discardShard('a', 0);
  assert(g.players[0].score === -2 && g.players[0].discards === 2, 'each discard stacks');
  assert(g.turnSeat === 1, 'turn ends when the hand empties');
}

// spectrum: holding all six colours scores the top tier and moves to placement
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.bag.push(...COLORS.slice().reverse()); // next six pops are six unique colors
  for (let i = 0; i < 6; i++) g.draw('a');
  assert(g.players[0].score === 12, 'full spectrum bonus scored');
  assert(g.players[0].spectrums === 1, 'spectrum counted');
  assert(g.turnPhase === 'place', 'spectrum forces placement');
}

// partial spectrum: banking 5 distinct colours pays the mid tier on stop
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.bag.push(...COLORS.slice(0, 5).reverse()); // five unique colours, no sixth
  for (let i = 0; i < 5; i++) g.draw('a');
  assert(g.players[0].score === 0, 'no bonus until banked');
  g.stop('a');
  assert(g.players[0].score === 6, 'five-colour bank scores the 5 tier');
  assert(g.players[0].spectrums === 0, 'partial is not a full spectrum');
  assert(g.turnPhase === 'place', 'stop moves to placement');
}

// partial spectrum: banking 4 colours pays the low tier; 3 or fewer pays nothing
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.bag.push(...COLORS.slice(0, 4).reverse());
  for (let i = 0; i < 4; i++) g.draw('a');
  g.stop('a');
  assert(g.players[0].score === 3, 'four-colour bank scores the 4 tier');

  const h = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  h.bag.push(...COLORS.slice(0, 3).reverse());
  for (let i = 0; i < 3; i++) h.draw('a');
  h.stop('a');
  assert(h.players[0].score === 0, 'three colours earns no partial bonus');
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

// a full, single-colour diagonal scores; the last placement awards the bonus
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.sockets = {};
  g.turnPhase = 'place';
  for (let i = 0; i < 4; i++) p.window[i][i] = 'ruby';
  const diagBonus = g.snapshot().rules.diagBonus;
  const before = p.score;
  g.hand = ['ruby'];
  g.place('a', 0, 4, 4);
  assert(p.score - before >= 1 + diagBonus, `single-colour diagonal scores (got +${p.score - before})`);
  assert(g.events.some((e) => e.type === 'score' && e.reason === 'diagonal'), 'diagonal event emitted');
}

// a full but MIXED-colour diagonal scores no bonus (the reported bug)
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.sockets = {};
  g.turnPhase = 'place';
  p.window[0][0] = 'ruby';
  p.window[1][1] = 'emerald';
  p.window[2][2] = 'ruby';
  p.window[3][3] = 'ruby';
  g.events.length = 0;
  const before = p.score;
  g.hand = ['ruby'];
  g.place('a', 0, 4, 4);
  assert(p.score - before === 1, `mixed-colour diagonal scores no bonus (got +${p.score - before})`);
  assert(!g.events.some((e) => e.type === 'score' && e.reason === 'diagonal'), 'no diagonal event for mixed colours');
}

// a prism on the diagonal is wild and keeps it monochrome
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.sockets = {};
  g.turnPhase = 'place';
  p.window[0][0] = 'ruby';
  p.window[1][1] = PRISM;
  p.window[2][2] = 'ruby';
  p.window[3][3] = 'ruby';
  const diagBonus = g.snapshot().rules.diagBonus;
  const before = p.score;
  g.hand = ['ruby'];
  g.place('a', 0, 4, 4);
  assert(p.score - before >= 1 + diagBonus, `prism keeps diagonal monochrome (got +${p.score - before})`);
}

// both diagonals score independently — the shared centre is just a cell.
function diagEventsForBoth(centerShard, sameColour) {
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const p = g.players[0];
  p.sockets = {};
  g.turnPhase = 'place';
  // both diagonals share the centre (2,2); place it last
  const arms = [[0, 0], [1, 1], [3, 3], [4, 4], [0, 4], [1, 3], [3, 1], [4, 0]];
  const colours = ['ruby', 'amber', 'emerald', 'sapphire', 'amethyst', 'moonstone'];
  arms.forEach(([r, c], i) => { p.window[r][c] = sameColour ? 'ruby' : colours[i % colours.length]; });
  g.events.length = 0;
  g.hand = [centerShard];
  g.place('a', 0, 2, 2);
  return g.events.filter((e) => e.type === 'score' && e.reason === 'diagonal').length;
}
{
  assert(diagEventsForBoth('ruby', true) === 2, 'two single-colour diagonals both score even with a solid shared centre');
  assert(diagEventsForBoth(PRISM, true) === 2, 'prism centre keeps both single-colour diagonals scoring');
  assert(diagEventsForBoth('ruby', false) === 0, 'mixed-colour diagonals do not score');
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

// startSeat picks who goes first, announces it, and survives a round-trip
{
  const infos = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const g = new Game(infos, { startSeat: 2 });
  assert(g.turnSeat === 2 && g.startSeat === 2, 'startSeat seats the first turn');
  assert(g.current().id === 'c', 'startSeat current() is the chosen player');
  const fp = g.events.find((e) => e.type === 'firstPlayer');
  assert(fp && fp.seat === 2 && fp.name === 'C', 'firstPlayer event announces the starter');
  const revived = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert(revived.startSeat === 2 && revived.turnSeat === 2, 'startSeat survives serialization');

  // default + out-of-range fall back to seat 0
  assert(new Game(infos).startSeat === 0, 'default startSeat is seat 0');
  assert(new Game(infos, { startSeat: 9 }).startSeat === 0, 'out-of-range startSeat falls back to 0');
  assert(new Game(infos, { startSeat: -1 }).startSeat === 0, 'negative startSeat falls back to 0');
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

// --- sfx node-safety guards -------------------------------------------------
// sfx.js is browser-only (Web Audio) but must load under Node without throwing
// and no-op when AudioContext is undefined, so this runner can require it.
{
  const Sfx = require('../public/js/sfx');
  assert(typeof Sfx.play === 'function', 'sfx exposes play()');
  assert(typeof Sfx.ensureAudio === 'function', 'sfx exposes ensureAudio()');
  assert(typeof Sfx.setMuted === 'function', 'sfx exposes setMuted()');
  // No AudioContext in Node: every entry point must be a safe no-op.
  Sfx.ensureAudio();
  Sfx.play('reveal', { mine: true, intensity: 0.5 });
  Sfx.play('bust', { mine: false });
  Sfx.play('totally-unknown-event', {}); // unmapped -> silent no-op
  Sfx.play('turn'); // mineOnly without opts -> no throw
  assert(Sfx.isMuted() === false, 'default unmuted (no localStorage in Node)');
  assert(Sfx.toggleMute() === true && Sfx.isMuted() === true, 'toggle mutes');
  assert(Sfx.setMuted(false) === false, 'setMuted returns new state');
  console.log('ok — sfx.js loads + no-ops safely under Node');
}
