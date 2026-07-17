#!/usr/bin/env node
/* Volt Control → jukebox PLAYER rig.
   Runs on a Raspberry Pi (or any Node box next to the speakers) and turns a
   jukebox-surface item into actual sound. It connects to the item's bus room as
   an AUTHENTICATED RIG, so the server's output election counts this player as an
   online output — and only ONE elected player is ever "program" at a time.

   The SERVER is the sole authority. This rig is a dumb player: it receives
   {type:'jukebox', action} commands (play / house / stop / skip), plays them,
   and reports what ACTUALLY happened back up the same socket
   ({type:'track_started' | 'track_ended' | 'position'}). The server's queue,
   skip-window, and bid math key on those reports, never on a local clock. On
   (re)connect the server resyncs this rig to the current track.

   Usage:
     node tools/volt-jukebox.mjs \
       --url wss://<site>/api/bus \
       --item ABC123 --rig pi-jukebox --key <rigKey from the ops page> \
       --backend mpd [--mpd-host 127.0.0.1 --mpd-port 6600 --house ""]

     # off a Pi, or to demo the whole loop with no audio hardware:
     node tools/volt-jukebox.mjs --url … --item … --rig … --key … \
       --backend log [--sim-sec 20]

   --url is the bus base (no query); --item/--rig/--key become query params.
   Get the rigKey ONCE from control-ops.html → the item's "Outputs" chain →
   "Add rig + get key", and add THIS rig to the item's output chain (an
   unlisted rig is never elected program, so the jukebox reads "player offline"
   and refuses requests).

   Backends:
     mpd  — Music Player Daemon (local files, rights-clean). Talks the plain
            MPD TCP protocol; no npm deps. A single-song play is clear→add→play;
            house mode is the whole library on random+repeat. Reports real
            durations + positions read from `status`/`currentsong`.
     log  — no audio: prints every command and SIMULATES playback with timers
            (--sim-sec per track). Reports track_started/ended/position exactly
            like mpd, so you can prove the server loop end-to-end anywhere.
   (spotify is deliberately NOT here yet — it slots in as its own backend once
   the OAuth/licensing path is signed off; the server is already backend-blind.)

   Redundancy (self-mute): the server elects one program player. On every
   {type:'output'} broadcast this rig checks program.name === --rig; if another
   output is program it goes SILENT (stops the player, ignores commands) and
   comes back automatically when it's elected program again (the server re-sends
   the current track on that election). It also stops on item 'off' and resumes
   on 'on'. A slot pause / slot_end does NOT stop the music — the queue and
   house mode are room-level, not tied to one holder's live presence.

   Reconnects forever with capped backoff; Ctrl-C stops the player and exits
   clean. */

import { WebSocket } from 'ws';
import net from 'node:net';

/* ── args ─────────────────────────────────────────────────────────── */
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes('--' + k);
const base = arg('url');
const item = (arg('item', '') || '').toUpperCase();
const rig  = arg('rig');
const key  = arg('key');
let   backend = (arg('backend', has('log-only') ? 'log' : 'log') || 'log').toLowerCase();
if (has('log-only')) backend = 'log';
const MPD_HOST = arg('mpd-host', '127.0.0.1');
const MPD_PORT = Number(arg('mpd-port', '6600'));
const HOUSE_URI = arg('house', '');            // MPD path/playlist for house mode ('' = whole library)
const SIM_SEC = Math.max(3, Number(arg('sim-sec', '20')));   // log backend: seconds per simulated track

if (!base || !item || !rig || !key){
  console.error('usage: node tools/volt-jukebox.mjs --url wss://<site>/api/bus --item CODE --rig NAME --key RIGKEY --backend mpd|log [--mpd-host H --mpd-port P --house URI | --sim-sec N]');
  process.exit(1);
}
if (backend !== 'mpd' && backend !== 'log'){
  console.error(`[jukebox] unknown --backend "${backend}" (use mpd or log)`); process.exit(1);
}

// The key rides an x-rig-key HEADER (not the URL) so it never lands in a proxy /
// access log; only the rig NAME is in the query string.
const url = `${base}?channel=${encodeURIComponent('item:' + item)}&rig=${encodeURIComponent(rig)}`;
const wsOpts = { headers: { 'x-rig-key': key } };

/* ── report up the bus (server CONSUMES these; they are player TRUTH) ── */
let sock = null;                               // the live bus WebSocket
function report(msg){
  if (sock && sock.readyState === WebSocket.OPEN){
    try { sock.send(JSON.stringify(msg)); } catch { /* closing — heartbeat reaps */ }
  }
}
const onStarted = (song, durationSec) => report({ type: 'track_started', songId: song.id, title: song.title, ...(durationSec ? { durationSec } : {}) });
const onEnded   = (songId) => report({ type: 'track_ended', songId });
const onPos     = (songId, sec) => report({ type: 'position', songId, sec: Math.round(sec) });
const hooks = { started: onStarted, ended: onEnded, pos: onPos };

