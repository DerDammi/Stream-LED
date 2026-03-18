const express = require('express');
const path = require('path');
const db = require('./src/database');
const EffectManager = require('./src/effect-manager');
const TwitchIntegration = require('./src/twitch');
const createApiRouter = require('./src/api/routes');

const PORT = db.getSetting('port', 3847);
const app = express();
const effectManager = new EffectManager();
const twitch = new TwitchIntegration(effectManager);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'src', 'web')));
app.use('/api', createApiRouter(effectManager, twitch));

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`<h2>Twitch OAuth Fehler: ${error}</h2>`);
  if (!code || !state || !twitch.consumeState(String(state))) {
    return res.status(400).send('<h2>Ungültiger OAuth Callback</h2>');
  }
  try {
    await twitch.exchangeCode(String(code));
    res.send(`<!doctype html><html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:32px"><h2>✅ Twitch erfolgreich verbunden</h2><p>Du kannst dieses Fenster jetzt schließen und zum Webinterface zurückgehen.</p><script>setTimeout(()=>{window.close()},1200)</script></body></html>`);
  } catch (e) {
    res.status(500).send(`<h2>OAuth fehlgeschlagen</h2><pre>${e.message}</pre>`);
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'web', 'index.html'));
});

async function schedule(name, secondsGetter, fn) {
  const run = async () => {
    try { await fn(); } catch (e) { db.log('ERROR', name, e.message); }
    setTimeout(run, Math.max(5, secondsGetter()) * 1000);
  };
  setTimeout(run, Math.max(5, secondsGetter()) * 1000);
}

async function start() {
  effectManager.initialize();
  await effectManager.refreshAllLampEffects().catch(() => {});
  await effectManager.healthCheck().catch(() => {});
  await twitch.initialize().catch(() => {});
  await twitch.pollOnlineStatus().catch(() => {});
  await twitch.tick().catch(() => {});

  schedule('online-poll', () => db.getSetting('online_poll_seconds', 30), () => twitch.pollOnlineStatus());
  schedule('runtime-tick', () => 2, () => twitch.tick());

  app.listen(PORT, () => {
    db.log('INFO', 'server', `LED Stream Controller läuft auf http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  db.log('ERROR', 'server', err.message);
  process.exit(1);
});
