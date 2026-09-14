import { DurableObject } from 'cloudflare:workers';

// Single-user, ciphertext-only transport. Encryption keys never enter this service.
// This is an envelope validator: only clients can prove successful AEAD encryption.
const LIMITS = Object.freeze({
  bodyBytes: 96 * 1024,
  ciphertextBytes: 64 * 1024,
  pullBytes: 512 * 1024,
  pullRows: 32,
  storageBytes: 128 * 1024 * 1024,
  storedBatches: 100000,
  requestsPerDay: 15000,
  appendsPerDay: 4000,
  appendBytesPerDay: 256 * 1024 * 1024,
  devices: 8,
  socketsPerDevice: 2,
  totalBytes: 768 * 1024 * 1024, // Below the conservative 1 GB Free/DO ceiling.
  checkpointBytes: 128 * 1024 * 1024,
  checkpointChunks: 4096,
  checkpointBytesPerDay: 128 * 1024 * 1024,
  writeUnitsPerDay: 80000,
  gcRowsPerDay: 10000,
  checkpointSlots: 32,
  readLeasesPerDevice: 2,
  leaseMs: 15 * 60 * 1000,
  stagingMs: 24 * 60 * 60 * 1000,
  readLeaseMs: 10 * 60 * 1000,
  graceMs: 30 * 60 * 1000,
});
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX_HASH = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const MINIMUM_APPEND_BYTES = encoder.encode(JSON.stringify({ v:1, alg:'XChaCha20-Poly1305', key_id:'a',
  nonce:'A'.repeat(32), ciphertext:'A'.repeat(22) })).byteLength + 512;

class HttpError extends Error {
  constructor(status, code, retryAfter, details = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  } });
}

function failure(error) {
  if (error instanceof HttpError) {
    return json({ error: error.code, ...error.details }, error.status,
      error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
  }
  // No request bodies, credentials, ciphertext, IDs or raw exceptions in logs.
  return json({ error: 'storage_unavailable' }, 503, { 'Retry-After': '30' });
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function decodeBase64url(value, minBytes, maxBytes) {
  if (typeof value !== 'string' || !BASE64URL.test(value)
      || value.length > Math.ceil(maxBytes * 4 / 3) || value.length % 4 === 1) {
    throw new HttpError(400, 'invalid_envelope');
  }
  let decoded;
  try {
    decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/')
      + '='.repeat((4 - value.length % 4) % 4));
  } catch {
    throw new HttpError(400, 'invalid_envelope');
  }
  if (decoded.length < minBytes || decoded.length > maxBytes
      || btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') !== value) {
    throw new HttpError(400, 'invalid_envelope');
  }
  return decoded.length;
}

function canonicalEnvelope(value) {
  if (!exactKeys(value, ['v', 'alg', 'key_id', 'nonce', 'ciphertext'])
      || value.v !== 1 || value.alg !== 'XChaCha20-Poly1305'
      || typeof value.key_id !== 'string' || !ID.test(value.key_id)) {
    throw new HttpError(400, 'invalid_envelope');
  }
  decodeBase64url(value.nonce, 24, 24);
  decodeBase64url(value.ciphertext, 16, LIMITS.ciphertextBytes);
  return JSON.stringify({ v: 1, alg: value.alg, key_id: value.key_id,
    nonce: value.nonce, ciphertext: value.ciphertext });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < 64; i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}

function tokenHashes(env) {
  let hashes, additional = {};
  try {
    hashes = JSON.parse(env.HANNI_DEVICE_TOKEN_HASHES || '');
    if (env.HANNI_ADDITIONAL_DEVICE_TOKEN_HASHES !== undefined) {
      additional = JSON.parse(env.HANNI_ADDITIONAL_DEVICE_TOKEN_HASHES);
    }
  } catch { throw new HttpError(503, 'relay_not_configured'); }
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)
      || !additional || typeof additional !== 'object' || Array.isArray(additional)) {
    throw new HttpError(503, 'relay_not_configured');
  }
  const original = Object.entries(hashes);
  const entries = [...original, ...Object.entries(additional)];
  if (!original.length || entries.length > LIMITS.devices
      || entries.some(([id, hash]) => !ID.test(id) || typeof hash !== 'string' || !HEX_HASH.test(hash))
      || new Set(entries.map(([id]) => id)).size !== entries.length
      || new Set(entries.map(([, hash]) => hash)).size !== entries.length) {
    throw new HttpError(503, 'relay_not_configured');
  }
  return entries;
}

async function authenticate(request, env) {
  const entries = tokenHashes(env);
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
  if (!match) throw new HttpError(401, 'unauthorized');
  try { decodeBase64url(match[1], 32, 32); }
  catch { throw new HttpError(401, 'unauthorized'); }
  const hash = await sha256(match[1]);
  let device;
  for (const [id, expected] of entries) if (constantTimeEqual(hash, expected)) device = id;
  if (!device) throw new HttpError(401, 'unauthorized');
  return { device, hash };
}

