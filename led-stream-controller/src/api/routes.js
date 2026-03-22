const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function clampByte(value, fallback = 128) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(255, Math.round(num)));
}

function clampRotationSeconds(value, fallback = null) {
  const base = fallback == null ? db.getSetting('rotation_seconds', 20) : fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return Math.max(5, Number(base || 20));
  return Math.max(5, Math.min(600, Math.round(num)));
}

function normalizeAddress(value = '') {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/json.*$/, '').replace(/\/$/, '');
}

function sanitizeTargets(targets = []) {
  return (Array.isArray(targets) ? targets : []).filter((target) => target && target.lamp_id).map((target) => ({
    lamp_id: String(target.lamp_id),
    mode: target.mode === 'effect' ? 'effect' : 'static',
    color: /^#[0-9a-f]{6}$/i.test(String(target.color || '')) ? String(target.color) : '#9147ff',
    effect_name: target.effect_name == null ? '' : String(target.effect_name),
    effect_speed: clampByte(target.effect_speed),
    effect_intensity: clampByte(target.effect_intensity),
    rotation_seconds: clampRotationSeconds(target.rotation_seconds)
  }));
}

function validateLampPayload(payload, existingId = null) {
  const name = String(payload.name || '').trim();
  const type = payload.type === 'govee' ? 'govee' : payload.type === 'hue' ? 'hue' : 'wled';
  const api_key = String(payload.api_key || '').trim() || null;
  const metadata = payload && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata) ? payload.metadata : {};
  let address = normalizeAddress(payload.address);

  if (type === 'hue') {
    const bridgeIp = normalizeAddress(metadata.bridge_ip || payload.bridge_ip || address.split('/')[0]);
    const lightId = String(metadata.light_id || payload.light_id || address.split('/')[1] || '').trim();
    if (!bridgeIp) throw new Error('Bitte trage die Hue-Bridge-IP ein oder importiere ein Licht aus der Discovery.');
    if (!lightId) throw new Error('Bitte wähle ein konkretes Hue-Licht aus. Am einfachsten per Hue-Assistent im Lampen-Dialog.');
    if (!api_key) throw new Error('Für Hue fehlt noch der lokale Bridge-Username. Bitte zuerst im Assistenten koppeln.');
    address = `${bridgeIp}/${lightId}`;
  }

  if (!name) throw new Error('Bitte gib der Lampe einen Namen.');
  if (!address) throw new Error('Bitte trage IP, Hostname oder Geräteadresse ein.');
  if (type === 'wled' && !/^[a-z0-9.-]+$/i.test(address)) throw new Error('WLED-Adresse sieht unplausibel aus. Bitte nur Hostname oder IP eintragen.');
  if (type === 'govee' && !api_key && !/^(\d{1,3}\.){3}\d{1,3}$/.test(address)) throw new Error('Für Govee ohne API-Key bitte eine lokale IP-Adresse eintragen.');
  const duplicate = db.getAllLamps().find((lamp) => lamp.id !== existingId && lamp.address === address && lamp.type === type);
  if (duplicate) throw new Error(`Diese Lampe existiert schon: ${duplicate.name}`);
  return { name, type, address, api_key, enabled: payload.enabled !== false, metadata: { ...metadata, bridge_ip: type === 'hue' ? address.split('/')[0] : metadata.bridge_ip || null, light_id: type === 'hue' ? address.split('/')[1] : metadata.light_id || null } };
}

function validateStreamerPayload(payload, existingId = null) {
  const login = String(payload.login || '').trim().toLowerCase();
  if (!login) throw new Error('Bitte einen Twitch-Login eintragen.');
  if (!/^[a-z0-9_]{3,25}$/i.test(login)) throw new Error('Twitch-Login wirkt ungültig.');
  const duplicate = db.getAllStreamers().find((entry) => entry.id !== existingId && entry.login === login);
  if (duplicate) throw new Error(`Streamer ${login} ist schon angelegt.`);
  return { login, enabled: payload.enabled !== false };
}

