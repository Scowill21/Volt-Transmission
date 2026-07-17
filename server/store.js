/* Channel store (ROADMAP Tier 1b).
   Two backends behind one interface:
     - Postgres when DATABASE_URL is set (Render). Tables mirror the roadmap:
       channels / vj_profiles / channel_vjs, created on boot if missing.
     - A JSON file (server/channels.json, gitignored) otherwise — zero-setup
       local dev: `node server/index.js` just works.
   Every method resolves to the client shape (the same shape as index.html's
   static CHANNELS seed), so GET /api/channels is a straight passthrough:
     [{ id, name, slug, defaultScene, vjs:[{ id, name, uses:{ plane, scene } }] }]
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCENES = ['ambient', 'pulse', 'static', 'drift'];
export const PLANES = ['scene', 'stream'];

// Matches index.html's seed, so an empty store boots with the same channels
// the static console shows.
const SEED = [
  { id: 'volt-fm', name: 'Volt FM', slug: 'volt-fm', defaultScene: 'ambient',
    vjs: [
      { id: 'kera', name: 'Kera',    uses: { plane: 'scene',  scene: 'pulse' } },
      { id: 'nova', name: 'VJ Nova', uses: { plane: 'stream', scene: null } },
    ] },
  { id: 'drift-radio', name: 'Drift Radio', slug: 'drift-radio', defaultScene: 'drift',
    vjs: [
      { id: 'moss', name: 'Moss',    uses: { plane: 'scene',  scene: 'static' } },
    ] },
];

export const slugify = (s) => String(s || '').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function validateScene(scene){
  if (!SCENES.includes(scene)) throw httpError(400, `scene must be one of ${SCENES.join('|')}`);
}
// Live channel audio (Tier 3a): empty clears it; otherwise it must be http(s).
function normalizeAudioUrl(url){
  const s = String(url ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) throw httpError(400, 'audioUrl must be an http(s) URL (or empty to clear)');
  return s.slice(0, 500);
}
export function httpError(status, message){
  const e = new Error(message); e.status = status; return e;
}

/* ── Items (Volt Control — pay-to-control objects, server/items.js) ──
   Durable definitions only; runtime queue/auction state lives in items.js.
   Codes are 6 chars from an unambiguous alphabet (no 0/O/1/I) — they get
   read aloud at events and typed on phones. */
export const ITEM_MODES = ['buynow', 'auction'];
export const ITEM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const ITEM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomItemCode(){
  let s = '';
  for (let i = 0; i < 6; i++) s += ITEM_CODE_ALPHABET[Math.floor(Math.random() * ITEM_CODE_ALPHABET.length)];
  return s;
}

// Admin-supplied numbers are clamped into sane ranges (friendly for the
// dashboard); user-supplied bid amounts are validated STRICTLY in items.js.
function itemInt(v, min, max, name){
  const n = Math.round(+v);
  if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
  return Math.min(max, Math.max(min, n));
}
const ITEM_FIELDS = {
  priceCents:        [0, 50000],   // buy-now price / auction starting bid — hard cap $500
  slotSeconds:       [10, 3600],
  auctionSeconds:    [15, 600],    // soft-close countdown length
  minIncrementCents: [1, 10000],
};

/* ── output chains + duty limits (the redundancy layer, items.js) ──
   outputs = ORDERED failover chain, best first:
     { kind:'rig',   name:'td-main', priority:1, keyHash:'<sha256 hex>' }
     { kind:'scene', name:'stage',   priority:2, scene:'orb' }
   keyHash is server-side only — it must never appear in a public payload
   (items.js strips it). limits = duty-cycle safety for physical rigs.
   BACK-COMPAT: items with an empty chain behave exactly as before the
   redundancy layer existed (always sellable, no presence tracking). */
