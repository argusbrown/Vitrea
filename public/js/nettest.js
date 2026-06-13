'use strict';

/* ============================================================
   Connection check — self-service network diagnostics.

   A P2P game can fail at three independent legs: reaching the
   matchmaking (signaling) service, discovering a public address
   (STUN), and relaying around blocked direct links (TURN). This
   probes each leg separately so a failure names its culprit
   instead of being guesswork.
   ============================================================ */

const VitreaNetTest = (() => {
  // Gather ICE candidates against a single server and report whether the
  // wanted candidate type ever shows up.
  function probeIceServer(server, wantedType, timeoutMs) {
    return new Promise((resolve) => {
      let pc;
      try {
        pc = new RTCPeerConnection({ iceServers: [server] });
      } catch {
        resolve(false);
        return;
      }
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { pc.close(); } catch { /* already closed */ }
        resolve(ok);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate.includes(` typ ${wantedType}`)) finish(true);
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish(false);
      };
      pc.createDataChannel('probe');
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish(false));
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  function probeSignaling(timeoutMs) {
    return new Promise((resolve) => {
      let peer;
      try {
        peer = new Peer(VitreaNet.peerOptions());
      } catch {
        resolve(false);
        return;
      }
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { peer.destroy(); } catch { /* already gone */ }
        resolve(ok);
      };
      peer.on('open', () => finish(true));
      peer.on('error', () => finish(false));
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  // report(rowId, status) with status 'testing' | 'ok' | 'bad'.
  // Resolves with a human verdict string.
  async function run(report) {
    // Resolve the live ICE list (includes the Cloudflare relay if a Worker is
    // configured); fall back to the static list if that fetch fails.
    let groups;
    try {
      groups = (await VitreaNet.resolveIce()).iceServers;
    } catch {
      groups = VitreaNet.iceConfig.iceServers;
    }
    const stunGroup = groups.find((g) => String(g.urls).includes('stun:'));
    const turnGroups = groups.filter((g) => String(g.urls).includes('turn'));

    const rows = [
      { id: 'signal', probe: () => probeSignaling(10000) },
      { id: 'stun', probe: () => probeIceServer(stunGroup, 'srflx', 8000) },
      ...turnGroups.map((g, i) => ({ id: `turn${i}`, probe: () => probeIceServer(g, 'relay', 10000) })),
    ];

    const results = {};
    await Promise.all(rows.map(async (row) => {
      report(row.id, 'testing');
      results[row.id] = await row.probe();
      report(row.id, results[row.id] ? 'ok' : 'bad');
    }));

    const anyRelay = turnGroups.some((_, i) => results[`turn${i}`]);
    if (!results.signal) {
      return 'This network blocks the matchmaking service, so games cannot start here at all. Try cellular data.';
    }
    if (anyRelay) {
      return 'A relay is reachable, so the game should connect even on Wi-Fi that blocks device-to-device traffic. If joining still fails, report these results.';
    }
    if (results.stun) {
      return 'No relay is reachable. On open networks the game can still connect directly, but on Wi-Fi that isolates devices it will fail — use cellular data or a phone hotspot.';
    }
    return 'This network blocks the connections the game needs. Use cellular data or a phone hotspot.';
  }

  return { run };
})();
