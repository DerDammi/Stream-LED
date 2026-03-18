const API = '/api';
let state = { lamps: [], streamers: [], onlineRules: [], chatRules: [], status: null, logs: [], settings: null };

const byId = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

window.openModal = (id) => document.getElementById(id).classList.remove('hidden');
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindNav();
  bindSetup();
  bindForms();
  const setup = await api('/setup/status');
  byId('redirect-uri').textContent = setup.redirectUri;
  if (setup.needsSetup) showScreen('setup-screen');
  else { showScreen('app'); await refreshAll(); setInterval(refreshAll, 5000); }
}

function bindNav() {
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = link.dataset.tab;
      document.querySelectorAll('.nav-link').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      link.classList.add('active');
      byId(`tab-${tab}`).classList.add('active');
    });
  });
}

function bindSetup() {
  byId('save-app-btn').addEventListener('click', async () => {
    await api('/setup/twitch-app', { method: 'POST', body: JSON.stringify({ client_id: byId('setup-client-id').value.trim(), client_secret: byId('setup-client-secret').value.trim() }) });
    alert('Twitch App gespeichert. Jetzt auf „Mit Twitch verbinden“ klicken.');
  });
  byId('oauth-btn').addEventListener('click', async () => {
    const data = await api('/auth/twitch/start');
    window.open(data.url, '_blank', 'width=720,height=820');
    const poll = setInterval(async () => {
      const setup = await api('/setup/status');
      if (!setup.needsSetup) {
        clearInterval(poll);
        showScreen('app');
        await refreshAll();
        setInterval(refreshAll, 5000);
      }
    }, 2000);
  });
}

function bindForms() {
  byId('lamp-form').addEventListener('submit', saveLamp);
  byId('streamer-form').addEventListener('submit', saveStreamer);
  byId('online-rule-form').addEventListener('submit', saveOnlineRule);
  byId('chat-rule-form').addEventListener('submit', saveChatRule);
  byId('save-settings-btn').addEventListener('click', saveSettings);
  byId('clear-logs-btn').addEventListener('click', async () => { await api('/logs', { method: 'DELETE' }); await refreshAll(); });
  byId('reconnect-btn').addEventListener('click', async () => {
    const data = await api('/auth/twitch/start');
    window.open(data.url, '_blank', 'width=720,height=820');
  });
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((x) => x.classList.add('hidden'));
  byId(id).classList.remove('hidden');
}