export const STAGE_SCENES = ['orb', 'grid'];
const OUTPUT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const LIMIT_FIELDS = { maxPerMin: [10, 1000], cooldownMs: [0, 10000] };
export const DEFAULT_LIMITS = { maxPerMin: 240, cooldownMs: 0 };

export function normalizeOutputs(arr){
  if (!Array.isArray(arr)) throw httpError(400, 'outputs must be an array');
  if (arr.length > 12) throw httpError(400, 'at most 12 outputs per item');
  const seen = new Set();
  const out = arr.map((o) => {
    const kind = o && o.kind;
    if (!['rig', 'scene'].includes(kind)) throw httpError(400, 'output kind must be rig|scene');
    const name = String(o.name || '').trim();
    if (!OUTPUT_NAME_RE.test(name)) throw httpError(400, 'output name: lowercase letters/digits/dashes, max 24');
    if (seen.has(name)) throw httpError(400, `duplicate output name "${name}"`);
    seen.add(name);
    const entry = { kind, name, priority: itemInt(o.priority ?? 1, 1, 99, 'priority') };
    if (kind === 'scene'){
      if (!STAGE_SCENES.includes(o.scene)) throw httpError(400, `scene must be one of ${STAGE_SCENES.join('|')}`);
      entry.scene = o.scene;
    } else {
      if (!/^[0-9a-f]{64}$/.test(String(o.keyHash || ''))) throw httpError(400, 'rig outputs need a keyHash');
      entry.keyHash = o.keyHash;
    }
    return entry;
  });
  out.sort((a, b) => a.priority - b.priority);
  return out;
}
function normalizeLimits(raw){
  const limits = { ...DEFAULT_LIMITS };
  if (raw === undefined || raw === null) return limits;
  if (typeof raw !== 'object') throw httpError(400, 'limits must be an object');
  for (const [f, [min, max]] of Object.entries(LIMIT_FIELDS))
    if (raw[f] !== undefined) limits[f] = itemInt(raw[f], min, max, f);
  return limits;
}
// Reads may hand back rows/objects written before this layer existed —
// normalize in one place so every backend returns the same shape.
function withOutputDefaults(item){
  if (!Array.isArray(item.outputs)) item.outputs = [];
  item.limits = { ...DEFAULT_LIMITS, ...(item.limits || {}) };
  if (item.surface !== 'jukebox') item.surface = 'pad';   // back-compat: every legacy item is a pad
  if (item.surface === 'jukebox') item.jukebox = normalizeJukebox(item.jukebox || {});
  else item.jukebox = null;
  return item;
}

/* ── Jukebox surface (server/jukebox.js) — audio as a control surface.
   An item with surface:'jukebox' carries this config. All server-authoritative;
   the rig is a dumb player. spotify secrets (deferred backend) would live under
   jukebox.spotify server-side ONLY — never in a public payload/broadcast/log. */
