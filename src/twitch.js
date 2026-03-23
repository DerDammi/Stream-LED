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
    this.onlineRotationStartedAt = Date.now();
    this.diagnostics = {
      initializedAt: null,
      lastInitSuccessAt: null,
      lastInitError: null,
      lastOnlinePollAt: null,
      lastOnlinePollSuccessAt: null,
      lastOnlinePollError: null,
      lastChatConnectAt: null,
      lastChatDisconnectAt: null,
      lastChatDisconnectReason: null,
      lastAuthCheckAt: null,
      lastAuthError: null
    };
  }

  async initialize() {
    this.diagnostics.initializedAt = new Date().toISOString();
    this.auth = db.getTwitchAuth();
    if (!this.auth?.access_token || !this.auth?.client_id) {
      db.log('INFO', 'twitch', 'Noch nicht mit Twitch verbunden');
      this.diagnostics.lastInitError = 'Noch nicht mit Twitch verbunden';
      return false;
    }

    const user = await this.fetchCurrentUser();
    if (!user) {
      const message = 'Twitch Token ungültig oder abgelaufen';
      db.log('WARN', 'twitch', message);
      this.diagnostics.lastAuthCheckAt = new Date().toISOString();
      this.diagnostics.lastAuthError = message;
      this.diagnostics.lastInitError = message;
      return false;
    }

    this.auth.login = user.login;
    this.auth.user_id = user.id;
    db.saveTwitchAuth(this.auth);
    this.diagnostics.lastAuthCheckAt = new Date().toISOString();
    this.diagnostics.lastAuthError = null;
    await this.connectChat();
    this.resetOnlineRotationClock();
    this.diagnostics.lastInitSuccessAt = new Date().toISOString();
    this.diagnostics.lastInitError = null;
    return true;
  }

  resetOnlineRotationClock() {
    this.onlineRotationStartedAt = Date.now();
  }

  getConfiguredBaseUrl() {
    return String(process.env.PUBLIC_BASE_URL || db.getSetting('public_base_url', '') || '').trim().replace(/\/$/, '');
  }

  isLocalhostHostname(hostname = '') {
    const value = String(hostname || '').trim().toLowerCase();
    return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
  }

  isPrivateHostname(hostname = '') {
    const value = String(hostname || '').trim().toLowerCase();
    if (!value) return false;
    if (this.isLocalhostHostname(value)) return false;
    if (value.endsWith('.local')) return true;
    if (/^10\./.test(value)) return true;
    if (/^192\.168\./.test(value)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value)) return true;
    if (/^169\.254\./.test(value)) return true;
    return false;
  }

  isTwitchSafeBaseUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return false;
    try {
      const parsed = new URL(raw);
      const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
      if (parsed.protocol === 'https:') return true;
      return parsed.protocol === 'http:' && this.isLocalhostHostname(hostname);
    } catch {
      return false;
    }
  }

  getBaseUrl(requestLike = null) {
    const configured = this.getConfiguredBaseUrl();
    if (this.isTwitchSafeBaseUrl(configured)) return configured;

    const forwardedProto = requestLike?.headers?.['x-forwarded-proto'];
    const proto = String(Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || requestLike?.protocol || 'http').split(',')[0].trim() || 'http';
    const rawHost = String(requestLike?.headers?.host || '').trim();

    if (rawHost) {
      const host = rawHost.replace(/\/$/, '');
      const hostname = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
      if (proto === 'https') {
        return `${proto}://${host}`;
      }
      if (this.isLocalhostHostname(hostname)) {
        return `http://localhost:${db.getSetting('port', 3847)}`;
      }
    }

    return `http://localhost:${db.getSetting('port', 3847)}`;
  }

  getRedirectUri(requestLike = null) {
    return `${this.getBaseUrl(requestLike)}/oauth/callback`;
  }

  getRedirectOptions(requestLike = null) {
    const configured = this.getConfiguredBaseUrl();
    const fallback = `http://localhost:${db.getSetting('port', 3847)}`;
    const currentBase = this.getBaseUrl(requestLike);
    const configuredIsSafeForOauth = this.isTwitchSafeBaseUrl(configured);
    const host = String(requestLike?.headers?.host || '').trim();
    const hostname = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
    const currentIsSafeForOauth = !host || String(currentBase).startsWith('https://') || this.isLocalhostHostname(hostname);
    return {
      configuredBaseUrl: configured || '',
      configuredIsSafeForOauth,
      currentBaseUrl: currentBase,
      fallbackBaseUrl: fallback,
      redirectUri: `${currentBase}/oauth/callback`,
      currentIsSafeForOauth,
      guidance: {
        goodExamples: [
          `http://localhost:${db.getSetting('port', 3847)}/oauth/callback`,
          'https://example.com/oauth/callback'
        ],
        avoid: [
          'http://192.168.x.x/oauth/callback',
          'http://mein-pc.local/oauth/callback'
        ]
      }
    };
  }

  getAuthStart(requestLike = null) {
    const auth = db.getTwitchAuth();
    if (!auth?.client_id) throw new Error('Client ID fehlt');
    const redirectUri = this.getRedirectUri(requestLike);
    const state = crypto.randomBytes(16).toString('hex');
    this.oauthStates.set(state, { createdAt: Date.now(), redirectUri });
    const params = new URLSearchParams({
      client_id: auth.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'chat:read user:read:email',
      state
    });
    return {
      url: `https://id.twitch.tv/oauth2/authorize?${params.toString()}`,
      redirectUri,
      redirectOptions: this.getRedirectOptions(requestLike)
    };
  }

  consumeState(state) {
    const entry = this.oauthStates.get(state) || null;
    this.oauthStates.delete(state);
    return entry;
  }

  async exchangeCode(code, redirectUri = null) {
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
        redirect_uri: redirectUri || this.getRedirectUri()
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
    this.chatClient.on('connected', () => {
      this.diagnostics.lastChatConnectAt = new Date().toISOString();
      this.diagnostics.lastChatDisconnectReason = null;
      db.log('INFO', 'twitch-chat', `Verbunden mit ${channels.length} Kanal/Kanälen`);
    });
    this.chatClient.on('disconnected', (reason) => {
      this.diagnostics.lastChatDisconnectAt = new Date().toISOString();
      this.diagnostics.lastChatDisconnectReason = reason || 'unbekannt';
      db.log('WARN', 'twitch-chat', `Getrennt: ${reason}`);
    });

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
    this.diagnostics.lastOnlinePollAt = new Date().toISOString();
    const channels = this.getChannels();
    if (channels.length === 0) {
      this.onlineStreamers.clear();
      this.diagnostics.lastOnlinePollSuccessAt = new Date().toISOString();
      this.diagnostics.lastOnlinePollError = null;
      return [];
    }
    const query = channels.map((login) => `user_login=${encodeURIComponent(login)}`).join('&');
    const data = await this.helixGet(`/streams?${query}`);
    if (!data) {
      const message = 'Live-Status konnte nicht von Twitch geladen werden';
      this.diagnostics.lastOnlinePollError = message;
      throw new Error(message);
    }
    const nextLive = new Set((data?.data || []).map((s) => s.user_login.toLowerCase()));
    const previousSorted = [...this.onlineStreamers].sort().join('|');
    const nextSorted = [...nextLive].sort().join('|');
    if (previousSorted !== nextSorted) this.resetOnlineRotationClock();
    this.onlineStreamers = nextLive;
    this.diagnostics.lastOnlinePollSuccessAt = new Date().toISOString();
    this.diagnostics.lastOnlinePollError = null;
    return [...nextLive];
  }

  getActiveOnlineRules() {
    return db.getAllOnlineRules()
      .filter((rule) => rule.enabled && this.onlineStreamers.has(rule.streamer_login))
      .sort((a, b) => String(a.streamer_login || '').localeCompare(String(b.streamer_login || '')) || String(a.id).localeCompare(String(b.id)));
  }

  getOnlineState() {
    return {
      activeRules: this.getActiveOnlineRules(),
      onlineStreamers: [...this.onlineStreamers],
      rotationStartedAt: this.onlineRotationStartedAt,
      now: Date.now()
    };
  }

  async tick() {
    const chatRule = this.getActiveChatRule();
    const onlineState = this.getOnlineState();
    await this.effectManager.applyResolvedState({ onlineState, chatRule });
    return { chatRule, onlineState };
  }

  getStatus() {
    const activeChatRule = this.getActiveChatRule();
    const activeOnlineRules = this.getActiveOnlineRules();
    return {
      connected: !!this.chatClient,
      auth: this.auth ? { login: this.auth.login, expires_at: this.auth.expires_at || null } : null,
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
      activeOnlineRule: activeOnlineRules[0] ? {
        id: activeOnlineRules[0].id,
        streamer_login: activeOnlineRules[0].streamer_login,
        multiLampRotation: activeOnlineRules.length > 1
      } : null,
      activeOnlineRules: activeOnlineRules.map((rule) => ({ id: rule.id, streamer_login: rule.streamer_login, targetCount: Array.isArray(rule.targets) ? rule.targets.length : 0 })),
      diagnostics: { ...this.diagnostics, watchedChannels: this.getChannels().length }
    };
  }

  async destroy() {
    if (this.chatClient) {
      try { await this.chatClient.disconnect(); } catch {}
    }
  }
}

module.exports = TwitchIntegration;
