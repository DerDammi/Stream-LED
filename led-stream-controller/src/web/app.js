const API = '/api';
let refreshTimer = null;
let state = { lamps: [], streamers: [], onlineRules: [], chatRules: [], status: null, logs: [], settings: null };

const byId = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

window.openModal = (id) => document.getElementById(id).classList.remove('hidden');
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');
window.openLampModal = () => { resetLampForm(); openModal('lamp-modal'); };
window.openStreamerModal = () => { resetStreamerForm(); openModal('streamer-modal'); };
window.openOnlineRuleModal = () => { resetOnlineRuleForm(); openModal('online-rule-modal'); };
window.openChatRuleModal = () => { resetChatRuleForm(); openModal('chat-rule-modal'); };

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindNav();
  bindSetup();
  bindForms();
  const setup = await api('/setup/status');
  byId('redirect-uri').textContent = setup.redirectUri;
  byId('setup-checklist').innerHTML = (setup.checklist || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  if (setup.needsSetup) showScreen('setup-screen');
  else {
    showScreen('app');
    await refreshAll();
    startRefreshLoop();
  }
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
    toast('Twitch App gespeichert. Als Nächstes auf „Mit Twitch verbinden“ klicken.');
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
        startRefreshLoop();
        toast('Twitch erfolgreich verbunden.');
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
  byId('clear-logs-btn').addEventListener('click', async () => {
    await api('/logs', { method: 'DELETE' });
    toast('Logs geleert.');
    await refreshAll();
  });
  byId('reconnect-btn').addEventListener('click', async () => {
    const data = await api('/auth/twitch/start');
    window.open(data.url, '_blank', 'width=720,height=820');
  });
  byId('refresh-now-btn').addEventListener('click', refreshAll);
  byId('export-config-btn').addEventListener('click', exportConfig);
  byId('import-config-input').addEventListener('change', importConfig);
  ['chat-rule-text', 'chat-rule-match-type', 'chat-rule-window', 'chat-rule-min'].forEach((id) => {
    byId(id).addEventListener('input', renderChatRulePreview);
  });
}

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, 5000);
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
  try {
    const [lamps, streamers, onlineRules, chatRules, status, logs, settings] = await Promise.all([
      api('/lamps'), api('/streamers'), api('/online-rules'), api('/chat-rules'), api('/status'), api('/logs?limit=100'), api('/settings')
    ]);
    state = { lamps, streamers, onlineRules, chatRules, status, logs, settings };
    renderAll();
  } catch (error) {
    console.error(error);
    toast(error.message || 'Aktualisierung fehlgeschlagen.', true);
  }
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
  renderChatRulePreview();
}

