const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function clampByte(value, fallback = 128) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(255, Math.round(num)));
}

function sanitizeTargets(targets = []) {
  return (Array.isArray(targets) ? targets : []).filter((target) => target && target.lamp_id).map((target) => ({
    lamp_id: String(target.lamp_id),
    mode: target.mode === 'effect' ? 'effect' : 'static',
    color: String(target.color || '#9147ff'),
    effect_name: target.effect_name == null ? '' : String(target.effect_name),
    effect_speed: clampByte(target.effect_speed),
    effect_intensity: clampByte(target.effect_intensity)
  }));
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

  return {
    name,
    streamer_id: streamerId,
    match_text: matchText,
    match_type: matchType,
    window_seconds: windowSeconds,
    min_matches: minMatches,
    enabled: payload.enabled !== false,
    targets
  };
}

function validateOnlineRulePayload(payload) {
  const streamerId = String(payload.streamer_id || '').trim();
  const targets = sanitizeTargets(payload.targets);
  if (!streamerId) throw new Error('Bitte wähle einen Streamer aus.');
  if (targets.length === 0) throw new Error('Bitte aktiviere mindestens eine Lampe für diese Online-Szene.');
  return {
    streamer_id: streamerId,
    enabled: payload.enabled !== false,
    targets
  };
}

function snapshotConfig() {
  return {
    version: 3,
    exported_at: new Date().toISOString(),
    settings: {
      online_poll_seconds: db.getSetting('online_poll_seconds', 30),
      rotation_seconds: db.getSetting('rotation_seconds', 20),
      healthcheck_seconds: db.getSetting('healthcheck_seconds', 30)
    },
    twitch_app: (() => {
      const auth = db.getTwitchAuth() || {};
      return {
        client_id: auth.client_id || '',
        client_secret: auth.client_secret || ''
      };
    })(),
    lamps: db.getAllLamps().map((lamp) => ({
      name: lamp.name,
      type: lamp.type,
      address: lamp.address,
      api_key: lamp.api_key || '',
      enabled: lamp.enabled,
      effects: lamp.effects || []
    })),
    streamers: db.getAllStreamers().map((streamer) => ({
      login: streamer.login,
      enabled: !!streamer.enabled
    })),
    onlineRules: db.getAllOnlineRules().map((rule) => ({
      streamer_login: rule.streamer_login,
      enabled: rule.enabled,
      targets: rule.targets
    })),
    chatRules: db.getAllChatRules().map((rule) => ({
      name: rule.name,
      streamer_login: rule.streamer_login,
      match_text: rule.match_text,
      match_type: rule.match_type,
      window_seconds: rule.window_seconds,
      min_matches: rule.min_matches,
      enabled: rule.enabled,
      targets: rule.targets
    }))
  };
}

function analyzeImportPayload(payload) {
  const warnings = [];
  const errors = [];
  const summary = {
    lamps: Array.isArray(payload.lamps) ? payload.lamps.length : 0,
    streamers: Array.isArray(payload.streamers) ? payload.streamers.length : 0,
    onlineRules: Array.isArray(payload.onlineRules) ? payload.onlineRules.length : 0,
    chatRules: Array.isArray(payload.chatRules) ? payload.chatRules.length : 0,
    hasTwitchApp: !!(payload.twitch_app?.client_id || payload.twitch_app?.client_secret)
  };

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('Die Datei enthält kein gültiges JSON-Objekt.');
    return { ok: false, errors, warnings, summary };
  }

  const seenStreamers = new Set();
  for (const streamer of Array.isArray(payload.streamers) ? payload.streamers : []) {
    const login = String(streamer.login || '').trim().toLowerCase();
    if (!login) errors.push('Mindestens ein Streamer hat keinen Login.');
    if (login && seenStreamers.has(login)) warnings.push(`Streamer ${login} ist mehrfach in der Importdatei enthalten.`);
    if (login) seenStreamers.add(login);
  }

  for (const lamp of Array.isArray(payload.lamps) ? payload.lamps : []) {
    if (!String(lamp.name || '').trim()) errors.push('Mindestens eine Lampe hat keinen Namen.');
    if (!String(lamp.address || '').trim()) errors.push(`Lampe ${String(lamp.name || 'ohne Namen')} hat keine Adresse/IP.`);
  }

  for (const rule of Array.isArray(payload.onlineRules) ? payload.onlineRules : []) {
    if (!String(rule.streamer_login || '').trim()) errors.push('Eine Online-Szene hat keinen streamer_login.');
    if (!Array.isArray(rule.targets) || rule.targets.length === 0) warnings.push(`Online-Szene für ${String(rule.streamer_login || 'unbekannt')} hat keine Ziel-Lampen.`);
  }

  for (const rule of Array.isArray(payload.chatRules) ? payload.chatRules : []) {
    if (!String(rule.name || '').trim()) warnings.push('Eine Chat-Regel hat keinen Namen und wird mit Fallback-Namen importiert.');
    if (!String(rule.streamer_login || '').trim()) errors.push(`Chat-Regel ${String(rule.name || 'ohne Namen')} hat keinen streamer_login.`);
    if (!String(rule.match_text || '').trim()) errors.push(`Chat-Regel ${String(rule.name || 'ohne Namen')} hat keinen Match-Text.`);
  }

  if (summary.lamps === 0 && summary.streamers === 0 && summary.onlineRules === 0 && summary.chatRules === 0) {
    warnings.push('Die Datei enthält keine Lampen, Streamer oder Regeln.');
  }

  return { ok: errors.length === 0, errors, warnings, summary };
}

