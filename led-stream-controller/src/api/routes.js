const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function createApiRouter(effectManager, twitch) {
  const router = express.Router();

  router.get('/setup/status', (_req, res) => {
    const auth = db.getTwitchAuth();
    res.json({
      needsSetup: !auth?.access_token,
      hasClientConfig: !!(auth?.client_id && auth?.client_secret),
      redirectUri: twitch.getRedirectUri(),
      login: auth?.login || null
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
  router.post('/lamps/:id/test', express.json(), async (req, res) => {
    const { action, color, effect_name } = req.body;
    const ok = action === 'off'
      ? await effectManager.setLampOff(req.params.id)
      : action === 'effect'
        ? await effectManager.setLampEffect(req.params.id, effect_name)
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
    db.saveOnlineRule({ ...req.body, id: uuidv4() });
    await twitch.refreshChannels();
    res.json({ success: true });
  });
  router.put('/online-rules/:id', express.json(), async (req, res) => {
    db.saveOnlineRule({ ...req.body, id: req.params.id });
    await twitch.refreshChannels();
    res.json({ success: true });
  });
  router.delete('/online-rules/:id', (req, res) => { db.deleteOnlineRule(req.params.id); res.json({ success: true }); });

  router.get('/chat-rules', (_req, res) => res.json(db.getAllChatRules()));
  router.post('/chat-rules', express.json(), async (req, res) => {
    db.saveChatRule({ ...req.body, id: uuidv4() });
    await twitch.refreshChannels();
    res.json({ success: true });
  });
  router.put('/chat-rules/:id', express.json(), async (req, res) => {
    db.saveChatRule({ ...req.body, id: req.params.id });
    await twitch.refreshChannels();
    res.json({ success: true });
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
      lamps: effectManager.getLampSummary()
    });
  });

  router.get('/logs', (req, res) => res.json(db.getRecentLogs(Number(req.query.limit || 100))));
  router.delete('/logs', (_req, res) => { db.clearLogs(); res.json({ success: true }); });

  return router;
}

module.exports = createApiRouter;