function renderDashboard() {
  const twitch = state.status?.twitch || { onlineStreamers: [] };
  const onlineLampCount = state.lamps.filter((lamp) => lamp.last_seen).length;
  byId('twitch-status').textContent = twitch.connected ? `🟢 ${twitch.auth?.login || 'Verbunden'}` : '🔴 Nicht verbunden';
  byId('runtime-summary').textContent = twitch.connected
    ? `${twitch.onlineStreamers.length} live · ${onlineLampCount}/${state.lamps.length} Lampen online`
    : 'Twitch ist aktuell nicht verbunden.';
  byId('stat-live').textContent = twitch.onlineStreamers.length;
  byId('stat-lamps').textContent = state.lamps.length;
  byId('stat-lamps-online').textContent = onlineLampCount;
  byId('stat-chat').textContent = twitch.activeChatRule ? twitch.activeChatRule.name : '-';
  byId('stat-chat-detail').textContent = twitch.activeChatRule
    ? `${twitch.activeChatRule.currentMatches}/${twitch.activeChatRule.minMatches} Treffer in ${twitch.activeChatRule.windowSeconds}s`
    : 'kein Trigger aktiv';
  byId('stat-rotation').textContent = twitch.activeOnlineRule ? twitch.activeOnlineRule.streamer_login : '-';
  byId('stat-rotation-detail').textContent = twitch.activeOnlineRule ? 'diese Online-Szene läuft gerade' : 'keine Online-Szene aktiv';

  const checklist = [
    { ok: state.streamers.length > 0, text: 'Mindestens 1 Streamer angelegt' },
    { ok: state.lamps.length > 0, text: 'Mindestens 1 Lampe angelegt' },
    { ok: state.onlineRules.length > 0, text: 'Mindestens 1 Online-Szene angelegt' },
    { ok: state.chatRules.length > 0, text: 'Mindestens 1 Chat-Regel angelegt' }
  ];
  byId('dashboard-checklist').innerHTML = checklist.map((item) => `<div class="status-row"><span>${item.ok ? '✅' : '⬜'}</span><span>${escapeHtml(item.text)}</span></div>`).join('');

  const systemRows = [
    `Twitch Chat: ${twitch.connected ? 'verbunden' : 'nicht verbunden'}`,
    `Live-Streamer: ${twitch.onlineStreamers.length || 0}`,
    `Online-Regeln: ${state.status?.counts?.onlineRules ?? state.onlineRules.length}`,
    `Chat-Regeln: ${state.status?.counts?.chatRules ?? state.chatRules.length}`
  ];
  byId('system-health').innerHTML = systemRows.map((row) => `<div class="status-row"><span>•</span><span>${escapeHtml(row)}</span></div>`).join('');

  byId('live-streamers').innerHTML = twitch.onlineStreamers.length
    ? twitch.onlineStreamers.map((s) => `<span class="chip live">${escapeHtml(s)}</span>`).join('')
    : '<span class="muted">Niemand live</span>';

  byId('lamp-status').innerHTML = state.lamps.map((lamp) => {
    const runtime = state.status.lamps[lamp.id];
    const source = runtime?.state?.source || 'kein aktiver Zustand';
    const detail = runtime?.state?.mode === 'effect'
      ? `Effekt ${runtime.state.effect_name || '-'} · Speed ${runtime.state.effect_speed} · Intensität ${runtime.state.effect_intensity}`
      : runtime?.state?.color ? `Farbe ${runtime.state.color}` : 'wartet auf Szene oder Regel';
    return `
      <div class="card comfort-card">
        <div>
          <strong>${escapeHtml(lamp.name)}</strong>
          <div class="meta">${escapeHtml(lamp.type.toUpperCase())} · ${escapeHtml(lamp.address)} · ${lamp.last_seen ? 'online' : 'offline'}</div>
          <div class="meta">Quelle: ${escapeHtml(source)}</div>
          <div class="meta">${escapeHtml(detail)}</div>
        </div>
      </div>`;
  }).join('') || '<div class="muted">Keine Lampen</div>';
}

function renderLamps() {
  byId('lamp-list').innerHTML = state.lamps.map((lamp) => {
    const effectOptions = (lamp.effects || []).slice(0, 6).map((fx) => `<option value="${escapeHtml(String(fx.id ?? fx.name))}">${escapeHtml(fx.name ?? fx.id)}</option>`).join('');
    return `
      <div class="card comfort-card lamp-card">
        <div>
          <strong>${escapeHtml(lamp.name)}</strong>
          <div class="meta">${escapeHtml(lamp.type.toUpperCase())} · ${escapeHtml(lamp.address)} · ${(lamp.effects || []).length} Effekte · ${lamp.last_seen ? 'online' : 'offline'}</div>
          <div class="lamp-test-row">
            <input type="color" id="lamp-color-${lamp.id}" value="#44ccff" title="Testfarbe">
            <select id="lamp-effect-${lamp.id}"><option value="">Effekt wählen</option>${effectOptions}</select>
            <button class="btn btn-secondary" onclick="testLampColor('${lamp.id}')">Farbe testen</button>
            <button class="btn btn-secondary" onclick="testLampEffect('${lamp.id}')">Effekt testen</button>
            <button class="btn btn-secondary" onclick="testLampOff('${lamp.id}')">Aus</button>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-secondary" onclick="editLamp('${lamp.id}')">Bearbeiten</button>
          <button class="btn btn-secondary" onclick="refreshLampEffects('${lamp.id}')">Effekte laden</button>
          <button class="btn btn-danger" onclick="deleteEntity('/lamps/${lamp.id}')">Löschen</button>
        </div>
      </div>`;
  }).join('') || '<div class="muted">Noch keine Lampen.</div>';
}

