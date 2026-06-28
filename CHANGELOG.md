# Changelog

All notable changes to Vitrea are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions match `public/js/version.js` and `package.json` (`MAJOR.MINOR.PATCH`).

## [1.17.5] - 2026-06-28

### Changed
- **"Your turn" no longer covers the board.** Now that the board stays visible
  while auto-watching, the full-screen "Your turn" banner was hiding it. Your
  turn is now signalled by a brief gold pulse on the kiln at the top (which
  already reads "Your turn — draw from the kiln"), plus the usual haptic buzz.
- Lengthened the auto-watch linger to 750ms (from 500ms) so the player who just
  acted stays on screen a touch longer before the board follows the next turn.

## [1.17.4] - 2026-06-27

### Fixed
- **A scanned join link now wins over your last game.** If you hosted a game and
  never left it, opening another game's QR code (or join link) used to resurrect
  your own hosted room instead of joining the new one. An explicit `?room=…` link
  now takes precedence over auto-resuming a prior session — the only time it
  still auto-resumes is a guest reloading their own join page.

## [1.17.3] - 2026-06-27

### Fixed
- **The auto-watch linger now works on every turn, not just the first.** 1.17.2's
  linger froze on a single in-flight flag, so once turns came faster than the
  half-second delay the board stopped pausing and could even show the wrong
  player. It now tracks the player it's easing toward and re-arms on every
  hand-off, so each player's final placement gets its beat on screen all game.

## [1.17.2] - 2026-06-27

### Fixed
- **Auto-watch now lingers on the player who just acted.** When a watched player
  placed their final shard the central board jumped to the next player instantly
  (the turn-advancing snapshot already names them), so watchers never saw the
  move land. The board now holds on the player who just finished for half a
  second before following the next one.

## [1.17.1] - 2026-06-24

### Changed
- **Watch the active player inline instead of in a modal.** The spectator no
  longer pops a full-screen card that buried the live action. While it isn't your
  turn, your central board now shows the active player's window filling in live,
  so their drawn shards (the kiln), crack risk, banked spectrum bonus, and every
  score in the top strip all stay visible at once. Reverts to your own board on
  your turn. The eye toggle (👁️) is now always reachable, and tapping a player
  chip still opens the detailed peek card on demand.

## [1.17.0] - 2026-06-24

### Added
- **Watch the active player live.** While it isn't your turn, a spectator view
  auto-opens and follows whoever is currently drawing and placing — their window
  and score update in real time as they press their luck. It closes automatically
  on your turn so the kiln and your own board stay clear. Tapping any player chip
  still opens a manual live peek of that player. A new eye toggle (👁️) in the
  game top bar turns auto-watch on/off (on by default, remembered per device);
  closing the spectator view also turns it off until you re-enable it.

## [1.16.3] - 2026-06-24

### Fixed
- Rewrote the chain-scoring explanation in the in-game "How to play" (and README)
  so it matches the engine: a shard scores the unbroken line it extends, counting
  both directions only where a row and column cross, and a lone shard scores 1.
  The old wording claimed it always scored "row and column", which contradicted
  itself.
- Clarified the adjacency rule — "touching shards may never share a colour" (it
  applies in every direction, not just "side-by-side") — and noted that a line of
  glass is therefore always a mix of colours. Reordered the spectrum tip ahead of
  placement so the rules follow the turn's actual order.

## [1.16.2] - 2026-06-24

### Fixed
- The "Your window" score breakdown no longer lists separate "rows" and
  "columns" (which stopped scoring on their own with v1.16.0 chain scoring).
  Completed full rows and columns are now shown together as "bright lines",
  matching the in-game and toast vocabulary.

## [1.16.1] - 2026-06-24

### Fixed
- In-game "How to play" scoring now matches the v1.16.0 chain scoring: a shard
  scores the row + column run it joins, and the stale "completed row / column"
  bonus lines were removed. Added a one-line strategy hint about lining glass up.

