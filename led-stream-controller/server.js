const express = require('express');
const path = require('path');
const db = require('./src/database');
const EffectManager = require('./src/effect-manager');
const TwitchIntegration = require('./src/twitch');
const createApiRouter = require('./src/api/routes');

const PORT = db.getSetting('port', 3847);
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const app = express();
const effectManager = new EffectManager();
const twitch = new TwitchIntegration(effectManager);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'src', 'web')));
app.use('/api', createApiRouter(effectManager, twitch));

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`<!doctype html><html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:32px"><h2>❌ Twitch OAuth Fehler</h2><p>${error_description || error}</p><p>Prüfe vor allem, ob die Redirect URI in Twitch exakt mit der hier verwendeten URL übereinstimmt.</p></body></html>`);
  const stateEntry = state ? twitch.consumeState(String(state)) : null;
  if (!code || !stateEntry) {
    return res.status(400).send('<!doctype html><html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:32px"><h2>Ungültiger OAuth Callback</h2><p>Der Login-Start ist abgelaufen oder wurde nicht von diesem Browser-Fenster begonnen. Starte die Verbindung bitte noch einmal direkt aus dem Webinterface.</p></body></html>');
  }
  try {
    await twitch.exchangeCode(String(code), stateEntry.redirectUri);
    res.send(`<!doctype html><html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:32px"><h2>✅ Twitch erfolgreich verbunden</h2><p>Du kannst dieses Fenster jetzt schließen und zum Webinterface zurückgehen.</p><script>setTimeout(()=>{window.close()},1200)</script></body></html>`);
  } catch (e) {
    res.status(500).send(`<!doctype html><html><body style="font-family:sans-serif;background:#111827;color:#fff;padding:32px"><h2>OAuth fehlgeschlagen</h2><pre>${e.message}</pre><p>Wenn Twitch über Redirect URIs meckert, nutze lokal <strong>http://localhost:${PORT}/oauth/callback</strong> oder extern eine <strong>https://</strong>-URL. Ein normales <strong>http://192.168.x.x</strong> akzeptiert Twitch meistens nicht.</p></body></html>`);
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

  app.listen(PORT, BIND_HOST, () => {
    const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || db.getSetting('public_base_url', '') || '').trim().replace(/\/$/, '');
    db.log('INFO', 'server', `LED Stream Controller läuft auf ${publicBaseUrl || `http://${BIND_HOST}:${PORT}`}`);
  });
}

start().catch((err) => {
  db.log('ERROR', 'server', err.message);
  process.exit(1);
});