window.editLamp = function(id) {
  const lamp = state.lamps.find((x) => x.id === id); if (!lamp) return;
  byId('lamp-id').value = lamp.id;
  byId('lamp-name').value = lamp.name;
  byId('lamp-type').value = lamp.type;
  byId('lamp-address').value = lamp.address;
  byId('lamp-api-key').value = lamp.api_key || '';
  byId('lamp-enabled').checked = lamp.enabled;
  openModal('lamp-modal');
};
window.refreshLampEffects = async function(id) {
  await api(`/lamps/${id}/refresh-effects`, { method: 'POST' });
  toast('Effektliste aktualisiert.');
  await refreshAll();
};
window.testLampColor = async function(id) {
  const color = byId(`lamp-color-${id}`).value;
  await api(`/lamps/${id}/test`, { method: 'POST', body: JSON.stringify({ action: 'color', color }) });
  toast('Testfarbe gesendet.');
};
window.testLampEffect = async function(id) {
  const effect_name = byId(`lamp-effect-${id}`).value;
  if (!effect_name) return toast('Bitte erst einen Effekt wählen.', true);
  await api(`/lamps/${id}/test`, { method: 'POST', body: JSON.stringify({ action: 'effect', effect_name, effect_speed: 128, effect_intensity: 128 }) });
  toast('Effekt-Test gesendet.');
};
window.testLampOff = async function(id) {
  await api(`/lamps/${id}/test`, { method: 'POST', body: JSON.stringify({ action: 'off' }) });
  toast('Lampe ausgeschaltet.');
};

function renderStreamers() {
  byId('streamer-list').innerHTML = state.streamers.map((s) => `<div class="card comfort-card"><div><strong>${escapeHtml(s.login)}</strong><div class="meta">${s.enabled ? 'aktiv' : 'inaktiv'}</div></div><div class="actions"><button class="btn btn-secondary" onclick="editStreamer('${s.id}')">Bearbeiten</button><button class="btn btn-danger" onclick="deleteEntity('/streamers/${s.id}')">Löschen</button></div></div>`).join('') || '<div class="muted">Noch keine Streamer.</div>';
}
window.editStreamer = function(id) { const s = state.streamers.find((x) => x.id === id); if (!s) return; byId('streamer-id').value = s.id; byId('streamer-login').value = s.login; byId('streamer-enabled').checked = s.enabled; openModal('streamer-modal'); };

function renderOnlineRules() {
  byId('online-rule-list').innerHTML = state.onlineRules.map((rule) => `<div class="card comfort-card"><div><strong>${escapeHtml(rule.streamer_login)}</strong><div class="meta">${rule.targets.length} Lampen · ${rule.enabled ? 'aktiv' : 'inaktiv'}</div><div class="meta">${escapeHtml(summarizeTargets(rule.targets))}</div></div><div class="actions"><button class="btn btn-secondary" onclick="editOnlineRule('${rule.id}')">Bearbeiten</button><button class="btn btn-danger" onclick="deleteEntity('/online-rules/${rule.id}')">Löschen</button></div></div>`).join('') || '<div class="muted">Noch keine Online-Szenen.</div>';
}
window.editOnlineRule = function(id) {
  const rule = state.onlineRules.find((x) => x.id === id); if (!rule) return;
  byId('online-rule-id').value = rule.id;
  fillStreamerSelects(rule.streamer_id, null);
  byId('online-rule-streamer').value = rule.streamer_id;
  byId('online-rule-enabled').checked = rule.enabled;
  renderTargets('online-rule-targets', rule.targets);
  openModal('online-rule-modal');
};