async function boundedJson(request) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, 'json_required');
  }
  if (request.headers.has('Content-Encoding')) throw new HttpError(415, 'encoding_not_supported');
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > LIMITS.bodyBytes)) {
    throw new HttpError(413, 'batch_too_large');
  }
  if (!request.body) throw new HttpError(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.bodyBytes) {
        await reader.cancel();
        throw new HttpError(413, 'batch_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'invalid_json'); }
}

function integerParameter(params, name, fallback, maximum) {
  const values = params.getAll(name);
  if (!values.length) return fallback;
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0])) throw new HttpError(400, 'invalid_cursor');
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value > maximum) throw new HttpError(400, 'invalid_cursor');
  return value;
}

function secondsUntilTomorrow() {
  return Math.max(1, Math.ceil(((Math.floor(Date.now() / 86400000) + 1) * 86400000 - Date.now()) / 1000));
}

function positive(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
function lowered(env, name, fallback) {
  const value = Number(env[name]);
  return positive(value) ? Math.min(value, fallback) : fallback;
}
function route(path) {
  return ['/v1/batches', '/v1/stream', '/v1/device-state', '/v1/budget-status', '/v1/maintenance',
    '/v1/checkpoints/lease', '/v1/checkpoints/latest'].includes(path)
    || /^\/v1\/checkpoints\/[a-f0-9-]{36}(?:\/(?:finalize|read-lease|chunks\/(?:0|[1-9]\d*)))?$/.test(path);
}

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    // MVP starts in a fresh namespace. Never reinterpret a legacy store.
    const columns = this.sql.exec('PRAGMA table_info(batches)').toArray();
    this.ready = !columns.length || columns.some(column => column.name === 'client_seq');
    if (!this.ready) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      id INTEGER PRIMARY KEY CHECK(id=1), latest_seq INTEGER NOT NULL DEFAULT 0,
      log_bytes INTEGER NOT NULL DEFAULT 0, retained_count INTEGER NOT NULL DEFAULT 0,
      compacted_through INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
      active_checkpoint TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0,
      day INTEGER NOT NULL DEFAULT 0, daily_requests INTEGER NOT NULL DEFAULT 0,
      daily_appends INTEGER NOT NULL DEFAULT 0, daily_bytes INTEGER NOT NULL DEFAULT 0,
      daily_checkpoint_bytes INTEGER NOT NULL DEFAULT 0, daily_write_units INTEGER NOT NULL DEFAULT 0,
      daily_gc_rows INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec('INSERT OR IGNORE INTO meta(id) VALUES(1)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS batches (
      seq INTEGER PRIMARY KEY, sender_device_id TEXT NOT NULL, client_seq INTEGER NOT NULL,
      batch_id TEXT NOT NULL, envelope_sha256 TEXT NOT NULL, envelope TEXT NOT NULL,
      stored_bytes INTEGER NOT NULL, UNIQUE(sender_device_id,client_seq))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS device_cursors (
      device_id TEXT PRIMARY KEY, accepted_client_seq INTEGER NOT NULL,
      seq INTEGER NOT NULL,batch_id TEXT NOT NULL,envelope_sha256 TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY,uploader TEXT NOT NULL,state TEXT NOT NULL,
      expected_generation INTEGER NOT NULL,base_seq INTEGER NOT NULL,chunk_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_count INTEGER NOT NULL DEFAULT 0,lease_epoch INTEGER NOT NULL,
      lease_until INTEGER NOT NULL,created_at INTEGER NOT NULL,delete_after INTEGER,
      published_generation INTEGER,key_id TEXT,chunk_root TEXT,envelope TEXT,envelope_sha256 TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS checkpoint_chunks (
      checkpoint_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,envelope_sha256 TEXT NOT NULL,
      envelope TEXT NOT NULL,envelope_bytes INTEGER NOT NULL,
      PRIMARY KEY(checkpoint_id,chunk_index)) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS read_leases (
      lease_id TEXT PRIMARY KEY,checkpoint_id TEXT NOT NULL,device_id TEXT NOT NULL,expires_at INTEGER NOT NULL)`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  state() { return this.sql.exec('SELECT * FROM meta WHERE id=1').one(); }
  checkpoint(id) { return this.sql.exec('SELECT * FROM checkpoints WHERE checkpoint_id=?',id).toArray()[0]; }
  summary(cp) { return cp ? { checkpoint_id:cp.checkpoint_id,base_seq:cp.base_seq,generation:cp.published_generation } : null; }
  active() { const id=this.state().active_checkpoint; return id ? this.checkpoint(id) : null; }
  quota() {
    this.ctx.storage.transactionSync(() => {
      const day=Math.floor(Date.now()/86400000); let state=this.state();
      if (state.day!==day) {
        this.sql.exec(`UPDATE meta SET day=?,daily_requests=0,daily_appends=0,daily_bytes=0,
          daily_checkpoint_bytes=0,daily_write_units=0,daily_gc_rows=0 WHERE id=1`,day);
        state=this.state();
      }
      if (state.daily_requests>=lowered(this.env,'HANNI_MAX_REQUESTS_PER_DAY',LIMITS.requestsPerDay)) throw new HttpError(429,'daily_request_limit',secondsUntilTomorrow());
      if (state.daily_write_units+2>LIMITS.writeUnitsPerDay) throw new HttpError(429,'daily_operation_limit',secondsUntilTomorrow());
      this.sql.exec('UPDATE meta SET daily_requests=daily_requests+1,daily_write_units=daily_write_units+2 WHERE id=1');
    });
  }
  charge(units) {
    if (this.state().daily_write_units+units>LIMITS.writeUnitsPerDay) throw new HttpError(429,'daily_operation_limit',secondsUntilTomorrow());
    this.sql.exec('UPDATE meta SET daily_write_units=daily_write_units+? WHERE id=1',units);
  }
  storageHeadroomBytes() {
    const cap=lowered(this.env,'HANNI_MAX_TOTAL_STORAGE_BYTES',LIMITS.totalBytes);
    // Reserve the unuploaded remainder so a full log cannot consume recovery space.
    const reserve=this.sql.exec(`SELECT COALESCE(SUM(total_bytes-uploaded_bytes+chunk_count*512+98304),0) AS bytes
      FROM checkpoints WHERE state='staging'`).one().bytes;
    return cap-Number(this.sql.databaseSize)-reserve;
  }
  availableStorageBytes() {
    return Math.max(0,this.storageHeadroomBytes());
  }
  storageCheck(extra=0) {
    if (this.storageHeadroomBytes()<extra) throw new HttpError(507,'relay_total_capacity_reached');
  }
  async schedule(delay) {
    const now=Date.now();const at=delay===undefined ? this.nextMaintenanceAt() : now+delay;
    if (at===null) return;
    const existing=await this.ctx.storage.getAlarm();
    if (existing===null || existing>at) await this.ctx.storage.setAlarm(at);
  }
  async fetch(request) {
    try {
      if (!this.ready) throw new HttpError(503,'protocol_migration_required');
      const url=new URL(request.url); const user=await authenticate(request,this.env);
      if (!route(url.pathname)) throw new HttpError(404,'not_found');
      const allowed=url.pathname==='/v1/batches' && request.method==='GET' ? ['after','limit'] : [];
      if ([...url.searchParams.keys()].some(key=>!allowed.includes(key))) throw new HttpError(400,'invalid_query');
      if (url.pathname==='/v1/budget-status' && request.method==='GET') return this.budgetStatus();
      this.quota();
      if (url.pathname==='/v1/batches' && request.method==='POST') return await this.append(request,user);
      if (url.pathname==='/v1/batches' && request.method==='GET') return this.pull(url.searchParams);
      if (url.pathname==='/v1/stream' && request.method==='GET') return this.stream(request,user);
      if (url.pathname==='/v1/device-state' && request.method==='GET') return this.deviceState(user);
      if (url.pathname==='/v1/maintenance' && request.method==='POST') { await this.emptyBody(request); return await this.maintenance(); }
      if (url.pathname==='/v1/checkpoints/lease' && request.method==='POST') return await this.acquire(request,user);
      if (url.pathname==='/v1/checkpoints/latest' && request.method==='GET') {
        const active=this.active(); if (!active) throw new HttpError(404,'checkpoint_missing');
        return json(this.summary(active));
      }
      const match=/^\/v1\/checkpoints\/([a-f0-9-]{36})(?:\/(finalize|read-lease|chunks\/(0|[1-9]\d*)))?$/.exec(url.pathname);
      if (match && BATCH_ID.test(match[1])) {
        const [_,id,operation,index]=match;
        if (operation==='finalize' && request.method==='POST') return await this.finalize(request,user,id);
        if (operation==='read-lease' && request.method==='POST') return await this.readLease(request,user,id);
        if (index!==undefined && request.method==='PUT') return await this.putChunk(request,user,id,Number(index));
        if ((!operation || index!==undefined) && request.method==='GET') return this.download(request,user,id,index===undefined ? null : Number(index));
      }
      throw new HttpError(405,'method_not_allowed');
    } catch (error) { return failure(error); }
  }
  async emptyBody(request) { if (!exactKeys(await boundedJson(request),[])) throw new HttpError(400,'invalid_body'); }
  budgetStatus() {
    const today=Math.floor(Date.now()/86400000),stored=this.state();
    const state=stored.day===today ? stored : {...stored,day:today,daily_requests:0,daily_appends:0,
      daily_bytes:0,daily_checkpoint_bytes:0,daily_write_units:0,daily_gc_rows:0};
    const requestLimit=lowered(this.env,'HANNI_MAX_REQUESTS_PER_DAY',LIMITS.requestsPerDay);
    const availableAppendBytes=Math.max(0,LIMITS.appendBytesPerDay-state.daily_bytes);
    const availableStorageBytes=Math.min(this.availableStorageBytes(),
      Math.max(0,lowered(this.env,'HANNI_MAX_STORAGE_BYTES',LIMITS.storageBytes)-state.log_bytes));
    const uploadAllowed=state.daily_requests<requestLimit && state.daily_appends<LIMITS.appendsPerDay
      && availableAppendBytes>=MINIMUM_APPEND_BYTES && availableStorageBytes>=MINIMUM_APPEND_BYTES
      && state.retained_count<lowered(this.env,'HANNI_MAX_RETAINED_BATCHES',LIMITS.storedBatches)
      && state.daily_write_units+12<=LIMITS.writeUnitsPerDay;
    return json({reset_after_seconds:secondsUntilTomorrow(),upload_allowed:uploadAllowed,
      retry_after_seconds:uploadAllowed?0:secondsUntilTomorrow(),minimum_append_bytes:MINIMUM_APPEND_BYTES,
      available_append_bytes:availableAppendBytes,available_storage_bytes:availableStorageBytes,
      requests:{used:state.daily_requests,limit:requestLimit},
      appends:{used:state.daily_appends,limit:LIMITS.appendsPerDay},
      append_bytes:{used:state.daily_bytes,limit:LIMITS.appendBytesPerDay},
      write_units:{used:state.daily_write_units,limit:LIMITS.writeUnitsPerDay}});
  }
  deviceState(user) {
    const cursor=this.sql.exec('SELECT * FROM device_cursors WHERE device_id=?',user.device).toArray()[0];
    return json({accepted_client_seq:cursor?.accepted_client_seq || 0,
      last_ack:cursor ? {seq:cursor.seq,client_seq:cursor.accepted_client_seq,sender_device_id:user.device,
        batch_id:cursor.batch_id,envelope_sha256:cursor.envelope_sha256} : null,
      checkpoint:this.summary(this.active()),latest_seq:this.state().latest_seq});
  }
  async append(request,user) {
    const body=await boundedJson(request);
    if (!exactKeys(body,['client_seq','batch_id','envelope']) || !positive(body.client_seq)
      || typeof body.batch_id!=='string' || !BATCH_ID.test(body.batch_id)) throw new HttpError(400,'invalid_batch');
    const envelope=canonicalEnvelope(body.envelope); const digest=await sha256(envelope);
    const storedBytes=encoder.encode(envelope).byteLength+512;
    const result=this.ctx.storage.transactionSync(() => {
      const previous=this.sql.exec('SELECT * FROM device_cursors WHERE device_id=?',user.device).toArray()[0];
      const accepted=previous?.accepted_client_seq || 0;
      if (body.client_seq<accepted) throw new HttpError(409,'device_state_stale',undefined,{accepted_client_seq:accepted,checkpoint:this.summary(this.active())});
      if (body.client_seq===accepted) {
        if (previous.batch_id!==body.batch_id || previous.envelope_sha256!==digest) throw new HttpError(409,'batch_payload_mismatch');
        return {seq:previous.seq,duplicate:true};
      }
      if (body.client_seq!==accepted+1) throw new HttpError(409,'client_sequence_gap',undefined,{accepted_client_seq:accepted});
      const state=this.state();
      if (state.latest_seq>=Number.MAX_SAFE_INTEGER) throw new HttpError(507,'sequence_capacity_reached');
      if (state.log_bytes+storedBytes>lowered(this.env,'HANNI_MAX_STORAGE_BYTES',LIMITS.storageBytes)
        || state.retained_count>=lowered(this.env,'HANNI_MAX_RETAINED_BATCHES',LIMITS.storedBatches)) throw new HttpError(507,'relay_capacity_reached');
      if (state.daily_appends>=LIMITS.appendsPerDay || state.daily_bytes+storedBytes>LIMITS.appendBytesPerDay) throw new HttpError(429,'daily_append_limit',secondsUntilTomorrow());
      this.charge(10); this.storageCheck(storedBytes);
      const seq=state.latest_seq+1;
      this.sql.exec('INSERT INTO batches VALUES(?,?,?,?,?,?,?)',seq,user.device,body.client_seq,body.batch_id,digest,envelope,storedBytes);
      this.sql.exec(`INSERT INTO device_cursors VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET
        accepted_client_seq=excluded.accepted_client_seq,seq=excluded.seq,batch_id=excluded.batch_id,envelope_sha256=excluded.envelope_sha256`,user.device,body.client_seq,seq,body.batch_id,digest);
      this.sql.exec(`UPDATE meta SET latest_seq=?,log_bytes=log_bytes+?,retained_count=retained_count+1,
        daily_appends=daily_appends+1,daily_bytes=daily_bytes+? WHERE id=1`,seq,storedBytes,storedBytes);
      this.storageCheck(); return {seq,duplicate:false};
    });
    await this.ctx.storage.sync(); if (!result.duplicate) this.notify(result.seq);
    return json({...result,client_seq:body.client_seq,sender_device_id:user.device,batch_id:body.batch_id,envelope_sha256:digest},result.duplicate?200:201);
  }
  pull(params) {
    const after=integerParameter(params,'after',0,Number.MAX_SAFE_INTEGER);
    const limit=integerParameter(params,'limit',16,LIMITS.pullRows);
    if (!limit) throw new HttpError(400,'invalid_limit');
    const state=this.state();
    if (after>state.latest_seq) throw new HttpError(409,'cursor_ahead');
    if (after<state.compacted_through) throw new HttpError(409,'checkpoint_required',undefined,{checkpoint:this.summary(this.active())});
    const rows=this.sql.exec('SELECT * FROM batches WHERE seq>? ORDER BY seq LIMIT ?',after,limit).toArray();
    const batches=[]; let bytes=0; let next=after;
    for (const row of rows) {
      if (bytes+row.stored_bytes>LIMITS.pullBytes) break;
      batches.push({seq:row.seq,client_seq:row.client_seq,sender_device_id:row.sender_device_id,batch_id:row.batch_id,
        envelope_sha256:row.envelope_sha256,envelope:JSON.parse(row.envelope)});
      bytes+=row.stored_bytes;next=row.seq;
    }
    return json({batches,next_cursor:next,latest_seq:state.latest_seq,has_more:next<state.latest_seq});
  }
  async acquire(request,user) {
    const body=await boundedJson(request);
    if (!exactKeys(body,['checkpoint_id','expected_generation','base_seq','chunk_count','total_bytes'])
      || !BATCH_ID.test(body.checkpoint_id || '') || !Number.isSafeInteger(body.expected_generation) || body.expected_generation<0
      || !positive(body.base_seq) || !positive(body.chunk_count,LIMITS.checkpointChunks)
      || !positive(body.total_bytes,LIMITS.checkpointBytes)) throw new HttpError(400,'invalid_checkpoint');
    // Establish a durable recovery wake before the metadata can commit.
    await this.schedule(60000);
    const now=Date.now(); const duration=lowered(this.env,'HANNI_LEASE_MS',LIMITS.leaseMs);
    const result=this.ctx.storage.transactionSync(() => {
      const state=this.state(); const existing=this.checkpoint(body.checkpoint_id);
      if (existing) {
        if (existing.uploader!==user.device || existing.expected_generation!==body.expected_generation || existing.base_seq!==body.base_seq
          || existing.chunk_count!==body.chunk_count || existing.total_bytes!==body.total_bytes) throw new HttpError(409,'checkpoint_payload_mismatch');
        if (existing.state!=='staging') throw new HttpError(409,'checkpoint_not_staging');
      }
      if (body.expected_generation!==state.generation || body.base_seq<=state.compacted_through || body.base_seq>state.latest_seq) throw new HttpError(409,'checkpoint_generation_changed');
      const busy=this.sql.exec("SELECT checkpoint_id FROM checkpoints WHERE state='staging' AND lease_until>? AND checkpoint_id<>? LIMIT 1",now,body.checkpoint_id).toArray()[0];
      if (busy) throw new HttpError(409,'checkpoint_lease_busy',30);
      if (!existing && this.sql.exec('SELECT COUNT(*) AS count FROM checkpoints').one().count>=LIMITS.checkpointSlots) throw new HttpError(507,'checkpoint_slots_full');
      this.charge(16);
      this.sql.exec("UPDATE checkpoints SET state='abandoned',delete_after=? WHERE state='staging' AND checkpoint_id<>?",now,body.checkpoint_id);
      // Every renewed/acquired lease gets a fencing epoch, including the same owner.
      const epoch=state.lease_epoch+1;
      this.sql.exec('UPDATE meta SET lease_epoch=? WHERE id=1',epoch);
      if (existing) this.sql.exec('UPDATE checkpoints SET lease_epoch=?,lease_until=? WHERE checkpoint_id=?',epoch,now+duration,body.checkpoint_id);
      else this.sql.exec(`INSERT INTO checkpoints(checkpoint_id,uploader,state,expected_generation,base_seq,chunk_count,total_bytes,lease_epoch,lease_until,created_at)
        VALUES(?,?,'staging',?,?,?,?,?,?,?)`,body.checkpoint_id,user.device,body.expected_generation,body.base_seq,body.chunk_count,body.total_bytes,epoch,now+duration,now);
      this.storageCheck();return {checkpoint_id:body.checkpoint_id,lease_epoch:epoch,expires_at:now+duration};
    });
    await this.ctx.storage.sync(); await this.schedule(); return json(result,201);
  }
  requireUploader(cp,user,epoch) {
    if (!cp) throw new HttpError(404,'checkpoint_missing');
    if (cp.uploader!==user.device) throw new HttpError(403,'checkpoint_owner_required');
    if (cp.state!=='staging' || cp.lease_epoch!==epoch || cp.lease_until<=Date.now()) throw new HttpError(409,'checkpoint_lease_expired');
    if (cp.expected_generation!==this.state().generation) throw new HttpError(409,'checkpoint_generation_changed');
  }
  async putChunk(request,user,id,index) {
    const body=await boundedJson(request);
    if (!exactKeys(body,['lease_epoch','envelope']) || !positive(body.lease_epoch) || !Number.isSafeInteger(index) || index<0) throw new HttpError(400,'invalid_chunk');
    const envelope=canonicalEnvelope(body.envelope);const digest=await sha256(envelope);const bytes=encoder.encode(envelope).byteLength;
    const result=this.ctx.storage.transactionSync(() => {
      const cp=this.checkpoint(id);this.requireUploader(cp,user,body.lease_epoch);
      if (index>=cp.chunk_count) throw new HttpError(400,'invalid_chunk');
      const old=this.sql.exec('SELECT envelope_sha256,envelope FROM checkpoint_chunks WHERE checkpoint_id=? AND chunk_index=?',id,index).toArray()[0];
      if (old) {
        if (old.envelope_sha256!==digest || old.envelope!==envelope) throw new HttpError(409,'chunk_payload_mismatch');
        return {duplicate:true};
      }
      if (cp.key_id!==null && cp.key_id!==body.envelope.key_id) throw new HttpError(400,'checkpoint_key_mismatch');
      if (cp.uploaded_bytes+bytes>cp.total_bytes) throw new HttpError(400,'checkpoint_size_mismatch');
      if (this.state().daily_checkpoint_bytes+bytes>lowered(this.env,'HANNI_MAX_CHECKPOINT_BYTES_PER_DAY',LIMITS.checkpointBytesPerDay)) throw new HttpError(429,'daily_checkpoint_limit',secondsUntilTomorrow());
      this.charge(8);
      this.sql.exec('INSERT INTO checkpoint_chunks VALUES(?,?,?,?,?)',id,index,digest,envelope,bytes);
      this.sql.exec('UPDATE checkpoints SET uploaded_bytes=uploaded_bytes+?,uploaded_count=uploaded_count+1,key_id=COALESCE(key_id,?) WHERE checkpoint_id=?',bytes,body.envelope.key_id,id);
      this.sql.exec('UPDATE meta SET daily_checkpoint_bytes=daily_checkpoint_bytes+? WHERE id=1',bytes);
      this.storageCheck();return {duplicate:false};
    });
    await this.ctx.storage.sync();return json({...result,checkpoint_id:id,index,envelope_sha256:digest},result.duplicate?200:201);
  }
  async finalize(request,user,id) {
    const body=await boundedJson(request);
    if (!exactKeys(body,['lease_epoch','chunk_root_sha256','envelope']) || !positive(body.lease_epoch)
      || !HEX_HASH.test(body.chunk_root_sha256 || '')) throw new HttpError(400,'invalid_manifest');
    const envelope=canonicalEnvelope(body.envelope);const digest=await sha256(envelope);
    const before=this.checkpoint(id);
    if (!before) throw new HttpError(404,'checkpoint_missing');
    if (before.uploader!==user.device) throw new HttpError(403,'checkpoint_owner_required');
    if (before.published_generation!==null) {
      if (before.envelope_sha256!==digest || before.chunk_root!==body.chunk_root_sha256) throw new HttpError(409,'checkpoint_payload_mismatch');
      return json({...this.summary(before),envelope_sha256:digest,duplicate:true});
    }
    this.requireUploader(before,user,body.lease_epoch);
    const chunks=this.sql.exec('SELECT chunk_index,envelope_sha256 FROM checkpoint_chunks WHERE checkpoint_id=? ORDER BY chunk_index',id).toArray();
    if (chunks.length!==before.chunk_count || chunks.some((chunk,index)=>chunk.chunk_index!==index)
      || before.uploaded_bytes!==before.total_bytes) throw new HttpError(409,'checkpoint_incomplete');
    const root=await sha256(JSON.stringify(chunks.map(chunk=>chunk.envelope_sha256)));
    if (root!==body.chunk_root_sha256) throw new HttpError(400,'checkpoint_digest_mismatch');
    await this.schedule(60000);
    const result=this.ctx.storage.transactionSync(() => {
      const cp=this.checkpoint(id);
      // Another identical finalize may have committed across the digest await.
      if (cp?.published_generation!==null && cp?.published_generation!==undefined) {
        if (cp.uploader!==user.device || cp.envelope_sha256!==digest || cp.chunk_root!==root) throw new HttpError(409,'checkpoint_payload_mismatch');
        return {...this.summary(cp),envelope_sha256:digest,duplicate:true};
      }
      this.requireUploader(cp,user,body.lease_epoch);const state=this.state();
      if (cp.key_id!==body.envelope.key_id) throw new HttpError(400,'checkpoint_key_mismatch');
      if (cp.base_seq<=state.compacted_through || cp.base_seq>state.latest_seq) throw new HttpError(409,'checkpoint_generation_changed');
      this.charge(16);const generation=state.generation+1;
      if (state.active_checkpoint) this.sql.exec("UPDATE checkpoints SET state='retired',delete_after=? WHERE checkpoint_id=?",Date.now()+lowered(this.env,'HANNI_GRACE_MS',LIMITS.graceMs),state.active_checkpoint);
      this.sql.exec("UPDATE checkpoints SET state='active',published_generation=?,chunk_root=?,envelope=?,envelope_sha256=?,lease_until=0 WHERE checkpoint_id=?",generation,root,envelope,digest,id);
      this.sql.exec('UPDATE meta SET generation=?,active_checkpoint=?,compacted_through=? WHERE id=1',generation,id,cp.base_seq);
      this.storageCheck();return {checkpoint_id:id,base_seq:cp.base_seq,generation,envelope_sha256:digest,duplicate:false};
    });
    await this.ctx.storage.sync();if (!result.duplicate) this.notify(this.state().latest_seq);await this.schedule();return json(result,result.duplicate?200:201);
  }
  async readLease(request,user,id) {
    await this.emptyBody(request);await this.schedule(lowered(this.env,'HANNI_READ_LEASE_MS',LIMITS.readLeaseMs));
    const now=Date.now();const leaseId=crypto.randomUUID();
    const result=this.ctx.storage.transactionSync(() => {
      const cp=this.checkpoint(id);
      if (!cp || !['active','retired'].includes(cp.state)) throw new HttpError(404,'checkpoint_missing');
      if (cp.state==='retired' && cp.delete_after<=now) throw new HttpError(410,'checkpoint_expired',undefined,{checkpoint:this.summary(this.active())});
      const duration=lowered(this.env,'HANNI_READ_LEASE_MS',LIMITS.readLeaseMs);
      const until=Math.min(now+duration,cp.delete_after || Number.MAX_SAFE_INTEGER);
      this.charge(80);
      this.sql.exec('DELETE FROM read_leases WHERE expires_at<=?',now);
      // Reuse an existing lease for this device/checkpoint; retry does not consume a slot.
      const existing=this.sql.exec('SELECT * FROM read_leases WHERE device_id=? AND checkpoint_id=?',user.device,id).toArray()[0];
      if (existing) return {checkpoint_id:id,read_lease_id:existing.lease_id,expires_at:existing.expires_at};
      if (this.sql.exec('SELECT COUNT(*) AS count FROM read_leases WHERE device_id=?',user.device).one().count>=LIMITS.readLeasesPerDevice) throw new HttpError(429,'read_lease_limit',30);
      this.sql.exec('INSERT INTO read_leases VALUES(?,?,?,?)',leaseId,id,user.device,until);
      this.storageCheck();return {checkpoint_id:id,read_lease_id:leaseId,expires_at:until};
    });
    await this.ctx.storage.sync();await this.schedule();return json(result,201);
  }
  download(request,user,id,index) {
    const lease=request.headers.get('X-Hanni-Read-Lease');
    if (!lease || !BATCH_ID.test(lease)) throw new HttpError(409,'read_lease_required');
    const valid=this.sql.exec('SELECT 1 AS ok FROM read_leases WHERE lease_id=? AND device_id=? AND checkpoint_id=? AND expires_at>?',lease,user.device,id,Date.now()).toArray()[0];
    if (!valid) throw new HttpError(409,'read_lease_expired');
    const cp=this.checkpoint(id);
    if (!cp || !['active','retired'].includes(cp.state)) throw new HttpError(410,'checkpoint_expired',undefined,{checkpoint:this.summary(this.active())});
    if (index===null) return json({...this.summary(cp),uploader_device_id:cp.uploader,chunk_count:cp.chunk_count,total_bytes:cp.total_bytes,
      chunk_root_sha256:cp.chunk_root,envelope_sha256:cp.envelope_sha256,envelope:JSON.parse(cp.envelope)});
    if (!Number.isSafeInteger(index) || index<0 || index>=cp.chunk_count) throw new HttpError(400,'invalid_chunk');
    const row=this.sql.exec('SELECT envelope,envelope_sha256 FROM checkpoint_chunks WHERE checkpoint_id=? AND chunk_index=?',id,index).toArray()[0];
    if (!row) throw new HttpError(503,'checkpoint_incomplete');
    return json({checkpoint_id:id,index,envelope_sha256:row.envelope_sha256,envelope:JSON.parse(row.envelope)});
  }
  gc() {
    const now=Date.now();let removed=0;
    this.ctx.storage.transactionSync(() => {
      const state=this.state();
      // Preserve room for normal reads/writes instead of spending the day on GC.
      if (state.daily_gc_rows>=LIMITS.gcRowsPerDay || state.daily_write_units+500>LIMITS.writeUnitsPerDay-10000) return;
      const expiry=lowered(this.env,'HANNI_STAGING_MS',LIMITS.stagingMs);
      const expiredStaging=this.sql.exec("SELECT checkpoint_id FROM checkpoints WHERE state='staging' AND created_at+?<=?",expiry,now).toArray();
      const expiredLeases=this.sql.exec('SELECT lease_id FROM read_leases WHERE expires_at<=?',now).toArray();
      const budget=Math.min(100,LIMITS.gcRowsPerDay-state.daily_gc_rows);
      const logs=this.sql.exec('SELECT seq,stored_bytes FROM batches WHERE seq<=? ORDER BY seq LIMIT ?',state.compacted_through,budget).toArray();
      const stale=this.sql.exec(`SELECT checkpoint_id FROM checkpoints c WHERE
        ((state='abandoned') OR (state='retired' AND delete_after<=?) OR (state='staging' AND created_at+?<=?))
        AND NOT EXISTS(SELECT 1 FROM read_leases l WHERE l.checkpoint_id=c.checkpoint_id AND l.expires_at>?)
        ORDER BY created_at LIMIT 1`,now,expiry,now,now).toArray()[0];
      const chunks=stale && logs.length<budget ? this.sql.exec('SELECT chunk_index FROM checkpoint_chunks WHERE checkpoint_id=? LIMIT ?',stale.checkpoint_id,budget-logs.length).toArray() : [];
      if (!logs.length && !chunks.length && !expiredStaging.length && !expiredLeases.length && !stale) return;
      this.charge(12+4*(logs.length+chunks.length+expiredStaging.length+expiredLeases.length));
      if (expiredStaging.length) this.sql.exec("UPDATE checkpoints SET state='abandoned',delete_after=? WHERE state='staging' AND created_at+?<=?",now,expiry,now);
      if (expiredLeases.length) this.sql.exec('DELETE FROM read_leases WHERE expires_at<=?',now);
      for (const row of logs) this.sql.exec('DELETE FROM batches WHERE seq=?',row.seq);
      if (logs.length) {
        this.sql.exec('UPDATE meta SET log_bytes=log_bytes-?,retained_count=retained_count-? WHERE id=1',logs.reduce((sum,row)=>sum+row.stored_bytes,0),logs.length);
        removed+=logs.length;
      }
      if (removed<budget) {
        if (stale) {
          for (const chunk of chunks) this.sql.exec('DELETE FROM checkpoint_chunks WHERE checkpoint_id=? AND chunk_index=?',stale.checkpoint_id,chunk.chunk_index);
          removed+=chunks.length;
          if (!this.sql.exec('SELECT 1 AS present FROM checkpoint_chunks WHERE checkpoint_id=? LIMIT 1',stale.checkpoint_id).toArray().length) this.sql.exec('DELETE FROM checkpoints WHERE checkpoint_id=?',stale.checkpoint_id);
        }
      }
      if (removed) this.sql.exec('UPDATE meta SET daily_gc_rows=daily_gc_rows+? WHERE id=1',removed);
    });
    return removed;
  }
  nextMaintenanceAt() {
    const state=this.state(),now=Date.now();const deadlines=[];
    if (this.sql.exec('SELECT 1 AS present FROM batches WHERE seq<=? LIMIT 1',state.compacted_through).toArray().length) deadlines.push(now);
    const leases=this.sql.exec('SELECT checkpoint_id,expires_at FROM read_leases').toArray();
    for (const lease of leases) deadlines.push(lease.expires_at);
    for (const cp of this.sql.exec("SELECT checkpoint_id,state,created_at,delete_after FROM checkpoints WHERE state<>'active'").toArray()) {
      if (cp.state==='abandoned') deadlines.push(now);
      else if (cp.state==='staging') deadlines.push(cp.created_at+lowered(this.env,'HANNI_STAGING_MS',LIMITS.stagingMs));
      else deadlines.push(Math.max(cp.delete_after,...leases.filter(lease=>lease.checkpoint_id===cp.checkpoint_id).map(lease=>lease.expires_at)));
    }
    if (!deadlines.length) return null;
    const budgetBlocked=state.daily_gc_rows>=LIMITS.gcRowsPerDay || state.daily_write_units+500>LIMITS.writeUnitsPerDay-10000;
    return Math.max(now+(budgetBlocked ? secondsUntilTomorrow()*1000 : 1000),Math.min(...deadlines));
  }
  async maintenance() {
    const removed=this.gc();await this.ctx.storage.sync();
    await this.schedule();
    return json({removed_rows:removed,more_pending:this.nextMaintenanceAt()!==null});
  }
  async alarm() {
    try { if (!this.ready) return;this.quota();await this.maintenance(); }
    catch (error) { await this.schedule((error instanceof HttpError && error.retryAfter ? error.retryAfter : 60)*1000); }
  }
  stream(request,user) {
    if ((request.headers.get('Upgrade') || '').toLowerCase()!=='websocket') throw new HttpError(426,'websocket_required');
    const peers=this.ctx.getWebSockets(user.device).filter(socket => {
      if (socket.readyState!==WebSocket.OPEN) return false;
      if (this.authorizedSocket(socket)) return true;
      try { socket.close(1008,'authorization_changed'); } catch {} return false;
    });
    if (peers.length>=LIMITS.socketsPerDevice) throw new HttpError(429,'connection_limit',30);
    const [client,server]=Object.values(new WebSocketPair());this.ctx.acceptWebSocket(server,[user.device]);
    server.serializeAttachment({device:user.device,hash:user.hash});
    server.send(JSON.stringify({type:'ready',latest_seq:this.state().latest_seq}));
    return new Response(null,{status:101,webSocket:client});
  }
  authorizedSocket(socket) {
    const attachment=socket.deserializeAttachment();
    return attachment && tokenHashes(this.env).some(([id,hash])=>id===attachment.device && constantTimeEqual(hash,attachment.hash));
  }
  notify(seq) {
    for (const socket of this.ctx.getWebSockets()) {
      try { if (!this.authorizedSocket(socket)) socket.close(1008,'authorization_changed');else socket.send(JSON.stringify({type:'changed',latest_seq:seq})); }
      catch { try {socket.close(1011,'connection_failed');}catch{} }
    }
  }
  webSocketMessage(socket,message) {
    try {
      if (!this.authorizedSocket(socket)) {socket.close(1008,'authorization_changed');return;}
      if (message==='ping') {socket.send('pong');return;}
      socket.close(1008,'use_http_batches');
    } catch {try {socket.close(1011,'connection_failed');}catch{}}
  }
  webSocketClose(socket,code) { try { socket.close(code===1000?1000:1001,''); } catch {} }
  webSocketError(socket) { try { socket.close(1011,'connection_failed'); } catch {} }
}

export default {
  async fetch(request,env) {
    try {
      const url=new URL(request.url);
      if (url.protocol!=='https:') throw new HttpError(400,'https_required');
      // A separate Worker namespace and fixed object name isolate MVP content.
      // Checkpoints remain unavailable until the MVP can authenticate their schema.
      if (!['/content/v1/batches','/content/v1/stream','/content/v1/device-state'].includes(url.pathname)) {
        throw new HttpError(404,'not_found');
      }
      await authenticate(request,env);
      url.pathname=url.pathname.slice('/content'.length);
      return await env.RELAY.get(env.RELAY.idFromName('hanni-mvp-relay-v1')).fetch(new Request(url,request));
    } catch(error) { return failure(error); }
  },
};
