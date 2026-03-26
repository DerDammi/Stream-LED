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
    this.runtimeStateProvider = null;
    this.runtime = {
      activeOnlineStreamer: null,
      activeChatRuleId: null,
      activeChatRuleName: null,
      lampStates: new Map(),
      desiredLampStates: new Map(),
      testOverrides: new Map(),
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
  setRuntimeStateProvider(provider) { this.runtimeStateProvider = typeof provider === 'function' ? provider : null; }

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

  normalizeRuntimeTarget(target = {}) {
    const usesSegmentColors = target.segment_mode === 'selected' && Array.isArray(target.segment_ids) && target.segment_ids.length > 0;
    const segmentColors = Array.isArray(target.segment_colors) ? target.segment_colors : [];
    return {
      source: target.source,
      mode: target.mode || 'static',
      color: usesSegmentColors ? (segmentColors[0]?.color || '#9147ff') : (target.color || '#ffffff'),
      color_overridden_by_segments: usesSegmentColors,
      effect_name: target.effect_name || '',
      effect_speed: Number(target.effect_speed || 128),
      effect_intensity: Number(target.effect_intensity || 128),
      rotation_seconds: Number(target.rotation_seconds || db.getSetting('rotation_seconds', 20) || 20),
      streamer_login: target.streamer_login || null,
      segment_mode: target.segment_mode === 'selected' ? 'selected' : 'all',
      segment_ids: Array.isArray(target.segment_ids) ? target.segment_ids : [],
      segment_colors: segmentColors
    };
  }

  getActiveTestOverride(lampId) {
    const current = this.runtime.testOverrides.get(lampId);
    if (!current) return null;
    if (current.expiresAt <= Date.now()) {
      this.clearTemporaryLampOverride(lampId, { reapply: true }).catch(() => {});
      return null;
    }
    return current;
  }

  async applyLampState(lamp, nextState) {
    if (!lamp || !nextState) return false;
    if (nextState.source === 'off' || nextState.source === 'test:off' || nextState.off === true) return this.getController(lamp.type).setOff(lamp);
    if (nextState.mode === 'effect' && nextState.effect_name) {
      return this.getController(lamp.type).setEffect(lamp, nextState.effect_name, {
        speed: nextState.effect_speed,
        intensity: nextState.effect_intensity,
        primaryColor: nextState.color,
        segment_mode: nextState.segment_mode,
        segment_ids: nextState.segment_ids,
        segment_colors: nextState.segment_colors
      });
    }
    return this.getController(lamp.type).setColor(lamp, nextState.color, {
      segment_mode: nextState.segment_mode,
      segment_ids: nextState.segment_ids,
      segment_colors: nextState.segment_colors
    });
  }

  async setTemporaryLampOverride(lampId, nextState, options = {}) {
    const lamp = db.getLamp(lampId);
    if (!lamp) return false;
    const durationMs = Math.max(1000, Number(options.durationMs || options.duration_ms || 10000));
    const existing = this.runtime.testOverrides.get(lampId);
    if (existing?.timer) clearTimeout(existing.timer);
    const overrideState = { ...nextState, is_test_override: true, source: nextState.source || 'test' };
    const timer = setTimeout(() => {
      this.clearTemporaryLampOverride(lampId, { reapply: true }).catch(() => {});
    }, durationMs);
    this.runtime.testOverrides.set(lampId, { state: overrideState, expiresAt: Date.now() + durationMs, timer });
    const ok = await this.applyLampState(lamp, overrideState);
    if (ok) this.runtime.lampStates.set(lamp.id, overrideState);
    return ok;
  }

  async clearTemporaryLampOverride(lampId, options = {}) {
    const existing = this.runtime.testOverrides.get(lampId);
    if (!existing) return false;
    if (existing.timer) clearTimeout(existing.timer);
    this.runtime.testOverrides.delete(lampId);
    if (options.reapply === false) return true;
    return this.reapplyCurrentRuntimeState({ lampId });
  }

  async reapplyCurrentRuntimeState(options = {}) {
    const lampId = options.lampId || null;
    if (this.runtimeStateProvider) {
      const state = await this.runtimeStateProvider();
      return this.applyResolvedState({ ...state, lampIdFilter: lampId ? new Set([lampId]) : null });
    }
    const lamp = lampId ? db.getLamp(lampId) : null;
    if (lamp && this.runtime.desiredLampStates.has(lampId)) {
      const desired = this.runtime.desiredLampStates.get(lampId);
      const ok = await this.applyLampState(lamp, desired);
      if (ok) this.runtime.lampStates.set(lamp.id, desired);
      return ok;
    }
    if (lamp) {
      const ok = await this.getController(lamp.type).setOff(lamp);
      if (ok) this.runtime.lampStates.set(lamp.id, { source: 'off' });
      return ok;
    }
    return false;
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
    if (lamp.type === 'wled' && result?.segment_count) db.saveLamp({ ...lamp, metadata: { ...(lamp.metadata || {}), segment_count: Math.max(1, Number(result.segment_count || 1)) } });
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
      const testOverride = this.getActiveTestOverride(lamp.id);
      output[lamp.id] = {
        lamp,
        state: this.runtime.lampStates.get(lamp.id) || null,
        desiredState: this.runtime.desiredLampStates.get(lamp.id) || null,
        testOverride: testOverride ? { ...testOverride.state, expiresAt: new Date(testOverride.expiresAt).toISOString() } : null,
        diagnostics: this.runtime.diagnostics.lampChecks.get(lamp.id) || null
      };
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

  resolveLampOnlineTarget(lamp, onlineState = {}) {
    const activeRules = Array.isArray(onlineState.activeRules) ? onlineState.activeRules : [];
    const candidates = activeRules
      .map((rule) => {
        const target = (Array.isArray(rule.targets) ? rule.targets : []).find((entry) => entry.lamp_id === lamp.id);
        if (!target) return null;
        return {
          ...target,
          source: `online:${rule.streamer_login}`,
          streamer_login: rule.streamer_login,
          rule_id: rule.id,
          rotation_seconds: Math.max(5, Number(target.rotation_seconds || db.getSetting('rotation_seconds', 20) || 20))
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(a.streamer_login || '').localeCompare(String(b.streamer_login || '')) || String(a.rule_id).localeCompare(String(b.rule_id)));

    if (!candidates.length) return null;
    if (candidates.length === 1) return { selected: candidates[0], candidates };

    const startMs = Number(onlineState.rotationStartedAt || Date.now());
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    const totalCycle = candidates.reduce((sum, item) => sum + Math.max(5, Number(item.rotation_seconds || 20)), 0);
    let position = totalCycle > 0 ? elapsedSeconds % totalCycle : 0;
    let selected = candidates[0];
    for (const item of candidates) {
      const stay = Math.max(5, Number(item.rotation_seconds || 20));
      if (position < stay) {
        selected = item;
        break;
      }
      position -= stay;
    }
    return { selected, candidates };
  }

  async applyResolvedState({ onlineState, chatRule, dryRun = false, lampIdFilter = null }) {
    const lamps = db.getAllLamps().filter((lamp) => lamp.enabled && (lamp.last_seen || (lampIdFilter && lampIdFilter.has(lamp.id))) && (!lampIdFilter || lampIdFilter.has(lamp.id)));
    const activeOnlineRules = Array.isArray(onlineState?.activeRules) ? onlineState.activeRules : [];
    const activeOnlineStreamers = [...new Set(activeOnlineRules.map((rule) => rule.streamer_login).filter(Boolean))];
    this.runtime.activeOnlineStreamer = activeOnlineStreamers.length ? activeOnlineStreamers.join(', ') : null;

    if (chatRule?.targets?.length) {
      this.runtime.activeChatRuleId = chatRule.id;
      this.runtime.activeChatRuleName = chatRule.name;
    } else {
      this.runtime.activeChatRuleId = null;
      this.runtime.activeChatRuleName = null;
    }

    const desired = new Map();
    const onlineCandidatesByLamp = new Map();
    for (const lamp of lamps) {
      const resolvedOnline = this.resolveLampOnlineTarget(lamp, onlineState);
      if (resolvedOnline) {
        onlineCandidatesByLamp.set(lamp.id, resolvedOnline.candidates);
        desired.set(lamp.id, resolvedOnline.selected);
      }
    }

    const conflicts = [];
    if (chatRule?.targets?.length) {
      for (const target of chatRule.targets) {
        if (lampIdFilter && !lampIdFilter.has(target.lamp_id)) continue;
        const onlineCandidates = onlineCandidatesByLamp.get(target.lamp_id) || [];
        if (onlineCandidates.length) {
          const lamp = db.getLamp(target.lamp_id);
          conflicts.push({
            lamp_id: target.lamp_id,
            lamp_name: lamp?.name || target.lamp_id,
            online_sources: onlineCandidates.map((entry) => entry.source),
            chat_source: `chat:${chatRule.name}`,
            winner: 'chat'
          });
        }
        desired.set(target.lamp_id, { ...target, source: `chat:${chatRule.name}` });
      }
    }

    const actions = [];
    for (const lamp of lamps) {
      const target = desired.get(lamp.id);
      if (!target) {
        this.runtime.desiredLampStates.set(lamp.id, { source: 'off' });
        const testOverride = this.getActiveTestOverride(lamp.id);
        if (testOverride) {
          actions.push({ lamp_id: lamp.id, lamp_name: lamp.name, action: 'test-override-active', nextState: testOverride.state });
          continue;
        }
        const prev = this.runtime.lampStates.get(lamp.id);
        if (prev?.source !== 'off') actions.push({ lamp_id: lamp.id, lamp_name: lamp.name, action: 'off', reason: 'keine aktive Szene oder Regel' });
        if (!dryRun && prev?.source !== 'off') {
          await this.getController(lamp.type).setOff(lamp);
          this.runtime.lampStates.set(lamp.id, { source: 'off' });
        }
        continue;
      }
      const nextState = this.normalizeRuntimeTarget(target);
      this.runtime.desiredLampStates.set(lamp.id, nextState);
      const testOverride = this.getActiveTestOverride(lamp.id);
      if (testOverride) {
        actions.push({ lamp_id: lamp.id, lamp_name: lamp.name, action: 'test-override-active', nextState: testOverride.state, deferredState: nextState });
        continue;
      }
      const prev = this.runtime.lampStates.get(lamp.id);
      if (JSON.stringify(prev) === JSON.stringify(nextState)) {
        actions.push({ lamp_id: lamp.id, lamp_name: lamp.name, action: 'unchanged', nextState });
        continue;
      }
      actions.push({ lamp_id: lamp.id, lamp_name: lamp.name, action: nextState.mode === 'effect' && nextState.effect_name ? 'effect' : 'color', nextState });
      if (dryRun) continue;
      await this.applyLampState(lamp, nextState);
      this.runtime.lampStates.set(lamp.id, nextState);
    }
    this.runtime.diagnostics.lastApplyAt = new Date().toISOString();
    this.runtime.diagnostics.lastApplySummary = {
      onlineRule: activeOnlineStreamers.length ? activeOnlineStreamers : null,
      chatRule: chatRule ? chatRule.name : null,
      priority: 'chat-overrides-online',
      conflicts,
      actions: actions.length,
      dryRun,
      perLampRotation: true,
      liveOnlineRules: activeOnlineRules.length,
      testOverrides: this.runtime.testOverrides.size
    };
    return {
      onlineRule: activeOnlineStreamers.length ? { streamer_login: activeOnlineStreamers.join(', '), streamer_logins: activeOnlineStreamers } : null,
      chatRule: chatRule ? { id: chatRule.id, name: chatRule.name } : null,
      conflicts,
      priority: 'chat-overrides-online',
      actions,
      dryRun
    };
  }

  async previewTarget(target, options = {}) {
    const lamp = db.getLamp(target.lamp_id);
    if (!lamp) throw new Error('Lampe für Vorschau nicht gefunden.');
    if (options.dryRun) return { lamp_id: lamp.id, lamp_name: lamp.name, dryRun: true, target };
    const state = this.normalizeRuntimeTarget({ ...target, source: options.source || 'test:preview' });
    const ok = await this.setTemporaryLampOverride(lamp.id, state, options);
    return { lamp_id: lamp.id, lamp_name: lamp.name, dryRun: false, target: state, expiresAt: new Date(Date.now() + Math.max(1000, Number(options.durationMs || options.duration_ms || 10000))).toISOString(), success: ok };
  }

  async setLampColor(lampId, color, opts = {}) {
    return this.setTemporaryLampOverride(lampId, this.normalizeRuntimeTarget({ source: 'test:color', mode: 'static', color, segment_mode: opts.segment_mode, segment_ids: opts.segment_ids, segment_colors: opts.segment_colors }), opts);
  }

  async setLampEffect(lampId, effectName, opts = {}) {
    return this.setTemporaryLampOverride(lampId, this.normalizeRuntimeTarget({ source: 'test:effect', mode: 'effect', color: opts.primaryColor, effect_name: effectName, effect_speed: opts.speed, effect_intensity: opts.intensity, segment_mode: opts.segment_mode, segment_ids: opts.segment_ids, segment_colors: opts.segment_colors }), opts);
  }

  async setLampOff(lampId, opts = {}) {
    return this.setTemporaryLampOverride(lampId, { source: 'test:off', mode: 'static' }, opts);
  }

  destroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const override of this.runtime.testOverrides.values()) {
      if (override?.timer) clearTimeout(override.timer);
    }
    this.runtime.testOverrides.clear();
  }
}

module.exports = EffectManager;
