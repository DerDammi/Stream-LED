const http = require('http');
const db = require('../database');

class WLEDController {
  constructor() {
    this.timeouts = new Map();
  }

  // Fetch WLED state and effects via HTTP API
  async fetchInfo(address) {
    return new Promise((resolve, reject) => {
      const url = `http://${address}/json`;
      const req = http.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`WLED parse error at ${address}`));
          }
        });
      });
      req.on('error', (e) => reject(new Error(`WLED unreachable: ${address}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error(`WLED timeout: ${address}`)); });
    });
  }

  async discoverEffects(lampOrAddress) {
    try {
      const address = typeof lampOrAddress === 'string' ? lampOrAddress : lampOrAddress.address;
      const info = await this.fetchInfo(address);
      const effects = (info.effects || []).map((name, idx) => ({
        id: idx,
        name: name
      }));
      return { effects, info };
    } catch (e) {
      db.log('WARN', 'wled', e.message);
      return null;
    }
  }

  // Send command to WLED
  async sendCommand(address, state) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(state);
      const options = {
        hostname: address,
        port: 80,
        path: '/json/state',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: true }); }
        });
      });
      req.on('error', (e) => reject(new Error(`WLED command failed: ${address}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error(`WLED timeout: ${address}`)); });
      req.write(payload);
      req.end();
    });
  }

  async setColor(lamp, color, opts = {}) {
    // Parse hex color to RGB
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);

    const state = {
      on: true,
      bri: opts.brightness ?? 128,
      seg: [{
        col: [[r, g, b]],
        fx: 0 // solid
      }]
    };

    try {
      await this.sendCommand(lamp.address, state);
      db.updateLampSeen(lamp.id);
      return true;
    } catch (e) {
      db.log('ERROR', 'wled', e.message);
      return false;
    }
  }

  async setEffect(lamp, effectId, opts = {}) {
    const state = {
      on: true,
      bri: opts.brightness ?? 128,
      seg: [{
        fx: effectId,
        sx: opts.speed ?? 128,
        ix: opts.intensity ?? 128
      }]
    };

    try {
      await this.sendCommand(lamp.address, state);
      db.updateLampSeen(lamp.id);
      return true;
    } catch (e) {
      db.log('ERROR', 'wled', e.message);
      return false;
    }
  }

  async setOff(lamp) {
    try {
      await this.sendCommand(lamp.address, { on: false });
      return true;
    } catch (e) {
      db.log('ERROR', 'wled', e.message);
      return false;
    }
  }

  // Check if lamp is reachable
  async ping(address) {
    try {
      await this.fetchInfo(address);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = WLEDController;
