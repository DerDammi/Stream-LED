const http = require('http');
const https = require('https');
const db = require('../database');

function requestJson(url, { method = 'GET', body = null, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      timeout,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ statusCode: res.statusCode || 0, data: parsed });
        } catch (error) {
          reject(new Error(`Hue parse error: ${error.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Hue timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function rgbToXy(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const gamma = (value) => (value > 0.04045 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92);
  const rn = gamma(r);
  const gn = gamma(g);
  const bn = gamma(b);
  const x = rn * 0.664511 + gn * 0.154324 + bn * 0.162028;
  const y = rn * 0.283881 + gn * 0.668433 + bn * 0.047685;
  const z = rn * 0.000088 + gn * 0.07231 + bn * 0.986039;
  const sum = x + y + z;
  return sum ? { x: x / sum, y: y / sum } : { x: 0.3227, y: 0.329 };
}

class HueController {
  parseLamp(lamp) {
    const raw = String(lamp.address || '');
    const [bridgeIp, lightId] = raw.split('/').map((part) => String(part || '').trim()).filter(Boolean);
    return { bridgeIp, lightId, username: lamp.api_key || null };
  }

  async discoverBridges() {
    const cloud = await this.fetchCloudDiscovery().catch(() => []);
    const unique = new Map();
    for (const bridge of cloud) {
      if (bridge?.internalipaddress) unique.set(bridge.internalipaddress, bridge);
    }
    return [...unique.values()].map((bridge) => ({
      id: bridge.id || bridge.internalipaddress,
      type: 'hue-bridge',
      name: bridge.name || `Hue Bridge ${bridge.internalipaddress}`,
      address: bridge.internalipaddress,
      bridge_id: bridge.id || null,
      helper: 'Bridge gefunden. Für V1.4 kannst du jetzt lokal per Link-Button koppeln und einzelne Hue-Lichter importieren.'
    }));
  }

  fetchCloudDiscovery() {
    return new Promise((resolve, reject) => {
      https.get('https://discovery.meethue.com/', { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch {
            reject(new Error('Hue discovery parse error'));
          }
        });
      }).on('error', reject).on('timeout', function onTimeout() {
        this.destroy(new Error('Hue discovery timeout'));
      });
    });
  }

  async pairBridge(address, deviceType = 'led-stream-controller#local') {
    const { data } = await requestJson(`http://${address}/api`, { method: 'POST', body: { devicetype: deviceType }, timeout: 7000 });
    const entry = Array.isArray(data) ? data[0] : null;
    if (entry?.error) throw new Error(entry.error.description || 'Hue Link-Button wurde noch nicht bestätigt.');
    const username = entry?.success?.username;
    if (!username) throw new Error('Hue-Pairing lieferte keinen Username zurück.');
    return { username };
  }

  async listLights(address, username) {
    if (!address || !username) throw new Error('Bridge-IP und Hue-Username sind erforderlich.');
    const { data } = await requestJson(`http://${address}/api/${username}/lights`, { timeout: 7000 });
    if (!data || Array.isArray(data) || typeof data !== 'object') return [];
    return Object.entries(data).map(([id, value]) => ({
      id,
      name: value.name || `Hue Light ${id}`,
      type: 'hue',
      address: `${address}/${id}`,
      bridge_ip: address,
      light_id: id,
      api_key: username,
      helper: `${value.type || 'Hue-Licht'}${value.manufacturername ? ` · ${value.manufacturername}` : ''}`
    }));
  }

  async discoverEffects() {
    return {
      effects: [
        { id: 'static', name: 'Statische Farbe' },
        { id: 'blink', name: 'Alarm Blinken' },
        { id: 'breathe', name: 'Atmen (simuliert als Farbe)' }
      ],
      info: { note: 'Hue unterstützt hier lokal primär Farbe/Ein-Aus. Effekte bleiben bewusst klein.' }
    };
  }

  async ping(address, username = null) {
    const bridgeIp = String(address || '').split('/')[0];
    if (!bridgeIp) return false;
    try {
      if (username) {
        const { statusCode } = await requestJson(`http://${bridgeIp}/api/${username}/config`, { timeout: 4000 });
        return statusCode >= 200 && statusCode < 500;
      }
      const { statusCode } = await requestJson(`http://${bridgeIp}/api/config`, { timeout: 4000 });
      return statusCode >= 200 && statusCode < 500;
    } catch {
      return false;
    }
  }

  async diagnoseBridge(address, username = null) {
    const online = await this.ping(address, username);
    return {
      address,
      online,
      hint: online
        ? (username ? 'Bridge antwortet und Username sieht nutzbar aus. Du kannst jetzt Hue-Lichter importieren oder testen.' : 'Bridge antwortet. Drücke den Link-Button und starte dann das Pairing im UI.')
        : 'Hue Bridge antwortet nicht. Prüfe IP/Host, gleiches LAN und ob die Bridge eingeschaltet ist.'
    };
  }

  async setColor(lamp, color) {
    const { bridgeIp, lightId, username } = this.parseLamp(lamp);
    if (!bridgeIp || !lightId || !username) return false;
    const { x, y } = rgbToXy(color || '#ffffff');
    try {
      await requestJson(`http://${bridgeIp}/api/${username}/lights/${lightId}/state`, { method: 'PUT', body: { on: true, bri: 254, xy: [x, y] }, timeout: 5000 });
      db.updateLampSeen(lamp.id, true);
      return true;
    } catch (error) {
      db.log('ERROR', 'hue', `Hue color failed for ${lamp.name}: ${error.message}`);
      return false;
    }
  }

  async setEffect(lamp, effectId, opts = {}) {
    if (opts.primaryColor) await this.setColor(lamp, opts.primaryColor);
    if (String(effectId) === 'blink') {
      const { bridgeIp, lightId, username } = this.parseLamp(lamp);
      if (!bridgeIp || !lightId || !username) return false;
      try {
        await requestJson(`http://${bridgeIp}/api/${username}/lights/${lightId}/state`, { method: 'PUT', body: { on: true, alert: 'lselect' }, timeout: 5000 });
        db.updateLampSeen(lamp.id, true);
        return true;
      } catch (error) {
        db.log('ERROR', 'hue', `Hue effect failed for ${lamp.name}: ${error.message}`);
        return false;
      }
    }
    return this.setColor(lamp, opts.primaryColor || '#9147ff');
  }

  async setOff(lamp) {
    const { bridgeIp, lightId, username } = this.parseLamp(lamp);
    if (!bridgeIp || !lightId || !username) return false;
    try {
      await requestJson(`http://${bridgeIp}/api/${username}/lights/${lightId}/state`, { method: 'PUT', body: { on: false }, timeout: 5000 });
      return true;
    } catch (error) {
      db.log('ERROR', 'hue', `Hue off failed for ${lamp.name}: ${error.message}`);
      return false;
    }
  }
}

module.exports = HueController;
