import axios from 'axios';
import tmi from 'tmi.js';
import EventEmitter from 'eventemitter3';
import { logger } from '../utils/logger.js';

export class TwitchService extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.client = null;
    this.onlineStates = new Map();
    this.connectedChannels = new Set();
    this.lastConnectionFingerprint = '';
  }

  async connectChat() {
    const config = this.getConfig();
    const channels = [...new Set(config.streamers.flatMap((streamer) => streamer.chatChannels || []))].filter(Boolean);
    const auth = config.auth?.twitch || {};
    const fingerprint = JSON.stringify({ channels, username: auth.username, token: auth.oauthToken });
    if (fingerprint === this.lastConnectionFingerprint && this.client) return;
    if (this.client) {
      try { await this.client.disconnect(); } catch {}
      this.client = null;
    }
    if (!auth.username || !auth.oauthToken || channels.length === 0) {
      logger.info('Twitch-Chat Verbindung übersprungen', {
        hasUsername: Boolean(auth.username),
        hasToken: Boolean(auth.oauthToken),
        channels: channels.length
      });
      return;
    }
    this.client = new tmi.Client({
      identity: { username: auth.username, password: auth.oauthToken.startsWith('oauth:') ? auth.oauthToken : `oauth:${auth.oauthToken}` },
      channels,
      connection: { reconnect: true, secure: true }
    });
    this.client.on('message', (channel, tags, message, self) => { if (!self) this.emit('chatMessage', { channel: channel.replace('#', ''), tags, message }); });
    this.client.on('connected', () => { this.connectedChannels = new Set(channels); logger.info('Mit Twitch-Chat verbunden', { channels }); logger.clearError('twitch-chat'); });
    this.client.on('disconnected', (reason) => logger.errorOnce('twitch-chat', 'Twitch-Chat getrennt', { reason }));
    await this.client.connect();
    this.lastConnectionFingerprint = fingerprint;
  }

  async pollOnlineStates() {
    const config = this.getConfig();
    const names = config.streamers.map((streamer) => streamer.login).filter(Boolean);
    if (names.length === 0) return [];
    const auth = config.auth?.twitch || {};
    if (!auth.clientId || !auth.clientSecret) {
      logger.errorOnce('twitch-api', 'Twitch API Zugangsdaten fehlen für Online-Checks.');
      return [];
    }
    const token = await this.getAppToken(auth.clientId, auth.clientSecret);
    const { data } = await axios.get('https://api.twitch.tv/helix/streams', {
      headers: { 'Client-Id': auth.clientId, Authorization: `Bearer ${token}` }, params: { user_login: names }, timeout: 6000
    });
    const liveSet = new Set((data.data || []).map((stream) => stream.user_login.toLowerCase()));
    const results = names.map((name) => ({ login: name, online: liveSet.has(name.toLowerCase()) }));
    results.forEach((r) => this.onlineStates.set(r.login.toLowerCase(), r.online));
    logger.clearError('twitch-api');
    logger.debug('Twitch Online-Status aktualisiert', {
      checked: names.length,
      online: results.filter((item) => item.online).map((item) => item.login)
    });
    return results;
  }

  isStreamerOnline(login) { return this.onlineStates.get(login?.toLowerCase()) ?? false; }

  async getAppToken(clientId, clientSecret) {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const { data } = await axios.post('https://id.twitch.tv/oauth2/token', null, { params: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }, timeout: 6000 });
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in * 1000) };
    return this.token.value;
  }

  async getUsersByLogins(logins) {
    const config = this.getConfig();
    const auth = config.auth?.twitch || {};
    const token = await this.getAppToken(auth.clientId, auth.clientSecret);
    const { data } = await axios.get('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': auth.clientId, Authorization: `Bearer ${token}` }, params: { login: logins }, timeout: 8000
    });
    return data.data || [];
  }

  async createEventSubSubscription(type, condition, callback, secret) {
    const config = this.getConfig();
    const auth = config.auth?.twitch || {};
    const token = await this.getAppToken(auth.clientId, auth.clientSecret);
    const { data } = await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
      type,
      version: '1',
      condition,
      transport: { method: 'webhook', callback, secret }
    }, {
      headers: { 'Client-Id': auth.clientId, Authorization: `Bearer ${token}` }, timeout: 10000
    });
    return data;
  }
}