## [1.16.0] - 2026-06-24

### Changed
- Placing a shard now scores the length of the contiguous run it joins
  (Azul-style "chain scoring") instead of a flat 1 point: a shard at the
  junction of a horizontal and vertical line scores both runs. Where you place
  finally matters — building and connecting lines is now the core placement
  skill, not just finding any legal cell.
- Removed the separate full-row and full-column bonuses; the run already pays
  out for completing a line, so the old bonuses double-counted. A long line is
  announced as a "bright line" with the scoring flourish.

## [1.15.0] - 2026-06-24

### Changed
- The first turn no longer always goes to the host. A fresh game now picks a
  random player to go first, and each rematch ("Play again") rotates the lead
  one seat onward, so it passes around the table over a series. A "✦ X goes
  first" banner (with a sound flourish) announces who starts.

## [1.14.1] - 2026-06-16

### Added
- Live spectrum-zone readout while drawing. The kiln hint now shows how many
  distinct colours you hold and what you'd bank by stopping now ("✦ Glimmer +3
  banked · +6 at 5"), plus a "2 more for Glimmer (+3)" nudge before the first
  tier. The Keep button shows the banked bonus inline ("Keep 5 shards · +6"), so
  you can see you're entering Glimmer/Radiance before you commit.

## [1.14.0] - 2026-06-16

### Changed
- Tiered spectrum scoring. Banking distinct colours in one turn now pays on a
  ladder instead of all-or-nothing: 4 colours = +3 ("Glimmer"), 5 colours = +6
  ("Radiance"), all 6 = +12 (Perfect Spectrum). The full spectrum (~1 in 20)
  finally out-scores a diagonal (+8) and the finish bonus (+10), and a near-miss
  is worth banking instead of wasted. Tunable via `SPECTRUM_TIERS` in
  `engine.js`. Replaces the flat `SPECTRUM_BONUS` of 7.

### Added
- Partial-spectrum feedback: a "Glimmer"/"Radiance" banner and a softer chime
  fire when you bank 4–5 colours, distinct from the full Perfect Spectrum cue.

## [1.13.2] - 2026-06-16

### Changed
- Softened the scoring sound. Completing a socket, row, column, or diagonal now
  plays a gentle two-note marimba "ta-da" rising a fifth, instead of the bright
  glassy chime that clashed with the placement sound on scoring placements.

## [1.13.1] - 2026-06-16

### Changed
- Softened the tile-placement sound. It was a sharp glassy clink; it's now a
  round, woody marimba-like tone with a gentle attack — calmer to hear over a
  full game.

## [1.13.0] - 2026-06-16

### Added
- Glassy synthesized sound effects, built entirely with the Web Audio API — no
  audio files. A draw chime whose pitch rises with your bust risk, a shattering
  glass sound when you crack, and cues for placements, scores, spectrums, prism
  shields, and turns.
- Mute toggle on the home screen and in-game header. Sound is on by default and
  the choice is remembered across reloads.

## [1.12.0] - 2026-06-15

### Changed
- Deliberately discarding a shard now costs 1 point, so a player's score can dip
  below zero. Discarding is a real trade-off instead of a free reset.

## [1.11.0] - 2026-06-15

### Added
- "How to play" help is reachable from the home screen.

## [1.10.1] - 2026-06-15

### Changed
- Connection check now shows the live Cloudflare relay and no longer probes the
  dead free public relays.

## [1.10.0] - 2026-06-15

### Added
- Live Cloudflare TURN relay so phones can connect on networks with client/AP
  isolation (some guest, hotel, and office Wi-Fi). Short-lived credentials are
  minted by a Cloudflare Worker, keeping the relay key off the public page.

---

Versions before 1.10.0 predate on-screen version stamping. They cover the
original peer-to-peer multiplayer foundation: QR-code join, the authoritative
host-tab engine over WebRTC, the 5x5 board with diagonal scoring and
prism-shield draws, and reconnect / host-resume.
