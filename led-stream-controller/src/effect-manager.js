const db = require('./database');
const WLEDController = require('./lamps/wled');
const GoveeController = require('./lamps/govee');
const HueController = require('./lamps/hue');

class EffectManager {
  constructor() {
    this.wled = new WLEDController();
    this.govee = new GoveeController();
    this.hue = new HueController();
    this.healthTimer = null;
    this.runtime = {
      activeOnlineStreamer: null,
      activeChatRuleId: null,
      activeChatRuleName: null,
      lampStates: new Map(),
      diagnostics: {
        lastHealthCheckAt: null,
        lastHealthCheckSuccessAt: null,
        lastHealthCheckError: null,
        lastDiscoveryAt: null,
        lastDiscoverySummary: null,
        lastApplyAt: null,
        lastApplySummary: null,
        lampChecks: new Map()
      }
    };
  }

  initialize() { this.startHealthChecks(); }
  startHealthChecks() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    const seconds = Math.max(10, db.getSetting('healthcheck_seconds', 30));
    this.healthTimer = setInterval(() => this.healthCheck().catch(() => {}), seconds * 1000);
  }

  getController(type) {
    if (type === 'govee') return this.govee;
    if (type === 'hue') return this.hue;
    return this.wled;
  }

  async discoverLamps(options = {}) {
    const startedAt = new Date().toISOString();
    const [wled, govee, hue] = await Promise.all([
      options.includeWled === false ? [] : this.wled.discoverDevices(options.wled || {}).catch(() => []),
      options.includeGovee === false ? [] : this.govee.discoverDevices(options.govee || {}).catch(() => []),
      options.includeHue === false ? [] : this.hue.discoverBridges().catch(() => [])
    ]);
    const result = { startedAt, finishedAt: new Date().toISOString(), devices: { wled, govee, hue }, counts: { wled: wled.length, govee: govee.length, hue: hue.length } };
    this.runtime.diagnostics.lastDiscoveryAt = result.finishedAt;
    this.runtime.diagnostics.lastDiscoverySummary = result.counts;
    return result;
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
    this.runtime.diagnostics.lastHealthCheckAt = new Date().toISOString();
    for (const lamp of lamps) {
      try {
        const online = await this.getController(lamp.type).ping(lamp.address, lamp.api_key);
        const now = new Date().toISOString();
        const previous = this.runtime.diagnostics.lampChecks.get(lamp.id);
        const wasOnline = !!lamp.last_seen;
        db.updateLampSeen(lamp.id, online);
        this.runtime.diagnostics.lampChecks.set(lamp.id, {
          lamp_id: lamp.id,
          name: lamp.name,
          type: lamp.type,
          address: lamp.address,
          online,
          checkedAt: now,
          successAt: online ? now : previous?.successAt || null,
          error: online ? null : 'Lampe nicht erreichbar'
        });
        if (online && !wasOnline) db.log('INFO', 'health', `${lamp.name} wieder online`);
        if (!online && wasOnline) db.log('WARN', 'health', `${lamp.name} nicht erreichbar`);
      } catch (error) {
        this.runtime.diagnostics.lampChecks.set(lamp.id, {
          lamp_id: lamp.id,
          name: lamp.name,
          type: lamp.type,
          address: lamp.address,
          online: false,
          checkedAt: new Date().toISOString(),
          successAt: this.runtime.diagnostics.lampChecks.get(lamp.id)?.successAt || null,
          error: error.message
        });
      }
    }
    this.runtime.diagnostics.lastHealthCheckSuccessAt = new Date().toISOString();
    this.runtime.diagnostics.lastHealthCheckError = null;
  }

  async diagnoseLamp(lampId) {
    const lamp = db.getLamp(lampId);
    if (!lamp) throw new Error('Lampe nicht gefunden.');
    const controller = this.getController(lamp.type);
    const pingOk = await controller.ping(lamp.address, lamp.api_key).catch(() => false);
    db.updateLampSeen(lamp.id, pingOk);
    let effectRefresh = null;
    let refreshError = null;
    try { effectRefresh = await this.refreshLampEffects(lamp.id); } catch (error) { refreshError = error.message; }
    const diagnostics = {
      lamp_id: lamp.id,
      pingOk,
      checkedAt: new Date().toISOString(),
      effectCount: Array.isArray(effectRefresh?.effects) ? effectRefresh.effects.length : (db.getLamp(lamp.id)?.effects || []).length,
      info: effectRefresh?.info || null,
      refreshError,
      hint: pingOk
        ? (lamp.type === 'wled'
          ? 'Lampe antwortet. Falls Effekte fehlen, prüfe ob WLED unter /json erreichbar ist.'
          : lamp.type === 'govee'
            ? 'Lampe antwortet. Bei Govee sind lokale Effektlisten oft nur Presets – das ist normal.'
            : 'Hue Bridge antwortet. Für Lampensteuerung fehlt meist nur noch ein erzeugter API-Benutzer per Link-Button.')
        : (lamp.type === 'wled'
          ? 'Nicht erreichbar. Prüfe IP/Hostname, ob WLED im gleichen Netz hängt und ob http://IP/json im Browser geht.'
          : lamp.type === 'govee'
            ? 'Nicht erreichbar. Prüfe IP/Device-ID, gleiches LAN und ggf. API-Key/LAN-Control in der Govee-App.'
            : 'Nicht erreichbar. Prüfe Bridge-IP, LAN und ob die Hue Bridge eingeschaltet ist.')
    };
    this.runtime.diagnostics.lampChecks.set(lamp.id, {
      lamp_id: lamp.id,
      name: lamp.name,
      type: lamp.type,
      address: lamp.address,
      online: pingOk,
      checkedAt: diagnostics.checkedAt,
      successAt: pingOk ? diagnostics.checkedAt : this.runtime.diagnostics.lampChecks.get(lamp.id)?.successAt || null,
      error: pingOk ? null : diagnostics.hint
    });
    return diagnostics;
  }

  getLampSummary() {
    const lamps = db.getAllLamps();
    const output = {};
    for (const lamp of lamps) {
      output[lamp.id] = { lamp, state: this.runtime.lampStates.get(lamp.id) || null, diagnostics: this.runtime.diagnostics.lampChecks.get(lamp.id) || null };
    }
    return output;
  }

  getDiagnostics() {
    return {
      lastHealthCheckAt: this.runtime.diagnostics.lastHealthCheckAt,
      lastHealthCheckSuccessAt: this.runtime.diagnostics.lastHealthCheckSuccessAt,
      lastHealthCheckError: this.runtime.diagnostics.lastHealthCheckError,
      lastDiscoveryAt: this.runtime.diagnostics.lastDiscoveryAt,
      lastDiscoverySummary: this.runtime.diagnostics.lastDiscoverySummary,
      lastApplyAt: this.runtime.diagnostics.lastApplyAt,
      lastApplySummary: this.runtime.diagnostics.lastApplySummary,
      lamps: [...this.runtime.diagnostics.lampChecks.values()]
    };
  }

  async applyResolvedState({ onlineRule, chatRule, dryRun = false }) {
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

    const actions = [];
    for (const lamp of lamps) {
      const target = desired.get(lamp.id);
      if (!target) {
        const prev = this.runtime.lampStates.get(lamp.id);
        if (prev?.source !== 'off') actions.push({ lamp_id: lamp.id, lamp_name: lamp.name, action: 'off', reason: 'keine aktive Szene oder Regel' });
        if (!dryRun && prev?.source !== 'off') {
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
      if (JSON.stringify(prev) === JSON.stringify(nextState)) {
        actions.push({ lamp_id: lamp.id, lamp_name: lamp.name, action: 'unchanged', nextState });
        continue;
      }
      actions.push({ lamp_id: lamp.id, lamp_name: lamp.name, action: nextState.mode === 'effect' && nextState.effect_name ? 'effect' : 'color', nextState });
      if (dryRun) continue;
      if (nextState.mode === 'effect' && nextState.effect_name) {
        await this.getController(lamp.type).setEffect(lamp, nextState.effect_name, { speed: nextState.effect_speed, intensity: nextState.effect_intensity });
      } else {
        await this.getController(lamp.type).setColor(lamp, nextState.color);
      }
      this.runtime.lampStates.set(lamp.id, nextState);
    }
    this.runtime.diagnostics.lastApplyAt = new Date().toISOString();
    this.runtime.diagnostics.lastApplySummary = { onlineRule: onlineRule ? onlineRule.streamer_login : null, chatRule: chatRule ? chatRule.name : null, actions: actions.length, dryRun };
    return { onlineRule: onlineRule ? { id: onlineRule.id, streamer_login: onlineRule.streamer_login } : null, chatRule: chatRule ? { id: chatRule.id, name: chatRule.name } : null, actions, dryRun };
  }

  async previewTarget(target, options = {}) {
    const lamp = db.getLamp(target.lamp_id);
    if (!lamp) throw new Error('Lampe für Vorschau nicht gefunden.');
    if (options.dryRun) return { lamp_id: lamp.id, lamp_name: lamp.name, dryRun: true, target };
    if (target.mode === 'effect' && target.effect_name) {
      await this.getController(lamp.type).setEffect(lamp, target.effect_name, { speed: target.effect_speed, intensity: target.effect_intensity });
    } else {
      await this.getController(lamp.type).setColor(lamp, target.color || '#ffffff');
    }
    return { lamp_id: lamp.id, lamp_name: lamp.name, dryRun: false, target };
  }

  async setLampColor(lampId, color) { const lamp = db.getLamp(lampId); if (!lamp) return false; return this.getController(lamp.type).setColor(lamp, color); }
  async setLampEffect(lampId, effectName, opts = {}) { const lamp = db.getLamp(lampId); if (!lamp) return false; return this.getController(lamp.type).setEffect(lamp, effectName, opts); }
  async setLampOff(lampId) { const lamp = db.getLamp(lampId); if (!lamp) return false; return this.getController(lamp.type).setOff(lamp); }
  destroy() { if (this.healthTimer) clearInterval(this.healthTimer); }
}

module.exports = EffectManager;
