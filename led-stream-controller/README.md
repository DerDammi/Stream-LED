# Twitch Lamp Controller V1.2.0

Lokales Webinterface für WLED- und Govee-Lampen mit Twitch-Anbindung.

## Was in V1.2.0 besser ist

- bessere Lampen-Hilfe direkt im UI, speziell für **WLED** und **Govee**
- neue **Diagnose-Buttons**: einzelnes Lampen-Diagnose-Check plus globaler Healthcheck direkt im Dashboard
- geführtere Regel-Erstellung durch kleinen **Regel-Assistenten** für Chat-Regeln
- komfortablere Ziel-Lampen-Bearbeitung: **auf alle kopieren**, schnelle Vorschau pro Lampe und kompakte Ziel-Zusammenfassung
- etwas sauberere Vorbereitung für **Philips Hue** im UI-/API-Metadaten-Layer, ohne V1 künstlich aufzublasen
- weiterhin bewusst noob-freundlich und ohne Framework-Overkill

## Was in V1.1.1 besser war

- sichererer Config-Import mit Vorab-Prüfung, Warnungen und Modus **ersetzen** oder **ergänzen**
- Import-Hinweis direkt im UI, inklusive Backup-/Export-Tipp und Import-Zusammenfassung
- kleine Vorlagen für Online-Szenen und Chat-Regeln, damit typische Setups schneller stehen
- Diagnosefeld im Dashboard für Twitch-Status, Lampen-Checks und letzte Warnungen/Fehler

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
- IP oder Hostname eintragen, z. B. `192.168.1.50` oder `wled-kueche.local`
- über **Diagnose** prüfst du direkt Erreichbarkeit und Effekt-Erkennung
- über **Effekte neu laden** wird die Liste direkt aus WLED eingelesen
- Testfarbe und Testeffekt können direkt in der Lampenliste geschickt werden

### Govee
- IP/Adresse eintragen
- falls dein Modell/API es braucht, zusätzlich API Key
- lokale Govee-Effektlisten sind oft Preset-basiert; das ist im UI bewusst so erklärt
- Diagnose gibt direkte Hinweise bei typischen LAN-/API-Key-Problemen

### Philips Hue
- in V1.2 nur vorbereitet, noch **nicht** als produktiver Lampentyp freigeschaltet
- Ziel war saubere Vorbereitung, nicht halb fertige Hue-Logik

## Online-Szenen und Chat-Regeln

### Komfortfunktionen in V1.2
- **Live-Look auf alle** bzw. **Hype-Look auf alle** als schneller Start
- **Auf alle kopieren** pro Lampen-Zielkarte
- **Jetzt testen** direkt aus der Zielkarten-Konfiguration
- kompakte Zusammenfassung, wie viele Lampen gerade aktiv belegt sind

### Chat-Regel-Assistent

Im Chat-Regel-Dialog gibt es jetzt einen kleinen Assistenten für:
- soliden Standard
- schnellen Meme-Trigger
- stabilen, weniger nervösen Trigger
- exakte Nachrichtenmatches

Danach lassen sich die Werte natürlich weiter manuell anpassen.

## Config Export / Import

Unter **Einstellungen** kannst du die Konfiguration als JSON exportieren oder wieder importieren.

V1.2 kann vor dem Import prüfen:
- ob die JSON-Datei strukturell passt
- wie viele Lampen, Streamer und Regeln erkannt wurden
- welche Warnungen es vorab gibt

Beim Import gibt es zwei Wege:
- **Ersetzen**: aktuelle Konfiguration wird komplett ersetzt
- **Ergänzen**: vorhandene Lampen/Streamer bleiben, neue Einträge werden hinzugefügt bzw. offensichtliche Treffer aktualisiert

## Diagnose

Im Dashboard siehst du jetzt zusätzlich:
- letzten Twitch Auth-/Live-Check
- Chat-Verbindungsstatus und letzten Disconnect-Hinweis
- Lampen-Healthchecks pro Lampe
- letzte Warnungen und Fehler
- manuellen **Healthcheck jetzt**-Button

## Hinweise

- V1.2 bleibt absichtlich einfach: keine unnötige Architektur-Migration
- Hue ist vorbereitet, aber noch nicht aktiv nutzbar
- bei **Ersetzen** ist Export vor dem Import weiterhin der sichere Weg
