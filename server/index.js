'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ROOM_TTL_MS = 10 * 60 * 1000; // empty rooms are reclaimed after 10 minutes

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      // Unknown paths fall back to the app shell so /?room=CODE links work.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

/** rooms: code -> {
 *    code, hostId, phase: 'lobby'|'playing'|'finished',
 *    players: [{id, token, name, ws|null, connected}],
 *    game: Game|null, joinUrl, qrDataUrl, emptySince
 * } */
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
function newRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function roomState(room) {
  return {
    type: 'state',
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    joinUrl: room.joinUrl,
    qrDataUrl: room.qrDataUrl,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    game: room.game ? room.game.snapshot() : null,
  };
}

function broadcast(room) {
  const msg = roomState(room);
  for (const p of room.players) send(p.ws, msg);
}

function sanitizeName(name) {
  const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  return clean || 'Glazier';
}

async function createRoom(name) {
  const code = newRoomCode();
  const joinUrl = `http://${lanAddress()}:${PORT}/?room=${code}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, {
    margin: 1,
    width: 480,
    color: { dark: '#1b1430', light: '#f4ead8' },
  });
  const host = newPlayer(name);
  const room = {
    code,
    hostId: host.id,
    phase: 'lobby',
    players: [host],
    game: null,
    joinUrl,
    qrDataUrl,
    emptySince: null,
  };
  rooms.set(code, room);
  return { room, player: host };
}

function newPlayer(name) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(16).toString('hex'),
    name: sanitizeName(name),
    ws: null,
    connected: true,
  };
}

function attach(ws, room, player) {
  ws.room = room;
  ws.player = player;
  player.ws = ws;
  player.connected = true;
  room.emptySince = null;
  send(ws, { type: 'joined', code: room.code, you: { id: player.id, token: player.token } });
  broadcast(room);
}

function requireGameTurnAction(ws, fn) {
  const room = ws.room;
  if (!room || !room.game) return;
  try {
    fn(room.game);
  } catch (err) {
    send(ws, { type: 'error', message: err.message });
    return;
  }
  if (room.game.phase === 'finished') room.phase = 'finished';
  broadcast(room);
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const room = ws.room;
    try {
      switch (msg.type) {
        case 'create': {
          const { room: newRoom, player } = await createRoom(msg.name);
          attach(ws, newRoom, player);
          break;
        }
        case 'join': {
          const target = rooms.get(String(msg.code || '').toUpperCase().trim());
          if (!target) return send(ws, { type: 'error', message: 'No game found with that code.' });
          if (target.phase !== 'lobby') return send(ws, { type: 'error', message: 'That game has already started.' });
          if (target.players.length >= 6) return send(ws, { type: 'error', message: 'That game is full (6 players max).' });
          const player = newPlayer(msg.name);
          target.players.push(player);
          attach(ws, target, player);
          break;
        }
        case 'rejoin': {
          const target = rooms.get(String(msg.code || '').toUpperCase().trim());
          const player = target && target.players.find((p) => p.token === msg.token);
          if (!player) return send(ws, { type: 'error', message: 'Could not rejoin that game.', fatal: true });
          if (player.ws && player.ws !== ws) try { player.ws.close(); } catch {}
          attach(ws, target, player);
          break;
        }
        case 'start': {
          if (!room || room.phase !== 'lobby') return;
          if (ws.player.id !== room.hostId) return send(ws, { type: 'error', message: 'Only the host can start.' });
          if (room.players.length < 2) return send(ws, { type: 'error', message: 'You need at least 2 players.' });
          room.phase = 'playing';
          room.game = new Game(room.players.map((p) => ({ id: p.id, name: p.name })));
          broadcast(room);
          break;
        }
        case 'draw':
          requireGameTurnAction(ws, (g) => g.draw(ws.player.id));
          break;
        case 'stop':
          requireGameTurnAction(ws, (g) => g.stop(ws.player.id));
          break;
        case 'place':
          requireGameTurnAction(ws, (g) => g.place(ws.player.id, msg.i | 0, msg.r | 0, msg.c | 0));
          break;
        case 'discard':
          requireGameTurnAction(ws, (g) => g.discardShard(ws.player.id, msg.i | 0));
          break;
        case 'skipTurn': {
          // Host may skip the active player's turn, but only if they dropped.
          if (!room || !room.game || ws.player.id !== room.hostId) return;
          const active = room.players.find((p) => p.id === room.game.current().id);
          if (active && active.connected) {
            return send(ws, { type: 'error', message: `${active.name} is still connected.` });
          }
          requireGameTurnAction(ws, (g) => g.forceEndTurn());
          break;
        }
        case 'playAgain': {
          if (!room || room.phase !== 'finished') return;
          if (ws.player.id !== room.hostId) return send(ws, { type: 'error', message: 'Only the host can start a new game.' });
          room.phase = 'playing';
          room.game = new Game(room.players.map((p) => ({ id: p.id, name: p.name })));
          broadcast(room);
          break;
        }
      }
    } catch (err) {
      send(ws, { type: 'error', message: 'Something went wrong.' });
      console.error(err);
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    const player = ws.player;
    if (!room || !player || player.ws !== ws) return;
    player.ws = null;
    player.connected = false;
    if (room.phase === 'lobby' && player.id !== room.hostId) {
      room.players = room.players.filter((p) => p !== player);
    }
    if (room.players.every((p) => !p.connected)) room.emptySince = Date.now();
    broadcast(room);
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log('');
  console.log('  ✦ Vitrea is glowing ✦');
  console.log('');
  console.log(`  On this device:  http://localhost:${PORT}`);
  console.log(`  On your network: http://${lanAddress()}:${PORT}`);
  console.log('');
  console.log('  Create a game there, then let friends scan the QR code in the lobby.');
  console.log('');
});
