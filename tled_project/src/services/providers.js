import axios from 'axios';
import dgram from 'dgram';
import { logger } from '../utils/logger.js';

const goveeEffectPresets = {
  default: ['Rainbow', 'Sunset', 'Ocean', 'Meteor', 'Aurora', 'Warm', 'Party'],
  H61: ['Rainbow', 'Sunset', 'Meteor', 'Aurora', 'Breath'],
  H60: ['Rainbow', 'Ocean', 'Warm', 'Party'],
  H70: ['Rainbow', 'Sunset', 'Meteor', 'Sparkle']
};

async function setWledState(lamp, payload) {
  const state = { on: true, seg: [{ id: 0 }] };
  if (payload.mode === 'static') {
    state.seg[0].fx = 0; state.seg[0].sx = 128; state.seg[0].ix = 128;
  } else if (typeof payload.effectId === 'number') {
    state.seg[0].fx = payload.effectId;
  }
  if (payload.color) state.seg[0].col = [[payload.color.r, payload.color.g, payload.color.b]];
  await axios.post(`http://${lamp.host}/json/state`, state, { timeout: 4000 });
}
async function fetchWledEffects(lamp) {
  const { data } = await axios.get(`http://${lamp.host}/json/effects`, { timeout: 4000 });
  return Array.isArray(data) ? data.map((name, index) => ({ id: index, name })) : [];
}
function sendGoveeUdp(message, host) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const buffer = Buffer.from(JSON.stringify(message));
    client.send(buffer, 4003, host, (error) => { client.close(); if (error) reject(error); else resolve(); });
  });
}
async function setGoveeState(lamp, payload) {
  if (!lamp.host || !lamp.sku) throw new Error('Govee-Lampe benötigt host und sku für LAN-Steuerung.');
  if (payload.mode === 'static' && payload.color) {
    await sendGoveeUdp({ msg: { cmd: 'colorwc', data: { color: payload.color, colorTemInKelvin: 0 } } }, lamp.host);
    return;
  }
  if (payload.mode === 'effect' && payload.effectName) {
    await sendGoveeUdp({ msg: { cmd: 'ptReal', data: { command: payload.effectName } } }, lamp.host);
  }
}
function getGoveeEffectsForSku(sku = '', customEffects = []) {
  if (customEffects?.length) return customEffects.map((name, index) => ({ id: index, name }));
  const normalized = sku.toUpperCase();
  const prefix = Object.keys(goveeEffectPresets).find((key) => key !== 'default' && normalized.startsWith(key));
  const list = prefix ? goveeEffectPresets[prefix] : goveeEffectPresets.default;
  return list.map((name, index) => ({ id: index, name }));
}
async function fetchGoveeEffects(lamp) { return getGoveeEffectsForSku(lamp.sku, lamp.customEffects); }

async function setHueState(lamp, payload) {
  if (!lamp.bridgeIp || !lamp.hueUsername || !lamp.hueLightId) throw new Error('Hue benötigt bridgeIp, hueUsername und hueLightId.');
  const body = { on: true };
  if (payload.color) {
    const { x, y } = rgbToXy(payload.color.r, payload.color.g, payload.color.b);
    body.xy = [x, y];
    body.bri = 254;
  }
  await axios.put(`http://${lamp.bridgeIp}/api/${lamp.hueUsername}/lights/${lamp.hueLightId}/state`, body, { timeout: 5000 });
}
async function fetchHueEffects() { return []; }
function rgbToXy(r, g, b) {
  let rn = r / 255, gn = g / 255, bn = b / 255;
  rn = rn > 0.04045 ? ((rn + 0.055) / 1.055) ** 2.4 : rn / 12.92;
  gn = gn > 0.04045 ? ((gn + 0.055) / 1.055) ** 2.4 : gn / 12.92;
  bn = bn > 0.04045 ? ((bn + 0.055) / 1.055) ** 2.4 : bn / 12.92;
  const x = rn * 0.664511 + gn * 0.154324 + bn * 0.162028;
  const y = rn * 0.283881 + gn * 0.668433 + bn * 0.047685;
  const z = rn * 0.000088 + gn * 0.07231 + bn * 0.986039;
  return { x: x / (x + y + z), y: y / (x + y + z) };
}

export async function discoverHueBridges() {
  const { data } = await axios.get('https://discovery.meethue.com/', { timeout: 5000 });
  return Array.isArray(data) ? data : [];
}
export async function pairHueBridge(bridgeIp) {
  const { data } = await axios.post(`http://${bridgeIp}/api`, { devicetype: 'streamlight_orchestrator#local' }, { timeout: 5000 });
  return data;
}
export async function fetchHueLights(bridgeIp, username) {
  const { data } = await axios.get(`http://${bridgeIp}/api/${username}/lights`, { timeout: 5000 });
  return Object.entries(data || {}).map(([id, value]) => ({ id, name: value.name }));
}

export async function discoverGoveeDevices(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const devices = new Map();
    const socket = dgram.createSocket('udp4');
    socket.on('message', (message, remote) => {
      try {
        const parsed = JSON.parse(message.toString());
        const data = parsed?.msg?.data || parsed?.data || {};
        const sku = data.sku || data.device || data.model || '';
        devices.set(remote.address, {
          host: remote.address,
          sku,
          device: data.device || data.deviceName || '',
          name: data.deviceName || data.model || `Govee ${sku || remote.address}`,
          effects: getGoveeEffectsForSku(sku)
        });
      } catch {}
    });
    socket.on('error', () => resolve([]));
    socket.bind(() => {
      socket.setBroadcast(true);
      const scanMessage = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
      socket.send(scanMessage, 4001, '255.255.255.255');
    });
    setTimeout(() => { try { socket.close(); } catch {} resolve([...devices.values()]); }, timeoutMs);
  });
}

export const providers = {
  wled: { setState: setWledState, fetchEffects: fetchWledEffects },
  govee: { setState: setGoveeState, fetchEffects: fetchGoveeEffects },
  hue: { setState: setHueState, fetchEffects: fetchHueEffects }
};

export async function testLampReachability(lamp) {
  try {
    if (lamp.provider === 'wled') {
      await axios.get(`http://${lamp.host}/json/info`, { timeout: 3000 });
      return true;
    }
    if (lamp.provider === 'govee') {
      if (!lamp.host) return false;
      await sendGoveeUdp({ msg: { cmd: 'devStatus', data: {} } }, lamp.host);
      return true;
    }
    if (lamp.provider === 'hue') {
      await axios.get(`http://${lamp.bridgeIp}/api/${lamp.hueUsername}/lights/${lamp.hueLightId}`, { timeout: 3000 });
      return true;
    }
    return false;
  } catch (error) {
    logger.errorOnce(`lamp-${lamp.id}-offline`, 'Lampe nicht erreichbar', { lamp: lamp.name, error: error.message });
    return false;
  }
}
