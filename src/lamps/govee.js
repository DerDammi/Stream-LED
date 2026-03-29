const dgram = require('dgram');
const net = require('net');
const db = require('../database');

const GOVEE_LAN_PORT = 4003;
const GOVEE_MULTICAST = { host: '239.255.255.250', port: 4001 };

function isIpv4(value = '') {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
}

function normalizeIp(value = '') {
  const raw = String(value || '').trim();
  return isIpv4(raw) ? raw : null;
}

function trimOrNull(value) {
  const text = String(value || '').trim();
  return text || null;
}

function uniqueById(list = []) {
  const seen = new Set();
  return list.filter((entry) => {
    const key = entry?.id || `${entry?.deviceId || ''}|${entry?.address || ''}|${entry?.model || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class GoveeController {
  constructor() {
    this.devices = new Map();
  }

  getMetadata(lamp = {}) {
    const metadata = lamp && typeof lamp.metadata === 'object' && !Array.isArray(lamp.metadata) ? lamp.metadata : {};
    const lanAddress = normalizeIp(metadata.lan_address || lamp.address);
    return {
      lanAddress,
      apiKey: trimOrNull(lamp.api_key),
      deviceId: trimOrNull(metadata.govee_device_id || metadata.device_id),
      model: trimOrNull(metadata.govee_model || metadata.model),
      sku: trimOrNull(metadata.govee_sku || metadata.sku),
      deviceName: trimOrNull(metadata.govee_device_name || metadata.device_name || lamp.name),
      supportsLan: metadata.govee_supports_lan === false ? false : true,
      retrievedVia: trimOrNull(metadata.govee_retrieved_via),
      cloudCapable: metadata.govee_cloud_capable === false ? false : true,
      raw: metadata
    };
  }

  describeTarget(lamp) {
    const meta = this.getMetadata(lamp);
    return `${lamp.name} (LAN ${meta.lanAddress || '-'} · Device ${meta.deviceId || '-'} · Model ${meta.model || meta.sku || '-'})`;
  }

  async discoverEffects(lamp) {
    const info = await this.getDeviceInfo(lamp).catch(() => null);
    return { effects: this._getPresetEffects(lamp, info), info };
  }

  async discoverDevices(options = {}) {
    const timeoutMs = Math.max(1200, Math.min(6000, Number(options.timeoutMs || 2200)));
    const found = [];
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve) => {
      socket.on('message', (msg, rinfo) => {
        try {
          const parsed = JSON.parse(msg.toString());
          const entry = this._parseLanDiscovery(parsed, rinfo.address);
          if (!entry || this.devices.has(entry.id)) return;
          this.devices.set(entry.id, entry);
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
    return uniqueById(found).sort((a, b) => String(a.address || '').localeCompare(String(b.address || '')) || String(a.name || '').localeCompare(String(b.name || '')));
  }

  async getDeviceInfo(lamp) {
    const meta = this.getMetadata(lamp);
    const lanInfo = meta.lanAddress && meta.supportsLan ? await this._fetchLanInfo(lamp).catch(() => null) : null;
    const cloudInfo = meta.apiKey ? await this._fetchCloudDevice(lamp).catch(() => null) : null;
    return this._mergeDeviceInfo(lamp, lanInfo, cloudInfo);
  }

  async setColor(lamp, color) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return this._performAction(lamp, {
      lan: () => this._lanSetColor(lamp, r, g, b),
      cloud: () => this._cloudSetColor(lamp, r, g, b),
      action: 'color'
    });
  }

  async setEffect(lamp, effectId, opts = {}) {
    if (opts.primaryColor && ['static', 'color_preset', 'gradient', 'rgb'].includes(String(effectId))) {
      await this.setColor(lamp, opts.primaryColor);
      if (String(effectId) === 'static' || String(effectId) === 'color_preset') return true;
    }
    return this._performAction(lamp, {
      lan: () => this._lanSetEffect(lamp, effectId, opts),
      cloud: () => this._cloudSetEffect(lamp, effectId, opts),
      action: 'effect'
    });
  }

  async setOff(lamp) {
    return this._performAction(lamp, {
      lan: async () => {
        await this._sendLanCommand(this.getMetadata(lamp).lanAddress, { msg: { cmd: 'turn', data: { value: 0 } } });
        db.updateLampSeen(lamp.id, true);
        return true;
      },
      cloud: async () => {
        const body = this._buildCloudCommandBody(lamp, { name: 'turn', value: 'off' });
        await this._cloudControl(lamp, body);
        db.updateLampSeen(lamp.id, true);
        return true;
      },
      action: 'off'
    });
  }

  async ping(address, apiKey = null, lamp = null) {
    const targetLamp = lamp || { address, api_key: apiKey, metadata: {} };
    const meta = this.getMetadata(targetLamp);
    const checks = [];
    if (meta.lanAddress && meta.supportsLan) checks.push(this._pingLan(meta.lanAddress));
    if (meta.apiKey) checks.push(this._pingCloud(targetLamp));
    if (!checks.length) return false;
    const results = await Promise.allSettled(checks);
    return results.some((entry) => entry.status === 'fulfilled' && entry.value === true);
  }

  async _performAction(lamp, handlers) {
    const meta = this.getMetadata(lamp);
    const attempts = [];
    if (meta.lanAddress && meta.supportsLan) attempts.push({ mode: 'lan', run: handlers.lan });
    if (meta.apiKey && meta.deviceId && meta.model && meta.cloudCapable) attempts.push({ mode: 'cloud', run: handlers.cloud });
    if (!attempts.length) {
      db.log('ERROR', 'govee', `${handlers.action} failed for ${this.describeTarget(lamp)}: no usable LAN IP or cloud deviceId/model configured`);
      return false;
    }
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const ok = await attempt.run();
        if (ok) return true;
      } catch (error) {
        lastError = error;
        db.log('WARN', 'govee', `${handlers.action} via ${attempt.mode} failed for ${this.describeTarget(lamp)}: ${error.message}`);
      }
    }
    db.log('ERROR', 'govee', `${handlers.action} failed for ${this.describeTarget(lamp)}${lastError ? `: ${lastError.message}` : ''}`);
    return false;
  }

  async _lanSetColor(lamp, r, g, b) {
    const lanAddress = this.getMetadata(lamp).lanAddress;
    if (!lanAddress) throw new Error('LAN address missing');
    await this._sendLanCommand(lanAddress, { msg: { cmd: 'colorwc', data: { color: { r, g, b } } } });
    db.updateLampSeen(lamp.id, true);
    return true;
  }

  async _cloudSetColor(lamp, r, g, b) {
    const body = this._buildCloudCommandBody(lamp, { name: 'color', value: { r, g, b } });
    await this._cloudControl(lamp, body);
    db.updateLampSeen(lamp.id, true);
    return true;
  }

  async _lanSetEffect(lamp, effectId) {
    const lanAddress = this.getMetadata(lamp).lanAddress;
    if (!lanAddress) throw new Error('LAN address missing');
    await this._sendLanCommand(lanAddress, { msg: { cmd: 'pt', data: { type: this._mapLanEffectType(effectId) } } });
    db.updateLampSeen(lamp.id, true);
    return true;
  }

  async _cloudSetEffect(lamp, effectId) {
    const cmd = effectId === 'static' ? { name: 'turn', value: 'on' } : { name: 'scene', value: this._mapCloudScene(effectId) };
    const body = this._buildCloudCommandBody(lamp, cmd);
    await this._cloudControl(lamp, body);
    db.updateLampSeen(lamp.id, true);
    return true;
  }

  async _cloudControl(lamp, body) {
    const meta = this.getMetadata(lamp);
    if (!meta.apiKey || !meta.deviceId || !meta.model) throw new Error('Cloud control requires API key, deviceId and model');
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch('https://developer-api.govee.com/v1/devices/control', {
      method: 'PUT',
      headers: { 'Govee-API-Key': meta.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Cloud API ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  _buildCloudCommandBody(lamp, cmd) {
    const meta = this.getMetadata(lamp);
    return { device: meta.deviceId, model: meta.model, cmd };
  }

  async _pingLan(ip) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch {}
        resolve(value);
      };
      socket.setTimeout(1200);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(GOVEE_LAN_PORT, ip);
    });
  }

  async _pingCloud(lamp) {
    const info = await this._fetchCloudDevice(lamp);
    return !!info;
  }

  async _fetchCloudDevice(lamp) {
    const meta = this.getMetadata(lamp);
    if (!meta.apiKey) return null;
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch('https://developer-api.govee.com/v1/devices', {
      headers: {
        'Govee-API-Key': meta.apiKey,
        'Content-Type': 'application/json'
      }
    });
    if (!resp.ok) throw new Error(`Govee Cloud API: ${resp.status}`);
    const data = await resp.json();
    const devices = Array.isArray(data?.data?.devices) ? data.data.devices : [];
    const match = devices.find((device) => {
      const deviceId = trimOrNull(device.device);
      const model = trimOrNull(device.model || device.sku);
      const ip = normalizeIp(device.ip);
      return (meta.deviceId && deviceId === meta.deviceId)
        || (meta.deviceId && meta.model && deviceId === meta.deviceId && model === meta.model)
        || (meta.lanAddress && ip === meta.lanAddress)
        || (meta.deviceName && trimOrNull(device.deviceName || device.device) === meta.deviceName)
        || (meta.model && model === meta.model && meta.lanAddress && ip === meta.lanAddress);
    }) || null;
    return match ? this._normalizeCloudDevice(match) : null;
  }

  async _fetchLanInfo(lamp) {
    const meta = this.getMetadata(lamp);
    const cacheKey = meta.deviceId || meta.lanAddress || lamp.address;
    if (cacheKey && this.devices.has(cacheKey)) return this.devices.get(cacheKey);
    const devices = await this.discoverDevices({ timeoutMs: 1500 }).catch(() => []);
    return devices.find((entry) => entry.deviceId === meta.deviceId || entry.address === meta.lanAddress || entry.name === lamp.name) || null;
  }

  _parseLanDiscovery(parsed, fallbackAddress) {
    const outer = parsed || {};
    const data = outer?.msg?.data || outer?.data || {};
    const deviceId = trimOrNull(data.device || data.deviceId || data.devId || outer.device);
    const model = trimOrNull(data.model || data.sku || outer.sku || outer.model);
    const sku = trimOrNull(data.sku || outer.sku || data.model || outer.model);
    const address = normalizeIp(data.ip || data.deviceIp || fallbackAddress) || fallbackAddress;
    const name = trimOrNull(data.deviceName || data.devName || data.device || deviceId || sku || `Govee ${address}`);
    const entry = {
      id: deviceId || address,
      type: 'govee',
      name,
      address,
      lanAddress: address,
      deviceId,
      model,
      sku,
      deviceName: name,
      supportsLan: true,
      retrievedVia: 'lan',
      cloudCapable: true,
      helper: 'Govee LAN-Gerät gefunden. Für Cloud-Steuerung zusätzlich Device ID + Model speichern; für lokale Steuerung reicht die LAN-IP bei kompatiblen Modellen.'
    };
    if (entry.id) this.devices.set(entry.id, entry);
    return entry;
  }

  _normalizeCloudDevice(device) {
    const address = normalizeIp(device.ip);
    return {
      id: trimOrNull(device.device) || address,
      type: 'govee',
      name: trimOrNull(device.deviceName || device.device) || `Govee ${trimOrNull(device.model || device.sku) || address || 'Device'}`,
      address,
      lanAddress: address,
      deviceId: trimOrNull(device.device),
      model: trimOrNull(device.model || device.sku),
      sku: trimOrNull(device.sku || device.model),
      deviceName: trimOrNull(device.deviceName || device.device),
      supportsLan: !!address,
      retrievedVia: 'cloud',
      cloudCapable: true,
      helper: 'Govee Cloud-Gerät erkannt. Für Cloud-Steuerung werden API-Key, Device ID und Model genutzt.'
    };
  }

  _mergeDeviceInfo(lamp, lanInfo, cloudInfo) {
    const meta = this.getMetadata(lamp);
    const merged = {
      name: lanInfo?.name || cloudInfo?.name || lamp.name,
      address: lanInfo?.address || cloudInfo?.address || meta.lanAddress || lamp.address || null,
      lanAddress: lanInfo?.lanAddress || cloudInfo?.lanAddress || meta.lanAddress || null,
      deviceId: lanInfo?.deviceId || cloudInfo?.deviceId || meta.deviceId || null,
      model: lanInfo?.model || cloudInfo?.model || meta.model || null,
      sku: lanInfo?.sku || cloudInfo?.sku || meta.sku || null,
      deviceName: lanInfo?.deviceName || cloudInfo?.deviceName || meta.deviceName || lamp.name,
      supportsLan: lanInfo?.supportsLan ?? cloudInfo?.supportsLan ?? !!meta.lanAddress,
      cloudCapable: cloudInfo?.cloudCapable ?? meta.cloudCapable,
      retrievedVia: lanInfo && cloudInfo ? 'lan+cloud' : lanInfo?.retrievedVia || cloudInfo?.retrievedVia || meta.retrievedVia || null
    };
    return Object.values(merged).some((value) => value != null && value !== false && value !== '') ? merged : null;
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

  _sendLanCommand(ip, command) {
    if (!ip) return Promise.reject(new Error('Missing Govee LAN IP'));
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
