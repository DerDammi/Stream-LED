const http = require('http');
const https = require('https');
const db = require('../database');

class HueController {
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
      helper: 'Bridge gefunden. Für echte Lampensteuerung fehlt in V1.3 nur noch der Link-Button-Schritt.'
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
          } catch (error) {
            reject(new Error('Hue discovery parse error'));
          }
        });
      }).on('error', reject).on('timeout', function onTimeout() {
        this.destroy(new Error('Hue discovery timeout'));
      });
    });
  }

  async ping(address) {
    return new Promise((resolve) => {
      const req = http.get(`http://${address}/api/config`, { timeout: 4000 }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  async diagnoseBridge(address) {
    const online = await this.ping(address);
    return {
      address,
      online,
      hint: online
        ? 'Bridge antwortet. Nächster Schritt für echte Steuerung wäre ein Benutzer per Link-Button auf der Hue Bridge.'
        : 'Hue Bridge antwortet nicht. Prüfe IP/Host, gleiches LAN und ob die Bridge eingeschaltet ist.'
    };
  }
}

module.exports = HueController;