export const JUKEBOX_BACKENDS = ['mpd', 'log'];          // 'spotify' deferred (see PROMPT-JUKEBOX §7-8)
export const JUKEBOX_MONETIZATION = ['controller_slot', 'per_action'];
export const JUKEBOX_MODES = ['buynow', 'bid'];
const bool = (v, d) => (v === undefined ? d : !!v);
const numOr = (v, min, max, d, name) => (v === undefined || v === null ? d : itemInt(v, min, max, name));
const CATALOG_MAX = 500;
const SONG_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function normalizeCatalog(arr){
  if (!Array.isArray(arr)) throw httpError(400, 'catalog must be an array');
  if (arr.length > CATALOG_MAX) throw httpError(400, `catalog max ${CATALOG_MAX} songs`);
  const seen = new Set();
  return arr.map((s, i) => {
    const title = String(s.title || '').trim().slice(0, 120);
    if (!title) throw httpError(400, `catalog[${i}]: title required`);
    let id = String(s.id || '').trim().toLowerCase();
    if (!id) id = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 's') + '-' + (i + 1);
    if (!SONG_ID_RE.test(id)) throw httpError(400, `catalog[${i}]: bad id "${id}"`);
    if (seen.has(id)) throw httpError(400, `catalog: duplicate id "${id}"`);
    seen.add(id);
    return {
      id, title,
      artist: String(s.artist || '').trim().slice(0, 120) || null,
      durationSec: numOr(s.durationSec, 0, 7200, 0, 'durationSec'),   // 0 = unknown; rig backfills
      file: String(s.file || '').trim().slice(0, 300) || null,        // rig filename or track URI
    };
  });
}
export function normalizeJukebox(raw){
  if (typeof raw !== 'object' || raw === null) raw = {};
  const monetization = JUKEBOX_MONETIZATION.includes(raw.monetization) ? raw.monetization : 'controller_slot';
  const backend = JUKEBOX_BACKENDS.includes(raw.backend) ? raw.backend : 'log';
  const mode = JUKEBOX_MODES.includes(raw.mode) ? raw.mode : 'buynow';
  const s = raw.skip || {};
  const q = raw.queueRules || {};
  const minPlaySec = numOr(s.minPlaySec, 0, 3600, 10, 'minPlaySec');
  let onlyBeforeSec = (s.onlyBeforeSec === undefined || s.onlyBeforeSec === null) ? 15 : itemInt(s.onlyBeforeSec, 0, 3600, 'onlyBeforeSec');
  // The skip window is [minPlaySec, onlyBeforeSec] when mid-song skips are off;
  // if the admin set onlyBeforeSec below the minPlay floor the window would be
  // EMPTY (song permanently unskippable, misleading "too late" the instant it
  // clears the floor). Widen it to at least the floor so the window is coherent.
  if (onlyBeforeSec < minPlaySec) onlyBeforeSec = minPlaySec;
  return {
    monetization, backend, mode,
    catalog: normalizeCatalog(raw.catalog || []),
    queuePriceCents: numOr(raw.queuePriceCents, 0, 50000, 200, 'queuePriceCents'),
    playNextPriceCents: (raw.playNextPriceCents === undefined || raw.playNextPriceCents === null)
      ? null : itemInt(raw.playNextPriceCents, 0, 50000, 'playNextPriceCents'),
    skip: {
      priceCents:   numOr(s.priceCents, 0, 50000, 100, 'skip.priceCents'),
      allowMidSong: bool(s.allowMidSong, false),
      onlyBeforeSec, minPlaySec,
      perUser: { max: numOr(s.perUser?.max, 0, 100, 2, 'perUser.max'), windowMin: numOr(s.perUser?.windowMin, 1, 1440, 30, 'perUser.windowMin') },
      global:  { max: numOr(s.global?.max, 0, 1000, 6, 'global.max'),  windowMin: numOr(s.global?.windowMin, 1, 1440, 60, 'global.windowMin') },
    },
    queueRules: {
      maxLen:     numOr(q.maxLen, 1, 200, 25, 'maxLen'),
      maxPerUser: numOr(q.maxPerUser, 1, 50, 3, 'maxPerUser'),
      noRepeatMin: numOr(q.noRepeatMin, 0, 1440, 60, 'noRepeatMin'),
    },
    houseMode: bool(raw.houseMode, true),
  };
}