function validateChatRulePayload(payload) {
  const name = String(payload.name || '').trim();
  const streamerId = String(payload.streamer_id || '').trim();
  const matchText = String(payload.match_text || '').trim();
  const matchType = payload.match_type === 'exact' ? 'exact' : 'contains';
  const windowSeconds = Number(payload.window_seconds);
  const minMatches = Number(payload.min_matches);
  const targets = sanitizeTargets(payload.targets);
  if (!name) throw new Error('Bitte gib der Regel einen Namen.');
  if (!streamerId) throw new Error('Bitte wähle einen Streamer aus.');
  if (!matchText) throw new Error('Bitte trage Text oder Emote für die Regel ein.');
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1 || windowSeconds > 300) throw new Error('Zeitfenster muss zwischen 1 und 300 Sekunden liegen.');
  if (!Number.isFinite(minMatches) || minMatches < 1 || minMatches > 1000) throw new Error('Mindestanzahl muss zwischen 1 und 1000 liegen.');
  if (targets.length === 0) throw new Error('Bitte aktiviere mindestens eine Lampe für diese Regel.');
  if (minMatches > windowSeconds * 10) throw new Error('Die Regel ist sehr streng. Prüfe bitte Mindestanzahl und Zeitfenster noch einmal.');
  return { name, streamer_id: streamerId, match_text: matchText, match_type: matchType, window_seconds: windowSeconds, min_matches: minMatches, enabled: payload.enabled !== false, targets };
}

function validateOnlineRulePayload(payload) {
  const streamerId = String(payload.streamer_id || '').trim();
  const targets = sanitizeTargets(payload.targets);
  if (!streamerId) throw new Error('Bitte wähle einen Streamer aus.');
  if (targets.length === 0) throw new Error('Bitte aktiviere mindestens eine Lampe für diese Online-Szene.');
  return { streamer_id: streamerId, enabled: payload.enabled !== false, targets };
}

