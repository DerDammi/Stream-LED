# Streamlight Orchestrator

Lokales Node.js-Webinterface für Twitch-gesteuerte Lampenlogik.

## Neu in dieser Stufe

- **Twitch EventSub direkt eingebaut**
  - Subscription-Endpoint
  - Webhook-Endpoint mit Signaturprüfung
  - Mapping auf Event-Regeln (`follow`, `stream_online`, `stream_offline`)
- **Philips Hue lokal**
  - Bridge Discovery
  - Bridge Pairing
  - Lichter laden und als Lampen speichern
- **Govee pro Gerät bessere Effektzuordnung**
  - Custom-Effect-Liste pro Lampe im UI
  - Discovery + Übernahme ins Formular
- **lokaler Passwortschutz fürs UI**
  - optionales UI-Passwort
  - Login-Seite unter `/login`
- **Docker + systemd Autostart**
  - `Dockerfile`
  - `docker/docker-compose.yml`
  - `streamlight-orchestrator.service`

## Start lokal

```bash
npm install
npm start
```

Dann öffnen:

<http://localhost:3017>

## Twitch OAuth

Redirect URI im Twitch Developer Portal:

```text
http://localhost:3017/api/auth/twitch/callback
```

## EventSub

Im UI setzen:

- `eventSubPublicUrl` → öffentlich erreichbare HTTPS-URL
- `eventSubSecret` → beliebiges geheimes Secret

Dann im UI einen Streamer-Login eintragen und **EventSub anlegen** klicken.

Webhook-Ziel:

```text
https://DEINE-DOMAIN/api/eventsub/webhook
```

Hinweis: EventSub braucht eine **öffentlich erreichbare HTTPS-URL**. Rein lokales `localhost` reicht dafür nicht.

## Philips Hue

1. Hue Bridges suchen
2. Bridge-IP übernehmen
3. Auf dem Hue-Bridge-Gerät den Knopf drücken
4. Im UI **Hue koppeln** klicken
5. Danach **Hue Lichter laden**
6. Hue-Licht beim Lampenformular auswählen

## Docker

```bash
docker build -t streamlight-orchestrator .
docker run -p 3017:3017 -v $(pwd)/data:/app/data streamlight-orchestrator
```

Oder mit Compose:

```bash
cd docker
docker compose up -d --build
```

## systemd Autostart

```bash
sudo cp streamlight-orchestrator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now streamlight-orchestrator.service
```

Passe ggf. den User/WorkingDirectory in der Service-Datei an.

## Wichtige Einschränkungen

- EventSub geht nur mit öffentlicher HTTPS-Erreichbarkeit.
- Hue ist lokal nutzbar, aber noch ohne Spezialeffekte.
- Govee bleibt je nach Modell unterschiedlich; Custom-Effects pro Lampe sind dafür jetzt der saubere Workaround.
