'use strict';

/* ============================================================
   Vitrea networking — the host's browser IS the server.

   The authoritative Room lives in the host's tab. Guests connect
   over WebRTC data channels (PeerJS); the PeerJS signaling server
   is only used to introduce phones to each other. The wire
   protocol is identical for host (loopback) and guests:
     client -> room : {type: join|rejoin|start|draw|stop|place|discard|skipTurn|playAgain}
     room -> client : {type: joined|state|error}
   ============================================================ */

const VitreaNet = (() => {
  const { Game } = window.VitreaEngine;

  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
  const PEER_PREFIX = 'vitrea-w7k-'; // namespace our ids on the public broker
  const HOST_ROOM_KEY = 'vitrea-hostroom';
  const MAX_PLAYERS = 6;

  function newCode() {
    return Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  }

  function randomId(bytes = 16) {
    if (crypto.randomUUID) return crypto.randomUUID();
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Optional override of the signaling server: ?ps=host:port (used by the
  // automated tests, and handy if the public PeerJS cloud is ever down).
  // The ICE list extends PeerJS's default (one STUN + UDP-only TURN) with
  // extra STUN and TCP/443 relays so restrictive networks can still connect.
  const ICE_CONFIG = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      {
        urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
        username: 'peerjs',
        credential: 'peerjsp',
      },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
          'turns:openrelay.metered.ca:443',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  };

  // A Cloudflare Worker mints short-lived TURN credentials so the relay key
  // never ships in this public page. Set this to your deployed Worker URL (see
  // worker/README.md). Leave '' to skip it and use the static relays only.
  const TURN_WORKER_URL = '';

  // Fetched creds are cached until shortly before they expire; on any failure
  // we fall back to ICE_CONFIG so play still works without the relay.
  let _turnCache = null; // { servers: [...], expires: ms-epoch }

  async function fetchTurnServers() {
    if (!TURN_WORKER_URL) return null;
    if (_turnCache && _turnCache.expires > Date.now() + 60000) return _turnCache.servers;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(TURN_WORKER_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return _turnCache ? _turnCache.servers : null;
      const data = await res.json();
      const raw = data && data.iceServers;
      const servers = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (!servers.length) return _turnCache ? _turnCache.servers : null;
      _turnCache = { servers, expires: Date.now() + (Number(data.ttl) || 86400) * 1000 };
      return servers;
    } catch {
      return _turnCache ? _turnCache.servers : null;
    }
  }

  // Resolve the full ICE config: Cloudflare relay first (preferred), then the
  // static STUN + free-relay fallbacks. Never rejects — worst case is ICE_CONFIG.
  async function resolveIce() {
    const turn = await fetchTurnServers();
    if (!turn || !turn.length) return ICE_CONFIG;
    return { iceServers: [...turn, ...ICE_CONFIG.iceServers] };
  }

  function peerOptions(ice) {
    const base = { config: ice || ICE_CONFIG };
    const ps = new URLSearchParams(location.search).get('ps');
    if (!ps) return base;
    const [host, port] = ps.split(':');
    return { ...base, host, port: Number(port) || 443, path: '/vitrea', secure: location.protocol === 'https:' };
  }

  function joinUrlFor(code) {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('room', code);
    const ps = new URLSearchParams(location.search).get('ps');
    if (ps) url.searchParams.set('ps', ps);
    return url.toString();
  }

  function sanitizeName(name) {
    const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
    return clean || 'Glazier';
  }

  /* ---------------- the authoritative room (host only) ---------------- */

  class Room {
    constructor(code, hostName) {
      this.code = code;
      this.phase = 'lobby'; // lobby | playing | finished
      this.game = null;
      this.players = []; // {id, token, name, connected}
      this.clients = new Map(); // playerId -> {send}
      const host = this.newPlayer(hostName);
      this.hostId = host.id;
    }

    static restore(data) {
      const room = Object.create(Room.prototype);
      room.code = data.code;
      room.phase = data.phase;
      room.hostId = data.hostId;
      room.players = data.players.map((p) => ({ ...p, connected: false }));
      room.game = data.game ? Game.fromJSON(data.game) : null;
      room.clients = new Map();
      return room;
    }

    persist() {
      try {
        localStorage.setItem(HOST_ROOM_KEY, JSON.stringify({
          code: this.code,
          phase: this.phase,
          hostId: this.hostId,
          players: this.players.map(({ id, token, name }) => ({ id, token, name })),
          game: this.game ? this.game.toJSON() : null,
        }));
      } catch { /* storage full or unavailable — play on without resume */ }
    }

    newPlayer(name) {
      const p = { id: randomId(), token: randomId(), name: sanitizeName(name), connected: true };
      this.players.push(p);
      return p;
    }

    attach(playerId, client) {
      const player = this.players.find((p) => p.id === playerId);
      this.clients.set(playerId, client);
      player.connected = true;
      client.send({ type: 'joined', code: this.code, you: { id: player.id, token: player.token } });
      this.broadcast();
    }

    detach(playerId, client) {
      const player = this.players.find((p) => p.id === playerId);
      if (!player) return;
      // a stale connection closing must not knock out a fresh reconnection
      if (client && this.clients.get(playerId) !== client) return;
      this.clients.delete(playerId);
      player.connected = false;
      if (this.phase === 'lobby' && playerId !== this.hostId) {
        this.players = this.players.filter((p) => p.id !== playerId);
      }
      this.broadcast();
    }

    stateMsg() {
      return {
        type: 'state',
        code: this.code,
        phase: this.phase,
        hostId: this.hostId,
        joinUrl: joinUrlFor(this.code),
        players: this.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
        game: this.game ? this.game.snapshot() : null,
      };
    }

    broadcast() {
      const msg = this.stateMsg();
      for (const client of this.clients.values()) client.send(msg);
      this.persist();
    }

    // msg.type 'join'/'rejoin' may arrive from a client with no player yet;
    // everything else requires an attached player.
    handle(client, msg, playerId) {
      switch (msg.type) {
        case 'join': {
          if (this.phase !== 'lobby') return client.send({ type: 'error', message: 'That game has already started.', fatal: true });
          if (this.players.length >= MAX_PLAYERS) return client.send({ type: 'error', message: `That game is full (${MAX_PLAYERS} players max).`, fatal: true });
          const player = this.newPlayer(msg.name);
          this.attach(player.id, client);
          return player.id;
        }
        case 'rejoin': {
          const player = this.players.find((p) => p.token === msg.token);
          if (!player) return client.send({ type: 'error', message: 'Could not rejoin that game.', fatal: true });
          this.attach(player.id, client);
          return player.id;
        }
      }

      if (!playerId) return;
      switch (msg.type) {
        case 'start': {
          if (this.phase !== 'lobby' || playerId !== this.hostId) return;
          if (this.players.length < 2) return client.send({ type: 'error', message: 'You need at least 2 players.' });
          this.phase = 'playing';
          this.game = new Game(this.players.map((p) => ({ id: p.id, name: p.name })));
          this.broadcast();
          break;
        }
        case 'draw':
        case 'stop':
        case 'place':
        case 'discard': {
          if (!this.game) return;
          try {
            if (msg.type === 'draw') this.game.draw(playerId);
            else if (msg.type === 'stop') this.game.stop(playerId);
            else if (msg.type === 'place') this.game.place(playerId, msg.i | 0, msg.r | 0, msg.c | 0);
            else this.game.discardShard(playerId, msg.i | 0);
          } catch (err) {
            return client.send({ type: 'error', message: err.message });
          }
          if (this.game.phase === 'finished') this.phase = 'finished';
          this.broadcast();
          break;
        }
        case 'skipTurn': {
          // host may skip the active player's turn, but only if they dropped
          if (!this.game || playerId !== this.hostId) return;
          const active = this.players.find((p) => p.id === this.game.current().id);
          if (active && active.connected) return client.send({ type: 'error', message: `${active.name} is still connected.` });
          this.game.forceEndTurn();
          if (this.game.phase === 'finished') this.phase = 'finished';
          this.broadcast();
          break;
        }
        case 'playAgain': {
          if (this.phase !== 'finished' || playerId !== this.hostId) return;
          this.phase = 'playing';
          this.game = new Game(this.players.map((p) => ({ id: p.id, name: p.name })));
          this.broadcast();
          break;
        }
      }
    }
  }

  /* ---------------- host transport ---------------- */

  // Resolves with {send} once the room is announced on the network.
  // onMessage receives room->client messages for the HOST's own UI.
  function host({ name, resume, onMessage, onStatus }) {
    return new Promise((resolve, reject) => {
      const room = resume ? Room.restore(resume) : new Room(newCode(), name);
      let attempts = 0;
      let settled = false;

      // The signaling websocket can stall without ever erroring; don't let
      // the host button hang forever.
      const killer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Could not reach the matchmaking service — check your internet connection and try again.'));
      }, 20000);

      function announce(ice) {
        const peer = new Peer(PEER_PREFIX + room.code, peerOptions(ice));

        peer.on('open', () => {
          // deliver to our own UI asynchronously, like a real socket would
          const localClient = { send: (msg) => queueMicrotask(() => onMessage(msg)) };
          room.attach(room.hostId, localClient);
          settled = true;
          clearTimeout(killer);
          resolve({
            code: room.code,
            send: (msg) => room.handle(localClient, msg, room.hostId),
          });
        });

        peer.on('connection', (conn) => {
          let playerId = null;
          const client = { send: (msg) => { try { conn.send(msg); } catch { /* gone */ } } };
          conn.on('data', (msg) => {
            if (!msg || typeof msg.type !== 'string') return;
            const claimed = room.handle(client, msg, playerId);
            if (claimed) playerId = claimed;
          });
          conn.on('close', () => { if (playerId) room.detach(playerId, client); });
          conn.on('error', () => { if (playerId) room.detach(playerId, client); });
        });

        peer.on('disconnected', () => {
          // lost the signaling server: existing games keep playing P2P,
          // but reconnect so new/rejoining players can find us
          if (onStatus) onStatus('signal-lost');
          try { peer.reconnect(); } catch { /* destroyed */ }
        });

        peer.on('error', (err) => {
          if (err.type === 'unavailable-id' && !resume && !settled && attempts++ < 5) {
            room.code = newCode(); // collision on the public broker — reroll
            peer.destroy();
            announce(ice);
            return;
          }
          if (!settled) {
            settled = true;
            clearTimeout(killer);
            reject(new Error(friendlyPeerError(err)));
          } else if (onStatus) {
            onStatus('error', friendlyPeerError(err));
          }
        });
      }

      resolveIce().then((ice) => { if (!settled) announce(ice); });
    });
  }

  /* ---------------- guest transport ---------------- */

  // Connects to the host and keeps reconnecting if the link drops.
  function join({ code, name, token, onMessage, onStatus }) {
    code = String(code || '').toUpperCase().trim();
    return new Promise((resolve, reject) => {
      let peer = null;
      let conn = null;
      let myToken = token || null;
      let everConnected = false;
      let stopped = false;
      let retryMs = 1000;
      let retryTimer = null;
      let stage = 'signal'; // signal -> link -> joined

      function fail(message) {
        if (everConnected || stopped) return;
        stopped = true;
        clearTimeout(killer);
        try { if (peer) peer.destroy(); } catch { /* already gone */ }
        reject(new Error(message));
      }

      // A blocked WebRTC link often produces NO event at all — without this,
      // the join button would hang forever with no explanation.
      const killer = setTimeout(() => {
        fail(stage === 'signal'
          ? 'Could not reach the matchmaking service — check your internet connection and try again.'
          : "Found the game, but couldn't open a direct link between the phones. This network may block device-to-device traffic (common on guest/hotel Wi-Fi) — try a phone hotspot or another network.");
      }, 25000);

      const transport = {
        code,
        send: (msg) => { if (conn && conn.open) conn.send(msg); },
        close: () => { stopped = true; clearTimeout(killer); try { if (peer) peer.destroy(); } catch { /* already gone */ } },
      };

      function connect() {
        if (stopped) return;
        stage = 'link';
        if (onStatus) onStatus('linking');
        conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        conn.on('iceStateChanged', (state) => {
          if (state === 'failed' && !everConnected) {
            fail('The phones found each other but the direct link was blocked. This network may block device-to-device traffic — try a phone hotspot or another network.');
          }
        });
        conn.on('open', () => {
          retryMs = 1000;
          conn.send(myToken ? { type: 'rejoin', token: myToken } : { type: 'join', name });
        });
        conn.on('data', (msg) => {
          if (!msg || typeof msg.type !== 'string') return;
          if (msg.type === 'joined') {
            stage = 'joined';
            myToken = msg.you.token;
            if (!everConnected) {
              everConnected = true;
              clearTimeout(killer);
              resolve(transport);
            }
          }
          if (msg.type === 'error' && msg.fatal) stopped = true;
          onMessage(msg);
        });
        conn.on('close', scheduleRetry);
        conn.on('error', scheduleRetry);
      }

      function scheduleRetry() {
        if (stopped || retryTimer) return;
        if (!everConnected) return; // initial failure is handled by peer error
        if (onStatus) onStatus('reconnecting');
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, retryMs);
        retryMs = Math.min(retryMs * 1.6, 8000);
      }

      resolveIce().then((ice) => {
        if (stopped) return;
        peer = new Peer(peerOptions(ice));
        peer.on('open', connect);
        peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* destroyed */ } });
        peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') {
            if (!everConnected) {
              fail("No game found with that code — is the host's lobby still open?");
            } else {
              scheduleRetry(); // host page may be reloading — keep looking for it
            }
            return;
          }
          if (!everConnected) fail(friendlyPeerError(err));
        });
      });
    });
  }

  function friendlyPeerError(err) {
    switch (err.type) {
      case 'peer-unavailable': return 'No game found with that code.';
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed': return 'Could not reach the matchmaking service — check your internet connection.';
      case 'browser-incompatible': return 'This browser does not support peer-to-peer play.';
      default: return 'Connection trouble: ' + (err.message || err.type || 'unknown error');
    }
  }

  function savedHostRoom() {
    try {
      return JSON.parse(localStorage.getItem(HOST_ROOM_KEY));
    } catch {
      return null;
    }
  }

  function clearHostRoom() {
    localStorage.removeItem(HOST_ROOM_KEY);
  }

  return { host, join, savedHostRoom, clearHostRoom, joinUrlFor, peerOptions, iceConfig: ICE_CONFIG, resolveIce };
})();
