const dgram = require('dgram');
const db = require('../database');

const GOVEE_LAN_PORT = 4003;
const GOVEE_MULTICAST = { host: '239.255.255.250', port: 4001 };

class GoveeController {
  constructor() {
    this.devices = new Map();
  }

  async discoverEffects(lamp) {
    if (lamp.api_key) return this._fetchCloudEffects(lamp);
    const device = await this._fetchLanInfo(lamp);
    return { effects: this._getPresetEffects(), info: device?.info || null };
  }

  async discoverDevices(options = {}) {
    const timeoutMs = Math.max(1200, Math.min(6000, Number(options.timeoutMs || 2200)));
    const found = [];
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve) => {
      socket.on('message', (msg, rinfo) => {
        try {
          const parsed = JSON.parse(msg.toString());
          const device = parsed?.msg?.data || {};
          const sku = device.sku || parsed?.sku || null;
          const name = device.device || device.devName || sku || `Govee ${rinfo.address}`;
          if (this.devices.has(rinfo.address)) return;
          const entry = {
            id: `govee:${rinfo.address}`,
            type: 'govee',
            name,
            address: rinfo.address,
            sku,
            helper: 'Govee LAN-Gerät geantwortet. Für manche Modelle bleibt die Effektliste preset-basiert – das ist normal.'
          };
          this.devices.set(rinfo.address, entry);
          found.push(entry);
        } catch {}
      });
      socket.bind(() => {
        socket.setBroadcast(true);
        const payload = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
        socket.send(payload, GOVEE_MULTICAST.port, GOVEE_MULTICAST.host, () => {});
        setTimeout(resolve, timeoutMs);
      });
    }).finally(() => socket.close());
    return found.sort((a, b) => a.address.localeCompare(b.address));
  }

  async _fetchCloudEffects(lamp) {
    try {
      const { default: fetch } = await import('node-fetch');
      const resp = await fetch('https://developer-api.govee.com/v1/devices/state', {
        headers: {
          'Govee-API-Key': lamp.api_key,
          'Content-Type': 'application/json'
        }
      });
      if (!resp.ok) throw new Error(`Govee Cloud API: ${resp.status}`);
      const data = await resp.json();
      const device = (data.data?.devices || []).find((d) => d.ip === lamp.address || d.device === lamp.address);
      return { effects: this._getPresetEffects(), info: device || null };
    } catch (error) {
      db.log('WARN', 'govee', `Cloud API error for ${lamp.name}: ${error.message}`);
      return null;
    }
  }

  async _fetchLanInfo(lamp) {
    const known = this.devices.get(lamp.address);
    if (known) return { info: known };
    const devices = await this.discoverDevices({ timeoutMs: 1500 }).catch(() => []);
    return { info: devices.find((entry) => entry.address === lamp.address) || null };
  }

  _getPresetEffects() {
    return [
      { id: 'static', name: 'Static' },
      { id: 'color_preset', name: 'Color Presets' },
      { id: 'rgb', name: 'RGB Cycle' },
      { id: 'gradient', name: 'Gradient' },
      { id: 'scene_nightlight', name: 'Night Light' },
      { id: 'scene_romantic', name: 'Romantic' },
      { id: 'scene_blinking', name: 'Blinking' },
      { id: 'scene_candle', name: 'Candle' },
      { id: 'scene_rainbow', name: 'Rainbow' },
      { id: 'scene_sunrise', name: 'Sunrise' }
    ];
  }

  async setColor(lamp, color) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    if (lamp.api_key) return this._cloudSetColor(lamp, r, g, b);
    return this._lanSetColor(lamp, r, g, b);
  }

  async _lanSetColor(lamp, r, g, b) {
    try {
      await this._sendLanCommand(lamp.address, { msg: { cmd: 'colorwc', data: { color: { r, g, b } } } });
      db.updateLampSeen(lamp.id, true);
      return true;
    } catch (error) {
      db.log('ERROR', 'govee', `LAN color failed for ${lamp.name}: ${error.message}`);
      return false;
    }
  }

  async _cloudSetColor(lamp, r, g, b) {
    try {
      const { default: fetch } = await import('node-fetch');
      const resp = await fetch('https://developer-api.govee.com/v1/devices/control', {
        method: 'PUT',
        headers: {
          'Govee-API-Key': lamp.api_key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          device: lamp.address,
          model: lamp.name,
          cmd: { name: 'color', value: { r, g, b } }
        })
      });
      if (!resp.ok) throw new Error(`Cloud API: ${resp.status}`);
      db.updateLampSeen(lamp.id, true);
      return true;
    } catch (error) {
      db.log('ERROR', 'govee', `Cloud color failed for ${lamp.name}: ${error.message}`);
      return false;
    }
  }

  async setEffect(lamp, effectId) {
    if (lamp.api_key) return this._cloudSetEffect(lamp, effectId);
    return this._lanSetEffect(lamp, effectId);
  }

  async _lanSetEffect(lamp, effectId) {
    try {
      await this._sendLanCommand(lamp.address, { msg: { cmd: 'pt', data: { type: this._mapLanEffectType(effectId) } } });
      db.updateLampSeen(lamp.id, true);
      return true;
    } catch (error) {
      db.log('ERROR', 'govee', `LAN effect failed: ${error.message}`);
      return false;
    }
  }

  async _cloudSetEffect(lamp, effectId) {
    try {
      const { default: fetch } = await import('node-fetch');
      const cmd = effectId === 'static' ? { name: 'turn', value: 'on' } : { name: 'scene', value: this._mapCloudScene(effectId) };
      const resp = await fetch('https://developer-api.govee.com/v1/devices/control', {
        method: 'PUT',
        headers: {
          'Govee-API-Key': lamp.api_key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ device: lamp.address, model: lamp.name, cmd })
      });
      if (!resp.ok) throw new Error(`Cloud API: ${resp.status}`);
      db.updateLampSeen(lamp.id, true);
      return true;
    } catch (error) {
      db.log('ERROR', 'govee', `Cloud effect failed: ${error.message}`);
      return false;
    }
  }

  async setOff(lamp) {
    if (lamp.api_key) {
      try {
        const { default: fetch } = await import('node-fetch');
        await fetch('https://developer-api.govee.com/v1/devices/control', {
          method: 'PUT',
          headers: { 'Govee-API-Key': lamp.api_key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ device: lamp.address, model: lamp.name, cmd: { name: 'turn', value: 'off' } })
        });
        return true;
      } catch (error) {
        db.log('ERROR', 'govee', error.message);
        return false;
      }
    }
    try {
      await this._sendLanCommand(lamp.address, { msg: { cmd: 'turn', data: { value: 0 } } });
      return true;
    } catch (error) {
      db.log('ERROR', 'govee', error.message);
      return false;
    }
  }

  _sendLanCommand(ip, command) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const msg = Buffer.from(JSON.stringify(command));
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        try { socket.close(); } catch {}
        if (error) reject(error);
        else resolve();
      };
      socket.send(msg, GOVEE_LAN_PORT, ip, (err) => finish(err || null));
      setTimeout(() => finish(new Error('Govee LAN timeout')), 3000);
    });
  }

  async ping(address, apiKey = null) {
    if (apiKey) {
      try {
        const { default: fetch } = await import('node-fetch');
        const resp = await fetch('https://developer-api.govee.com/v1/devices/state', { headers: { 'Govee-API-Key': apiKey } });
        return resp.ok;
      } catch {
        return false;
      }
    }
    try {
      await this._sendLanCommand(address, { msg: { cmd: 'scan', data: {} } });
      return true;
    } catch {
      return false;
    }
  }

  _mapLanEffectType(effectId) {
    const map = { static: 1, color_preset: 2, rgb: 3, gradient: 4, scene_nightlight: 5, scene_romantic: 6 };
    return map[effectId] || 1;
  }

  _mapCloudScene(effectId) {
    const map = { scene_nightlight: 1, scene_romantic: 2, scene_blinking: 3, scene_candle: 4, scene_rainbow: 5, scene_sunrise: 6 };
    return map[effectId] || 1;
  }
}

module.exports = GoveeController;
