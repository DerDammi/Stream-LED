const http = require('http');
const dgram = require('dgram');
const db = require('../database');

// Govee LAN API (local control, no cloud needed for supported devices)
// Port 4003, multicast 239.255.255.250:4001

const GOVEE_LAN_PORT = 4003;
const GOVEE_MULTICAST = { host: '239.255.255.250', port: 4001 };

class GoveeController {
  constructor() {
    this.devices = new Map(); // ip -> device info
  }

  // Try LAN API first, fall back to Cloud API
  async discoverEffects(lamp) {
    if (lamp.api_key) {
      return this._fetchCloudEffects(lamp);
    }
    return this._fetchLanInfo(lamp);
  }

  // Cloud API - fetch device state/effects
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

      // Find our device
      const device = (data.data?.devices || []).find(d =>
        d.ip === lamp.address || d.device === lamp.address
      );

      if (device) {
        // Govee doesn't expose effects list via API, use common presets
        const effects = this._getPresetEffects();
        return { effects, info: device };
      }
      return { effects: this._getPresetEffects(), info: null };
    } catch (e) {
      db.log('WARN', 'govee', `Cloud API error for ${lamp.name}: ${e.message}`);
      return null;
    }
  }

  async _fetchLanInfo(lamp) {
    // LAN discovery via scan
    return { effects: this._getPresetEffects(), info: null };
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
      { id: 'scene_sunrise', name: 'Sunrise' },
    ];
  }

  // Set color via LAN or Cloud
  async setColor(lamp, color, opts = {}) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);

    if (lamp.api_key) {
      return this._cloudSetColor(lamp, r, g, b);
    }
    return this._lanSetColor(lamp, r, g, b);
  }

  async _lanSetColor(lamp, r, g, b) {
    try {
      const command = {
        msg: {
          cmd: 'colorwc',
          data: {
            color: { r, g, b }
          }
        }
      };

      await this._sendLanCommand(lamp.address, command);
      db.updateLampSeen(lamp.id);
      return true;
    } catch (e) {
      db.log('ERROR', 'govee', `LAN color failed for ${lamp.name}: ${e.message}`);
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
          model: lamp.name, // device model, stored in name field for cloud
          cmd: {
            name: 'color',
            value: { r, g, b }
          }
        })
      });
      if (!resp.ok) throw new Error(`Cloud API: ${resp.status}`);
      db.updateLampSeen(lamp.id);
      return true;
    } catch (e) {
      db.log('ERROR', 'govee', `Cloud color failed for ${lamp.name}: ${e.message}`);
      return false;
    }
  }

  async setEffect(lamp, effectId, opts = {}) {
    if (lamp.api_key) {
      return this._cloudSetEffect(lamp, effectId, opts);
    }
    return this._lanSetEffect(lamp, effectId, opts);
  }

  async _lanSetEffect(lamp, effectId, opts) {
    try {
      const command = {
        msg: {
          cmd: 'pt',
          data: {
            type: this._mapLanEffectType(effectId)
          }
        }
      };
      await this._sendLanCommand(lamp.address, command);
      db.updateLampSeen(lamp.id);
      return true;
    } catch (e) {
      db.log('ERROR', 'govee', `LAN effect failed: ${e.message}`);
      return false;
    }
  }

  async _cloudSetEffect(lamp, effectId, opts) {
    try {
      const { default: fetch } = await import('node-fetch');
      let cmd;
      if (effectId === 'static') {
        cmd = { name: 'turn', value: 'on' };
      } else {
        cmd = { name: 'scene', value: this._mapCloudScene(effectId) };
      }

      const resp = await fetch('https://developer-api.govee.com/v1/devices/control', {
        method: 'PUT',
        headers: {
          'Govee-API-Key': lamp.api_key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          device: lamp.address,
          model: lamp.name,
          cmd
        })
      });
      if (!resp.ok) throw new Error(`Cloud API: ${resp.status}`);
      db.updateLampSeen(lamp.id);
      return true;
    } catch (e) {
      db.log('ERROR', 'govee', `Cloud effect failed: ${e.message}`);
      return false;
    }
  }

  async setOff(lamp) {
    if (lamp.api_key) {
      try {
        const { default: fetch } = await import('node-fetch');
        await fetch('https://developer-api.govee.com/v1/devices/control', {
          method: 'PUT',
          headers: {
            'Govee-API-Key': lamp.api_key,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            device: lamp.address,
            model: lamp.name,
            cmd: { name: 'turn', value: 'off' }
          })
        });
        return true;
      } catch (e) {
        db.log('ERROR', 'govee', e.message);
        return false;
      }
    }
    try {
      await this._sendLanCommand(lamp.address, {
        msg: { cmd: 'turn', data: { value: 0 } }
      });
      return true;
    } catch (e) {
      db.log('ERROR', 'govee', e.message);
      return false;
    }
  }

  // Send UDP command to Govee LAN device
  _sendLanCommand(ip, command) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const msg = Buffer.from(JSON.stringify(command));

      socket.send(msg, GOVEE_LAN_PORT, ip, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });

      setTimeout(() => {
        socket.close();
        reject(new Error('Govee LAN timeout'));
      }, 3000);
    });
  }

  // Ping via LAN
  async ping(address, apiKey = null) {
    if (apiKey) {
      try {
        const { default: fetch } = await import('node-fetch');
        const resp = await fetch('https://developer-api.govee.com/v1/devices/state', {
          headers: { 'Govee-API-Key': apiKey }
        });
        return resp.ok;
      } catch {
        return false;
      }
    }
    try {
      await this._sendLanCommand(address, {
        msg: { cmd: 'scan', data: {} }
      });
      return true;
    } catch {
      return false;
    }
  }

  _mapLanEffectType(effectId) {
    const map = {
      'static': 1,
      'color_preset': 2,
      'rgb': 3,
      'gradient': 4,
      'scene_nightlight': 5,
      'scene_romantic': 6,
    };
    return map[effectId] || 1;
  }

  _mapCloudScene(effectId) {
    const map = {
      'scene_nightlight': 1,
      'scene_romantic': 2,
      'scene_blinking': 3,
      'scene_candle': 4,
      'scene_rainbow': 5,
      'scene_sunrise': 6,
    };
    return map[effectId] || 1;
  }
}

module.exports = GoveeController;
