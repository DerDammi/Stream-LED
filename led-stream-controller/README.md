# Twitch Lamp Controller V1.1.1

Lokales Webinterface für WLED- und Govee-Lampen mit Twitch-Anbindung.

## Was in V1.1.1 besser ist

- sichererer Config-Import mit Vorab-Prüfung, Warnungen und Modus **ersetzen** oder **ergänzen**
- Import-Hinweis direkt im UI, inklusive Backup-/Export-Tipp und Import-Zusammenfassung
- kleine Vorlagen für Online-Szenen und Chat-Regeln, damit typische Setups schneller stehen
- neues Diagnosefeld im Dashboard für Twitch-Status, Lampen-Checks und letzte Warnungen/Fehler
- weiterhin bewusst einfach gehalten: gleiche V1/V1.1-Richtung, nur runder und freundlicher

## Was in V1.1 schon besser war

- deutlich noob-freundlicheres Setup mit kleinem Wizard und Klartext-Hinweisen
- bequemere Lampentests direkt in der Lampenliste
- Effekt-Auswahl aus der Lampen-API direkt im UI
- klarere Chat-Regel-Erklärung inklusive Sliding-Window-Vorschau
- sicherere Validierung für Online-Szenen und Chat-Regeln
- Config Export / Import als JSON
- besser sichtbarer Runtime- und Statusbereich im Dashboard

## V1 Kernideen

- Docker als Zielplattform
- Twitch OAuth per Button
- WLED + Govee
- Online-Szenen pro Streamer
- Chat-Regeln über Sliding Window (`x Treffer in y Sekunden`)
- online erkannte Streamer rotieren über die Online-Szenen

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

Im Twitch Developer Portal muss als Redirect URI die URL gesetzt sein, unter der dein Interface erreichbar ist. Lokal ist das standardmäßig:

```text
http://localhost:3847/oauth/callback
```

Danach im Webinterface einfach auf **Mit Twitch verbinden** klicken.

## Lampen

### WLED
- Adresse/IP eintragen, z. B. `192.168.1.50`
- über **Effekte laden** wird die Liste direkt aus WLED eingelesen
- Testfarbe und Testeffekt können direkt in der Lampenliste geschickt werden

### Govee
- Adresse/IP eintragen
- falls dein Modell/API es braucht, zusätzlich API Key
- wenn keine echte Effektliste geliefert werden kann, wird ein sinnvoller Preset-Fallback genutzt

## Chat-Regeln

Beispiel:
- Text: `Kappa`
- Match: `enthält`
- Zeitfenster: `10 Sekunden`
- Mindestanzahl: `5`

Dann wird die Regel aktiv, sobald in den letzten 10 Sekunden mindestens 5 Treffer erkannt wurden.
Sie bleibt aktiv, solange dieses Fenster weiter erfüllt ist.

## Config Export / Import

Unter **Einstellungen** kannst du die Konfiguration als JSON exportieren oder wieder importieren.

V1.1.1 kann vor dem Import prüfen:
- ob die JSON-Datei strukturell passt
- wie viele Lampen, Streamer und Regeln erkannt wurden
- welche Warnungen es vorab gibt

Beim Import gibt es zwei Wege:
- **Ersetzen**: aktuelle Konfiguration wird komplett ersetzt
- **Ergänzen**: vorhandene Lampen/Streamer bleiben, neue Einträge werden hinzugefügt bzw. offensichtliche Treffer aktualisiert

Exportiert werden:
- Lampen
- Streamer
- Online-Szenen
- Chat-Regeln
- Basis-Settings
- Twitch Client ID / Client Secret

Nicht als aktive Session gedacht:
- laufende Twitch OAuth Tokens werden nicht als portable Runtime-Konfiguration behandelt

## Diagnose

Im Dashboard siehst du jetzt zusätzlich:
- letzten Twitch Auth-/Live-Check
- Chat-Verbindungsstatus und letzten Disconnect-Hinweis
- Lampen-Healthchecks pro Lampe
- letzte Warnungen und Fehler

## Hinweise

- V1.1.1 bleibt absichtlich einfach: kein unnötiger Architekturumbau
- Hue und komplexere Twitch-Events sind weiterhin spätere Erweiterungen
- bei **Ersetzen** ist Export vor dem Import weiterhin der sichere Weg