function applyImportPayload(payload, mode = 'replace') {
  const streamerMap = new Map();
  const lampMap = new Map();
  const result = {
    mode,
    created: { lamps: 0, streamers: 0, onlineRules: 0, chatRules: 0 },
    updated: { lamps: 0, streamers: 0, onlineRules: 0, chatRules: 0 },
    skipped: [],
    backup: mode === 'replace' ? snapshotConfig() : null
  };

  if (mode === 'replace') db.replaceAllConfig();

  if (payload.twitch_app?.client_id || payload.twitch_app?.client_secret) {
    db.saveTwitchAuth({
      ...(db.getTwitchAuth() || {}),
      client_id: String(payload.twitch_app?.client_id || '').trim(),
      client_secret: String(payload.twitch_app?.client_secret || '').trim()
    });
  }

  for (const [key, fallback] of [['online_poll_seconds', 30], ['rotation_seconds', 20], ['healthcheck_seconds', 30]]) {
    if (payload.settings?.[key] != null) db.setSetting(key, Number(payload.settings[key]));
    else if (mode === 'replace') db.setSetting(key, fallback);
  }

  const currentLamps = db.getAllLamps();
  for (const lamp of Array.isArray(payload.lamps) ? payload.lamps : []) {
    const name = String(lamp.name || '').trim() || 'Lampe';
    const address = String(lamp.address || '').trim();
    if (!address) {
      result.skipped.push(`Lampe ${name} übersprungen: Adresse fehlt.`);
      continue;
    }
    const existing = mode === 'merge'
      ? currentLamps.find((entry) => entry.address === address || entry.name === name)
      : null;
    db.saveLamp({
      id: existing?.id || uuidv4(),
      name,
      type: lamp.type === 'govee' ? 'govee' : 'wled',
      address,
      api_key: String(lamp.api_key || '').trim() || null,
      enabled: lamp.enabled !== false,
      effects: Array.isArray(lamp.effects) ? lamp.effects : [],
      last_seen: existing?.last_seen || null
    });
    lampMap.set(`${name}|${address}`, existing?.id || db.getAllLamps().find((entry) => entry.address === address)?.id);
    if (existing) result.updated.lamps += 1;
    else result.created.lamps += 1;
  }

  for (const streamer of Array.isArray(payload.streamers) ? payload.streamers : []) {
    const login = String(streamer.login || '').trim().toLowerCase();
    if (!login) {
      result.skipped.push('Streamer ohne Login übersprungen.');
      continue;
    }
    const existing = mode === 'merge' ? db.getAllStreamers().find((entry) => entry.login === login) : null;
    const saved = db.saveStreamer({ id: existing?.id || uuidv4(), login, enabled: streamer.enabled !== false });
    streamerMap.set(saved.login, saved.id);
    if (existing) result.updated.streamers += 1;
    else result.created.streamers += 1;
  }

  const resolveTarget = (target) => {
    const lampId = target.lamp_id || lampMap.get(`${target.lamp_name || ''}|${target.lamp_address || ''}`) || null;
    if (!lampId || !db.getLamp(lampId)) return null;
    return {
      lamp_id: lampId,
      mode: target.mode === 'effect' ? 'effect' : 'static',
      color: String(target.color || '#9147ff'),
      effect_name: target.effect_name == null ? '' : String(target.effect_name),
      effect_speed: clampByte(target.effect_speed),
      effect_intensity: clampByte(target.effect_intensity)
    };
  };

  if (mode === 'merge') {
    for (const rule of Array.isArray(payload.onlineRules) ? payload.onlineRules : []) {
      const streamer_id = streamerMap.get(String(rule.streamer_login || '').trim().toLowerCase()) || db.getAllStreamers().find((entry) => entry.login === String(rule.streamer_login || '').trim().toLowerCase())?.id;
      const targets = (Array.isArray(rule.targets) ? rule.targets : []).map(resolveTarget).filter(Boolean);
      if (!streamer_id || targets.length === 0) {
        result.skipped.push(`Online-Szene für ${String(rule.streamer_login || 'unbekannt')} übersprungen.`);
        continue;
      }
      db.saveOnlineRule({ id: uuidv4(), streamer_id, enabled: rule.enabled !== false, targets });
      result.created.onlineRules += 1;
    }

    for (const rule of Array.isArray(payload.chatRules) ? payload.chatRules : []) {
      const streamer_id = streamerMap.get(String(rule.streamer_login || '').trim().toLowerCase()) || db.getAllStreamers().find((entry) => entry.login === String(rule.streamer_login || '').trim().toLowerCase())?.id;
      const targets = (Array.isArray(rule.targets) ? rule.targets : []).map(resolveTarget).filter(Boolean);
      if (!streamer_id || targets.length === 0) {
        result.skipped.push(`Chat-Regel ${String(rule.name || 'ohne Namen')} übersprungen.`);
        continue;
      }
      db.saveChatRule({
        id: uuidv4(),
        name: String(rule.name || '').trim() || 'Importierte Regel',
        streamer_id,
        match_text: String(rule.match_text || '').trim(),
        match_type: rule.match_type === 'exact' ? 'exact' : 'contains',
        window_seconds: Number(rule.window_seconds || 10),
        min_matches: Number(rule.min_matches || 5),
        enabled: rule.enabled !== false,
        targets
      });
      result.created.chatRules += 1;
    }
  } else {
    for (const rule of Array.isArray(payload.onlineRules) ? payload.onlineRules : []) {
      const streamer_id = streamerMap.get(String(rule.streamer_login || '').trim().toLowerCase());
      const targets = (Array.isArray(rule.targets) ? rule.targets : []).map(resolveTarget).filter(Boolean);
      if (!streamer_id || targets.length === 0) {
        result.skipped.push(`Online-Szene für ${String(rule.streamer_login || 'unbekannt')} übersprungen.`);
        continue;
      }
      db.saveOnlineRule({ id: uuidv4(), streamer_id, enabled: rule.enabled !== false, targets });
      result.created.onlineRules += 1;
    }

    for (const rule of Array.isArray(payload.chatRules) ? payload.chatRules : []) {
      const streamer_id = streamerMap.get(String(rule.streamer_login || '').trim().toLowerCase());
      const targets = (Array.isArray(rule.targets) ? rule.targets : []).map(resolveTarget).filter(Boolean);
      if (!streamer_id || targets.length === 0) {
        result.skipped.push(`Chat-Regel ${String(rule.name || 'ohne Namen')} übersprungen.`);
        continue;
      }
      db.saveChatRule({
        id: uuidv4(),
        name: String(rule.name || '').trim() || 'Importierte Regel',
        streamer_id,
        match_text: String(rule.match_text || '').trim(),
        match_type: rule.match_type === 'exact' ? 'exact' : 'contains',
        window_seconds: Number(rule.window_seconds || 10),
        min_matches: Number(rule.min_matches || 5),
        enabled: rule.enabled !== false,
        targets
      });
      result.created.chatRules += 1;
    }
  }

  return result;
}

