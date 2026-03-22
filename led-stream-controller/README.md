# Twitch Lamp Controller V1.4.0

Lokales Webinterface für WLED- und Govee-Lampen mit Twitch-Anbindung.

## Was in V1.4.0 besser ist

- **praktischere Lampen-Discovery** für WLED, Govee LAN und erste **Hue-Bridge-Erkennung**
- deutlich mehr **Status- und Diagnose-Sicht** im Dashboard und in den API-Statusdaten
- neuer **Regel-Testmodus**: Online-Szenen und Chat-Regeln trocken simulieren, ohne echte Lampen umzuschalten
- mehr Schutz vor **Fehlkonfigurationen** bei Lampen, Streamern, Settings und Importen
- **Philips Hue** sauber einen Schritt weiter vorbereitet: Bridge-Erkennung ja, kompletter Link-Button-/Lampflow bewusst noch klein gehalten
- weiterhin noob-freundlich statt unnötig kompliziert

## Was in V1.2.0 besser war

- bessere Lampen-Hilfe direkt im UI, speziell für **WLED** und **Govee**
- neue **Diagnose-Buttons**: einzelnes Lampen-Diagnose-Check plus globaler Healthcheck direkt im Dashboard
- geführtere Regel-Erstellung durch kleinen **Regel-Assistenten** für Chat-Regeln
- komfortablere Ziel-Lampen-Bearbeitung: **auf alle kopieren**, schnelle Vorschau pro Lampe und kompakte Ziel-Zusammenfassung
- etwas sauberere Vorbereitung für **Philips Hue** im UI-/API-Metadaten-Layer, ohne V1 künstlich aufzublasen

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

Im Twitch Developer Portal muss als Redirect URI die URL gesetzt sein, unter der dein Interface erreichbar ist.

Standard lokal:

```text
http://localhost:3847/oauth/callback
```

Wenn du die App von außen erreichbar machen willst, setze eine öffentliche Basis-URL. Beispiel:

```text
https://deine-domain.de/oauth/callback
```

Dafür gibt es zwei Wege:

1. dauerhaft in der App über die Einstellung `public_base_url`
2. per Umgebungsvariable beim Start:

```bash
PUBLIC_BASE_URL=https://deine-domain.de BIND_HOST=0.0.0.0 npm start
```

Danach im Webinterface einfach auf **Mit Twitch verbinden** klicken.

## Lampen

### WLED
- IP oder Hostname eintragen, z. B. `192.168.1.50` oder `wled-kueche.local`
- über **Diagnose** prüfst du direkt Erreichbarkeit und Effekt-Erkennung
- über **Effekte neu laden** wird die Liste direkt aus WLED eingelesen
- **Discovery** kann bekannte IPs direkt testen oder einen kleinen LAN-Bereich absuchen

### Govee
- IP/Adresse eintragen
- falls dein Modell/API es braucht, zusätzlich API Key
- lokale Govee-Effektlisten sind oft Preset-basiert; das ist im UI bewusst so erklärt
- **Discovery** lauscht auf Govee-LAN-Antworten und zeigt gefundene Geräte kompakt an

### Philips Hue
- V1.4 kann jetzt **Hue Bridges lokal koppeln** (Link-Button), **Hue-Lichter laden** und als echte Lampen importieren
- gespeichert wird bewusst simpel: Bridge-IP + lokaler Username + ausgewähltes Licht
- Fokus bleibt lokal-first: Farbe, Ein/Aus und ein kleiner Blink-Fallback statt unnötig komplexer Effekt-Magie

## Online-Szenen, Chat-Regeln und Testmodus

### Komfortfunktionen
- **Live-Look auf alle** bzw. **Hype-Look auf alle** als schneller Start
- **Auf alle kopieren** pro Lampen-Zielkarte
- **Jetzt testen** direkt aus der Zielkarten-Konfiguration
- kompakte Zusammenfassung, wie viele Lampen gerade aktiv belegt sind

### Neuer Regel-Testmodus in V1.3

Unter **Einstellungen** kannst du jetzt:
- eine **Online-Szene** auswählen
- optional zusätzlich eine **Chat-Regel** auswählen
- optional eine Chat-Nachricht simulieren
- das Ergebnis **trocken berechnen**, ohne echte Lampen umzuschalten

Das hilft besonders beim Debuggen von Sliding-Window-Regeln.

## Config Export / Import

Unter **Einstellungen** kannst du die Konfiguration als JSON exportieren oder wieder importieren.

V1.3 prüft vor dem Import strenger:
- ob die JSON-Datei strukturell passt
- ob Lampen-/Streamer-Daten plausibel aussehen
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
- letzten Discovery-Zeitpunkt
- letzten angewendeten bzw. trocken berechneten Regel-Lauf
- manuellen **Healthcheck jetzt**-Button

## Hinweise

- Discovery ist bewusst **praktisch statt magisch**: sie hilft viel, garantiert aber nicht jede exotische Netzkonstellation
- Hue ist jetzt als kleiner, echter lokaler Workflow drin – bewusst pragmatisch statt überladen
- bei **Ersetzen** ist Export vor dem Import weiterhin der sichere Weg
