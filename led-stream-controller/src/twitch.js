const crypto = require('crypto');
const tmi = require('tmi.js');
const db = require('./database');

class TwitchIntegration {
  constructor(effectManager) {
    this.effectManager = effectManager;
    this.auth = null;
    this.chatClient = null;
    this.onlineStreamers = new Set();
    this.chatWindows = new Map(); // ruleId -> timestamps[]
    this.lastFingerprint = '';
    this.oauthStates = new Map();
    this.rotationIndex = 0;
    this.rotationTimer = null;
  }

  async initialize() {
    this.auth = db.getTwitchAuth();
    if (!this.auth?.access_token || !this.auth?.client_id) {
      db.log('INFO', 'twitch', 'Noch nicht mit Twitch verbunden');
      return false;
    }

    const user = await this.fetchCurrentUser();
    if (!user) {
      db.log('WARN', 'twitch', 'Twitch Token ungültig oder abgelaufen');
      return false;
    }

    this.auth.login = user.login;
    this.auth.user_id = user.id;
    db.saveTwitchAuth(this.auth);
    await this.connectChat();
    this.startRotation();
    return true;
  }

  getRedirectUri() {
    return `http://localhost:${db.getSetting('port', 3847)}/oauth/callback`;
  }

  getAuthUrl() {
    const auth = db.getTwitchAuth();
    if (!auth?.client_id) throw new Error('Client ID fehlt');
    const state = crypto.randomBytes(16).toString('hex');
    this.oauthStates.set(state, Date.now());
    const params = new URLSearchParams({
      client_id: auth.client_id,
      redirect_uri: this.getRedirectUri(),
      response_type: 'code',
      scope: 'chat:read user:read:email',
      state
    });
    return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  }

  consumeState(state) {
    const ok = this.oauthStates.has(state);
    this.oauthStates.delete(state);
    return ok;
  }