function createApiRouter(effectManager, twitch) {
  const router = express.Router();

  router.get('/meta/support', (_req, res) => {
    res.json({
      lampTypes: [
        { id: 'wled', name: 'WLED', status: 'supported', helper: 'Am einfachsten per IP/Hostname. Effektliste kann direkt aus WLED geladen werden.' },
        { id: 'govee', name: 'Govee', status: 'supported', helper: 'LAN-Modelle lokal per IP, alternativ mit API-Key. Effektliste ist oft eine Preset-Liste.' },
        { id: 'hue', name: 'Philips Hue', status: 'planned', helper: 'Für V1.2 vorbereitet im UI, aber absichtlich noch nicht aktiv geschaltet.' }
      ]
    });
  });

  router.get('/setup/status', (_req, res) => {
    const auth = db.getTwitchAuth();
    res.json({
      needsSetup: !auth?.access_token,
      hasClientConfig: !!(auth?.client_id && auth?.client_secret),
      redirectUri: twitch.getRedirectUri(),
      login: auth?.login || null,
      checklist: [
        'Twitch App mit Redirect URI anlegen',
        'Client ID und Client Secret eintragen',
        'Per Button mit Twitch verbinden',
        'Danach Lampen, Streamer und Regeln anlegen'
      ]
    });
  });

  router.post('/setup/twitch-app', express.json(), (req, res) => {
    const current = db.getTwitchAuth() || {};
    db.saveTwitchAuth({
      ...current,
      client_id: String(req.body.client_id || '').trim(),
      client_secret: String(req.body.client_secret || '').trim()
    });
    res.json({ success: true });
  });

  router.get('/auth/twitch/start', (req, res) => {
    try {
      res.json({ url: twitch.getAuthUrl(), redirectUri: twitch.getRedirectUri() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/auth/logout', (_req, res) => {
    db.clearTwitchAuth();
    res.json({ success: true });
  });

  router.get('/lamps', (_req, res) => res.json(db.getAllLamps()));
  router.post('/lamps', express.json(), async (req, res) => {
    const lamp = db.saveLamp({ ...req.body, id: uuidv4() });
    try { await effectManager.refreshLampEffects(lamp.id); } catch {}
    res.json({ success: true, lamp: db.getLamp(lamp.id) });
  });
  router.put('/lamps/:id', express.json(), async (req, res) => {
    db.saveLamp({ ...req.body, id: req.params.id });
    try { await effectManager.refreshLampEffects(req.params.id); } catch {}
    res.json({ success: true, lamp: db.getLamp(req.params.id) });
  });
  router.delete('/lamps/:id', (req, res) => { db.deleteLamp(req.params.id); res.json({ success: true }); });
  router.post('/lamps/:id/refresh-effects', async (req, res) => {
    const result = await effectManager.refreshLampEffects(req.params.id);
    res.json({ success: !!result, result, lamp: db.getLamp(req.params.id) });
  });
  router.post('/lamps/:id/diagnose', async (req, res) => {
    try {
      const result = await effectManager.diagnoseLamp(req.params.id);
      res.json({ success: true, result, lamp: db.getLamp(req.params.id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  router.post('/lamps/:id/test', express.json(), async (req, res) => {
    const { action, color, effect_name, effect_speed, effect_intensity } = req.body;
    const ok = action === 'off'
      ? await effectManager.setLampOff(req.params.id)
      : action === 'effect'
        ? await effectManager.setLampEffect(req.params.id, effect_name, { speed: effect_speed, intensity: effect_intensity })
        : await effectManager.setLampColor(req.params.id, color || '#ffffff');
    res.json({ success: ok });
  });

  router.get('/streamers', (_req, res) => res.json(db.getAllStreamers()));
  router.post('/streamers', express.json(), async (req, res) => {
    const streamer = db.saveStreamer({ id: uuidv4(), login: req.body.login, enabled: req.body.enabled !== false });
    await twitch.refreshChannels();
    res.json({ success: true, streamer });
  });
  router.put('/streamers/:id', express.json(), async (req, res) => {
    const streamer = db.saveStreamer({ id: req.params.id, login: req.body.login, enabled: req.body.enabled !== false });
    await twitch.refreshChannels();
    res.json({ success: true, streamer });
  });
  router.delete('/streamers/:id', async (req, res) => { db.deleteStreamer(req.params.id); await twitch.refreshChannels(); res.json({ success: true }); });

  router.get('/online-rules', (_req, res) => res.json(db.getAllOnlineRules()));
  router.post('/online-rules', express.json(), async (req, res) => {
    try {
      db.saveOnlineRule({ ...validateOnlineRulePayload(req.body), id: uuidv4() });
      await twitch.refreshChannels();
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  router.put('/online-rules/:id', express.json(), async (req, res) => {
    try {
      db.saveOnlineRule({ ...validateOnlineRulePayload(req.body), id: req.params.id });
      await twitch.refreshChannels();
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  router.delete('/online-rules/:id', (req, res) => { db.deleteOnlineRule(req.params.id); res.json({ success: true }); });

  router.get('/chat-rules', (_req, res) => res.json(db.getAllChatRules()));
  router.post('/chat-rules', express.json(), async (req, res) => {
    try {
      db.saveChatRule({ ...validateChatRulePayload(req.body), id: uuidv4() });
      await twitch.refreshChannels();
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  router.put('/chat-rules/:id', express.json(), async (req, res) => {
    try {
      db.saveChatRule({ ...validateChatRulePayload(req.body), id: req.params.id });
      await twitch.refreshChannels();
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  router.delete('/chat-rules/:id', (req, res) => { db.deleteChatRule(req.params.id); res.json({ success: true }); });

  router.get('/settings', (_req, res) => {
    res.json({
      port: db.getSetting('port', 3847),
      online_poll_seconds: db.getSetting('online_poll_seconds', 30),
      rotation_seconds: db.getSetting('rotation_seconds', 20),
      healthcheck_seconds: db.getSetting('healthcheck_seconds', 30),
      redirect_uri: twitch.getRedirectUri()
    });
  });
  router.put('/settings', express.json(), (req, res) => {
    for (const key of ['online_poll_seconds', 'rotation_seconds', 'healthcheck_seconds']) {
      if (req.body[key] != null) db.setSetting(key, Number(req.body[key]));
    }
    twitch.startRotation();
    effectManager.startHealthChecks();
    res.json({ success: true });
  });

  router.get('/status', (_req, res) => {
    res.json({
      twitch: twitch.getStatus(),
      lamps: effectManager.getLampSummary(),
      diagnostics: {
        twitch: twitch.getStatus().diagnostics,
        lamps: effectManager.getDiagnostics(),
        recentErrors: db.getRecentLogs(12).filter((entry) => entry.level === 'ERROR' || entry.level === 'WARN').slice(0, 6)
      },
      counts: {
        lamps: db.getAllLamps().length,
        streamers: db.getAllStreamers().length,
        onlineRules: db.getAllOnlineRules().length,
        chatRules: db.getAllChatRules().length
      }
    });
  });

  router.post('/diagnostics/healthcheck', async (_req, res) => {
    await effectManager.healthCheck();
    res.json({ success: true, diagnostics: effectManager.getDiagnostics() });
  });

  router.get('/config/export', (_req, res) => {
    res.json(snapshotConfig());
  });

  router.post('/config/validate', express.json({ limit: '2mb' }), (req, res) => {
    const report = analyzeImportPayload(req.body || {});
    res.status(report.ok ? 200 : 400).json(report);
  });

  router.post('/config/import', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const payload = req.body?.config || req.body || {};
      const mode = req.body?.mode === 'merge' ? 'merge' : 'replace';
      const report = analyzeImportPayload(payload);
      if (!report.ok) {
        return res.status(400).json({ error: `Import abgebrochen: ${report.errors.join(' ')}`, report });
      }
      const result = applyImportPayload(payload, mode);
      twitch.startRotation();
      effectManager.startHealthChecks();
      await twitch.refreshChannels();
      res.json({ success: true, result, report });
    } catch (error) {
      res.status(400).json({ error: `Import fehlgeschlagen: ${error.message}` });
    }
  });

  router.get('/logs', (req, res) => res.json(db.getRecentLogs(Number(req.query.limit || 100))));
  router.delete('/logs', (_req, res) => { db.clearLogs(); res.json({ success: true }); });

  return router;
}

module.exports = createApiRouter;