function validateSettingsPayload(payload = {}) {
  const next = {
    online_poll_seconds: Number(payload.online_poll_seconds),
    rotation_seconds: Number(payload.rotation_seconds),
    healthcheck_seconds: Number(payload.healthcheck_seconds),
    public_base_url: payload.public_base_url == null ? undefined : String(payload.public_base_url || '').trim().replace(/\/$/, '')
  };
  if (!Number.isFinite(next.online_poll_seconds) || next.online_poll_seconds < 10 || next.online_poll_seconds > 600) throw new Error('Online Polling muss zwischen 10 und 600 Sekunden liegen.');
  if (!Number.isFinite(next.rotation_seconds) || next.rotation_seconds < 5 || next.rotation_seconds > 600) throw new Error('Standard-Rotation muss zwischen 5 und 600 Sekunden liegen.');
  if (!Number.isFinite(next.healthcheck_seconds) || next.healthcheck_seconds < 10 || next.healthcheck_seconds > 600) throw new Error('Healthcheck muss zwischen 10 und 600 Sekunden liegen.');
  if (next.public_base_url !== undefined && next.public_base_url !== '' && !/^https?:\/\//i.test(next.public_base_url)) throw new Error('Öffentliche Basis-URL muss mit http:// oder https:// beginnen.');
  return next;
}

function snapshotConfig() {
  return {
    version: 6,
    exported_at: new Date().toISOString(),
    settings: {
      online_poll_seconds: db.getSetting('online_poll_seconds', 30),
      rotation_seconds: db.getSetting('rotation_seconds', 20),
      healthcheck_seconds: db.getSetting('healthcheck_seconds', 30)
    },
    twitch_app: (() => { const auth = db.getTwitchAuth() || {}; return { client_id: auth.client_id || '', client_secret: auth.client_secret || '' }; })(),
    lamps: db.getAllLamps().map((lamp) => ({ name: lamp.name, type: lamp.type, address: lamp.address, api_key: lamp.api_key || '', enabled: lamp.enabled, effects: lamp.effects || [], metadata: lamp.metadata || {} })),
    streamers: db.getAllStreamers().map((streamer) => ({ login: streamer.login, enabled: !!streamer.enabled })),
    onlineRules: db.getAllOnlineRules().map((rule) => ({ streamer_login: rule.streamer_login, enabled: rule.enabled, targets: rule.targets })),
    chatRules: db.getAllChatRules().map((rule) => ({ name: rule.name, streamer_login: rule.streamer_login, match_text: rule.match_text, match_type: rule.match_type, window_seconds: rule.window_seconds, min_matches: rule.min_matches, enabled: rule.enabled, targets: rule.targets }))
  };
}

function analyzeImportPayload(payload) {
  const warnings = [];
  const errors = [];
  const safe = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const summary = { lamps: Array.isArray(safe.lamps) ? safe.lamps.length : 0, streamers: Array.isArray(safe.streamers) ? safe.streamers.length : 0, onlineRules: Array.isArray(safe.onlineRules) ? safe.onlineRules.length : 0, chatRules: Array.isArray(safe.chatRules) ? safe.chatRules.length : 0, hasTwitchApp: !!(safe.twitch_app?.client_id || safe.twitch_app?.client_secret), version: safe.version || null };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('Die Datei enthält kein gültiges JSON-Objekt.');
    return { ok: false, errors, warnings, summary };
  }
  for (const lamp of Array.isArray(payload.lamps) ? payload.lamps : []) {
    try { validateLampPayload(lamp); } catch (error) { errors.push(error.message); }
  }
  for (const streamer of Array.isArray(payload.streamers) ? payload.streamers : []) {
    try { validateStreamerPayload(streamer); } catch (error) { errors.push(error.message); }
  }
  for (const rule of Array.isArray(payload.onlineRules) ? payload.onlineRules : []) {
    if (!String(rule.streamer_login || '').trim()) errors.push('Eine Online-Szene hat keinen streamer_login.');
    if (!Array.isArray(rule.targets) || rule.targets.length === 0) warnings.push(`Online-Szene für ${String(rule.streamer_login || 'unbekannt')} hat keine Ziel-Lampen.`);
    for (const target of Array.isArray(rule.targets) ? rule.targets : []) {
      const rotation = Number(target?.rotation_seconds);
      if (target && target.lamp_id && Number.isFinite(rotation) && (rotation < 5 || rotation > 600)) warnings.push(`Online-Szene für ${String(rule.streamer_login || 'unbekannt')} hat eine Lampen-Rotation außerhalb 5-600s und wird beim Import gekappt.`);
    }
  }
  for (const rule of Array.isArray(payload.chatRules) ? payload.chatRules : []) {
    if (!String(rule.name || '').trim()) warnings.push('Eine Chat-Regel hat keinen Namen und wird mit Fallback-Namen importiert.');
    if (!String(rule.streamer_login || '').trim()) errors.push(`Chat-Regel ${String(rule.name || 'ohne Namen')} hat keinen streamer_login.`);
    if (!String(rule.match_text || '').trim()) errors.push(`Chat-Regel ${String(rule.name || 'ohne Namen')} hat keinen Match-Text.`);
  }
  if (summary.lamps === 0 && summary.streamers === 0 && summary.onlineRules === 0 && summary.chatRules === 0) warnings.push('Die Datei enthält keine Lampen, Streamer oder Regeln.');
  if (!summary.version || summary.version < 6) warnings.push('Ältere Config erkannt. Online-Rotationen pro Lampe werden mit der Standard-Rotation aus den Einstellungen ergänzt.');
  return { ok: errors.length === 0, errors, warnings, summary };
}

