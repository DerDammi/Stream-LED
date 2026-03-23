import { providers, testLampReachability } from './providers.js';
import { logger } from '../utils/logger.js';

export class LampManager {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.effectsCache = new Map();
    this.reachable = new Map();
  }

  async refreshEffects() {
    const config = this.getConfig();
    const results = [];
    for (const lamp of config.lamps) {
      const provider = providers[lamp.provider];
      if (!provider) continue;
      try {
        const effects = await provider.fetchEffects(lamp);
        this.effectsCache.set(lamp.id, effects);
        results.push({ lampId: lamp.id, effects });
        logger.clearError(`effects-${lamp.id}`);
      } catch (error) {
        logger.errorOnce(`effects-${lamp.id}`, 'Effekte konnten nicht geladen werden', { lamp: lamp.name, error: error.message });
      }
    }
    return results;
  }

  async probeLamps() {
    const config = this.getConfig();
    for (const lamp of config.lamps) {
      const online = await testLampReachability(lamp);
      const wasOnline = this.reachable.get(lamp.id);
      this.reachable.set(lamp.id, online);
      if (online && wasOnline === false) {
        logger.info('Lampe wieder online', { lamp: lamp.name });
        logger.clearError(`lamp-${lamp.id}-offline`);
      }
    }
  }

  getEffects(lampId) {
    return this.effectsCache.get(lampId) || [];
  }

  isReachable(lampId) {
    return this.reachable.get(lampId) ?? false;
  }

  async applySceneToLamp(lamp, scene) {
    const provider = providers[lamp.provider];
    if (!provider) throw new Error(`Unbekannter Provider: ${lamp.provider}`);
    await provider.setState(lamp, scene);
  }
}