function renderChatRules() {
  byId('chat-rule-list').innerHTML = state.chatRules.map((rule) => {
    const liveStatus = state.status?.twitch?.activeChatRule?.id === rule.id ? ' · gerade aktiv' : '';
    return `<div class="card comfort-card"><div><strong>${escapeHtml(rule.name)}</strong><div class="meta">${escapeHtml(rule.streamer_login)} · „${escapeHtml(rule.match_text)}“ · ${rule.match_type === 'exact' ? 'exakt' : 'enthält'} · ${rule.min_matches}x / ${rule.window_seconds}s · ${rule.enabled ? 'aktiv' : 'inaktiv'}${liveStatus}</div><div class="meta">${escapeHtml(summarizeTargets(rule.targets))}</div></div><div class="actions"><button class="btn btn-secondary" onclick="duplicateChatRule('${rule.id}')">Duplizieren</button><button class="btn btn-secondary" onclick="editChatRule('${rule.id}')">Bearbeiten</button><button class="btn btn-danger" onclick="deleteEntity('/chat-rules/${rule.id}')">Löschen</button></div></div>`;
  }).join('') || '<div class="muted">Noch keine Chat-Regeln.</div>';
}
window.editChatRule = function(id) {
  const rule = state.chatRules.find((x) => x.id === id); if (!rule) return;
  byId('chat-rule-id').value = rule.id;
  byId('chat-rule-name').value = rule.name;
  fillStreamerSelects(null, rule.streamer_id);
  byId('chat-rule-streamer').value = rule.streamer_id;
  byId('chat-rule-text').value = rule.match_text;
  byId('chat-rule-match-type').value = rule.match_type;
  byId('chat-rule-window').value = rule.window_seconds;
  byId('chat-rule-min').value = rule.min_matches;
  byId('chat-rule-enabled').checked = rule.enabled;
  renderTargets('chat-rule-targets', rule.targets);
  renderChatRulePreview();
  openModal('chat-rule-modal');
};
window.duplicateChatRule = function(id) {
  const rule = state.chatRules.find((x) => x.id === id); if (!rule) return;
  resetChatRuleForm();
  byId('chat-rule-name').value = `${rule.name} Kopie`;
  fillStreamerSelects(null, rule.streamer_id);
  byId('chat-rule-streamer').value = rule.streamer_id;
  byId('chat-rule-text').value = rule.match_text;
  byId('chat-rule-match-type').value = rule.match_type;
  byId('chat-rule-window').value = rule.window_seconds;
  byId('chat-rule-min').value = rule.min_matches;
  byId('chat-rule-enabled').checked = rule.enabled;
  renderTargets('chat-rule-targets', rule.targets);
  renderChatRulePreview();
  openModal('chat-rule-modal');
};

function renderLogs() {
  byId('log-list').innerHTML = state.logs.map((log) => `<div class="log-entry"><span>${escapeHtml(log.last_seen)}</span> <strong>${escapeHtml(log.level)}</strong> [${escapeHtml(log.source)}] ${escapeHtml(log.message)} ${log.count > 1 ? `×${log.count}` : ''}</div>`).join('') || '<div class="muted">Keine Logs.</div>';
}

function renderSettings() {
  byId('setting-online-poll').value = state.settings.online_poll_seconds;
  byId('setting-rotation').value = state.settings.rotation_seconds;
  byId('setting-health').value = state.settings.healthcheck_seconds;
}

function fillStreamerSelects(onlineValue = null, chatValue = null) {
  const options = ['<option value="">Bitte wählen</option>'].concat(state.streamers.map((s) => `<option value="${s.id}">${escapeHtml(s.login)}</option>`)).join('');
  byId('online-rule-streamer').innerHTML = options;
  byId('chat-rule-streamer').innerHTML = options;
  if (onlineValue) byId('online-rule-streamer').value = onlineValue;
  if (chatValue) byId('chat-rule-streamer').value = chatValue;
}

