import fs from 'fs-extra';
import path from 'path';

const dataDir = path.resolve('data');
const configPath = path.join(dataDir, 'config.json');
const SCHEMA_VERSION = 2;

const defaultScene = {
  mode: 'static',
  color: '#ffffff',
  effectId: 0,
  effectName: ''
};

function normalizeScene(input = {}) {
  return {
    mode: input.mode === 'effect' ? 'effect' : 'static',
    color: input.color || defaultScene.color,
    effectId: Number.isFinite(Number(input.effectId)) ? Number(input.effectId) : 0,
    effectName: String(input.effectName || '')
  };
}

function normalizeLamp(input = {}) {
  const provider = String(input.provider || 'wled').toLowerCase();
  const connection = {
    host: input.connection?.host || input.host || '',
    bridgeIp: input.connection?.bridgeIp || input.bridgeIp || ''
  };
  const providerConfig = {
    sku: input.providerConfig?.sku || input.sku || '',
    customEffects: Array.isArray(input.providerConfig?.customEffects)
      ? input.providerConfig.customEffects.filter(Boolean)
      : Array.isArray(input.customEffects)
        ? input.customEffects.filter(Boolean)
        : [],
    hueUsername: input.providerConfig?.hueUsername || input.hueUsername || '',
    hueLightId: input.providerConfig?.hueLightId || input.hueLightId || ''
  };

  return {
    id: input.id || '',
    name: input.name || 'Unbenannte Lampe',
    provider,
    connection,
    providerConfig,
    capabilities: {
      color: input.capabilities?.color ?? true,
      effects: input.capabilities?.effects ?? true
    },
    metadata: input.metadata || {},

    // Rückwärtskompatible Spiegel für vorhandenen Code/UI
    host: connection.host,
    bridgeIp: connection.bridgeIp,
    sku: providerConfig.sku,
    customEffects: providerConfig.customEffects,
    hueUsername: providerConfig.hueUsername,
    hueLightId: providerConfig.hueLightId
  };
}

function normalizeStreamer(input = {}) {
  const channels = Array.isArray(input.chat?.channels)
    ? input.chat.channels
    : Array.isArray(input.chatChannels)
      ? input.chatChannels
      : [];

  return {
    id: input.id || '',
    name: input.name || input.login || 'Unbenannter Streamer',
    login: String(input.login || '').trim(),
    chat: {
      channels: [...new Set(channels.map((item) => String(item).trim()).filter(Boolean))]
    },
    events: {
      enabled: input.events?.enabled ?? input.eventsEnabled ?? true
    },
    metadata: input.metadata || {},

    // Rückwärtskompatible Spiegel
    chatChannels: [...new Set(channels.map((item) => String(item).trim()).filter(Boolean))],
    eventsEnabled: input.events?.enabled ?? input.eventsEnabled ?? true
  };
}

function normalizeRule(type, input = {}) {
  const sceneTargets = Array.isArray(input.sceneTargets)
    ? input.sceneTargets
    : Array.isArray(input.selections)
      ? input.selections.map((selection) => ({ lampId: selection.lampId, scene: selection }))
      : Array.isArray(input.lampIds)
        ? input.lampIds.map((lampId) => ({ lampId, scene: {} }))
        : [];

  const normalizedTargets = sceneTargets
    .filter((target) => target?.lampId)
    .map((target) => ({
      lampId: target.lampId,
      scene: normalizeScene(target.scene || target)
    }));

  const trigger = input.trigger || {};
  const triggerValue = type === 'emotes'
    ? (trigger.value || input.emote || '')
    : type === 'events'
      ? (trigger.value || input.eventKey || '')
      : '';

  return {
    id: input.id || '',
    type,
    enabled: input.enabled !== false,
    streamerId: input.streamerId || '',
    trigger: {
      kind: type === 'online' ? 'online' : type === 'emotes' ? 'chat_match' : 'event',
      value: String(triggerValue).trim()
    },
    durationSeconds: Number.isFinite(Number(input.durationSeconds)) ? Number(input.durationSeconds) : (type === 'online' ? 0 : 10),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : (type === 'events' ? 200 : type === 'emotes' ? 100 : 10),
    sceneTargets: normalizedTargets,
    metadata: input.metadata || {},

    // Rückwärtskompatible Spiegel
    lampIds: normalizedTargets.map((target) => target.lampId),
    selections: normalizedTargets.map((target) => ({ lampId: target.lampId, ...target.scene })),
    emote: type === 'emotes' ? String(triggerValue).trim() : undefined,
    eventKey: type === 'events' ? String(triggerValue).trim() : undefined
  };
}

