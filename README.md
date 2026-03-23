# Twitch Lamp Controller

Lokales Webinterface für WLED-, Govee- und Philips-Hue-Lampen mit Twitch-Anbindung.

## Zusammenfassung

Dieses Projekt ist ein lokaler Lampen-Controller mit Webinterface.
Er reagiert auf:
- **Streamer, die live sind**
- **Chat-Regeln** auf Basis von Emotes oder freiem Text

Du kannst damit:
- Lampen hinzufügen und technisch verwalten
- Streamer anlegen
- pro Streamer festlegen, **welche Lampen** genutzt werden
- pro zugewiesener Lampe festlegen:
  - Farbe
  - Effekt
  - Rotationszeit
- Chat-Regeln anlegen, die die normale Live-Anzeige überschreiben

## Kernfunktionen

- Webinterface für lokale Nutzung
- WLED Support
- Govee Support
- Philips Hue Support (lokal, pragmatisch)
- Twitch OAuth Login
- Live-Erkennung für Streamer
- lampenspezifische Rotation bei mehreren live Streamern
- Chat-Regeln mit Sliding-Window-Logik
- Diagnose / Discovery / Tests
- Import / Export der Konfiguration
- HTTP und HTTPS (selbstsigniertes Zertifikat)


## Was in V1.5.0 besser ist

- **Online-Verhalten jetzt pro Lampe statt global**: wenn mehrere zugewiesene Streamer gleichzeitig live sind, rotiert jede Lampe unabhängig nur zwischen ihren eigenen Live-Zuweisungen
- jede Online-Zuweisung hat jetzt **eigene Lampen-Szene plus eigenes Rotationsintervall pro Lampe**
- bestehende Online-Regeln werden beim Laden/Import **vorsichtig migriert**: fehlt ein Rotationswert, wird automatisch die bisherige Standard-Rotation verwendet
- **Chat-Regeln behalten weiter Vorrang** und übersteuern Online-Zustände lampengenau
- Dashboard, Testmodus, Import/Export und UI-Texte sind auf das neue Verhalten angepasst

## Was in V1.4.2 besser ist

- **Twitch OAuth Redirects sind jetzt schlauer**: lokal bevorzugt die App automatisch `localhost`, extern sauber eine konfigurierte `https://`-Adresse
- deutlich klarere **Setup-Hinweise**, welche Redirect URIs Twitch akzeptiert — und welche typischen LAN-HTTP-URLs man lieber nicht einträgt
- neue **öffentliche Basis-URL** direkt in den Einstellungen, damit Docker/Reverse-Proxy/VPS einfacher werden
- OAuth speichert die beim Start verwendete Redirect URI jetzt sauber mit, damit der Callback robuster ist
- freundlichere Fehlertexte bei Redirect-/Callback-Problemen

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
- Online-Szenen pro Streamer mit expliziten Lampen-Zuweisungen
- Chat-Regeln über Sliding Window (`x Treffer in y Sekunden`)
- pro Lampe eigene Rotation zwischen den gerade live zugewiesenen Streamern

## Installation

### Voraussetzungen

Du brauchst:
- Node.js
- npm
- Zugriff auf dein lokales Netzwerk, wenn du Lampen im LAN steuern willst

### Lokale Installation

```bash
git clone https://github.com/DerDammi/Stream-LED.git
cd Stream-LED
npm install
npm start
```

Dann öffnen:
- HTTP: <http://localhost:3847>
- HTTPS (selbstsigniert): <https://localhost:3443>

Für HTTPS liegt ein selbstsigniertes Zertifikat im Ordner `certs/`. Im Browser musst du die Warnung einmal bestätigen.

## Docker Overview

Dieses Projekt kann direkt per Docker oder Docker Compose betrieben werden.

### Enthalten
- `Dockerfile` für den App-Container
- `docker-compose.yml` für den schnellen lokalen Start
- persistente Daten unter `./data`
- HTTP und HTTPS im Container

### Verwendete Ports
- `3847` = HTTP
- `3443` = HTTPS

### Container starten

```bash
docker compose up -d --build
```

Dann öffnen:
- HTTP: <http://localhost:3847>
- HTTPS: <https://localhost:3443>

### Container stoppen

```bash
docker compose down
```

### Logs ansehen

```bash
docker compose logs -f
```

### Image lokal bauen

```bash
docker build -t derdammi/stream-led:latest .
```

### Image auf Docker Hub hochladen

```bash
docker login
docker push derdammi/stream-led:latest
```

### Optional mit Version-Tag

```bash
docker build -t derdammi/stream-led:latest -t derdammi/stream-led:1.5.0 .
docker push derdammi/stream-led:latest
docker push derdammi/stream-led:1.5.0
```

### Wichtige Hinweise
- Die App speichert Daten lokal in `./data`
- Für Twitch OAuth ist lokal meist `http://localhost:3847/oauth/callback` der richtige Startpunkt
- HTTPS nutzt ein selbstsigniertes Zertifikat. Browser zeigen dabei zunächst eine Warnung an

## Twitch Einrichtung

Im Setup-Screen trägst du ein:

- Client ID
- Client Secret

Im Twitch Developer Portal muss als Redirect URI **exakt** die URL gesetzt sein, die beim OAuth-Start verwendet wird.

**Gut für lokale Entwicklung / Tests:**

```text
http://localhost:3847/oauth/callback
```

**Gut für extern / deployed:**

Wenn du die App von außen erreichbar machen willst, setze eine öffentliche Basis-URL. Beispiel:

```text
https://deine-domain.de/oauth/callback
```

Wichtig: Ein normales `http://192.168.x.x/...` oder `http://mein-rechner.local/...` ist für Twitch meist **nicht** passend. Nutze lokal lieber `localhost`, extern lieber `https://`.

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
