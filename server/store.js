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
export function httpError(status, message){
  const e = new Error(message); e.status = status; return e;
}

// The live pg pool when running on Postgres (null in JSON-file mode).
// auth.js shares it for the profiles table instead of opening a second pool.
let sharedPool = null;
export const getPool = () => sharedPool;

/* ── JSON-file backend (local dev) ────────────────────────────────── */
class FileStore {
  constructor(file){
    this.file = file;
    if (!fs.existsSync(file)){
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this._write(SEED);
    }
  }
  _read(){ return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  _write(data){ fs.writeFileSync(this.file, JSON.stringify(data, null, 2)); }

  async list(){ return this._read(); }

  async createChannel({ name, slug, defaultScene = 'ambient' }){
    if (!name || !String(name).trim()) throw httpError(400, 'name required');
    validateScene(defaultScene);
    const id = slugify(slug || name);
    if (!id) throw httpError(400, 'slug required');
    const data = this._read();
    if (data.some(c => c.id === id)) throw httpError(409, `channel "${id}" already exists`);
    const channel = { id, name: String(name).trim(), slug: id, defaultScene, vjs: [] };
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
    });
    sharedPool = this.pool;
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
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS n FROM channels');
    if (rows[0].n === 0) for (const c of SEED){
      await this.pool.query('INSERT INTO channels (id, name, default_scene) VALUES ($1,$2,$3)', [c.id, c.name, c.defaultScene]);
      for (const v of c.vjs){
        await this.pool.query('INSERT INTO vj_profiles (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [v.id, v.name]);
        await this.pool.query('INSERT INTO channel_vjs (channel_id, vj_id, plane, scene) VALUES ($1,$2,$3,$4)',
          [c.id, v.id, v.uses.plane, v.uses.scene]);
      }
    }
  }

  async list(){
    const { rows: chans } = await this.pool.query('SELECT id, name, default_scene FROM channels ORDER BY position');
    const { rows: vjs } = await this.pool.query(`
      SELECT cv.channel_id, cv.vj_id, cv.plane, cv.scene, p.name
      FROM channel_vjs cv JOIN vj_profiles p ON p.id = cv.vj_id
      ORDER BY cv.position`);
    return chans.map(c => ({
      id: c.id, name: c.name, slug: c.id, defaultScene: c.default_scene,
      vjs: vjs.filter(v => v.channel_id === c.id)
        .map(v => ({ id: v.vj_id, name: v.name, uses: { plane: v.plane, scene: v.scene } })),
    }));
  }

  async createChannel({ name, slug, defaultScene = 'ambient' }){
    if (!name || !String(name).trim()) throw httpError(400, 'name required');
    validateScene(defaultScene);
    const id = slugify(slug || name);
    if (!id) throw httpError(400, 'slug required');
    try {
      await this.pool.query('INSERT INTO channels (id, name, default_scene) VALUES ($1,$2,$3)',
        [id, String(name).trim(), defaultScene]);
    } catch (e){
      if (e.code === '23505') throw httpError(409, `channel "${id}" already exists`);
      throw e;
    }
    return { id, name: String(name).trim(), slug: id, defaultScene, vjs: [] };
  }

  async updateChannel(id, patch){
    if (patch.name !== undefined && !String(patch.name).trim()) throw httpError(400, 'name required');
    if (patch.defaultScene !== undefined) validateScene(patch.defaultScene);
    const { rows } = await this.pool.query(
      `UPDATE channels SET name = COALESCE($2, name), default_scene = COALESCE($3, default_scene)
       WHERE id = $1 RETURNING id, name, default_scene`,
      [id, patch.name !== undefined ? String(patch.name).trim() : null, patch.defaultScene ?? null]);
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
}

export async function createStore(){
  if (process.env.DATABASE_URL){
    const store = new PgStore(process.env.DATABASE_URL);
    await store.init();
    console.log('[store] postgres');
    return store;
  }
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'channels.json');
  console.log('[store] json file:', file);
  return new FileStore(file);
}