function renderTargets(containerId, values = null) {
  const container = byId(containerId);
  if (!state.lamps.length) { container.innerHTML = '<div class="muted">Bitte erst Lampen anlegen.</div>'; return; }
  const current = values || state.lamps.map((lamp) => ({ lamp_id: lamp.id, enabled: false, mode: 'static', color: '#9147ff', effect_name: '', effect_speed: 128, effect_intensity: 128 }));
  container.innerHTML = state.lamps.map((lamp) => {
    const target = current.find((x) => x.lamp_id === lamp.id) || { lamp_id: lamp.id, enabled: false, mode: 'static', color: '#9147ff', effect_name: '', effect_speed: 128, effect_intensity: 128 };
    const effects = (lamp.effects || []).map((fx) => {
      const value = String(fx.id ?? fx.name);
      return `<option value="${escapeHtml(value)}" ${value === String(target.effect_name || '') ? 'selected' : ''}>${escapeHtml(fx.name ?? fx.id)}</option>`;
    }).join('');
    const isEnabled = values ? true : target.enabled !== false;
    return `
      <div class="target-card">
        <label class="inline"><input type="checkbox" data-field="enabled" data-lamp="${lamp.id}" ${isEnabled && values?.find((x) => x.lamp_id === lamp.id) ? 'checked' : ''}> ${escapeHtml(lamp.name)}</label>
        <label>Modus<select data-field="mode" data-lamp="${lamp.id}"><option value="static" ${target.mode !== 'effect' ? 'selected' : ''}>Statisch</option><option value="effect" ${target.mode === 'effect' ? 'selected' : ''}>Effekt</option></select></label>
        <label>Farbe<input type="color" data-field="color" data-lamp="${lamp.id}" value="${escapeHtml(target.color || '#9147ff')}"></label>
        <label>Effekt<select data-field="effect_name" data-lamp="${lamp.id}"><option value="">Bitte wählen</option>${effects}</select></label>
        <label>Speed<input type="range" min="0" max="255" value="${Number(target.effect_speed || 128)}" data-field="effect_speed" data-lamp="${lamp.id}"></label>
        <label>Intensität<input type="range" min="0" max="255" value="${Number(target.effect_intensity || 128)}" data-field="effect_intensity" data-lamp="${lamp.id}"></label>
      </div>`;
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
      effect_speed: Number(byId(containerId).querySelector(`[data-field="effect_speed"][data-lamp="${lamp.id}"]`).value),
      effect_intensity: Number(byId(containerId).querySelector(`[data-field="effect_intensity"][data-lamp="${lamp.id}"]`).value)
    };
  }).filter(Boolean);
}

function summarizeTargets(targets = []) {
  if (!targets.length) return 'keine Lampen gewählt';
  return targets.map((target) => {
    const lamp = state.lamps.find((entry) => entry.id === target.lamp_id);
    const name = lamp?.name || target.lamp_id;
    return `${name}: ${target.mode === 'effect' ? `Effekt ${target.effect_name || '-'}` : `Farbe ${target.color || '#ffffff'}`}`;
  }).join(' · ');
}

function renderChatRulePreview() {
  const text = byId('chat-rule-text')?.value?.trim() || 'Kappa';
  const type = byId('chat-rule-match-type')?.value || 'contains';
  const windowSeconds = Number(byId('chat-rule-window')?.value || 10);
  const minMatches = Number(byId('chat-rule-min')?.value || 5);
  const behavior = type === 'exact' ? 'muss exakt gleich sein' : 'darf Teil einer Nachricht sein';
  const strictness = minMatches > Math.max(10, windowSeconds) ? 'relativ streng' : 'eher normal';
  const box = byId('chat-rule-preview');
  if (box) box.innerHTML = `<strong>Vorschau:</strong> Die Regel reagiert auf <code>${escapeHtml(text)}</code>, ${behavior}, braucht <strong>${minMatches}</strong> Treffer in <strong>${windowSeconds}</strong> Sekunden und ist damit <strong>${strictness}</strong>.`;
}

