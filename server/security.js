/* Security hardening — the "can't hack it to take control" layer.
   Collected here so the protections are one auditable unit; index.js and bus.js
   wire them in. Everything is dependency-free (no helmet / express-rate-limit).

   What lives here:
   - securityHeaders    — anti-clickjacking + nosniff + referrer + HSTS.
   - safeEqual          — constant-time secret comparison (admin/rig keys).
   - makeRequireAdmin   — admin gate: constant-time key check, per-IP
                          brute-force lockout, and FAIL-CLOSED when a real
                          (Supabase-configured) deploy is left on the insecure
                          'dev'/unset key.
   - makeRateLimiter    — per-IP sliding-window limiter for state-changing
                          routes (auth brute-force, buy/bid/jukebox floods).
   - assertPublicUrl    — SSRF guard: rejects URLs that resolve to loopback /
                          link-local / private / reserved IPs (used by the audio
                          relay, re-run on every redirect hop).
   - wsOriginAllowed    — same-origin (or allowlisted) check for WS upgrades. */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

/* ── response headers ─────────────────────────────────────────────── */
// Applied to every response. frame-ancestors 'none' + X-Frame-Options DENY stop
// the control/ops pages being framed for clickjacking; nosniff stops the audio
// relay's echoed body being sniffed into active content; Referrer-Policy keeps
// item codes / any URL secrets out of the Referer header on outbound links.
export function securityHeaders(req, res, next){
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  if ((req.get('x-forwarded-proto') || req.protocol) === 'https')
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

/* ── constant-time compare ────────────────────────────────────────── */
// Hash both sides to a fixed 32 bytes first: timingSafeEqual requires equal
// lengths, and hashing avoids leaking the secret's length via the compare.
export function safeEqual(a, b){
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ── admin gate ───────────────────────────────────────────────────── */
// The 'dev' fallback (or an unset key) is fine for local, hack-free dev — but on
// a real deploy (Supabase configured = production intent) it would hand full
// control to anyone. There, refuse it: admin fails CLOSED until a real key is
// set, mirroring the payload-identity escape hatch's intent-not-reachability rule.
export function adminKeyInsecure(){
  const k = process.env.ADMIN_KEY;
  return !k || k === 'dev';
}
export function adminDisabledInProd(){
  const configured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
  return configured && adminKeyInsecure();
}

// Per-IP failure lockout so the key can't be ground down online (defence in
// depth on top of a high-entropy key). N failures in WINDOW → locked for WINDOW.
const ADMIN_FAILS = new Map();   // ip -> { count, first, until }
const ADMIN_MAX_FAILS = 10;
const ADMIN_WINDOW_MS = 5 * 60 * 1000;
let adminSweepAt = 0;

export function makeRequireAdmin(adminKey){
  return function requireAdmin(req, res, next){
    // A misconfigured production deploy: never accept the insecure default.
    if (adminDisabledInProd())
      return res.status(503).json({ error: 'admin disabled — set a real ADMIN_KEY (the insecure default is refused on a configured deploy)' });

    const ip = clientIp(req);
    const now = Date.now();
    // opportunistic sweep so the failure table can't grow unbounded under IP churn
    if (now - adminSweepAt > ADMIN_WINDOW_MS){
      for (const [k, v] of ADMIN_FAILS) if ((v.until || v.first) < now - ADMIN_WINDOW_MS) ADMIN_FAILS.delete(k);
      adminSweepAt = now;
    }
    const rec = ADMIN_FAILS.get(ip);
    if (rec && rec.until && rec.until > now)
      return res.status(429).json({ error: 'too many bad admin keys — locked out, try again later' });

    if (safeEqual(req.get('x-admin-key') || '', adminKey)){
      if (rec) ADMIN_FAILS.delete(ip);            // success clears the counter
      return next();
    }
    // record the failure; lock the IP once it trips the threshold
    const r = rec && rec.first > now - ADMIN_WINDOW_MS ? rec : { count: 0, first: now, until: 0 };
    r.count++;
    if (r.count >= ADMIN_MAX_FAILS) r.until = now + ADMIN_WINDOW_MS;
    ADMIN_FAILS.set(ip, r);
    res.status(401).json({ error: 'bad admin key' });
  };
}
// Test/introspection helper — reset the lockout table between suite cases.
export function __resetAdminThrottle(){ ADMIN_FAILS.clear(); }

/* ── per-IP rate limiter (state-changing routes only) ─────────────── */
// Sliding window, in-memory (resets on deploy like the rest of the runtime).
// Skips safe methods so reads are never throttled. A backstop against
// brute-force (auth) and flood/monopolisation (buy/bid/jukebox) — NOT the
// take-control fix, which is the gates; this just denies the abuse volume.
export function makeRateLimiter({ windowMs = 60000, max = 120, skipSafe = true } = {}){
  const hits = new Map();   // ip -> number[] (timestamps)
  // opportunistic sweep so the map can't grow unbounded under churn
  let lastSweep = 0;
  return function rateLimit(req, res, next){
    if (skipSafe && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) return next();
    const now = Date.now();
    if (now - lastSweep > windowMs){ for (const [k, arr] of hits) if (!arr.some(t => t > now - windowMs)) hits.delete(k); lastSweep = now; }
    const ip = clientIp(req);
    const arr = (hits.get(ip) || []).filter(t => t > now - windowMs);
    if (arr.length >= max){ res.setHeader('Retry-After', Math.ceil(windowMs / 1000)); return res.status(429).json({ error: 'slow down — too many requests' }); }
    arr.push(now); hits.set(ip, arr);
    next();
  };
}

export function clientIp(req){
  // Express req.ip is correct once `trust proxy` is set (Render sits in front);
  // fall back defensively so the limiter/lockout still keys on something.
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ── SSRF guard for the audio relay ───────────────────────────────── */
// Blocks the classic "point a stream URL at 169.254.169.254 / an internal host
// and read the response back through the public relay". Resolves DNS, rejects if
// ANY resolved address is non-public, and RETURNS the pinned IP so the caller can
// connect to that exact address (defeats DNS-rebind: the connect uses the IP we
// validated, not an independent second lookup). Re-run on every redirect hop.
export async function assertPublicUrl(urlStr){
  let u;
  try { u = new URL(String(urlStr)); }
  catch { throw httpErr(400, 'invalid stream URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpErr(400, 'stream URL must be http(s)');
  if (u.username || u.password) throw httpErr(400, 'stream URL must not embed credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');   // strip IPv6 brackets
  let resolved = [];
  if (net.isIP(host)) resolved = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  else {
    try { resolved = await dns.lookup(host, { all: true }); }
    catch { throw httpErr(502, 'stream host did not resolve'); }
  }
  if (!resolved.length) throw httpErr(502, 'stream host did not resolve');
  for (const a of resolved)
    if (isPrivateIp(a.address)) throw httpErr(403, 'stream host resolves to a non-public address');
  return { url: u, ip: resolved[0].address, family: resolved[0].family };   // PINNED
}

// True for loopback / link-local / private / CGNAT / reserved ranges (v4 + v6).
export function isPrivateIp(ip){
  if (net.isIPv4(ip)){
    const p = ip.split('.').map(Number);
    if (p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;   // malformed → treat as unsafe
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;                    // this-net, private, loopback
    if (a === 169 && b === 254) return true;                              // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;                     // private
    if (a === 192 && b === 168) return true;                             // private
    if (a === 100 && b >= 64 && b <= 127) return true;                    // CGNAT
    if (a === 192 && b === 0 && p[2] === 0) return true;                  // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;                 // benchmarking
    if (a >= 224) return true;                                            // multicast + reserved (224+)
    return false;
  }
  if (net.isIPv6(ip)){
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;                           // loopback / unspecified
    if (x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return true;  // link-local / ULA
    if (x.startsWith('ff')) return true;                                 // multicast
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);                   // v4-mapped → check as v4
    if (m) return isPrivateIp(m[1]);
    if (x.startsWith('::ffff:') || x.startsWith('64:ff9b')) return true;  // mapped/NAT64 without dotted form
    return false;
  }
  return true;   // not a valid IP → unsafe
}

/* ── WebSocket upgrade origin check ───────────────────────────────── */
// Browsers send Origin on the WS handshake; Node rigs (the ws lib) send none.
// Reject a PRESENT origin that isn't same-host or allowlisted (defence in depth
// atop SameSite=Lax on the session cookie). Missing origin (rigs, curl) passes —
// those carry no ambient cookie to abuse.
export function wsOriginAllowed(req){
  const origin = req.headers.origin;
  if (!origin) return true;                       // non-browser client (rig)
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (host === req.headers.host) return true;     // same-origin
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allow.some(a => { try { return new URL(a).host === host; } catch { return a === host || a === origin; } });
}

/* small local httpError (avoid a store.js import cycle) */
function httpErr(status, message){ const e = new Error(message); e.status = status; return e; }