  async exchangeCode(code) {
    const auth = db.getTwitchAuth();
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: auth.client_id,
        client_secret: auth.client_secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.getRedirectUri()
      })
    });
    if (!resp.ok) throw new Error(`OAuth fehlgeschlagen (${resp.status})`);
    const tokenData = await resp.json();
    const merged = {
      ...auth,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || auth.refresh_token || null,
      expires_at: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null
    };
    db.saveTwitchAuth(merged);
    this.auth = db.getTwitchAuth();
    await this.initialize();
    return this.auth;
  }

  async fetchCurrentUser() {
    const data = await this.helixGet('/users');
    return data?.data?.[0] || null;
  }

  async helixGet(endpoint) {
    const auth = db.getTwitchAuth();
    if (!auth?.access_token || !auth?.client_id) return null;
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(`https://api.twitch.tv/helix${endpoint}`, {
      headers: {
        'Client-ID': auth.client_id,
        'Authorization': `Bearer ${auth.access_token}`
      }
    });
    if (!resp.ok) return null;
    return resp.json();
  }

  getChannels() {
    return db.getAllStreamers().filter((s) => s.enabled).map((s) => s.login.toLowerCase());
  }

  async connectChat() {
    const channels = this.getChannels();
    const auth = db.getTwitchAuth();
    const fingerprint = JSON.stringify({ login: auth?.login, token: auth?.access_token, channels });
    if (fingerprint === this.lastFingerprint && this.chatClient) return;

    if (this.chatClient) {
      try { await this.chatClient.disconnect(); } catch {}
      this.chatClient = null;
    }

    if (!auth?.login || !auth?.access_token || channels.length === 0) return;

    this.chatClient = new tmi.Client({
      identity: {
        username: auth.login,
        password: auth.access_token.startsWith('oauth:') ? auth.access_token : `oauth:${auth.access_token}`
      },
      channels,
      connection: { reconnect: true, secure: true }
    });

    this.chatClient.on('message', (channel, tags, message, self) => {
      if (!self) this.handleChatMessage(channel.replace('#', '').toLowerCase(), message, tags);
    });
    this.chatClient.on('connected', () => db.log('INFO', 'twitch-chat', `Verbunden mit ${channels.length} Kanal/Kanälen`));
    this.chatClient.on('disconnected', (reason) => db.log('WARN', 'twitch-chat', `Getrennt: ${reason}`));

    await this.chatClient.connect();
    this.lastFingerprint = fingerprint;
  }

  async refreshChannels() {
    this.lastFingerprint = '';
    await this.connectChat();
  }

  pruneRuleWindow(ruleId, windowSeconds) {
    const now = Date.now();
    const min = now - (windowSeconds * 1000);
    const arr = this.chatWindows.get(ruleId) || [];
    const next = arr.filter((ts) => ts >= min);
    this.chatWindows.set(ruleId, next);
    return next;
  }

  handleChatMessage(streamerLogin, message) {
    const rules = db.getEnabledChatRules().filter((rule) => rule.streamer_login === streamerLogin);
    const normalized = String(message || '').trim().toLowerCase();
    for (const rule of rules) {
      const needle = String(rule.match_text || '').trim().toLowerCase();
      const matched = rule.match_type === 'exact'
        ? normalized === needle
        : normalized.includes(needle);
      if (!matched) {
        this.pruneRuleWindow(rule.id, rule.window_seconds);
        continue;
      }
      const arr = this.pruneRuleWindow(rule.id, rule.window_seconds);
      arr.push(Date.now());
      this.chatWindows.set(rule.id, arr);
    }
  }

  isChatRuleActive(rule) {
    const arr = this.pruneRuleWindow(rule.id, rule.window_seconds);
    return arr.length >= rule.min_matches;
  }

  getActiveChatRule() {
    const rules = db.getEnabledChatRules();
    let active = null;
    for (const rule of rules) {
      if (this.isChatRuleActive(rule)) active = rule;
    }
    return active;
  }

  async pollOnlineStatus() {
    const channels = this.getChannels();
    if (channels.length === 0) {
      this.onlineStreamers.clear();
      return [];
    }
    const query = channels.map((login) => `user_login=${encodeURIComponent(login)}`).join('&');
    const data = await this.helixGet(`/streams?${query}`);
    const live = new Set((data?.data || []).map((s) => s.user_login.toLowerCase()));
    this.onlineStreamers = live;
    return [...live];
  }

  getActiveOnlineRule() {
    const onlineRules = db.getAllOnlineRules().filter((rule) => rule.enabled && this.onlineStreamers.has(rule.streamer_login));
    if (!onlineRules.length) return null;
    const rule = onlineRules[this.rotationIndex % onlineRules.length];
    return rule || null;
  }

  startRotation() {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    const seconds = Math.max(5, db.getSetting('rotation_seconds', 20));
    this.rotationTimer = setInterval(() => {
      this.rotationIndex += 1;
    }, seconds * 1000);
  }

  async tick() {
    const chatRule = this.getActiveChatRule();
    const onlineRule = this.getActiveOnlineRule();
    await this.effectManager.applyResolvedState({ onlineRule, chatRule });
    return { chatRule, onlineRule };
  }

  getStatus() {
    const activeChatRule = this.getActiveChatRule();
    const activeOnlineRule = this.getActiveOnlineRule();
    return {
      connected: !!this.chatClient,
      auth: this.auth ? { login: this.auth.login } : null,
      onlineStreamers: [...this.onlineStreamers],
      activeChatRule: activeChatRule ? {
        id: activeChatRule.id,
        name: activeChatRule.name,
        streamer_login: activeChatRule.streamer_login,
        match_text: activeChatRule.match_text,
        currentMatches: this.pruneRuleWindow(activeChatRule.id, activeChatRule.window_seconds).length,
        minMatches: activeChatRule.min_matches,
        windowSeconds: activeChatRule.window_seconds
      } : null,
      activeOnlineRule: activeOnlineRule ? {
        id: activeOnlineRule.id,
        streamer_login: activeOnlineRule.streamer_login
      } : null
    };
  }

  async destroy() {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    if (this.chatClient) {
      try { await this.chatClient.disconnect(); } catch {}
    }
  }
}

module.exports = TwitchIntegration;
