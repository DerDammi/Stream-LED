const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'led-controller.db');
let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function ensureColumn(table, column, sql) {
  const columns = getDb().prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
  if (!columns.includes(column)) getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
}

function initSchema() {
  const conn = getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS twitch_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      client_id TEXT,
      client_secret TEXT,
      access_token TEXT,
      refresh_token TEXT,
      login TEXT,
      user_id TEXT,
      expires_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lamps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('wled', 'govee', 'hue')),
      address TEXT NOT NULL,
      api_key TEXT,
      enabled INTEGER DEFAULT 1,
      effects_json TEXT DEFAULT '[]',
      metadata_json TEXT DEFAULT '{}',
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS streamers (
      id TEXT PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS online_rules (
      id TEXT PRIMARY KEY,
      streamer_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      targets_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_rules (
      id TEXT PRIMARY KEY,
      streamer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      match_text TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','exact')),
      window_seconds INTEGER NOT NULL DEFAULT 10,
      min_matches INTEGER NOT NULL DEFAULT 5,
      enabled INTEGER DEFAULT 1,
      targets_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      hash TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_logs_hash ON logs(hash);
  `);

  ensureColumn('twitch_auth', 'client_secret', 'client_secret TEXT');
  ensureColumn('twitch_auth', 'auth_type', "auth_type TEXT DEFAULT 'oauth'");
  ensureColumn('lamps', 'metadata_json', "metadata_json TEXT DEFAULT '{}'");

  setDefaultSetting('port', 3847);
  setDefaultSetting('online_poll_seconds', 30);
  setDefaultSetting('rotation_seconds', 20);
  setDefaultSetting('healthcheck_seconds', 30);
}

function setDefaultSetting(key, value) {
  const exists = getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
  if (!exists) setSetting(key, value);
}

function getSetting(key, defaultVal = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : defaultVal;
}

function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(value));
}

function getTwitchAuth() {
  return getDb().prepare('SELECT * FROM twitch_auth WHERE id = 1').get() || null;
}

function saveTwitchAuth(data) {
  getDb().prepare(`
    INSERT INTO twitch_auth (id, auth_type, client_id, client_secret, access_token, refresh_token, login, user_id, expires_at, updated_at)
    VALUES (1, @auth_type, @client_id, @client_secret, @access_token, @refresh_token, @login, @user_id, @expires_at, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      auth_type = excluded.auth_type,
      client_id = excluded.client_id,
      client_secret = excluded.client_secret,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      login = excluded.login,
      user_id = excluded.user_id,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `).run({
    auth_type: data.auth_type || 'oauth',
    client_id: data.client_id || null,
    client_secret: data.client_secret || null,
    access_token: data.access_token || null,
    refresh_token: data.refresh_token || null,
    login: data.login || null,
    user_id: data.user_id || null,
    expires_at: data.expires_at || null
  });
}

function clearTwitchAuth() {
  getDb().prepare('DELETE FROM twitch_auth WHERE id = 1').run();
}

function getAllLamps() {
  return getDb().prepare('SELECT * FROM lamps ORDER BY name').all().map(parseLamp);
}
function getLamp(id) {
  const row = getDb().prepare('SELECT * FROM lamps WHERE id = ?').get(id);
  return row ? parseLamp(row) : null;
}
function saveLamp(lamp) {
  getDb().prepare(`
    INSERT INTO lamps (id, name, type, address, api_key, enabled, effects_json, metadata_json, last_seen)
    VALUES (@id, @name, @type, @address, @api_key, @enabled, @effects_json, @metadata_json, @last_seen)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      address = excluded.address,
      api_key = excluded.api_key,
      enabled = excluded.enabled,
      effects_json = COALESCE(excluded.effects_json, lamps.effects_json),
      metadata_json = COALESCE(excluded.metadata_json, lamps.metadata_json),
      last_seen = COALESCE(excluded.last_seen, lamps.last_seen)
  `).run({
    id: lamp.id,
    name: lamp.name,
    type: lamp.type,
    address: lamp.address,
    api_key: lamp.api_key || null,
    enabled: lamp.enabled ? 1 : 0,
    effects_json: JSON.stringify(lamp.effects || []),
    metadata_json: JSON.stringify(lamp.metadata || {}),
    last_seen: lamp.last_seen || null
  });
  return getLamp(lamp.id);
}
function deleteLamp(id) { getDb().prepare('DELETE FROM lamps WHERE id = ?').run(id); }
function updateLampEffects(id, effects) { getDb().prepare('UPDATE lamps SET effects_json = ? WHERE id = ?').run(JSON.stringify(effects || []), id); }
function updateLampSeen(id, online) { getDb().prepare('UPDATE lamps SET last_seen = ? WHERE id = ?').run(online ? new Date().toISOString() : null, id); }

function getAllStreamers() {
  return getDb().prepare('SELECT * FROM streamers ORDER BY login').all();
}
function getStreamer(id) { return getDb().prepare('SELECT * FROM streamers WHERE id = ?').get(id) || null; }
function saveStreamer(streamer) {
  getDb().prepare(`
    INSERT INTO streamers (id, login, enabled) VALUES (@id, @login, @enabled)
    ON CONFLICT(id) DO UPDATE SET login = excluded.login, enabled = excluded.enabled
  `).run({ id: streamer.id, login: String(streamer.login || '').toLowerCase(), enabled: streamer.enabled ? 1 : 0 });
  return getStreamer(streamer.id);
}
function deleteStreamer(id) { getDb().prepare('DELETE FROM streamers WHERE id = ?').run(id); }

function getAllOnlineRules() {
  return getDb().prepare(`
    SELECT r.*, s.login AS streamer_login
    FROM online_rules r
    JOIN streamers s ON s.id = r.streamer_id
    ORDER BY s.login
  `).all().map(parseTargetsRule);
}
function saveOnlineRule(rule) {
  getDb().prepare(`
    INSERT INTO online_rules (id, streamer_id, enabled, targets_json)
    VALUES (@id, @streamer_id, @enabled, @targets_json)
    ON CONFLICT(id) DO UPDATE SET
      streamer_id = excluded.streamer_id,
      enabled = excluded.enabled,
      targets_json = excluded.targets_json
  `).run({
    id: rule.id,
    streamer_id: rule.streamer_id,
    enabled: rule.enabled ? 1 : 0,
    targets_json: JSON.stringify(rule.targets || [])
  });
}
function deleteOnlineRule(id) { getDb().prepare('DELETE FROM online_rules WHERE id = ?').run(id); }

function getAllChatRules() {
  return getDb().prepare(`
    SELECT r.*, s.login AS streamer_login
    FROM chat_rules r
    JOIN streamers s ON s.id = r.streamer_id
    ORDER BY s.login, r.name
  `).all().map(parseTargetsRule);
}
function getEnabledChatRules() {
  return getDb().prepare(`
    SELECT r.*, s.login AS streamer_login
    FROM chat_rules r
    JOIN streamers s ON s.id = r.streamer_id
    WHERE r.enabled = 1 AND s.enabled = 1
    ORDER BY s.login, r.name
  `).all().map(parseTargetsRule);
}
function saveChatRule(rule) {
  getDb().prepare(`
    INSERT INTO chat_rules (id, streamer_id, name, match_text, match_type, window_seconds, min_matches, enabled, targets_json)
    VALUES (@id, @streamer_id, @name, @match_text, @match_type, @window_seconds, @min_matches, @enabled, @targets_json)
    ON CONFLICT(id) DO UPDATE SET
      streamer_id = excluded.streamer_id,
      name = excluded.name,
      match_text = excluded.match_text,
      match_type = excluded.match_type,
      window_seconds = excluded.window_seconds,
      min_matches = excluded.min_matches,
      enabled = excluded.enabled,
      targets_json = excluded.targets_json
  `).run({
    id: rule.id,
    streamer_id: rule.streamer_id,
    name: rule.name,
    match_text: rule.match_text,
    match_type: rule.match_type,
    window_seconds: rule.window_seconds,
    min_matches: rule.min_matches,
    enabled: rule.enabled ? 1 : 0,
    targets_json: JSON.stringify(rule.targets || [])
  });
}
function deleteChatRule(id) { getDb().prepare('DELETE FROM chat_rules WHERE id = ?').run(id); }

function parseLamp(row) {
  return { ...row, enabled: !!row.enabled, effects: JSON.parse(row.effects_json || '[]'), metadata: JSON.parse(row.metadata_json || '{}') };
}
function parseTargetsRule(row) {
  const fallbackRotation = getSetting('rotation_seconds', 20);
  const targets = JSON.parse(row.targets_json || '[]').map((target) => ({
    ...target,
    secondary_color: /^#[0-9a-f]{6}$/i.test(String(target?.secondary_color || '')) ? String(target.secondary_color) : '#ffffff',
    rotation_seconds: Math.max(5, Number(target?.rotation_seconds || fallbackRotation || 20)),
    segment_mode: target?.segment_mode === 'selected' ? 'selected' : 'all',
    segment_ids: [...new Set((Array.isArray(target?.segment_ids) ? target.segment_ids : []).map((value) => Math.max(0, Math.round(Number(value)))).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b),
    segment_colors: (Array.isArray(target?.segment_colors) ? target.segment_colors : []).map((entry, index) => ({
      segment_id: Math.max(0, Number.isFinite(Number(entry?.segment_id)) ? Math.round(Number(entry.segment_id)) : index),
      color: /^#[0-9a-f]{6}$/i.test(String(entry?.color || '')) ? String(entry.color) : (/^#[0-9a-f]{6}$/i.test(String(target?.color || '')) ? String(target.color) : '#9147ff')
    }))
  }));
  return { ...row, enabled: !!row.enabled, targets };
}

function log(level, source, message) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(`${level}:${source}:${message}`).digest('hex');
  const existing = getDb().prepare('SELECT id FROM logs WHERE hash = ?').get(hash);
  if (existing) {
    getDb().prepare(`UPDATE logs SET count = count + 1, last_seen = datetime('now') WHERE id = ?`).run(existing.id);
  } else {
    getDb().prepare(`INSERT INTO logs (level, source, message, hash) VALUES (?, ?, ?, ?)`).run(level, source, message, hash);
  }
  console.log(`[${new Date().toISOString()}] [${level}] [${source}] ${message}`);
}
function getRecentLogs(limit = 100) { return getDb().prepare('SELECT * FROM logs ORDER BY last_seen DESC LIMIT ?').all(limit); }
function clearLogs() { getDb().prepare('DELETE FROM logs').run(); }
function replaceAllConfig() {
  const conn = getDb();
  conn.exec(`
    DELETE FROM online_rules;
    DELETE FROM chat_rules;
    DELETE FROM streamers;
    DELETE FROM lamps;
    DELETE FROM settings;
  `);
  setDefaultSetting('port', 3847);
  setDefaultSetting('online_poll_seconds', 30);
  setDefaultSetting('rotation_seconds', 20);
  setDefaultSetting('healthcheck_seconds', 30);
}

module.exports = {
  getDb,
  getSetting,
  setSetting,
  getTwitchAuth,
  saveTwitchAuth,
  clearTwitchAuth,
  getAllLamps,
  getLamp,
  saveLamp,
  deleteLamp,
  updateLampEffects,
  updateLampSeen,
  getAllStreamers,
  getStreamer,
  saveStreamer,
  deleteStreamer,
  getAllOnlineRules,
  saveOnlineRule,
  deleteOnlineRule,
  getAllChatRules,
  getEnabledChatRules,
  saveChatRule,
  deleteChatRule,
  log,
  getRecentLogs,
  clearLogs,
  replaceAllConfig
};