async function saveLamp(e) {
  e.preventDefault();
  const id = byId('lamp-id').value;
  const payload = { name: byId('lamp-name').value.trim(), type: byId('lamp-type').value, address: byId('lamp-address').value.trim(), api_key: byId('lamp-api-key').value.trim() || null, enabled: byId('lamp-enabled').checked };
  await api(id ? `/lamps/${id}` : '/lamps', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('lamp-modal');
  resetLampForm();
  toast('Lampe gespeichert.');
  await refreshAll();
}

async function saveStreamer(e) {
  e.preventDefault();
  const id = byId('streamer-id').value;
  const payload = { login: byId('streamer-login').value.trim().toLowerCase(), enabled: byId('streamer-enabled').checked };
  await api(id ? `/streamers/${id}` : '/streamers', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('streamer-modal');
  resetStreamerForm();
  toast('Streamer gespeichert.');
  await refreshAll();
}

async function saveOnlineRule(e) {
  e.preventDefault();
  const id = byId('online-rule-id').value;
  const payload = { streamer_id: byId('online-rule-streamer').value, enabled: byId('online-rule-enabled').checked, targets: collectTargets('online-rule-targets') };
  await api(id ? `/online-rules/${id}` : '/online-rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('online-rule-modal');
  resetOnlineRuleForm();
  toast('Online-Szene gespeichert.');
  await refreshAll();
}

async function saveChatRule(e) {
  e.preventDefault();
  const id = byId('chat-rule-id').value;
  const payload = { name: byId('chat-rule-name').value.trim(), streamer_id: byId('chat-rule-streamer').value, match_text: byId('chat-rule-text').value.trim(), match_type: byId('chat-rule-match-type').value, window_seconds: Number(byId('chat-rule-window').value), min_matches: Number(byId('chat-rule-min').value), enabled: byId('chat-rule-enabled').checked, targets: collectTargets('chat-rule-targets') };
  await api(id ? `/chat-rules/${id}` : '/chat-rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('chat-rule-modal');
  resetChatRuleForm();
  toast('Chat-Regel gespeichert.');
  await refreshAll();
}

async function saveSettings() {
  await api('/settings', { method: 'PUT', body: JSON.stringify({ online_poll_seconds: Number(byId('setting-online-poll').value), rotation_seconds: Number(byId('setting-rotation').value), healthcheck_seconds: Number(byId('setting-health').value) }) });
  toast('Einstellungen gespeichert.');
  await refreshAll();
}

async function exportConfig() {
  const payload = await api('/config/export');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `twitch-lamp-config-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Config exportiert.');
}

async function importConfig(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!confirm('Import ersetzt die aktuelle Konfiguration. Wirklich fortfahren?')) {
    event.target.value = '';
    return;
  }
  const text = await file.text();
  const payload = JSON.parse(text);
  await api('/config/import', { method: 'POST', body: JSON.stringify(payload) });
  event.target.value = '';
  toast('Config importiert.');
  await refreshAll();
}

window.deleteEntity = async function(endpoint) {
  if (!confirm('Wirklich löschen?')) return;
  await api(endpoint, { method: 'DELETE' });
  toast('Eintrag gelöscht.');
  await refreshAll();
};

function resetLampForm() {
  byId('lamp-form').reset();
  byId('lamp-id').value = '';
  byId('lamp-enabled').checked = true;
}

function resetStreamerForm() {
  byId('streamer-form').reset();
  byId('streamer-id').value = '';
  byId('streamer-enabled').checked = true;
}

function resetOnlineRuleForm() {
  byId('online-rule-form').reset();
  byId('online-rule-id').value = '';
  byId('online-rule-enabled').checked = true;
  fillStreamerSelects();
  renderTargets('online-rule-targets');
}

function resetChatRuleForm() {
  byId('chat-rule-form').reset();
  byId('chat-rule-id').value = '';
  byId('chat-rule-window').value = 10;
  byId('chat-rule-min').value = 5;
  byId('chat-rule-enabled').checked = true;
  fillStreamerSelects();
  renderTargets('chat-rule-targets');
  renderChatRulePreview();
}

function toast(message, isError = false) {
  const box = byId('toast');
  box.textContent = message;
  box.className = `toast ${isError ? 'error' : ''}`;
  setTimeout(() => box.classList.add('hidden'), 2600);
}
