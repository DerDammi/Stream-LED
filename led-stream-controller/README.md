# Twitch Lamp Controller

Lokales Webinterface für WLED- und Govee-Lampen mit Twitch-Anbindung.

## V1 Funktionen

- Twitch Login per Button (OAuth)
- mehrere Lampen
- mehrere Streamer
- Online-Szenen pro Streamer
- Chat-Regeln für Emotes **und freien Text**
- Sliding-Window Logik: z. B. `5 Treffer in 10 Sekunden`
- Chat-Regel bleibt aktiv, solange weiter genug Treffer da sind
- Effekte werden pro Lampe aus der Lampen-API geladen, wenn verfügbar
- deduplizierte Logs
- Docker-ready

## Start lokal

```bash
npm install
npm start
```

Dann öffnen:

<http://localhost:3847>

## Docker

```bash
docker compose up -d --build
```

Dann öffnen:

<http://localhost:3847>

## Twitch Einrichtung

Im Setup-Screen trägst du ein:

- Client ID
- Client Secret

Im Twitch Developer Portal muss als Redirect URI gesetzt sein:

```text
http://localhost:3847/oauth/callback
```

Danach im Webinterface einfach auf **Mit Twitch verbinden** klicken.

## Lampen

### WLED
- Adresse/IP eintragen, z. B. `192.168.1.50`
- Effekte können über **Effekte laden** eingelesen werden

### Govee
- Adresse/IP eintragen
- falls dein Modell/API es braucht, zusätzlich API Key
- wenn keine echte Effektliste geliefert werden kann, wird ein Fallback genutzt

## Chat-Regeln

Beispiel:
- Text: `Kappa`
- Match: `enthält`
- Zeitfenster: `10 Sekunden`
- Mindestanzahl: `5`

Dann wird die Regel aktiv, sobald in den letzten 10 Sekunden mindestens 5 Treffer erkannt wurden.
Sie bleibt aktiv, solange das weiter erfüllt ist.

## Hinweise

- V1 konzentriert sich auf Online-Anzeige + Chat-Regeln
- Hue und komplexere Twitch-Events sind als spätere Erweiterung gedacht