/* ════════════════════════════════════════════════════════════════════
   Backend: LOG — no audio, timer-simulated playback (testable anywhere).
   ════════════════════════════════════════════════════════════════════ */
function makeLogBackend(){
  let cur = null;                              // { song, endTimer, posTimer, startedAt }
  const clear = () => {
    if (cur){ clearTimeout(cur.endTimer); clearInterval(cur.posTimer); cur = null; }
  };
  return {
    name: 'log',
    async play(song){
      clear();
      console.log(`[log] ▶ play "${song.title}" (${song.id})${song.file ? ' ← ' + song.file : ''}`);
      const startedAt = Date.now();
      cur = { song, startedAt,
        endTimer: setTimeout(() => { console.log(`[log] ⏹ end "${song.title}"`); const s = song; clear(); hooks.ended(s.id); }, SIM_SEC * 1000),
        posTimer: setInterval(() => hooks.pos(song.id, (Date.now() - startedAt) / 1000), 5000) };
      hooks.started(song, SIM_SEC);
    },
    async house(on){ clear(); console.log(`[log] ${on ? '♪ house mode ON (would shuffle the library)' : '♪ house mode OFF'}`); },
    async stop(){ if (cur) console.log(`[log] ⏹ stop "${cur.song.title}"`); else console.log('[log] ⏹ stop'); clear(); },
    async skip(){ if (cur){ const s = cur.song; console.log(`[log] ⏭ skip "${s.title}"`); clear(); hooks.ended(s.id); } else console.log('[log] ⏭ skip (nothing playing)'); },
    async close(){ clear(); },
    currentId(){ return cur?.song.id ?? null; },
  };
}

/* ════════════════════════════════════════════════════════════════════
   Backend: MPD — Music Player Daemon, plain TCP line protocol, no deps.
   ════════════════════════════════════════════════════════════════════ */