async function api(url, options = {}) {
  const response = await fetch(`${API}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Fehler');
  return data;
}

async function refreshAll() {
  const [lamps, streamers, onlineRules, chatRules, status, logs, settings] = await Promise.all([
    api('/lamps'), api('/streamers'), api('/online-rules'), api('/chat-rules'), api('/status'), api('/logs?limit=100'), api('/settings')
  ]);
  state = { lamps, streamers, onlineRules, chatRules, status, logs, settings };
  renderAll();
}

function renderAll() {
  renderDashboard();
  renderLamps();
  renderStreamers();
  renderOnlineRules();
  renderChatRules();
  renderLogs();
  renderSettings();
  fillStreamerSelects();
}

function renderDashboard() {
  byId('twitch-status').textContent = state.status.twitch.connected ? `🟢 ${state.status.twitch.auth?.login || 'Verbunden'}` : '🔴 Nicht verbunden';
  byId('stat-live').textContent = state.status.twitch.onlineStreamers.length;
  byId('stat-lamps').textContent = state.lamps.length;
  byId('stat-chat').textContent = state.status.twitch.activeChatRule ? state.status.twitch.activeChatRule.name : '-';
  byId('stat-rotation').textContent = state.status.twitch.activeOnlineRule ? state.status.twitch.activeOnlineRule.streamer_login : '-';
  byId('live-streamers').innerHTML = state.status.twitch.onlineStreamers.length ? state.status.twitch.onlineStreamers.map((s) => `<span class="chip live">${escapeHtml(s)}</span>`).join('') : '<span class="muted">Niemand live</span>';
  byId('lamp-status').innerHTML = state.lamps.map((lamp) => {
    const runtime = state.status.lamps[lamp.id];
    return `<div class="card"><div><strong>${escapeHtml(lamp.name)}</strong><div class="meta">${escapeHtml(lamp.type.toUpperCase())} · ${escapeHtml(lamp.address)} · ${lamp.last_seen ? 'online' : 'offline'}</div><div class="meta">${runtime?.state?.source || 'kein aktiver Zustand'}</div></div></div>`;
  }).join('') || '<div class="muted">Keine Lampen</div>';
}

function renderLamps() {
  byId('lamp-list').innerHTML = state.lamps.map((lamp) => `<div class="card"><div><strong>${escapeHtml(lamp.name)}</strong><div class="meta">${escapeHtml(lamp.type.toUpperCase())} · ${escapeHtml(lamp.address)} · ${(lamp.effects || []).length} Effekte · ${lamp.last_seen ? 'online' : 'offline'}</div></div><div class="actions"><button class="btn btn-secondary" onclick="editLamp('${lamp.id}')">Bearbeiten</button><button class="btn btn-secondary" onclick="refreshLampEffects('${lamp.id}')">Effekte laden</button><button class="btn btn-secondary" onclick="testLamp('${lamp.id}','color')">Test</button><button class="btn btn-danger" onclick="deleteEntity('/lamps/${lamp.id}')">Löschen</button></div></div>`).join('') || '<div class="muted">Noch keine Lampen.</div>';
}

window.editLamp = function(id) {
  const lamp = state.lamps.find((x) => x.id === id); if (!lamp) return;
  byId('lamp-id').value = lamp.id; byId('lamp-name').value = lamp.name; byId('lamp-type').value = lamp.type; byId('lamp-address').value = lamp.address; byId('lamp-api-key').value = lamp.api_key || ''; byId('lamp-enabled').checked = lamp.enabled; openModal('lamp-modal');
};
window.refreshLampEffects = async function(id) { await api(`/lamps/${id}/refresh-effects`, { method: 'POST' }); await refreshAll(); };
window.testLamp = async function(id, action) { await api(`/lamps/${id}/test`, { method: 'POST', body: JSON.stringify({ action, color: '#44ccff' }) }); };

function renderStreamers() {
  byId('streamer-list').innerHTML = state.streamers.map((s) => `<div class="card"><div><strong>${escapeHtml(s.login)}</strong><div class="meta">${s.enabled ? 'aktiv' : 'inaktiv'}</div></div><div class="actions"><button class="btn btn-secondary" onclick="editStreamer('${s.id}')">Bearbeiten</button><button class="btn btn-danger" onclick="deleteEntity('/streamers/${s.id}')">Löschen</button></div></div>`).join('') || '<div class="muted">Noch keine Streamer.</div>';
}
window.editStreamer = function(id) { const s = state.streamers.find((x) => x.id === id); if (!s) return; byId('streamer-id').value = s.id; byId('streamer-login').value = s.login; byId('streamer-enabled').checked = s.enabled; openModal('streamer-modal'); };

function renderOnlineRules() {
  byId('online-rule-list').innerHTML = state.onlineRules.map((rule) => `<div class="card"><div><strong>${escapeHtml(rule.streamer_login)}</strong><div class="meta">${rule.targets.length} Lampen · ${rule.enabled ? 'aktiv' : 'inaktiv'}</div></div><div class="actions"><button class="btn btn-secondary" onclick="editOnlineRule('${rule.id}')">Bearbeiten</button><button class="btn btn-danger" onclick="deleteEntity('/online-rules/${rule.id}')">Löschen</button></div></div>`).join('') || '<div class="muted">Noch keine Online-Szenen.</div>';
}
window.editOnlineRule = function(id) {
  const rule = state.onlineRules.find((x) => x.id === id); if (!rule) return;
  byId('online-rule-id').value = rule.id; byId('online-rule-streamer').value = rule.streamer_id; byId('online-rule-enabled').checked = rule.enabled; renderTargets('online-rule-targets', rule.targets); openModal('online-rule-modal');
};

function renderChatRules() {
  byId('chat-rule-list').innerHTML = state.chatRules.map((rule) => `<div class="card"><div><strong>${escapeHtml(rule.name)}</strong><div class="meta">${escapeHtml(rule.streamer_login)} · "${escapeHtml(rule.match_text)}" · ${rule.min_matches}x / ${rule.window_seconds}s · ${rule.enabled ? 'aktiv' : 'inaktiv'}</div></div><div class="actions"><button class="btn btn-secondary" onclick="editChatRule('${rule.id}')">Bearbeiten</button><button class="btn btn-danger" onclick="deleteEntity('/chat-rules/${rule.id}')">Löschen</button></div></div>`).join('') || '<div class="muted">Noch keine Chat-Regeln.</div>';
}
window.editChatRule = function(id) {
  const rule = state.chatRules.find((x) => x.id === id); if (!rule) return;
  byId('chat-rule-id').value = rule.id; byId('chat-rule-name').value = rule.name; byId('chat-rule-streamer').value = rule.streamer_id; byId('chat-rule-text').value = rule.match_text; byId('chat-rule-match-type').value = rule.match_type; byId('chat-rule-window').value = rule.window_seconds; byId('chat-rule-min').value = rule.min_matches; byId('chat-rule-enabled').checked = rule.enabled; renderTargets('chat-rule-targets', rule.targets); openModal('chat-rule-modal');
};

function renderLogs() {
  byId('log-list').innerHTML = state.logs.map((log) => `<div class="log-entry"><span>${escapeHtml(log.last_seen)}</span> <strong>${escapeHtml(log.level)}</strong> [${escapeHtml(log.source)}] ${escapeHtml(log.message)} ${log.count > 1 ? `×${log.count}` : ''}</div>`).join('') || '<div class="muted">Keine Logs.</div>';
}

function renderSettings() {
  byId('setting-online-poll').value = state.settings.online_poll_seconds;
  byId('setting-rotation').value = state.settings.rotation_seconds;
  byId('setting-health').value = state.settings.healthcheck_seconds;
}

function fillStreamerSelects() {
  const options = ['<option value="">Bitte wählen</option>'].concat(state.streamers.map((s) => `<option value="${s.id}">${escapeHtml(s.login)}</option>`)).join('');
  byId('online-rule-streamer').innerHTML = options;
  byId('chat-rule-streamer').innerHTML = options;
  renderTargets('online-rule-targets');
  renderTargets('chat-rule-targets');
}

function renderTargets(containerId, values = null) {
  const container = byId(containerId);
  if (!state.lamps.length) { container.innerHTML = '<div class="muted">Bitte erst Lampen anlegen.</div>'; return; }
  const current = values || state.lamps.map((lamp) => ({ lamp_id: lamp.id, enabled: false, mode: 'static', color: '#9147ff', effect_name: '' }));
  container.innerHTML = state.lamps.map((lamp) => {
    const target = current.find((x) => x.lamp_id === lamp.id) || { lamp_id: lamp.id, enabled: false, mode: 'static', color: '#9147ff', effect_name: '' };
    const effects = (lamp.effects || []).map((fx) => `<option value="${escapeHtml(fx.id ?? fx.name)}" ${String(fx.id ?? fx.name) === String(target.effect_name) ? 'selected' : ''}>${escapeHtml(fx.name ?? fx.id)}</option>`).join('');
    return `<div class="target-card"><label class="inline"><input type="checkbox" data-field="enabled" data-lamp="${lamp.id}" ${target.enabled !== false && values ? 'checked' : ''}> ${escapeHtml(lamp.name)}</label><label>Modus<select data-field="mode" data-lamp="${lamp.id}"><option value="static" ${target.mode !== 'effect' ? 'selected' : ''}>Statisch</option><option value="effect" ${target.mode === 'effect' ? 'selected' : ''}>Effekt</option></select></label><label>Farbe<input type="color" data-field="color" data-lamp="${lamp.id}" value="${escapeHtml(target.color || '#9147ff')}"></label><label>Effekt<select data-field="effect_name" data-lamp="${lamp.id}"><option value="">Bitte wählen</option>${effects}</select></label></div>`;
  }).join('');
}

function collectTargets(containerId) {
  return state.lamps.map((lamp) => {
    const enabled = byId(containerId).querySelector(`[data-field="enabled"][data-lamp="${lamp.id}"]`)?.checked;
    if (!enabled) return null;
    return {
      lamp_id: lamp.id,
      mode: byId(containerId).querySelector(`[data-field="mode"][data-lamp="${lamp.id}"]`).value,
      color: byId(containerId).querySelector(`[data-field="color"][data-lamp="${lamp.id}"]`).value,
      effect_name: byId(containerId).querySelector(`[data-field="effect_name"][data-lamp="${lamp.id}"]`).value,
      effect_speed: 128,
      effect_intensity: 128
    };
  }).filter(Boolean);
}

async function saveLamp(e) {
  e.preventDefault();
  const id = byId('lamp-id').value;
  const payload = { name: byId('lamp-name').value.trim(), type: byId('lamp-type').value, address: byId('lamp-address').value.trim(), api_key: byId('lamp-api-key').value.trim() || null, enabled: byId('lamp-enabled').checked };
  await api(id ? `/lamps/${id}` : '/lamps', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('lamp-modal'); e.target.reset(); await refreshAll();
}

async function saveStreamer(e) {
  e.preventDefault();
  const id = byId('streamer-id').value;
  const payload = { login: byId('streamer-login').value.trim().toLowerCase(), enabled: byId('streamer-enabled').checked };
  await api(id ? `/streamers/${id}` : '/streamers', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('streamer-modal'); e.target.reset(); await refreshAll();
}

async function saveOnlineRule(e) {
  e.preventDefault();
  const id = byId('online-rule-id').value;
  const payload = { streamer_id: byId('online-rule-streamer').value, enabled: byId('online-rule-enabled').checked, targets: collectTargets('online-rule-targets') };
  await api(id ? `/online-rules/${id}` : '/online-rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('online-rule-modal'); e.target.reset(); await refreshAll();
}

async function saveChatRule(e) {
  e.preventDefault();
  const id = byId('chat-rule-id').value;
  const payload = { name: byId('chat-rule-name').value.trim(), streamer_id: byId('chat-rule-streamer').value, match_text: byId('chat-rule-text').value.trim(), match_type: byId('chat-rule-match-type').value, window_seconds: Number(byId('chat-rule-window').value), min_matches: Number(byId('chat-rule-min').value), enabled: byId('chat-rule-enabled').checked, targets: collectTargets('chat-rule-targets') };
  await api(id ? `/chat-rules/${id}` : '/chat-rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('chat-rule-modal'); e.target.reset(); await refreshAll();
}

async function saveSettings() {
  await api('/settings', { method: 'PUT', body: JSON.stringify({ online_poll_seconds: Number(byId('setting-online-poll').value), rotation_seconds: Number(byId('setting-rotation').value), healthcheck_seconds: Number(byId('setting-health').value) }) });
  await refreshAll();
}

window.deleteEntity = async function(endpoint) { if (!confirm('Wirklich löschen?')) return; await api(endpoint, { method: 'DELETE' }); await refreshAll(); };