const defaultConfig = {
  schemaVersion: SCHEMA_VERSION,
  auth: {
    mode: 'oauth',
    configured: false,
    twitch: {
      username: '',
      oauthToken: '',
      clientId: '',
      clientSecret: ''
    }
  },
  settings: {
    rotationSeconds: 15,
    onlinePollSeconds: 30,
    healthPollSeconds: 20,
    eventOverridesEnabledByDefault: true,
    uiPassword: '',
    eventSubSecret: '',
    eventSubPublicUrl: ''
  },
  integrations: {
    hue: {
      bridgeIp: '',
      username: ''
    }
  },
  lamps: [],
  streamers: [],
  rules: {
    online: [],
    emotes: [],
    events: []
  }
};

export function normalizeConfig(input = {}) {
  const merged = {
    ...defaultConfig,
    ...input,
    auth: {
      ...defaultConfig.auth,
      ...(input.auth || {}),
      twitch: {
        ...defaultConfig.auth.twitch,
        ...(input.auth?.twitch || {})
      }
    },
    settings: {
      ...defaultConfig.settings,
      ...(input.settings || {})
    },
    integrations: {
      ...defaultConfig.integrations,
      ...(input.integrations || {}),
      hue: {
        ...defaultConfig.integrations.hue,
        ...(input.integrations?.hue || {})
      }
    },
    rules: {
      ...defaultConfig.rules,
      ...(input.rules || {})
    }
  };

  return {
    ...merged,
    schemaVersion: SCHEMA_VERSION,
    lamps: Array.isArray(merged.lamps) ? merged.lamps.map(normalizeLamp).filter((lamp) => lamp.id) : [],
    streamers: Array.isArray(merged.streamers) ? merged.streamers.map(normalizeStreamer).filter((streamer) => streamer.id) : [],
    rules: {
      online: Array.isArray(merged.rules.online) ? merged.rules.online.map((rule) => normalizeRule('online', rule)).filter((rule) => rule.id) : [],
      emotes: Array.isArray(merged.rules.emotes) ? merged.rules.emotes.map((rule) => normalizeRule('emotes', rule)).filter((rule) => rule.id) : [],
      events: Array.isArray(merged.rules.events) ? merged.rules.events.map((rule) => normalizeRule('events', rule)).filter((rule) => rule.id) : []
    }
  };
}

export async function ensureStore() {
  await fs.ensureDir(dataDir);
  const exists = await fs.pathExists(configPath);
  if (!exists) {
    await fs.writeJson(configPath, defaultConfig, { spaces: 2 });
  }
}

export async function loadConfig() {
  await ensureStore();
  const raw = await fs.readJson(configPath);
  const normalized = normalizeConfig(raw);
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
    await fs.writeJson(configPath, normalized, { spaces: 2 });
  }
  return normalized;
}

export async function saveConfig(config) {
  await ensureStore();
  const normalized = normalizeConfig(config);
  await fs.writeJson(configPath, normalized, { spaces: 2 });
  return normalized;
}

export { defaultConfig, configPath, normalizeLamp, normalizeRule, normalizeStreamer, SCHEMA_VERSION };