function makeMpdBackend(){
  let mpd = null, connected = false, greeting = false, buf = '';
  const q = [];                                // pending { resolve, reject, lines:[] }
  let onDrop = null;

  const parseKV = (lines) => { const o = {}; for (const l of lines){ const i = l.indexOf(': '); if (i > 0) o[l.slice(0, i)] = l.slice(i + 2); } return o; };

  function handle(chunk){
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0){
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!greeting){ if (line.startsWith('OK MPD')) greeting = true; continue; }
      const cur = q[0];
      if (!cur) continue;                      // no outstanding command — ignore
      if (line === 'OK'){ q.shift(); cur.resolve(cur.lines); }
      else if (line.startsWith('ACK')){ q.shift(); cur.reject(new Error(line)); }
      else cur.lines.push(line);
    }
  }
  function connect(){
    return new Promise((resolve, reject) => {
      greeting = false; buf = ''; connected = false;
      mpd = net.createConnection({ host: MPD_HOST, port: MPD_PORT });
      mpd.setEncoding('utf8');
      mpd.on('data', handle);
      mpd.on('error', (e) => { if (!connected) reject(e); });
      mpd.on('close', () => { connected = false; while (q.length) q.shift().reject(new Error('mpd closed')); if (onDrop) onDrop(); });
      const iv = setInterval(() => { if (greeting){ clearInterval(iv); clearTimeout(to); connected = true; resolve(); } }, 20);
      const to = setTimeout(() => { clearInterval(iv); if (!connected) reject(new Error('mpd greeting timeout')); }, 4000);
    });
  }
  function cmd(text){
    return new Promise((resolve, reject) => {
      if (!connected){ reject(new Error('mpd not connected')); return; }
      q.push({ resolve, reject, lines: [] });
      mpd.write(text + '\n');
    });
  }
  const esc = (s) => String(s).replace(/(["\\])/g, '\\$1');
  const list = (cmds) => cmd('command_list_begin\n' + cmds.join('\n') + '\ncommand_list_end');

  /* polling: while a REAL track plays, watch for its natural end + report
     position/duration. House mode isn't tracked server-side, so we don't poll
     for it. */
  let cur = null;                              // { song, sawPlay, reportedDur, lastPos }
  let poll = null;
  function startPoll(){
    if (poll) return;
    poll = setInterval(async () => {
      if (!cur || !connected) return;
      let st;
      try { st = parseKV(await cmd('status')); } catch { return; }
      const state = st.state;                  // play | stop | pause
      const elapsed = parseFloat(st.elapsed || st.time?.split(':')[0] || '0');
      const duration = parseFloat(st.duration || st.time?.split(':')[1] || '0');
      if (state === 'play'){
        cur.sawPlay = true;
        if (duration && !cur.reportedDur){ cur.reportedDur = true; hooks.started(cur.song, Math.round(duration)); }
        if (Number.isFinite(elapsed) && Math.abs(elapsed - cur.lastPos) >= 4){ cur.lastPos = elapsed; hooks.pos(cur.song.id, elapsed); }
      } else if (state === 'stop' && cur.sawPlay){
        const done = cur.song; cur = null; stopPoll();       // natural end
        hooks.ended(done.id);
      }
    }, 1000);
    poll.unref?.();
  }
  function stopPoll(){ if (poll){ clearInterval(poll); poll = null; } }

  async function ensure(){ if (!connected) await connect(); }

  return {
    name: 'mpd',
    setOnDrop(fn){ onDrop = fn; },
    async play(song){
      await ensure();
      cur = { song, sawPlay: false, reportedDur: false, lastPos: -99 };
      // single-song queue, no random/repeat → MPD goes to state:stop at the end,
      // which the poll loop turns into one track_ended.
      await list(['clear', `add "${esc(song.file || song.id)}"`, 'random 0', 'repeat 0', 'single 0', 'play']);
      hooks.started(song);                     // optimistic; real duration follows from the poll
      startPoll();
    },
    async house(on){
      await ensure();
      stopPoll(); cur = null;
      if (on){
        const add = HOUSE_URI ? `add "${esc(HOUSE_URI)}"` : 'add ""';
        await list(['clear', add, 'random 1', 'repeat 1', 'single 0', 'play']);
      } else {
        await cmd('stop').catch(() => {});
      }
    },
    async stop(){ stopPoll(); cur = null; if (connected) await cmd('stop').catch(() => {}); },
    async skip(){
      const done = cur?.song || null;
      stopPoll(); cur = null;
      if (connected) await cmd('stop').catch(() => {});
      if (done) hooks.ended(done.id);          // server advances on our report
    },
    async close(){ stopPoll(); try { mpd?.end(); } catch {} },
    currentId(){ return cur?.song.id ?? null; },
  };
}

/* ════════════════════════════════════════════════════════════════════
   Core: bus wiring, mute/pause state machine, command dispatch.
   ════════════════════════════════════════════════════════════════════ */
const player = backend === 'mpd' ? makeMpdBackend() : makeLogBackend();

let muted = false;                             // true = another output is program → stay silent
let off = false;                               // true = item is off → stay silent
let target = null;                             // id of the track we were last told to play (dedupe)
let housing = false;                           // last house state we applied

async function safeStop(reason){
  target = null; housing = false;
  try { await player.stop(); } catch (e){ console.warn('[player] stop failed:', e.message); }
  if (reason) console.log(`[silent] ${reason}`);
}

function onOutput(m){
  const wasMuted = muted;
  muted = !!(m.program && m.program.name !== rig);
  if (muted !== wasMuted){
    if (muted) safeStop(`standing by — "${m.program.name}" is program`);
    else console.log('[output] this rig is PROGRAM now — live (awaiting resync)');
    // On un-mute the SERVER re-sends the current track (election resync), so we
    // just wait for the next play/house command rather than guessing state.
  }
}

async function onJukebox(m){
  if (muted || off) return;                    // silent backup / item off — ignore commands
  try {
    if (m.action === 'play' && m.song){
      if (target === m.song.id){ return; }     // dedupe: already playing/loading this exact track
      target = m.song.id; housing = false;
      await player.play({ id: m.song.id, file: m.song.file, title: m.song.title || m.song.id });
    } else if (m.action === 'house'){
      if (m.on){ if (housing) return; housing = true; target = null; await player.house(true); }
      else { housing = false; await player.house(false); }
    } else if (m.action === 'stop'){
      target = null; housing = false; await player.stop();
    } else if (m.action === 'skip'){
      target = null; await player.skip();
    }
  } catch (e){ console.warn(`[player] ${m.action} failed:`, e.message); }
}

function route(m){
  if (m.item && m.item !== item) return;
  if (m.type === 'output'){ onOutput(m); return; }
  if (m.type === 'jukebox'){ onJukebox(m); return; }
  if (m.type === 'item'){
    // Only 'off' silences the player; 'on' lets the server resync (it re-sends
    // the current track). Slot pause/resume/slot_end are the holder's clock,
    // not the music — the queue and house mode play on regardless.
    if (m.action === 'off'){ off = true; safeStop('item off'); }
    else if (m.action === 'on'){ if (off){ off = false; console.log('[item] on — awaiting resync'); } }
    return;
  }
}

/* ── connect (reconnect forever, capped backoff) ─────────────────────── */
if (player.setOnDrop) player.setOnDrop(() => console.warn('[mpd] connection dropped — will reconnect on the next command'));
let delay = 1000;
(function connect(){
  const ws = new WebSocket(url, wsOpts);
  sock = ws;
  ws.on('open', () => {
    delay = 1000;
    console.log(`[bus] connected as rig "${rig}" on item ${item} — backend:${player.name}`);
  });
  ws.on('message', (data) => { try { route(JSON.parse(data)); } catch { /* not JSON */ } });
  ws.on('error', (e) => console.error('[bus]', e.message));
  ws.on('close', (code) => {
    safeStop('bus disconnected');
    if (code === 4401){ console.error('[bus] rig key rejected (4401) — check --rig / --key against the ops page'); process.exit(1); }
    console.log(`[bus] closed — retrying in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 15000);
  });
})();

/* ── clean shutdown ───────────────────────────────────────────────── */
async function shutdown(){
  console.log('\n[jukebox] shutting down — stopping player');
  try { await player.stop(); await player.close?.(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
