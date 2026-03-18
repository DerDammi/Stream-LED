const db = require('./database');
const WLEDController = require('./lamps/wled');
const GoveeController = require('./lamps/govee');

class EffectManager {
  constructor() {
    this.wled = new WLEDController();
    this.govee = new GoveeController();
    this.healthTimer = null;
    this.runtime = {
      activeOnlineStreamer: null,
      activeChatRuleId: null,
      activeChatRuleName: null,
      lampStates: new Map()
    };
  }

  initialize() {
    this.startHealthChecks();
  }

  startHealthChecks() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    const seconds = Math.max(10, db.getSetting('healthcheck_seconds', 30));
    this.healthTimer = setInterval(() => this.healthCheck().catch(() => {}), seconds * 1000);
  }

  getController(type) {
    return type === 'govee' ? this.govee : this.wled;
  }

  async refreshLampEffects(lampId) {
    const lamp = db.getLamp(lampId);
    if (!lamp || !lamp.enabled) return null;
    const result = await this.getController(lamp.type).discoverEffects(lamp);
    if (result?.effects) db.updateLampEffects(lamp.id, result.effects);
    return result;
  }

  async refreshAllLampEffects() {
    const lamps = db.getAllLamps().filter((lamp) => lamp.enabled);
    for (const lamp of lamps) {
      try { await this.refreshLampEffects(lamp.id); } catch {}
    }
  }

  async healthCheck() {
    const lamps = db.getAllLamps().filter((lamp) => lamp.enabled);
    for (const lamp of lamps) {
      try {
        const online = await this.getController(lamp.type).ping(lamp.address, lamp.api_key);
        const wasOnline = !!lamp.last_seen;
        db.updateLampSeen(lamp.id, online);
        if (online && !wasOnline) db.log('INFO', 'health', `${lamp.name} wieder online`);
        if (!online && wasOnline) db.log('WARN', 'health', `${lamp.name} nicht erreichbar`);
      } catch {}
    }
  }

  getLampSummary() {
    const lamps = db.getAllLamps();
    const output = {};
    for (const lamp of lamps) {
      output[lamp.id] = {
        lamp,
        state: this.runtime.lampStates.get(lamp.id) || null
      };
    }
    return output;
  }

  async applyResolvedState({ onlineRule, chatRule }) {
    const lamps = db.getAllLamps().filter((lamp) => lamp.enabled && lamp.last_seen);
    const desired = new Map();

    if (onlineRule?.targets?.length) {
      this.runtime.activeOnlineStreamer = onlineRule.streamer_login;
      for (const target of onlineRule.targets) desired.set(target.lamp_id, { ...target, source: `online:${onlineRule.streamer_login}` });
    } else {
      this.runtime.activeOnlineStreamer = null;
    }

    if (chatRule?.targets?.length) {
      this.runtime.activeChatRuleId = chatRule.id;
      this.runtime.activeChatRuleName = chatRule.name;
      for (const target of chatRule.targets) desired.set(target.lamp_id, { ...target, source: `chat:${chatRule.name}` });
    } else {
      this.runtime.activeChatRuleId = null;
      this.runtime.activeChatRuleName = null;
    }

    for (const lamp of lamps) {
      const target = desired.get(lamp.id);
      if (!target) {
        const prev = this.runtime.lampStates.get(lamp.id);
        if (prev?.source !== 'off') {
          await this.getController(lamp.type).setOff(lamp);
          this.runtime.lampStates.set(lamp.id, { source: 'off' });
        }
        continue;
      }

      const nextState = {
        source: target.source,
        mode: target.mode || 'static',
        color: target.color || '#ffffff',
        effect_name: target.effect_name || '',
        effect_speed: Number(target.effect_speed || 128),
        effect_intensity: Number(target.effect_intensity || 128)
      };

      const prev = this.runtime.lampStates.get(lamp.id);
      if (JSON.stringify(prev) === JSON.stringify(nextState)) continue;

      if (nextState.mode === 'effect' && nextState.effect_name) {
        await this.getController(lamp.type).setEffect(lamp, nextState.effect_name, {
          speed: nextState.effect_speed,
          intensity: nextState.effect_intensity
        });
      } else {
        await this.getController(lamp.type).setColor(lamp, nextState.color);
      }
      this.runtime.lampStates.set(lamp.id, nextState);
    }
  }

  async setLampColor(lampId, color) {
    const lamp = db.getLamp(lampId);
    if (!lamp) return false;
    return this.getController(lamp.type).setColor(lamp, color);
  }

  async setLampEffect(lampId, effectName, opts = {}) {
    const lamp = db.getLamp(lampId);
    if (!lamp) return false;
    return this.getController(lamp.type).setEffect(lamp, effectName, opts);
  }

  async setLampOff(lampId) {
    const lamp = db.getLamp(lampId);
    if (!lamp) return false;
    return this.getController(lamp.type).setOff(lamp);
  }

  destroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }
}

module.exports = EffectManager;
