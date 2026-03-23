import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { ensureStore, loadConfig, saveConfig, defaultConfig } from './services/store.js';
import { LampManager } from './services/lamp-manager.js';
import { TwitchService } from './services/twitch-service.js';
import { Orchestrator } from './services/orchestrator.js';
import { discoverGoveeDevices, discoverHueBridges, pairHueBridge, fetchHueLights } from './services/providers.js';
import { logger } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 3017);
const oauthStates = new Map();
const uiSessions = new Set();

await ensureStore();
let config = await loadConfig();

const getConfig = () => config;
const lampManager = new LampManager(getConfig);
const twitchService = new TwitchService(getConfig);
const orchestrator = new Orchestrator(getConfig, lampManager, twitchService);
orchestrator.start();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info('HTTP Request', {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: req.ip
    });
  });
  next();
});

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    return [part.slice(0, i), decodeURIComponent(part.slice(i + 1))];
  }));
}

function requireUiAuth(req, res, next) {
  const openPaths = ['/api/session/login', '/api/health', '/api/auth/twitch/callback', '/login'];
  if (openPaths.includes(req.path) || req.path.startsWith('/assets')) return next();
  if (!config.settings.uiPassword) return next();
  const cookies = parseCookies(req);
  const token = cookies.sl_session;
  if (token && uiSessions.has(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nicht angemeldet' });
  return res.sendFile(path.resolve(__dirname, '../public/login.html'));
}

app.use(requireUiAuth);
app.use(express.static(path.resolve(__dirname, '../public')));

async function persist(nextConfig) {
  config = await saveConfig(nextConfig);
  logger.info('Konfiguration gespeichert', {
    lamps: config.lamps.length,
    streamers: config.streamers.length,
    onlineRules: config.rules.online.length,
    emoteRules: config.rules.emotes.length,
    eventRules: config.rules.events.length
  });
  await lampManager.refreshEffects();
  await lampManager.probeLamps();
  await twitchService.connectChat();
}

function cleanupRules(nextConfig) {
  const lampIds = new Set(nextConfig.lamps.map((lamp) => lamp.id));
  const streamerIds = new Set(nextConfig.streamers.map((streamer) => streamer.id));
  const cleanedRules = Object.fromEntries(Object.entries(nextConfig.rules).map(([type, rules]) => [type, rules.filter((rule) => streamerIds.has(rule.streamerId)).map((rule) => ({ ...rule, lampIds: (rule.lampIds || []).filter((lampId) => lampIds.has(lampId)), selections: (rule.selections || []).filter((selection) => lampIds.has(selection.lampId)) }))]));
  return { ...nextConfig, rules: cleanedRules };
}
function enrichConfig() {
  return {
    ...config,
    oauth: { redirectUri: `http://localhost:${port}/api/auth/twitch/callback` },
    lamps: config.lamps.map((lamp) => ({ ...lamp, reachable: lampManager.isReachable(lamp.id), effects: lampManager.getEffects(lamp.id) })),
    onlineStates: config.streamers.map((streamer) => ({ streamerId: streamer.id, login: streamer.login, online: twitchService.isStreamerOnline(streamer.login) }))
  };
}
function buildTwitchAuthUrl() {
  const clientId = config.auth?.twitch?.clientId;
  if (!clientId) throw new Error('Client ID fehlt für OAuth.');
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  const redirectUri = `http://localhost:${port}/api/auth/twitch/callback`;
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'chat:read user:read:email', state });
  return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
}
function verifyEventSubSignature(req) {
  const id = req.headers['twitch-eventsub-message-id'];
  const timestamp = req.headers['twitch-eventsub-message-timestamp'];
  const signature = req.headers['twitch-eventsub-message-signature'];
  const body = req.rawBody?.toString() || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', config.settings.eventSubSecret || '').update(id + timestamp + body).digest('hex');
  return signature === expected;
}