function applyImportPayload(payload, mode = 'replace') {
  const streamerMap = new Map();
  const lampMap = new Map();
  const result = { mode, created: { lamps: 0, streamers: 0, onlineRules: 0, chatRules: 0 }, updated: { lamps: 0, streamers: 0, onlineRules: 0, chatRules: 0 }, skipped: [], backup: mode === 'replace' ? snapshotConfig() : null };
  if (mode === 'replace') db.replaceAllConfig();
  if (payload.twitch_app?.client_id || payload.twitch_app?.client_secret) db.saveTwitchAuth({ ...(db.getTwitchAuth() || {}), client_id: String(payload.twitch_app?.client_id || '').trim(), client_secret: String(payload.twitch_app?.client_secret || '').trim() });
  for (const [key, fallback] of [['online_poll_seconds', 30], ['rotation_seconds', 20], ['healthcheck_seconds', 30]]) {
    if (payload.settings?.[key] != null) db.setSetting(key, Number(payload.settings[key]));
    else if (mode === 'replace') db.setSetting(key, fallback);
  }
  const currentLamps = db.getAllLamps();
  for (const lamp of Array.isArray(payload.lamps) ? payload.lamps : []) {
    try {
      const valid = validateLampPayload(lamp);
      const existing = mode === 'merge' ? currentLamps.find((entry) => entry.address === valid.address || entry.name === valid.name) : null;
      db.saveLamp({ id: existing?.id || uuidv4(), ...valid, effects: Array.isArray(lamp.effects) ? lamp.effects : [], last_seen: existing?.last_seen || null });
      lampMap.set(`${valid.name}|${valid.address}`, existing?.id || db.getAllLamps().find((entry) => entry.address === valid.address)?.id);
      if (existing) result.updated.lamps += 1; else result.created.lamps += 1;
    } catch (error) { result.skipped.push(`Lampe ${String(lamp.name || 'ohne Namen')} übersprungen: ${error.message}`); }
  }
  for (const streamer of Array.isArray(payload.streamers) ? payload.streamers : []) {
    try {
      const valid = validateStreamerPayload(streamer);
      const existing = mode === 'merge' ? db.getAllStreamers().find((entry) => entry.login === valid.login) : null;
      const saved = db.saveStreamer({ id: existing?.id || uuidv4(), ...valid });
      streamerMap.set(saved.login, saved.id);
      if (existing) result.updated.streamers += 1; else result.created.streamers += 1;
    } catch (error) { result.skipped.push(`Streamer ${String(streamer.login || 'ohne Login')} übersprungen: ${error.message}`); }
  }
  const resolveTarget = (target) => {
    const lampId = target.lamp_id || lampMap.get(`${target.lamp_name || ''}|${target.lamp_address || ''}`) || null;
    if (!lampId || !db.getLamp(lampId)) return null;
    return { lamp_id: lampId, mode: target.mode === 'effect' ? 'effect' : 'static', color: String(target.color || '#9147ff'), effect_name: target.effect_name == null ? '' : String(target.effect_name), effect_speed: clampByte(target.effect_speed), effect_intensity: clampByte(target.effect_intensity), rotation_seconds: clampRotationSeconds(target.rotation_seconds) };
  };
  for (const rule of Array.isArray(payload.onlineRules) ? payload.onlineRules : []) {
    const streamer_id = streamerMap.get(String(rule.streamer_login || '').trim().toLowerCase()) || db.getAllStreamers().find((entry) => entry.login === String(rule.streamer_login || '').trim().toLowerCase())?.id;
    const targets = (Array.isArray(rule.targets) ? rule.targets : []).map(resolveTarget).filter(Boolean);
    if (!streamer_id || targets.length === 0) { result.skipped.push(`Online-Szene für ${String(rule.streamer_login || 'unbekannt')} übersprungen.`); continue; }
    db.saveOnlineRule({ id: uuidv4(), streamer_id, enabled: rule.enabled !== false, targets });
    result.created.onlineRules += 1;
  }
  for (const rule of Array.isArray(payload.chatRules) ? payload.chatRules : []) {
    const streamer_id = streamerMap.get(String(rule.streamer_login || '').trim().toLowerCase()) || db.getAllStreamers().find((entry) => entry.login === String(rule.streamer_login || '').trim().toLowerCase())?.id;
    const targets = (Array.isArray(rule.targets) ? rule.targets : []).map(resolveTarget).filter(Boolean);
    if (!streamer_id || targets.length === 0) { result.skipped.push(`Chat-Regel ${String(rule.name || 'ohne Namen')} übersprungen.`); continue; }
    db.saveChatRule({ id: uuidv4(), name: String(rule.name || '').trim() || 'Importierte Regel', streamer_id, match_text: String(rule.match_text || '').trim(), match_type: rule.match_type === 'exact' ? 'exact' : 'contains', window_seconds: Number(rule.window_seconds || 10), min_matches: Number(rule.min_matches || 5), enabled: rule.enabled !== false, targets });
    result.created.chatRules += 1;
  }
  return result;
}

