import { logger } from '../utils/logger.js';

function hexToRgb(hex = '#ffffff') {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map((x) => x + x).join('')
    : normalized;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

export class Orchestrator {
  constructor(getConfig, lampManager, twitchService) {
    this.getConfig = getConfig;
    this.lampManager = lampManager;
    this.twitchService = twitchService;
    this.overrideQueue = [];
    this.rotationIndex = 0;
  }

  start() {
    this.twitchService.on('chatMessage', (message) => this.handleChatMessage(message));
  }

  enqueueOverride(kind, rule, streamer) {
    const until = Date.now() + ((rule.durationSeconds || 10) * 1000);
    this.overrideQueue.push({ kind, rule, streamer, until });
    this.overrideQueue.sort((a, b) => a.until - b.until);
    logger.info('Override aktiviert', { kind, streamer: streamer?.name, durationSeconds: rule.durationSeconds || 10 });
  }

  async handleChatMessage({ channel, message }) {
    const config = this.getConfig();
    const streamer = config.streamers.find((item) => (item.chatChannels || []).includes(channel));
    if (!streamer) return;

    for (const rule of config.rules.emotes.filter((item) => item.enabled !== false && item.streamerId === streamer.id)) {
      if (message.includes(rule.emote)) {
        this.enqueueOverride('emote', rule, streamer);
      }
    }
  }

  triggerEvent(streamerId, eventKey) {
    const config = this.getConfig();
    const streamer = config.streamers.find((item) => item.id === streamerId);
    if (!streamer?.eventsEnabled) {
      logger.info('Event ignoriert: Streamer-Events deaktiviert', { streamerId, eventKey });
      return false;
    }
    const rule = config.rules.events.find((item) => item.enabled !== false && item.streamerId === streamerId && item.eventKey === eventKey);
    if (!rule) {
      logger.info('Event ignoriert: keine passende Regel', { streamerId, eventKey });
      return false;
    }
    this.enqueueOverride('event', rule, streamer);
    return true;
  }

  async tick() {
    const config = this.getConfig();
    this.overrideQueue = this.overrideQueue.filter((item) => item.until > Date.now());

    const activeOverride = this.overrideQueue[0];
    if (activeOverride) {
      await this.applyRule(activeOverride.rule);
      return { mode: 'override', activeOverride };
    }

    const onlineStreamers = config.streamers.filter((streamer) => this.twitchService.isStreamerOnline(streamer.login));
    if (onlineStreamers.length === 0) {
      return { mode: 'idle' };
    }

    const streamer = onlineStreamers[this.rotationIndex % onlineStreamers.length];
    this.rotationIndex += 1;
    const rules = config.rules.online.filter((rule) => rule.enabled !== false && rule.streamerId === streamer.id);
    await Promise.all(rules.map((rule) => this.applyRule(rule)));
    return { mode: 'online', streamer };
  }

  async applyRule(rule) {
    const config = this.getConfig();
    const lamps = config.lamps.filter((lamp) => rule.lampIds.includes(lamp.id));
    await Promise.all(lamps.map(async (lamp) => {
      if (!this.lampManager.isReachable(lamp.id)) return;
      try {
        await this.lampManager.applySceneToLamp(lamp, this.ruleToScene(rule, lamp.id));
        logger.clearError(`apply-${lamp.id}`);
      } catch (error) {
        logger.errorOnce(`apply-${lamp.id}`, 'Lampe konnte nicht gesetzt werden', { lamp: lamp.name, error: error.message });
      }
    }));
  }

  ruleToScene(rule, lampId) {
    const selection = (rule.selections || []).find((item) => item.lampId === lampId) || {};
    return {
      mode: selection.mode || 'static',
      color: selection.color ? hexToRgb(selection.color) : undefined,
      effectId: selection.effectId,
      effectName: selection.effectName,
      durationSeconds: rule.durationSeconds
    };
  }
}
