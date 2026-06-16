# Changelog

All notable changes to Vitrea are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions match `public/js/version.js` and `package.json` (`MAJOR.MINOR.PATCH`).

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