function normalizeNewItem(props = {}){
  const name = String(props.name || '').trim().slice(0, 60);
  if (!name) throw httpError(400, 'name required');
  const mode = props.mode === undefined ? 'buynow' : props.mode;
  if (!ITEM_MODES.includes(mode)) throw httpError(400, `mode must be one of ${ITEM_MODES.join('|')}`);
  const defaults = { priceCents: 500, slotSeconds: 120, auctionSeconds: 60, minIncrementCents: 50 };
  const item = { code: null, name, mode,
    description: String(props.description || '').trim().slice(0, 200) || null,
    // What the controls DO to the rig (admin-written, player-facing): shown
    // on the item page and behind the controller's (i) button.
    instructions: String(props.instructions || '').trim().slice(0, 500) || null,
    status: 'on', createdAt: new Date().toISOString(),
    // Output chain edits go through the dedicated /outputs endpoints, not
    // create — new items start unconfigured (= legacy behavior).
    outputs: [], limits: normalizeLimits(props.limits) };
  for (const [f, [min, max]] of Object.entries(ITEM_FIELDS))
    item[f] = props[f] === undefined ? defaults[f] : itemInt(props[f], min, max, f);
  // Control surface: 'pad' (default, back-compat) or 'jukebox' (music).
  item.surface = props.surface === 'jukebox' ? 'jukebox' : 'pad';
  item.jukebox = item.surface === 'jukebox' ? normalizeJukebox(props.jukebox || {}) : null;
  return item;
}

function applyItemPatch(item, patch = {}){
  if (patch.name !== undefined){
    const name = String(patch.name).trim().slice(0, 60);
    if (!name) throw httpError(400, 'name required');
    item.name = name;
  }
  if (patch.description !== undefined)
    item.description = String(patch.description || '').trim().slice(0, 200) || null;
  if (patch.instructions !== undefined)
    item.instructions = String(patch.instructions || '').trim().slice(0, 500) || null;
  if (patch.mode !== undefined){
    if (!ITEM_MODES.includes(patch.mode)) throw httpError(400, `mode must be one of ${ITEM_MODES.join('|')}`);
    item.mode = patch.mode;
  }
  if (patch.status !== undefined){
    if (!['on', 'off'].includes(patch.status)) throw httpError(400, 'status must be on|off');
    item.status = patch.status;
  }
  for (const [f, [min, max]] of Object.entries(ITEM_FIELDS))
    if (patch[f] !== undefined) item[f] = itemInt(patch[f], min, max, f);
  if (patch.limits !== undefined) item.limits = normalizeLimits(patch.limits);
  if (patch.outputs !== undefined)   // chain edits use POST/PATCH/DELETE …/outputs
    throw httpError(400, 'use the /api/items/:code/outputs endpoints to edit the output chain');
  // Surface flip + jukebox config. items.js guards a flip against live runtime
  // (like the mode-flip guard) before calling this.
  if (patch.surface !== undefined){
    if (!['pad', 'jukebox'].includes(patch.surface)) throw httpError(400, 'surface must be pad|jukebox');
    item.surface = patch.surface;
  }
  if (item.surface === 'jukebox'){
    if (patch.jukebox !== undefined || !item.jukebox)
      item.jukebox = normalizeJukebox(patch.jukebox || item.jukebox || {});
  } else item.jukebox = null;
  return item;
}

// The live pg pool when running on Postgres (null in JSON-file mode).
// auth.js shares it for the profiles table instead of opening a second pool.
let sharedPool = null;
export const getPool = () => sharedPool;

/* ── JSON-file backend (local dev) ────────────────────────────────── */
export class FileStore {
  constructor(file, itemsFile){
    this.file = file;
    this.itemsFile = itemsFile || path.join(path.dirname(file), 'items.json');
    if (!fs.existsSync(file)){
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this._write(SEED);
    }
    if (!fs.existsSync(this.itemsFile)) this._writeItems([]);
  }
  _read(){ return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  _write(data){ fs.writeFileSync(this.file, JSON.stringify(data, null, 2)); }
  // Items reads must never take the site down (index.js loads them at boot,
  // and the JSON store is also the documented prod fallback when Postgres is
  // unreachable): a corrupt file is set aside — not deleted — and treated as
  // empty. Writes are atomic (tmp + rename) so a mid-write crash can't
  // truncate the file in the first place.
  _readItems(){
    try { return JSON.parse(fs.readFileSync(this.itemsFile, 'utf8')); }
    catch (e){
      const bak = this.itemsFile + '.corrupt-' + Date.now();
      try { fs.renameSync(this.itemsFile, bak); } catch { /* already gone */ }
      console.error(`[store] items file unreadable (${e.message}) — set aside as ${bak}, starting empty`);
      this._writeItems([]);
      return [];
    }
  }
  _writeItems(data){
    const tmp = this.itemsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.itemsFile);
  }