function createRuleTestReport({ twitch, effectManager, onlineRuleId, chatRuleId, message, streamer_login }) {
  const onlineRule = onlineRuleId ? db.getAllOnlineRules().find((rule) => rule.id === onlineRuleId) : null;
  const chatRule = chatRuleId ? db.getAllChatRules().find((rule) => rule.id === chatRuleId) : null;
  if (!onlineRule && !chatRule) throw new Error('Bitte mindestens eine Online-Szene oder Chat-Regel zum Testen wählen.');
  if (chatRule) {
    const simulatedLogin = String(streamer_login || chatRule.streamer_login).trim().toLowerCase();
    const simulatedMessage = String(message || chatRule.match_text).trim();
    twitch.handleChatMessage(simulatedLogin, simulatedMessage);
  }
  const onlineState = onlineRule ? { activeRules: [onlineRule], rotationStartedAt: Date.now() } : { activeRules: [], rotationStartedAt: Date.now() };
  return effectManager.applyResolvedState({ onlineState, chatRule: chatRule && twitch.isChatRuleActive(chatRule) ? chatRule : null, dryRun: true });
}

function createApiRouter(effectManager, twitch) {
  const router = express.Router();

  router.get('/meta/support', (_req, res) => res.json({ lampTypes: [
    { id: 'wled', name: 'WLED', status: 'supported', helper: 'Am einfachsten per IP/Hostname. Effektliste kann direkt aus WLED geladen werden.' },
    { id: 'govee', name: 'Govee', status: 'supported', helper: 'LAN-Modelle lokal per IP, alternativ mit API-Key. Effektliste ist oft eine Preset-Liste.' },
    { id: 'hue', name: 'Philips Hue', status: 'supported-local', helper: 'V1.4 kann jetzt Hue Bridges lokal koppeln, Lichter importieren und Farbe/Ein-Aus direkt steuern.' }
  ] }));

  router.get('/setup/status', (req, res) => {
    const auth = db.getTwitchAuth();
    const redirect = twitch.getRedirectOptions(req);
    res.json({
      needsSetup: !auth?.access_token,
      hasClientConfig: !!(auth?.client_id && auth?.client_secret),
      redirectUri: redirect.redirectUri,
      redirectOptions: redirect,
      login: auth?.login || null,
      savedClientId: auth?.client_id || '',
      checklist: ['In Twitch eine App anlegen', 'Als Redirect URI entweder localhost oder deine HTTPS-Domain eintragen', 'Client ID und Client Secret hier speichern', 'Per Button mit Twitch verbinden', 'Danach Lampen, Streamer und Regeln anlegen']
    });
  });

  router.post('/setup/twitch-app', express.json(), (req, res) => { const current = db.getTwitchAuth() || {}; db.saveTwitchAuth({ ...current, client_id: String(req.body.client_id || '').trim(), client_secret: String(req.body.client_secret || '').trim() }); res.json({ success: true }); });
  router.get('/auth/twitch/start', (req, res) => {
    try { res.json(twitch.getAuthStart(req)); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/auth/logout', (_req, res) => { db.clearTwitchAuth(); res.json({ success: true }); });

  router.get('/discover/lamps', async (req, res) => {
    const result = await effectManager.discoverLamps({ wled: { address: req.query.address, start: req.query.start, end: req.query.end } });
    res.json({ success: true, result });
  });
  router.post('/discover/hue/pair', express.json(), async (req, res) => {
    try {
      const address = normalizeAddress(req.body.address || req.body.bridge_ip);
      const result = await effectManager.hue.pairBridge(address);
      res.json({ success: true, result: { bridge_ip: address, ...result } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.get('/discover/hue/lights', async (req, res) => {
    try {
      const bridge_ip = normalizeAddress(req.query.bridge_ip);
      const username = String(req.query.username || '').trim();
      const lights = await effectManager.hue.listLights(bridge_ip, username);
      res.json({ success: true, bridge_ip, username, lights });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get('/lamps', (_req, res) => res.json(db.getAllLamps()));
  router.post('/lamps', express.json(), async (req, res) => {
    try {
      const lamp = db.saveLamp({ ...validateLampPayload(req.body), id: uuidv4() });
      try { await effectManager.refreshLampEffects(lamp.id); } catch {}
      res.json({ success: true, lamp: db.getLamp(lamp.id) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.put('/lamps/:id', express.json(), async (req, res) => {
    try {
      const current = db.getLamp(req.params.id) || {};
      db.saveLamp({ ...current, ...validateLampPayload(req.body, req.params.id), id: req.params.id, effects: current.effects || [], last_seen: current.last_seen || null });
      try { await effectManager.refreshLampEffects(req.params.id); } catch {}
      res.json({ success: true, lamp: db.getLamp(req.params.id) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.delete('/lamps/:id', (req, res) => { db.deleteLamp(req.params.id); res.json({ success: true }); });
  router.post('/lamps/:id/refresh-effects', async (req, res) => { const result = await effectManager.refreshLampEffects(req.params.id); res.json({ success: !!result, result, lamp: db.getLamp(req.params.id) }); });
  router.post('/lamps/:id/diagnose', async (req, res) => { try { const result = await effectManager.diagnoseLamp(req.params.id); res.json({ success: true, result, lamp: db.getLamp(req.params.id) }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.post('/lamps/:id/test', express.json(), async (req, res) => { const { action, color, effect_name, effect_speed, effect_intensity } = req.body; const ok = action === 'off' ? await effectManager.setLampOff(req.params.id) : action === 'effect' ? await effectManager.setLampEffect(req.params.id, effect_name, { speed: effect_speed, intensity: effect_intensity }) : await effectManager.setLampColor(req.params.id, color || '#ffffff'); res.json({ success: ok }); });

  router.get('/streamers', (_req, res) => res.json(db.getAllStreamers()));
  router.post('/streamers', express.json(), async (req, res) => { try { const streamer = db.saveStreamer({ id: uuidv4(), ...validateStreamerPayload(req.body) }); await twitch.refreshChannels(); res.json({ success: true, streamer }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.put('/streamers/:id', express.json(), async (req, res) => { try { const streamer = db.saveStreamer({ id: req.params.id, ...validateStreamerPayload(req.body, req.params.id) }); await twitch.refreshChannels(); res.json({ success: true, streamer }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.delete('/streamers/:id', async (req, res) => { db.deleteStreamer(req.params.id); await twitch.refreshChannels(); res.json({ success: true }); });

  router.get('/online-rules', (_req, res) => res.json(db.getAllOnlineRules()));
  router.post('/online-rules', express.json(), async (req, res) => { try { db.saveOnlineRule({ ...validateOnlineRulePayload(req.body), id: uuidv4() }); await twitch.refreshChannels(); res.json({ success: true }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.put('/online-rules/:id', express.json(), async (req, res) => { try { db.saveOnlineRule({ ...validateOnlineRulePayload(req.body), id: req.params.id }); await twitch.refreshChannels(); res.json({ success: true }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.delete('/online-rules/:id', (req, res) => { db.deleteOnlineRule(req.params.id); res.json({ success: true }); });

  router.get('/chat-rules', (_req, res) => res.json(db.getAllChatRules()));
  router.post('/chat-rules', express.json(), async (req, res) => { try { db.saveChatRule({ ...validateChatRulePayload(req.body), id: uuidv4() }); await twitch.refreshChannels(); res.json({ success: true }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.put('/chat-rules/:id', express.json(), async (req, res) => { try { db.saveChatRule({ ...validateChatRulePayload(req.body), id: req.params.id }); await twitch.refreshChannels(); res.json({ success: true }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.delete('/chat-rules/:id', (req, res) => { db.deleteChatRule(req.params.id); res.json({ success: true }); });

  router.post('/rule-test', express.json(), async (req, res) => {
    try { const result = await createRuleTestReport({ twitch, effectManager, onlineRuleId: req.body.online_rule_id, chatRuleId: req.body.chat_rule_id, message: req.body.message, streamer_login: req.body.streamer_login }); res.json({ success: true, result }); } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get('/settings', (req, res) => res.json({ port: db.getSetting('port', 3847), online_poll_seconds: db.getSetting('online_poll_seconds', 30), rotation_seconds: db.getSetting('rotation_seconds', 20), healthcheck_seconds: db.getSetting('healthcheck_seconds', 30), public_base_url: db.getSetting('public_base_url', ''), redirect_uri: twitch.getRedirectUri(req), redirect_options: twitch.getRedirectOptions(req) }));
  router.put('/settings', express.json(), (req, res) => {
    try {
      const valid = validateSettingsPayload(req.body);
      for (const [key, value] of Object.entries(valid)) {
        if (value !== undefined) db.setSetting(key, value);
      }
      effectManager.startHealthChecks();
      res.json({ success: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get('/status', (_req, res) => {
    const twitchStatus = twitch.getStatus();
    const lampDiagnostics = effectManager.getDiagnostics();
    const runtimeConflicts = lampDiagnostics.lastApplySummary?.conflicts || [];
    res.json({
      twitch: twitchStatus,
      lamps: effectManager.getLampSummary(),
      diagnostics: {
        twitch: twitchStatus.diagnostics,
        lamps: lampDiagnostics,
        recentErrors: db.getRecentLogs(12).filter((entry) => entry.level === 'ERROR' || entry.level === 'WARN').slice(0, 6)
      },
      counts: { lamps: db.getAllLamps().length, streamers: db.getAllStreamers().length, onlineRules: db.getAllOnlineRules().length, chatRules: db.getAllChatRules().length },
      ruleReadiness: {
        onlineRulesReady: db.getAllOnlineRules().filter((rule) => rule.enabled && rule.targets.length > 0).length,
        chatRulesReady: db.getAllChatRules().filter((rule) => rule.enabled && rule.targets.length > 0).length
      },
      priority: {
        summary: runtimeConflicts.length ? 'Chat-Regeln haben Vorrang vor Online-Zuständen, wenn beide dieselbe Lampe belegen.' : 'Aktuell keine Regel-Konflikte erkannt.',
        conflicts: runtimeConflicts
      }
    });
  });

  router.post('/diagnostics/healthcheck', async (_req, res) => { await effectManager.healthCheck(); res.json({ success: true, diagnostics: effectManager.getDiagnostics() }); });
  router.get('/config/export', (_req, res) => res.json(snapshotConfig()));
  router.post('/config/validate', express.json({ limit: '2mb' }), (req, res) => { const report = analyzeImportPayload(req.body || {}); res.status(report.ok ? 200 : 400).json(report); });
  router.post('/config/import', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const payload = req.body?.config || req.body || {};
      const mode = req.body?.mode === 'merge' ? 'merge' : 'replace';
      const report = analyzeImportPayload(payload);
      if (!report.ok) return res.status(400).json({ error: `Import abgebrochen: ${report.errors.join(' ')}`, report });
      const result = applyImportPayload(payload, mode);
      effectManager.startHealthChecks(); await twitch.refreshChannels(); res.json({ success: true, result, report });
    } catch (error) { res.status(400).json({ error: `Import fehlgeschlagen: ${error.message}` }); }
  });
  router.get('/logs', (req, res) => res.json(db.getRecentLogs(Number(req.query.limit || 100))));
  router.delete('/logs', (_req, res) => { db.clearLogs(); res.json({ success: true }); });
  return router;
}

module.exports = createApiRouter;
