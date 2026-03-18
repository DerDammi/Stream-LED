const http = require('http');
const os = require('os');
const db = require('../database');

class WLEDController {
  async fetchInfo(address) {
    return new Promise((resolve, reject) => {
      const url = `http://${address}/json`;
      const req = http.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`WLED parse error at ${address}`));
          }
        });
      });
      req.on('error', () => reject(new Error(`WLED unreachable: ${address}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error(`WLED timeout: ${address}`)); });
    });
  }

  async discoverEffects(lampOrAddress) {
    try {
      const address = typeof lampOrAddress === 'string' ? lampOrAddress : lampOrAddress.address;
      const info = await this.fetchInfo(address);
      const effects = (info.effects || []).map((name, idx) => ({ id: idx, name }));
      return { effects, info };
    } catch (error) {
      db.log('WARN', 'wled', error.message);
      return null;
    }
  }

  async discoverDevices(options = {}) {
    const candidates = this.buildCandidates(options);
    const found = [];
    await Promise.all(candidates.map(async (address) => {
      try {
        const info = await this.fetchInfo(address);
        if (!info?.info?.ver) return;
        found.push({
          id: `wled:${address}`,
          type: 'wled',
          name: info.info.name || `WLED ${address}`,
          address,
          version: info.info.ver || null,
          effect_count: Array.isArray(info.effects) ? info.effects.length : 0,
          helper: 'WLED antwortet direkt auf /json – gute Chance, dass die Lampe sofort nutzbar ist.'
        });
      } catch {}
    }));
    return found.sort((a, b) => a.address.localeCompare(b.address));
  }

  buildCandidates(options = {}) {
    const single = String(options.address || '').trim().replace(/^https?:\/\//, '').replace(/\/json.*$/, '').replace(/\/$/, '');
    if (single) return [single];

    const start = Math.max(1, Number(options.start || 2));
    const end = Math.max(start, Math.min(254, Number(options.end || 30)));
    const subnets = new Set();
    const interfaces = os.networkInterfaces();
    for (const list of Object.values(interfaces)) {
      for (const info of list || []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        const parts = String(info.address || '').split('.');
        if (parts.length === 4) subnets.add(parts.slice(0, 3).join('.'));
      }
    }
    const candidates = [];
    for (const subnet of subnets) {
      for (let i = start; i <= end; i += 1) candidates.push(`${subnet}.${i}`);
    }
    return candidates;
  }

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
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: true }); }
        });
      });
      req.on('error', () => reject(new Error(`WLED command failed: ${address}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error(`WLED timeout: ${address}`)); });
      req.write(payload);
      req.end();
    });
  }

  async setColor(lamp, color, opts = {}) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const state = { on: true, bri: opts.brightness ?? 128, seg: [{ col: [[r, g, b]], fx: 0 }] };
    try {
      await this.sendCommand(lamp.address, state);
      db.updateLampSeen(lamp.id, true);
      return true;
    } catch (error) {
      db.log('ERROR', 'wled', error.message);
      return false;
    }
  }

  async setEffect(lamp, effectId, opts = {}) {
    const resolvedEffect = Number.isFinite(Number(effectId)) ? Number(effectId) : effectId;
    const state = { on: true, bri: opts.brightness ?? 128, seg: [{ fx: resolvedEffect, sx: opts.speed ?? 128, ix: opts.intensity ?? 128 }] };
    try {
      await this.sendCommand(lamp.address, state);
      db.updateLampSeen(lamp.id, true);
      return true;
    } catch (error) {
      db.log('ERROR', 'wled', error.message);
      return false;
    }
  }

  async setOff(lamp) {
    try {
      await this.sendCommand(lamp.address, { on: false });
      return true;
    } catch (error) {
      db.log('ERROR', 'wled', error.message);
      return false;
    }
  }

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