app.get('/login', (_req, res) => res.sendFile(path.resolve(__dirname, '../public/login.html')));
app.post('/api/session/login', (req, res) => {
  if (!config.settings.uiPassword) return res.json({ ok: true, noPassword: true });
  if (req.body.password !== config.settings.uiPassword) {
    logger.warn('UI-Login fehlgeschlagen', { ip: req.ip });
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  uiSessions.add(token);
  logger.info('UI-Login erfolgreich', { ip: req.ip });
  res.setHeader('Set-Cookie', `sl_session=${token}; Path=/; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/api/config', async (_req, res) => res.json(enrichConfig()));
app.get('/api/export', (_req, res) => res.json(config));
app.post('/api/import', async (req, res) => {
  const incoming = req.body;
  const nextConfig = cleanupRules({ ...defaultConfig, ...incoming, auth: { ...defaultConfig.auth, ...(incoming.auth || {}), twitch: { ...defaultConfig.auth.twitch, ...(incoming.auth?.twitch || {}) } }, settings: { ...defaultConfig.settings, ...(incoming.settings || {}) }, integrations: { ...defaultConfig.integrations, ...(incoming.integrations || {}) }, lamps: incoming.lamps || [], streamers: incoming.streamers || [], rules: { ...defaultConfig.rules, ...(incoming.rules || {}) } });
  await persist(nextConfig); res.json({ ok: true });
});
app.get('/api/auth/twitch/start', (req, res) => { try { res.json({ url: buildTwitchAuthUrl() }); } catch (error) { res.status(400).json({ error: error.message }); } });
app.get('/api/auth/twitch/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) return res.status(400).send(`<html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:24px">OAuth-Fehler: ${error} ${errorDescription || ''}</body></html>`);
  if (!code || !state || !oauthStates.has(String(state))) return res.status(400).send('<html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:24px">Ungültiger OAuth-Callback.</body></html>');
  oauthStates.delete(String(state));
  try {
    const redirectUri = `http://localhost:${port}/api/auth/twitch/callback`;
    const { data: tokenData } = await axios.post('https://id.twitch.tv/oauth2/token', null, { params: { client_id: config.auth.twitch.clientId, client_secret: config.auth.twitch.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }, timeout: 10000 });
    const accessToken = tokenData.access_token;
    const { data: userData } = await axios.get('https://api.twitch.tv/helix/users', { headers: { 'Client-Id': config.auth.twitch.clientId, Authorization: `Bearer ${accessToken}` }, timeout: 8000 });
    const user = userData.data?.[0];
    await persist({ ...config, auth: { ...config.auth, mode: 'oauth', configured: true, twitch: { ...config.auth.twitch, username: user?.login || config.auth.twitch.username, oauthToken: accessToken } } });
    res.send('<html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:24px"><h2>Twitch Login erfolgreich</h2><p>Du kannst dieses Fenster schließen und ins UI zurückgehen.</p></body></html>');
  } catch (oauthError) { res.status(500).send(`<html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:24px">OAuth-Austausch fehlgeschlagen: ${oauthError.message}</body></html>`); }
});

app.post('/api/setup', async (req, res) => {
  const nextConfig = { ...config, auth: { ...config.auth, ...req.body, configured: true, twitch: { ...config.auth.twitch, ...(req.body.twitch || {}) } }, settings: { ...config.settings, ...(req.body.settings || {}) }, integrations: { ...config.integrations, ...(req.body.integrations || {}) } };
  await persist(nextConfig); res.json({ ok: true });
});
app.put('/api/settings', async (req, res) => { const nextConfig = { ...config, settings: { ...config.settings, ...req.body } }; await persist(nextConfig); res.json(nextConfig.settings); });
app.get('/api/govee/discover', async (_req, res) => { try { res.json({ devices: await discoverGoveeDevices() }); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get('/api/hue/discover', async (_req, res) => { try { res.json({ bridges: await discoverHueBridges() }); } catch (error) { res.status(500).json({ error: error.message }); } });
app.post('/api/hue/pair', async (req, res) => { try { res.json({ result: await pairHueBridge(req.body.bridgeIp) }); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get('/api/hue/lights', async (req, res) => { try { res.json({ lights: await fetchHueLights(req.query.bridgeIp, req.query.username) }); } catch (error) { res.status(500).json({ error: error.message }); } });

app.post('/api/eventsub/subscribe', async (req, res) => {
  try {
    const { streamerLogin, types = ['stream.online', 'stream.offline', 'channel.follow'] } = req.body;
    if (!config.settings.eventSubPublicUrl || !config.settings.eventSubSecret) throw new Error('eventSubPublicUrl und eventSubSecret sind erforderlich.');
    const users = await twitchService.getUsersByLogins([streamerLogin]);
    const user = users[0];
    if (!user) throw new Error('Streamer nicht gefunden.');
    const callback = `${config.settings.eventSubPublicUrl.replace(/\/$/, '')}/api/eventsub/webhook`;
    const created = [];
    for (const type of types) {
      const condition = type === 'channel.follow' ? { broadcaster_user_id: user.id, moderator_user_id: user.id } : { broadcaster_user_id: user.id };
      created.push(await twitchService.createEventSubSubscription(type, condition, callback, config.settings.eventSubSecret));
    }
    res.json({ ok: true, created });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/eventsub/webhook', (req, res) => {
  const messageType = req.headers['twitch-eventsub-message-type'];
  if (messageType !== 'webhook_callback_verification' && !verifyEventSubSignature(req)) return res.status(403).send('invalid signature');
  if (messageType === 'webhook_callback_verification') return res.status(200).send(req.body.challenge);
  if (messageType === 'notification') {
    const type = req.body.subscription?.type;
    const event = req.body.event || {};
    const streamer = config.streamers.find((s) => s.login?.toLowerCase() === String(event.broadcaster_user_login || '').toLowerCase());
    if (streamer) {
      const map = { 'channel.follow': 'follow', 'stream.online': 'stream_online', 'stream.offline': 'stream_offline' };
      const eventKey = map[type];
      if (eventKey) orchestrator.triggerEvent(streamer.id, eventKey);
    }
  }
  res.status(200).send('ok');
});

app.post('/api/lamps', async (req, res) => { const lamp = { id: nanoid(), ...req.body }; const nextConfig = { ...config, lamps: [...config.lamps, lamp] }; await persist(nextConfig); res.json(lamp); });
app.put('/api/lamps/:id', async (req, res) => { const nextConfig = { ...config, lamps: config.lamps.map((lamp) => lamp.id === req.params.id ? { ...lamp, ...req.body, id: lamp.id } : lamp) }; await persist(nextConfig); res.json({ ok: true }); });
app.delete('/api/lamps/:id', async (req, res) => { const nextConfig = cleanupRules({ ...config, lamps: config.lamps.filter((lamp) => lamp.id !== req.params.id) }); await persist(nextConfig); res.json({ ok: true }); });
app.post('/api/streamers', async (req, res) => { const streamer = { id: nanoid(), eventsEnabled: true, chatChannels: [], ...req.body }; const nextConfig = { ...config, streamers: [...config.streamers, streamer] }; await persist(nextConfig); res.json(streamer); });
app.put('/api/streamers/:id', async (req, res) => { const nextConfig = { ...config, streamers: config.streamers.map((streamer) => streamer.id === req.params.id ? { ...streamer, ...req.body, id: streamer.id } : streamer) }; await persist(nextConfig); res.json({ ok: true }); });
app.delete('/api/streamers/:id', async (req, res) => { const nextConfig = cleanupRules({ ...config, streamers: config.streamers.filter((streamer) => streamer.id !== req.params.id) }); await persist(nextConfig); res.json({ ok: true }); });
app.post('/api/rules/:type', async (req, res) => { const type = req.params.type; if (!config.rules[type]) return res.status(400).json({ error: 'Ungültiger Regeltyp' }); const rule = { id: nanoid(), enabled: true, ...req.body }; const nextConfig = { ...config, rules: { ...config.rules, [type]: [...config.rules[type], rule] } }; await persist(nextConfig); res.json(rule); });
app.put('/api/rules/:type/:id', async (req, res) => { const type = req.params.type; if (!config.rules[type]) return res.status(400).json({ error: 'Ungültiger Regeltyp' }); const nextConfig = { ...config, rules: { ...config.rules, [type]: config.rules[type].map((rule) => rule.id === req.params.id ? { ...rule, ...req.body, id: rule.id } : rule) } }; await persist(nextConfig); res.json({ ok: true }); });
app.delete('/api/rules/:type/:id', async (req, res) => { const type = req.params.type; if (!config.rules[type]) return res.status(400).json({ error: 'Ungültiger Regeltyp' }); const nextConfig = { ...config, rules: { ...config.rules, [type]: config.rules[type].filter((rule) => rule.id !== req.params.id) } }; await persist(nextConfig); res.json({ ok: true }); });
app.post('/api/events/trigger', (req, res) => res.json({ ok: orchestrator.triggerEvent(req.body.streamerId, req.body.eventKey) }));
app.post('/api/events/webhook', (req, res) => { const { streamerLogin, streamerId, eventKey } = req.body || {}; const targetStreamerId = streamerId || config.streamers.find((streamer) => streamer.login?.toLowerCase() === String(streamerLogin || '').toLowerCase())?.id; if (!targetStreamerId || !eventKey) return res.status(400).json({ ok: false, error: 'streamerId oder streamerLogin sowie eventKey erforderlich' }); const ok = orchestrator.triggerEvent(targetStreamerId, eventKey); logger.info('Webhook-Event verarbeitet', { streamerLogin, streamerId: targetStreamerId, eventKey, matched: ok }); res.json({ ok }); });
app.get('/api/health', (_req, res) => res.json({ ok: true, authConfigured: config.auth.configured }));
app.get('*', (_req, res) => res.sendFile(path.resolve(__dirname, '../public/index.html')));

function schedule(name, secondsGetter, task) {
  const run = async () => {
    try {
      const result = await task();
      logger.clearError(name);
      logger.debug('Scheduled Task erfolgreich', { task: name, result });
    } catch (error) {
      logger.errorOnce(name, `${name} fehlgeschlagen`, error);
    } finally {
      setTimeout(run, secondsGetter() * 1000);
    }
  };
  setTimeout(run, secondsGetter() * 1000);
}

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled Promise Rejection', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
});

app.listen(port, async () => {
  logger.info('Streamlight Orchestrator gestartet', { port, logLevel: process.env.LOG_LEVEL || 'INFO' });
  await lampManager.refreshEffects();
  await lampManager.probeLamps();
  await twitchService.connectChat();
  try {
    await twitchService.pollOnlineStates();
  } catch (error) {
    logger.errorOnce('startup-online-poll', 'Initialer Online-Check fehlgeschlagen', error);
  }
  schedule('lamp-probe', () => Math.max(config.settings.healthPollSeconds, 10), () => lampManager.probeLamps());
  schedule('online-poll', () => Math.max(config.settings.onlinePollSeconds, 10), () => twitchService.pollOnlineStates());
  schedule('tick', () => Math.max(config.settings.rotationSeconds, 5), () => orchestrator.tick());
});
