# Stream-LED

Ein lokaler Twitch-Lampen-Controller für:
- **WLED**
- **Govee**
- **Philips Hue**

Das Projekt steuert Lampen abhängig davon:
- welche **Streamer live** sind
- welche **Chat-Regeln / Emotes / Texte** ausgelöst werden

## Kurzfassung

Mit dem Webinterface kannst du:
- Lampen hinzufügen und testen
- Streamer anlegen
- pro Streamer festlegen, **welche Lampen** genutzt werden
- pro Lampenzuordnung festlegen:
  - Farbe
  - Effekt
  - Rotationszeit
- Chat-Regeln anlegen, die Live-Regeln überschreiben

## Wichtiges Verhalten

### Live-Regeln
- Jeder Streamer kann eigene Lampenzuordnungen haben
- Jede Lampe kann pro Streamer eine eigene Szene bekommen
- Wenn mehrere passende Streamer live sind, rotiert **jede Lampe einzeln** nach ihrer eingestellten Zeit

### Chat-Regeln
- Chat-Regeln haben Vorrang vor Live-Regeln
- Solange ein Chat-Trigger aktiv ist, überschreibt er die normale Live-Anzeige

## Projektordner

Der eigentliche App-Code liegt in:

```text
led-stream-controller/
```

## Installation

Die vollständige Installationsanleitung findest du hier:

- [led-stream-controller/README.md](led-stream-controller/README.md)

## Schnellstart

```bash
cd led-stream-controller
npm install
npm start
```

Dann öffnen:
- HTTP: <http://localhost:3847>
- HTTPS: <https://localhost:3443>

## GitHub-Hinweis

Dieses Repository enthält zusätzlich Workspace-/Hilfsdateien. Die eigentliche Anwendung liegt im Unterordner `led-stream-controller`.