  async listItems(){ return this._readItems().map(withOutputDefaults); }

  async createItem(props){
    const item = normalizeNewItem(props);
    const data = this._readItems();
    const taken = new Set(data.map(i => i.code));
    do { item.code = randomItemCode(); } while (taken.has(item.code));
    data.push(item);
    this._writeItems(data);
    return item;
  }

  async updateItem(code, patch){
    const data = this._readItems();
    const item = data.find(i => i.code === code);
    if (!item) throw httpError(404, 'item not found');
    applyItemPatch(withOutputDefaults(item), patch);
    this._writeItems(data);
    return item;
  }

  async updateItemOutputs(code, outputs){
    const data = this._readItems();
    const item = data.find(i => i.code === code);
    if (!item) throw httpError(404, 'item not found');
    withOutputDefaults(item).outputs = normalizeOutputs(outputs);
    this._writeItems(data);
    return item;
  }

  async deleteItem(code){
    const data = this._readItems();
    if (!data.some(i => i.code === code)) throw httpError(404, 'item not found');
    this._writeItems(data.filter(i => i.code !== code));
  }

  async list(){ return this._read(); }

  async createChannel({ name, slug, defaultScene = 'ambient', audioUrl }){
    if (!name || !String(name).trim()) throw httpError(400, 'name required');
    validateScene(defaultScene);
    const id = slugify(slug || name);
    if (!id) throw httpError(400, 'slug required');
    const data = this._read();
    if (data.some(c => c.id === id)) throw httpError(409, `channel "${id}" already exists`);
    const channel = { id, name: String(name).trim(), slug: id, defaultScene,
      audioUrl: normalizeAudioUrl(audioUrl), vjs: [] };
    data.push(channel);
    this._write(data);
    return channel;
  }

  async updateChannel(id, patch){
    const data = this._read();
    const c = data.find(c => c.id === id);
    if (!c) throw httpError(404, 'channel not found');
    if (patch.name !== undefined){
      if (!String(patch.name).trim()) throw httpError(400, 'name required');
      c.name = String(patch.name).trim();
    }
    if (patch.defaultScene !== undefined){ validateScene(patch.defaultScene); c.defaultScene = patch.defaultScene; }
    if (patch.audioUrl !== undefined) c.audioUrl = normalizeAudioUrl(patch.audioUrl);
    this._write(data);
    return c;
  }

  async deleteChannel(id){
    const data = this._read();
    if (!data.some(c => c.id === id)) throw httpError(404, 'channel not found');
    this._write(data.filter(c => c.id !== id));
  }

  async addVJ(channelId, { name, plane = 'scene', scene }){
    if (!name || !String(name).trim()) throw httpError(400, 'name required');
    if (!PLANES.includes(plane)) throw httpError(400, `plane must be one of ${PLANES.join('|')}`);
    if (plane === 'scene') validateScene(scene);
    const data = this._read();
    const c = data.find(c => c.id === channelId);
    if (!c) throw httpError(404, 'channel not found');
    let id = slugify(name), n = 2;
    while (c.vjs.some(v => v.id === id)) id = slugify(name) + '-' + n++;
    const vj = { id, name: String(name).trim(), uses: { plane, scene: plane === 'scene' ? scene : null } };
    c.vjs.push(vj);
    this._write(data);
    return vj;
  }

  async removeVJ(channelId, vjId){
    const data = this._read();
    const c = data.find(c => c.id === channelId);
    if (!c) throw httpError(404, 'channel not found');
    if (!c.vjs.some(v => v.id === vjId)) throw httpError(404, 'vj not found');
    c.vjs = c.vjs.filter(v => v.id !== vjId);
    this._write(data);
  }
}

