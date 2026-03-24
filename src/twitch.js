const crypto = require('crypto');
const tmi = require('tmi.js');
const db = require('./database');

const DEFAULT_AUTH_STATE = 'missing';
const AUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;
const INVALID_AUTH_RETRY_MS = 15 * 60 * 1000;
const CHAT_INVALID_AUTH_BACKOFF_MS = 30 * 60 * 1000;

class TwitchIntegration {
  constructor(effectManager) {
    this.effectManager = effectManager;
    this.auth = null;
    this.chatClient = null;
    this.onlineStreamers = new Set();
    this.chatWindows = new Map();
    this.lastFingerprint = '';
    this.oauthStates = new Map();
    this.onlineRotationStartedAt = Date.now();
    this.chatReconnectBlockedUntil = 0;
    this.authFailureBlockedUntil = 0;
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
      lastAuthError: null,
      lastAuthRefreshAt: null,
      lastAuthRefreshSuccessAt: null,
      lastAuthRefreshError: null,
      authStateChangedAt: null,
      authState: DEFAULT_AUTH_STATE,
      authHint: 'Twitch ist noch nicht verbunden.',
      reloginRequired: false,
      authBlockedUntil: null,
      chatReconnectBlockedUntil: null
    };
  }

  async initialize() {
    this.diagnostics.initializedAt = new Date().toISOString();
    this.auth = db.getTwitchAuth();
    if (!this.auth?.access_token || !this.auth?.client_id) {
      const hasClientConfig = !!(this.auth?.client_id && this.auth?.client_secret);
      this.setAuthState('missing', hasClientConfig ? 'Twitch Login fehlt oder ist ungültig. Bitte im Webinterface neu verbinden.' : 'Noch nicht mit Twitch verbunden.', { reloginRequired: hasClientConfig || !this.auth?.client_id || !this.auth?.access_token });
      return false;
    }

    const authReady = await this.ensureValidAuth({ reason: 'initialize', allowInvalidBlockBypass: true });
    if (!authReady) {
      this.diagnostics.lastInitError = this.diagnostics.authHint;
      return false;
    }

    const user = await this.fetchCurrentUser();
    if (!user) {
      this.handleAuthFailure('Twitch Token ungültig oder abgelaufen.', { reloginRequired: true, code: 'invalid_token' });
      this.diagnostics.lastInitError = this.diagnostics.authHint;
      return false;
    }

    this.auth = { ...(db.getTwitchAuth() || {}), login: user.login, user_id: user.id };
    db.saveTwitchAuth(this.auth);
    this.setAuthState('ok', `Verbunden als ${user.login}.`, { reloginRequired: false, clearBlocks: true });
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
    const tokenData = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const details = tokenData?.message || tokenData?.error_description || `OAuth fehlgeschlagen (${resp.status})`;
      throw new Error(details);
    }
    const merged = {
      ...auth,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || auth.refresh_token || null,
      expires_at: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null
    };
    db.saveTwitchAuth(merged);
    this.auth = db.getTwitchAuth();
    this.setAuthState('ok', 'Twitch OAuth erfolgreich erneuert.', { reloginRequired: false, clearBlocks: true });
    await this.initialize();
    return this.auth;
  }

  parseExpiresAt(value) {
    if (!value) return null;
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  isAccessTokenExpiringSoon(auth = null) {
    const expiresAt = this.parseExpiresAt(auth?.expires_at);
    if (!expiresAt) return false;
    return expiresAt - Date.now() <= AUTH_REFRESH_SKEW_MS;
  }

  setAuthState(state, hint, options = {}) {
    const nowIso = new Date().toISOString();
    const changed = this.diagnostics.authState !== state || this.diagnostics.authHint !== hint || this.diagnostics.reloginRequired !== !!options.reloginRequired;
    this.diagnostics.authState = state;
    this.diagnostics.authHint = hint;
    this.diagnostics.reloginRequired = !!options.reloginRequired;
    this.diagnostics.lastAuthCheckAt = nowIso;
    this.diagnostics.lastAuthError = state === 'ok' ? null : hint;
    this.diagnostics.authBlockedUntil = this.authFailureBlockedUntil ? new Date(this.authFailureBlockedUntil).toISOString() : null;
    this.diagnostics.chatReconnectBlockedUntil = this.chatReconnectBlockedUntil ? new Date(this.chatReconnectBlockedUntil).toISOString() : null;
    if (changed) this.diagnostics.authStateChangedAt = nowIso;
    if (options.clearBlocks) {
      this.authFailureBlockedUntil = 0;
      this.chatReconnectBlockedUntil = 0;
      this.diagnostics.authBlockedUntil = null;
      this.diagnostics.chatReconnectBlockedUntil = null;
    }
  }

  async disconnectChat(reason = 'disconnect') {
    if (!this.chatClient) return;
    try { await this.chatClient.disconnect(); } catch {}
    this.chatClient = null;
    this.lastFingerprint = '';
    this.diagnostics.lastChatDisconnectAt = new Date().toISOString();
    this.diagnostics.lastChatDisconnectReason = reason;
  }

  handleAuthFailure(message, options = {}) {
    const reason = options.code || 'auth_invalid';
    const reloginRequired = options.reloginRequired !== false;
    this.authFailureBlockedUntil = Date.now() + INVALID_AUTH_RETRY_MS;
    this.chatReconnectBlockedUntil = Date.now() + CHAT_INVALID_AUTH_BACKOFF_MS;
    this.onlineStreamers.clear();
    this.disconnectChat(`auth:${reason}`).catch(() => {});
    if (reloginRequired) {
      const saved = db.getTwitchAuth() || {};
      db.saveTwitchAuth({ ...saved, access_token: null, refresh_token: options.keepRefreshToken ? saved.refresh_token || null : null, login: saved.login || null, user_id: saved.user_id || null, expires_at: null });
      this.auth = db.getTwitchAuth();
    }
    this.setAuthState('reauth_required', message, { reloginRequired });
    db.log('WARN', 'twitch-auth', message);
  }

  async refreshAccessToken(auth = null) {
    const current = auth || db.getTwitchAuth();
    this.diagnostics.lastAuthRefreshAt = new Date().toISOString();
    if (!current?.client_id || !current?.client_secret || !current?.refresh_token) {
      this.handleAuthFailure('Twitch Login muss erneut verbunden werden: Refresh-Token fehlt.', { reloginRequired: true, code: 'refresh_missing' });
      return false;
    }
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: current.client_id,
        client_secret: current.client_secret
      })
    });
    const tokenData = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const errorCode = String(tokenData?.error || '').toLowerCase();
      const description = tokenData?.message || tokenData?.error_description || `Token-Refresh fehlgeschlagen (${resp.status})`;
      this.diagnostics.lastAuthRefreshError = description;
      if (
        resp.status === 400
        || resp.status === 401
        || /invalid_grant|revoked|invalid refresh|invalid client secret|client secret/i.test(description)
        || /invalid request|bad request|unauthorized/i.test(errorCode)
      ) {
        this.handleAuthFailure(`Twitch Login/App-Daten wurden von Twitch abgelehnt: ${description}. Bitte im Webinterface neu verbinden und ggf. Client Secret prüfen.`, { reloginRequired: true, code: 'invalid_grant' });
        return false;
      }
      db.log('WARN', 'twitch-auth', description);
      return false;
    }
    const merged = {
      ...current,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || current.refresh_token,
      expires_at: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : current.expires_at || null
    };
    db.saveTwitchAuth(merged);
    this.auth = db.getTwitchAuth();
    this.diagnostics.lastAuthRefreshSuccessAt = new Date().toISOString();
    this.diagnostics.lastAuthRefreshError = null;
    this.setAuthState('ok', `Verbunden als ${this.auth?.login || 'Twitch User'}.`, { reloginRequired: false, clearBlocks: true });
    db.log('INFO', 'twitch-auth', 'Twitch Access-Token erfolgreich erneuert.');
    return true;
  }

  async ensureValidAuth(options = {}) {
    const auth = db.getTwitchAuth();
    this.auth = auth;
    if (!auth?.access_token || !auth?.client_id) {
      const hasClientConfig = !!(auth?.client_id && auth?.client_secret);
      this.setAuthState('missing', hasClientConfig ? 'Twitch Login fehlt oder ist ungültig. Bitte neu verbinden.' : 'Twitch ist noch nicht verbunden.', { reloginRequired: hasClientConfig || !auth?.refresh_token });
      return false;
    }
    if (!options.allowInvalidBlockBypass && this.authFailureBlockedUntil && Date.now() < this.authFailureBlockedUntil && this.diagnostics.reloginRequired) {
      this.setAuthState('reauth_required', this.diagnostics.authHint || 'Twitch Login muss neu verbunden werden.', { reloginRequired: true });
      return false;
    }
    if (this.isAccessTokenExpiringSoon(auth)) {
      const refreshed = await this.refreshAccessToken(auth);
      if (!refreshed) return false;
    }
    return !!(this.auth?.access_token || db.getTwitchAuth()?.access_token);
  }

  async fetchCurrentUser() {
    const data = await this.helixGet('/users', { allowRefreshOnUnauthorized: true });
    return data?.data?.[0] || null;
  }

  async helixGet(endpoint, options = {}) {
    const authReady = await this.ensureValidAuth();
    if (!authReady) return null;
    const auth = db.getTwitchAuth();
    if (!auth?.access_token || !auth?.client_id) return null;
    const { default: fetch } = await import('node-fetch');

    const requestOnce = async (token) => fetch(`https://api.twitch.tv/helix${endpoint}`, {
      headers: {
        'Client-ID': auth.client_id,
        'Authorization': `Bearer ${token}`
      }
    });

    let resp = await requestOnce(auth.access_token);
    if (resp.status === 401 && options.allowRefreshOnUnauthorized !== false) {
      const refreshed = await this.refreshAccessToken(auth);
      if (!refreshed) return null;
      const latest = db.getTwitchAuth();
      resp = await requestOnce(latest?.access_token);
    }

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const message = body?.message || `Twitch API Fehler (${resp.status})`;
      if (resp.status === 401) {
        this.handleAuthFailure('Twitch Auth wurde abgelehnt. Bitte im Webinterface neu verbinden.', { reloginRequired: true, code: 'unauthorized' });
      } else {
        this.diagnostics.lastOnlinePollError = message;
      }
      return null;
    }
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

    if (this.chatReconnectBlockedUntil && Date.now() < this.chatReconnectBlockedUntil) {
      this.diagnostics.chatReconnectBlockedUntil = new Date(this.chatReconnectBlockedUntil).toISOString();
      return;
    }

    if (this.chatClient) {
      try { await this.chatClient.disconnect(); } catch {}
      this.chatClient = null;
    }

    const authReady = await this.ensureValidAuth();
    if (!authReady) return;

    const latestAuth = db.getTwitchAuth();
    if (!latestAuth?.login || !latestAuth?.access_token || channels.length === 0) return;

    this.chatClient = new tmi.Client({
      identity: {
        username: latestAuth.login,
        password: latestAuth.access_token.startsWith('oauth:') ? latestAuth.access_token : `oauth:${latestAuth.access_token}`
      },
      channels,
      connection: { reconnect: false, secure: true }
    });

    this.chatClient.on('message', (channel, tags, message, self) => {
      if (!self) this.handleChatMessage(channel.replace('#', '').toLowerCase(), message, tags);
    });
    this.chatClient.on('connected', () => {
      this.diagnostics.lastChatConnectAt = new Date().toISOString();
      this.diagnostics.lastChatDisconnectReason = null;
      this.chatReconnectBlockedUntil = 0;
      this.diagnostics.chatReconnectBlockedUntil = null;
      db.log('INFO', 'twitch-chat', `Verbunden mit ${channels.length} Kanal/Kanälen`);
    });
    this.chatClient.on('disconnected', (reason) => {
      const text = String(reason || 'unbekannt');
      this.diagnostics.lastChatDisconnectAt = new Date().toISOString();
      this.diagnostics.lastChatDisconnectReason = text;
      this.chatClient = null;
      this.lastFingerprint = '';
      if (/login authentication failed|improperly formatted auth|invalid nick/i.test(text)) {
        this.handleAuthFailure('Twitch Chat Login wurde abgelehnt. Bitte Twitch im Webinterface neu verbinden.', { reloginRequired: true, code: 'chat_auth' });
        return;
      }
      this.chatReconnectBlockedUntil = Date.now() + 60 * 1000;
      this.diagnostics.chatReconnectBlockedUntil = new Date(this.chatReconnectBlockedUntil).toISOString();
      db.log('WARN', 'twitch-chat', `Getrennt: ${text}`);
    });

    try {
      await this.chatClient.connect();
      this.lastFingerprint = fingerprint;
    } catch (error) {
      this.chatClient = null;
      this.lastFingerprint = '';
      const message = String(error?.message || error || 'Twitch Chat Verbindung fehlgeschlagen');
      if (/Login authentication failed|invalid/i.test(message)) {
        this.handleAuthFailure('Twitch Chat Login wurde abgelehnt. Bitte Twitch im Webinterface neu verbinden.', { reloginRequired: true, code: 'chat_auth' });
        return;
      }
      this.chatReconnectBlockedUntil = Date.now() + 60 * 1000;
      this.diagnostics.chatReconnectBlockedUntil = new Date(this.chatReconnectBlockedUntil).toISOString();
      db.log('WARN', 'twitch-chat', message);
    }
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
    const authReady = await this.ensureValidAuth();
    if (!authReady) {
      this.onlineStreamers.clear();
      const message = this.diagnostics.authHint || 'Twitch Auth ungültig.';
      this.diagnostics.lastOnlinePollError = message;
      throw new Error(message);
    }
    const query = channels.map((login) => `user_login=${encodeURIComponent(login)}`).join('&');
    const data = await this.helixGet(`/streams?${query}`);
    if (!data) {
      const message = this.diagnostics.authHint || 'Live-Status konnte nicht von Twitch geladen werden';
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
    if (this.authFailureBlockedUntil && Date.now() >= this.authFailureBlockedUntil && this.diagnostics.reloginRequired) {
      this.authFailureBlockedUntil = Date.now() + INVALID_AUTH_RETRY_MS;
      this.diagnostics.authBlockedUntil = new Date(this.authFailureBlockedUntil).toISOString();
    }
    if (!this.diagnostics.reloginRequired && (!this.chatClient || this.lastFingerprint === '')) {
      await this.connectChat().catch(() => {});
    }
    const chatRule = this.getActiveChatRule();
    const onlineState = this.getOnlineState();
    await this.effectManager.applyResolvedState({ onlineState, chatRule });
    return { chatRule, onlineState };
  }

  getStatus() {
    const activeChatRule = this.getActiveChatRule();
    const activeOnlineRules = this.getActiveOnlineRules();
    const auth = this.auth || db.getTwitchAuth();
    return {
      connected: !!this.chatClient,
      auth: auth ? { login: auth.login, expires_at: auth.expires_at || null } : null,
      authState: {
        state: this.diagnostics.authState,
        hint: this.diagnostics.authHint,
        reloginRequired: this.diagnostics.reloginRequired,
        blockedUntil: this.diagnostics.authBlockedUntil,
        chatReconnectBlockedUntil: this.diagnostics.chatReconnectBlockedUntil
      },
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