/* ── Postgres backend (Render) ────────────────────────────────────── */
class PgStore {
  constructor(url){
    this.url = url;
    this.pool = null;
  }
  async init(){
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({
      connectionString: this.url,
      // Render Postgres requires TLS; local Postgres usually doesn't.
      ssl: /localhost|127\.0\.0\.1/.test(this.url) ? false : { rejectUnauthorized: false },
      // Polite sizing for pooled providers (Supabase session pooler etc.).
      max: 5,
      // Fail fast instead of hanging boot forever on a bad URL/password —
      // createStore() catches this and falls back to the JSON store.
      connectionTimeoutMillis: 10000,
    });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        default_scene TEXT NOT NULL DEFAULT 'ambient',
        position      SERIAL
      );
      CREATE TABLE IF NOT EXISTS vj_profiles (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_vjs (
        channel_id TEXT NOT NULL REFERENCES channels(id)    ON DELETE CASCADE,
        vj_id      TEXT NOT NULL REFERENCES vj_profiles(id) ON DELETE CASCADE,
        plane      TEXT NOT NULL DEFAULT 'scene',
        scene      TEXT,
        position   SERIAL,
        PRIMARY KEY (channel_id, vj_id)
      );
    `);
    // Tier 3a: live channel audio — additive migration for existing tables.
    await this.pool.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS audio_url TEXT');
    // Volt Control items (pay-to-control objects — server/items.js).
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS items (
        code                TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        description         TEXT,
        mode                TEXT NOT NULL DEFAULT 'buynow',
        price_cents         INT  NOT NULL DEFAULT 500,
        slot_seconds        INT  NOT NULL DEFAULT 120,
        auction_seconds     INT  NOT NULL DEFAULT 60,
        min_increment_cents INT  NOT NULL DEFAULT 50,
        status              TEXT NOT NULL DEFAULT 'on',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Controls guide — additive migration for tables created before it.
    await this.pool.query('ALTER TABLE items ADD COLUMN IF NOT EXISTS instructions TEXT');
    // Output chains + duty limits (redundancy layer) — additive, default = legacy behavior.
    await this.pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS outputs JSONB NOT NULL DEFAULT '[]'`);
    await this.pool.query('ALTER TABLE items ADD COLUMN IF NOT EXISTS limits JSONB');
    // Jukebox surface — additive; default surface 'pad' keeps every legacy item a pad.
    await this.pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'pad'`);
    await this.pool.query('ALTER TABLE items ADD COLUMN IF NOT EXISTS jukebox JSONB');
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS n FROM channels');
    if (rows[0].n === 0) for (const c of SEED){
      await this.pool.query('INSERT INTO channels (id, name, default_scene) VALUES ($1,$2,$3)', [c.id, c.name, c.defaultScene]);
      for (const v of c.vjs){
        await this.pool.query('INSERT INTO vj_profiles (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [v.id, v.name]);
        await this.pool.query('INSERT INTO channel_vjs (channel_id, vj_id, plane, scene) VALUES ($1,$2,$3,$4)',
          [c.id, v.id, v.uses.plane, v.uses.scene]);
      }
    }
    // Only hand the pool to auth once the schema is confirmed reachable —
    // a failed init must leave authConfigured() false, not half-wired.
    sharedPool = this.pool;
  }

  async list(){
    const { rows: chans } = await this.pool.query('SELECT id, name, default_scene, audio_url FROM channels ORDER BY position');
    const { rows: vjs } = await this.pool.query(`
      SELECT cv.channel_id, cv.vj_id, cv.plane, cv.scene, p.name
      FROM channel_vjs cv JOIN vj_profiles p ON p.id = cv.vj_id
      ORDER BY cv.position`);
    return chans.map(c => ({
      id: c.id, name: c.name, slug: c.id, defaultScene: c.default_scene,
      audioUrl: c.audio_url || null,
      vjs: vjs.filter(v => v.channel_id === c.id)
        .map(v => ({ id: v.vj_id, name: v.name, uses: { plane: v.plane, scene: v.scene } })),
    }));
  }

  async createChannel({ name, slug, defaultScene = 'ambient', audioUrl }){
    if (!name || !String(name).trim()) throw httpError(400, 'name required');
    validateScene(defaultScene);
    const cleanUrl = normalizeAudioUrl(audioUrl);
    const id = slugify(slug || name);
    if (!id) throw httpError(400, 'slug required');
    try {
      await this.pool.query('INSERT INTO channels (id, name, default_scene, audio_url) VALUES ($1,$2,$3,$4)',
        [id, String(name).trim(), defaultScene, cleanUrl]);
    } catch (e){
      if (e.code === '23505') throw httpError(409, `channel "${id}" already exists`);
      throw e;
    }
    return { id, name: String(name).trim(), slug: id, defaultScene, audioUrl: cleanUrl, vjs: [] };
  }

  async updateChannel(id, patch){
    if (patch.name !== undefined && !String(patch.name).trim()) throw httpError(400, 'name required');
    if (patch.defaultScene !== undefined) validateScene(patch.defaultScene);
    // audioUrl can be SET or CLEARED (unlike name/scene, null is a real value),
    // so it gets an explicit has-flag instead of COALESCE.
    const hasAudio = patch.audioUrl !== undefined;
    const audioVal = hasAudio ? normalizeAudioUrl(patch.audioUrl) : null;
    const { rows } = await this.pool.query(
      `UPDATE channels SET
         name          = COALESCE($2, name),
         default_scene = COALESCE($3, default_scene),
         audio_url     = CASE WHEN $4 THEN $5 ELSE audio_url END
       WHERE id = $1 RETURNING id, name, default_scene, audio_url`,
      [id, patch.name !== undefined ? String(patch.name).trim() : null,
       patch.defaultScene ?? null, hasAudio, audioVal]);
    if (!rows.length) throw httpError(404, 'channel not found');
    return rows[0];
  }

  async deleteChannel(id){
    const { rowCount } = await this.pool.query('DELETE FROM channels WHERE id = $1', [id]);
    if (!rowCount) throw httpError(404, 'channel not found');
  }

  async addVJ(channelId, { name, plane = 'scene', scene }){
    if (!name || !String(name).trim()) throw httpError(400, 'name required');
    if (!PLANES.includes(plane)) throw httpError(400, `plane must be one of ${PLANES.join('|')}`);
    if (plane === 'scene') validateScene(scene);
    const { rows } = await this.pool.query('SELECT 1 FROM channels WHERE id = $1', [channelId]);
    if (!rows.length) throw httpError(404, 'channel not found');

    // Fresh profile per attachment keeps 1b simple; roster reuse is a later tier.
    let id = slugify(name), n = 2;
    for (;;){
      const { rows: taken } = await this.pool.query('SELECT 1 FROM vj_profiles WHERE id = $1', [id]);
      if (!taken.length) break;
      id = slugify(name) + '-' + n++;
    }
    await this.pool.query('INSERT INTO vj_profiles (id, name) VALUES ($1,$2)', [id, String(name).trim()]);
    await this.pool.query('INSERT INTO channel_vjs (channel_id, vj_id, plane, scene) VALUES ($1,$2,$3,$4)',
      [channelId, id, plane, plane === 'scene' ? scene : null]);
    return { id, name: String(name).trim(), uses: { plane, scene: plane === 'scene' ? scene : null } };
  }

  async removeVJ(channelId, vjId){
    const { rowCount } = await this.pool.query(
      'DELETE FROM channel_vjs WHERE channel_id = $1 AND vj_id = $2', [channelId, vjId]);
    if (!rowCount) throw httpError(404, 'vj not found');
    // Tidy the profile if nothing references it anymore.
    await this.pool.query(
      'DELETE FROM vj_profiles WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM channel_vjs WHERE vj_id = $1)', [vjId]);
  }

  /* items (Volt Control) — same client shape as the FileStore */
  _itemRow(r){
    return withOutputDefaults({ code: r.code, name: r.name, description: r.description, mode: r.mode,
      instructions: r.instructions,
      priceCents: r.price_cents, slotSeconds: r.slot_seconds, auctionSeconds: r.auction_seconds,
      minIncrementCents: r.min_increment_cents, status: r.status,
      outputs: r.outputs, limits: r.limits, surface: r.surface, jukebox: r.jukebox,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at });
  }

  async listItems(){
    const { rows } = await this.pool.query('SELECT * FROM items ORDER BY created_at');
    return rows.map(r => this._itemRow(r));
  }

  async createItem(props){
    const item = normalizeNewItem(props);
    for (;;){                                   // 32^6 codes — collisions are lottery-rare
      item.code = randomItemCode();
      try {
        await this.pool.query(
          `INSERT INTO items (code, name, description, instructions, mode, price_cents, slot_seconds,
             auction_seconds, min_increment_cents, status, outputs, limits, surface, jukebox, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [item.code, item.name, item.description, item.instructions, item.mode, item.priceCents,
           item.slotSeconds, item.auctionSeconds, item.minIncrementCents, item.status,
           JSON.stringify(item.outputs), JSON.stringify(item.limits),
           item.surface, item.jukebox ? JSON.stringify(item.jukebox) : null, item.createdAt]);
        return item;
      } catch (e){
        if (e.code !== '23505') throw e;        // anything but a code collision is real
      }
    }
  }

  async updateItem(code, patch){
    const { rows } = await this.pool.query('SELECT * FROM items WHERE code = $1', [code]);
    if (!rows.length) throw httpError(404, 'item not found');
    const item = applyItemPatch(this._itemRow(rows[0]), patch);
    await this.pool.query(
      `UPDATE items SET name=$2, description=$3, instructions=$4, mode=$5, price_cents=$6,
         slot_seconds=$7, auction_seconds=$8, min_increment_cents=$9, status=$10, limits=$11,
         surface=$12, jukebox=$13 WHERE code=$1`,
      [code, item.name, item.description, item.instructions, item.mode, item.priceCents,
       item.slotSeconds, item.auctionSeconds, item.minIncrementCents, item.status,
       JSON.stringify(item.limits), item.surface, item.jukebox ? JSON.stringify(item.jukebox) : null]);
    return item;
  }

  async updateItemOutputs(code, outputs){
    const { rows } = await this.pool.query('SELECT * FROM items WHERE code = $1', [code]);
    if (!rows.length) throw httpError(404, 'item not found');
    const item = this._itemRow(rows[0]);
    item.outputs = normalizeOutputs(outputs);
    await this.pool.query('UPDATE items SET outputs=$2 WHERE code=$1', [code, JSON.stringify(item.outputs)]);
    return item;
  }

  async deleteItem(code){
    const { rowCount } = await this.pool.query('DELETE FROM items WHERE code = $1', [code]);
    if (!rowCount) throw httpError(404, 'item not found');
  }
}

export async function createStore(){
  if (process.env.DATABASE_URL){
    const store = new PgStore(process.env.DATABASE_URL);
    try {
      await store.init();
      console.log('[store] postgres');
      return store;
    } catch (e){
      // Never take the site down over a bad database URL — boot on the JSON
      // store (seed channels, accounts disabled) and say exactly what to fix.
      console.error('[store] POSTGRES UNREACHABLE — falling back to the JSON file store.');
      console.error('[store] check DATABASE_URL (rotated password? wrong pooler string?):', e.message);
      await store.pool?.end().catch(() => {});
    }
  }
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'channels.json');
  console.log('[store] json file:', file);
  return new FileStore(file);
}
