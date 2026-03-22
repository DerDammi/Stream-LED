const API = '/api';
let refreshTimer = null;
let state = { lamps: [], streamers: [], onlineRules: [], chatRules: [], status: null, logs: [], settings: null, support: null, discoveries: null, lastRuleTest: null };

const RULE_PRESETS = {
  online: [
    { id: '', name: 'Keine Vorlage' },
    { id: 'purple-static', name: 'Twitch Purple', target: { mode: 'static', color: '#9147ff' } },
    { id: 'alert-red', name: 'Live-Alarm Rot', target: { mode: 'static', color: '#ff4d4d' } },
    { id: 'rainbow-effect', name: 'Rainbow Effekt', target: { mode: 'effect', effect_name: 'Rainbow', effect_speed: 160, effect_intensity: 180 } }
  ],
  chat: [
    { id: '', name: 'Keine Vorlage' },
    { id: 'hype', name: 'Hype / Spam-Spitze', form: { name: 'Hype', match_text: 'hype', match_type: 'contains', window_seconds: 10, min_matches: 5 }, target: { mode: 'static', color: '#22c55e' } },
    { id: 'lul', name: 'LUL / Lach-Trigger', form: { name: 'LUL Flood', match_text: 'LUL', match_type: 'contains', window_seconds: 8, min_matches: 4 }, target: { mode: 'static', color: '#f59e0b' } },
    { id: 'kappa', name: 'Kappa Burst', form: { name: 'Kappa Burst', match_text: 'Kappa', match_type: 'exact', window_seconds: 10, min_matches: 5 }, target: { mode: 'static', color: '#8b5cf6' } }
  ]
};

const byId = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const formatTime = (value) => value ? new Date(value).toLocaleString('de-DE') : 'noch nie';
const effectLabel = (target) => target.mode === 'effect' ? `Effekt ${target.effect_name || '-'}` : `Farbe ${target.color || '#ffffff'}`;

window.openModal = (id) => document.getElementById(id).classList.remove('hidden');
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');
window.openLampModal = () => { resetLampForm(); openModal('lamp-modal'); renderLampWizardHelp(); renderHueAssistant(); };
window.useDiscoveryLamp = function(type, address, name) { byId('lamp-type').value = type; byId('lamp-address').value = address; if (!byId('lamp-name').value) byId('lamp-name').value = name || ''; renderLampWizardHelp(); renderHueAssistant(); openModal('lamp-modal'); };
window.openStreamerModal = () => { resetStreamerForm(); openModal('streamer-modal'); };
window.openOnlineRuleModal = () => { resetOnlineRuleForm(); openModal('online-rule-modal'); };
window.openChatRuleModal = () => { resetChatRuleForm(); openModal('chat-rule-modal'); };

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindNav();
  bindSetup();
  bindForms();
  fillPresetSelects();
  try {
    const [setup, support] = await Promise.all([api('/setup/status'), api('/meta/support')]);
    state.support = support;
    byId('redirect-uri').textContent = setup.redirectUri;
    byId('setup-checklist').innerHTML = (setup.checklist || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    if (setup.savedClientId) byId('setup-client-id').value = setup.savedClientId;
    if (setup.hasClientConfig) setSetupStatus('Twitch App Daten sind gespeichert. Als Nächstes auf „Mit Twitch verbinden“ klicken.');
    renderSupportHints();
    if (setup.needsSetup) showScreen('setup-screen');
    else {
      showScreen('app');
      await refreshAll();
      startRefreshLoop();
    }
  } catch (error) {
    console.error(error);
    showScreen('setup-screen');
    setSetupStatus(`Setup konnte nicht geladen werden: ${error.message || 'unbekannter Fehler'}`, true);
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
    try {
      const client_id = byId('setup-client-id').value.trim();
      const client_secret = byId('setup-client-secret').value.trim();
      if (!client_id || !client_secret) {
        setSetupStatus('Bitte Client ID und Client Secret eintragen.', true);
        return;
      }
      byId('save-app-btn').disabled = true;
      await api('/setup/twitch-app', { method: 'POST', body: JSON.stringify({ client_id, client_secret }) });
      setSetupStatus('Twitch App gespeichert. Jetzt auf „Mit Twitch verbinden“ klicken.');
      toast('Twitch App gespeichert.');
    } catch (error) {
      console.error(error);
      setSetupStatus(`Speichern fehlgeschlagen: ${error.message || 'unbekannter Fehler'}`, true);
      toast(error.message || 'Speichern fehlgeschlagen.', true);
    } finally {
      byId('save-app-btn').disabled = false;
    }
  });

  byId('oauth-btn').addEventListener('click', async () => {
    try {
      byId('oauth-btn').disabled = true;
      setSetupStatus('OAuth-Fenster wird geöffnet …');
      const data = await api('/auth/twitch/start');
      const popup = window.open(data.url, '_blank', 'width=720,height=820');
      if (!popup) {
        throw new Error('Das OAuth-Fenster wurde blockiert. Bitte Popup-Blocker erlauben und erneut klicken.');
      }
      const poll = setInterval(async () => {
        try {
          const setup = await api('/setup/status');
          if (!setup.needsSetup) {
            clearInterval(poll);
            showScreen('app');
            await refreshAll();
            startRefreshLoop();
            toast('Twitch erfolgreich verbunden.');
          }
        } catch (error) {
          clearInterval(poll);
          setSetupStatus(`OAuth-Status konnte nicht geprüft werden: ${error.message || 'unbekannter Fehler'}`, true);
        }
      }, 2000);
    } catch (error) {
      console.error(error);
      setSetupStatus(`OAuth konnte nicht gestartet werden: ${error.message || 'unbekannter Fehler'}`, true);
      toast(error.message || 'OAuth konnte nicht gestartet werden.', true);
    } finally {
      byId('oauth-btn').disabled = false;
    }
  });
}

function bindForms() {
  byId('lamp-form').addEventListener('submit', saveLamp);
  byId('streamer-form').addEventListener('submit', saveStreamer);
  byId('online-rule-form').addEventListener('submit', saveOnlineRule);
  byId('chat-rule-form').addEventListener('submit', saveChatRule);
  byId('save-settings-btn').addEventListener('click', saveSettings);
  byId('clear-logs-btn').addEventListener('click', async () => { await api('/logs', { method: 'DELETE' }); toast('Logs geleert.'); await refreshAll(); });
  byId('reconnect-btn').addEventListener('click', async () => { const data = await api('/auth/twitch/start'); window.open(data.url, '_blank', 'width=720,height=820'); });
  byId('refresh-now-btn').addEventListener('click', refreshAll);
  byId('run-healthcheck-btn')?.addEventListener('click', runHealthcheckNow);
  byId('discover-lamps-btn')?.addEventListener('click', discoverLampsNow);
  byId('run-rule-test-btn')?.addEventListener('click', runRuleTestNow);
  byId('export-config-btn').addEventListener('click', exportConfig);
  byId('import-config-input').addEventListener('change', importConfig);
  byId('lamp-type').addEventListener('change', () => { renderLampWizardHelp(); renderHueAssistant(); });
  byId('lamp-address').addEventListener('input', handleLampAddressHelper);
  byId('hue-pair-btn')?.addEventListener('click', pairHueBridge);
  byId('hue-load-lights-btn')?.addEventListener('click', loadHueLights);
  byId('apply-chat-assistant-btn')?.addEventListener('click', applyChatAssistant);
  byId('online-copy-live-btn')?.addEventListener('click', () => bulkSetTargets('online-rule-targets', { color: '#9147ff', mode: 'static' }));
  byId('chat-copy-hype-btn')?.addEventListener('click', () => bulkSetTargets('chat-rule-targets', { color: '#22c55e', mode: 'static' }));
  ['chat-rule-text', 'chat-rule-match-type', 'chat-rule-window', 'chat-rule-min'].forEach((id) => byId(id).addEventListener('input', renderChatRulePreview));
  byId('online-rule-preset').addEventListener('change', applyOnlinePreset);
  byId('chat-rule-preset').addEventListener('change', applyChatPreset);
}

function fillPresetSelects() {
  byId('online-rule-preset').innerHTML = RULE_PRESETS.online.map((preset) => `<option value="${preset.id}">${escapeHtml(preset.name)}</option>`).join('');
  byId('chat-rule-preset').innerHTML = RULE_PRESETS.chat.map((preset) => `<option value="${preset.id}">${escapeHtml(preset.name)}</option>`).join('');
}

function startRefreshLoop() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = setInterval(refreshAll, 5000); }
function showScreen(id) { document.querySelectorAll('.screen').forEach((x) => x.classList.add('hidden')); byId(id).classList.remove('hidden'); }

async function api(url, options = {}) {
  const response = await fetch(`${API}${url}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Fehler');
  return data;
}

async function refreshAll() {
  try {
    const [lamps, streamers, onlineRules, chatRules, status, logs, settings] = await Promise.all([
      api('/lamps'), api('/streamers'), api('/online-rules'), api('/chat-rules'), api('/status'), api('/logs?limit=100'), api('/settings')
    ]);
    state = { ...state, lamps, streamers, onlineRules, chatRules, status, logs, settings };
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
  fillRuleTestSelects();
  renderChatRulePreview();
}

function renderSupportHints() {
  const list = state.support?.lampTypes || [];
  const box = byId('lamp-type-overview');
  if (!box) return;
  box.innerHTML = list.map((entry) => `<div class="support-chip ${entry.status}"><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(entry.status === 'planned' ? 'später' : 'jetzt')}</span></div>`).join('');
}

function renderDashboard() {
  const twitch = state.status?.twitch || { onlineStreamers: [] };
  const diagnostics = state.status?.diagnostics || {};
  const onlineLampCount = state.lamps.filter((lamp) => lamp.last_seen).length;
  byId('twitch-status').textContent = twitch.connected ? `🟢 ${twitch.auth?.login || 'Verbunden'}` : '🔴 Nicht verbunden';
  byId('runtime-summary').textContent = twitch.connected ? `${twitch.onlineStreamers.length} live · ${onlineLampCount}/${state.lamps.length} Lampen online` : 'Twitch ist aktuell nicht verbunden.';
  byId('stat-live').textContent = twitch.onlineStreamers.length;
  byId('stat-lamps').textContent = state.lamps.length;
  byId('stat-lamps-online').textContent = onlineLampCount;
  byId('stat-chat').textContent = twitch.activeChatRule ? twitch.activeChatRule.name : '-';
  byId('stat-chat-detail').textContent = twitch.activeChatRule ? `${twitch.activeChatRule.currentMatches}/${twitch.activeChatRule.minMatches} Treffer in ${twitch.activeChatRule.windowSeconds}s` : 'kein Trigger aktiv';
  byId('stat-rotation').textContent = twitch.activeOnlineRule ? twitch.activeOnlineRule.streamer_login : '-';
  byId('stat-rotation-detail').textContent = twitch.activeOnlineRule ? 'diese Online-Szene läuft gerade' : 'keine Online-Szene aktiv';

  const checklist = [
    { ok: state.streamers.length > 0, text: 'Mindestens 1 Streamer angelegt' },
    { ok: state.lamps.length > 0, text: 'Mindestens 1 Lampe angelegt' },
    { ok: state.onlineRules.length > 0, text: 'Mindestens 1 Online-Szene angelegt' },
    { ok: state.chatRules.length > 0, text: 'Mindestens 1 Chat-Regel angelegt' }
  ];
  byId('dashboard-checklist').innerHTML = checklist.map((item) => `<div class="status-row"><span>${item.ok ? '✅' : '⬜'}</span><span>${escapeHtml(item.text)}</span></div>`).join('');
  byId('system-health').innerHTML = [
    `Twitch Chat: ${twitch.connected ? 'verbunden' : 'nicht verbunden'}`,
    `Überwachte Kanäle: ${diagnostics.twitch?.watchedChannels ?? 0}`,
    `Letzter Live-Check: ${formatTime(diagnostics.twitch?.lastOnlinePollSuccessAt)}`,
    `Healthcheck Lampen: ${formatTime(diagnostics.lamps?.lastHealthCheckSuccessAt)}`,
    `Discovery zuletzt: ${formatTime(diagnostics.lamps?.lastDiscoveryAt)}`,
    `Regeln bereit: ${state.status?.ruleReadiness?.onlineRulesReady ?? 0} Online · ${state.status?.ruleReadiness?.chatRulesReady ?? 0} Chat`
  ].map((row) => `<div class="status-row"><span>•</span><span>${escapeHtml(row)}</span></div>`).join('');

  byId('live-streamers').innerHTML = twitch.onlineStreamers.length ? twitch.onlineStreamers.map((s) => `<span class="chip live">${escapeHtml(s)}</span>`).join('') : '<span class="muted">Niemand live</span>';
  byId('diagnostics-summary').innerHTML = [
    `Twitch Auth zuletzt geprüft: ${formatTime(diagnostics.twitch?.lastAuthCheckAt)}`,
    `Chat zuletzt verbunden: ${formatTime(diagnostics.twitch?.lastChatConnectAt)}`,
    `Letzter Chat-Disconnect: ${diagnostics.twitch?.lastChatDisconnectReason ? `${formatTime(diagnostics.twitch?.lastChatDisconnectAt)} · ${escapeHtml(diagnostics.twitch.lastChatDisconnectReason)}` : 'kein Disconnect bekannt'}`,
    `Letzter Twitch-Fehler: ${escapeHtml(diagnostics.twitch?.lastOnlinePollError || diagnostics.twitch?.lastAuthError || 'kein Fehler gespeichert')}`,
    `Letzter Anwendungs-Lauf: ${formatTime(diagnostics.lamps?.lastApplyAt)} · ${escapeHtml(diagnostics.lamps?.lastApplySummary?.dryRun ? 'nur Testmodus' : 'live angewendet')}`
  ].map((row) => `<div class="status-row"><span>•</span><span>${row}</span></div>`).join('');

  const priorityBox = byId('priority-summary');
  if (priorityBox) {
    const conflicts = state.status?.priority?.conflicts || [];
    priorityBox.innerHTML = conflicts.length
      ? `<strong>Priorität aktiv:</strong> Chat-Regeln übersteuern gerade Online-Szenen auf ${conflicts.length} Lampe(n): ${conflicts.map((c) => escapeHtml(c.lamp_name)).join(', ')}`
      : '<strong>Priorität:</strong> Chat-Regeln haben Vorrang vor Online-Rotation, aktuell aber ohne Konflikt.';
  }

  byId('lamp-status').innerHTML = state.lamps.map((lamp) => {
    const runtime = state.status?.lamps?.[lamp.id];
    const source = runtime?.state?.source || 'kein aktiver Zustand';
    const detail = runtime?.state?.mode === 'effect' ? `Effekt ${runtime.state.effect_name || '-'} · Speed ${runtime.state.effect_speed} · Intensität ${runtime.state.effect_intensity}` : runtime?.state?.color ? `Farbe ${runtime.state.color}` : 'wartet auf Szene oder Regel';
    const diag = runtime?.diagnostics;
    return `<div class="card comfort-card"><div><strong>${escapeHtml(lamp.name)}</strong><div class="meta">${escapeHtml(lamp.type.toUpperCase())} · ${escapeHtml(lamp.address)} · ${lamp.last_seen ? 'online' : 'offline'}</div><div class="meta">Quelle: ${escapeHtml(source)}</div><div class="meta">${escapeHtml(detail)}</div><div class="meta">Diagnose: letzter Check ${formatTime(diag?.checkedAt)} · ${diag?.error ? escapeHtml(diag.error) : 'ok'}</div></div></div>`;
  }).join('') || '<div class="muted">Keine Lampen</div>';

  byId('diagnostics-errors').innerHTML = (diagnostics.recentErrors || []).map((log) => `<div class="log-entry"><span>${escapeHtml(log.last_seen)}</span> <strong>${escapeHtml(log.level)}</strong> [${escapeHtml(log.source)}] ${escapeHtml(log.message)}</div>`).join('') || '<div class="muted">Zuletzt keine Warnungen oder Fehler.</div>';
}

function renderLamps() {
  byId('lamp-list').innerHTML = state.lamps.map((lamp) => {
    const effectOptions = (lamp.effects || []).slice(0, 12).map((fx) => `<option value="${escapeHtml(String(fx.id ?? fx.name))}">${escapeHtml(fx.name ?? fx.id)}</option>`).join('');
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
          <div class="actions-row compact-top">
            <button class="btn btn-ghost" onclick="diagnoseLamp('${lamp.id}')">Diagnose</button>
            <button class="btn btn-ghost" onclick="refreshLampEffects('${lamp.id}')">Effekte neu laden</button>
            <span class="meta">${lamp.type === 'wled' ? 'Tipp: WLED antwortet typischerweise unter /json.' : lamp.type === 'hue' ? 'Tipp: Hue lokal braucht Bridge-IP, Link-Button und einen Username.' : 'Tipp: Govee lokal braucht oft LAN-Control oder API-Key.'}</span>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-secondary" onclick="editLamp('${lamp.id}')">Bearbeiten</button>
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
  byId('lamp-address').value = lamp.metadata?.bridge_ip || lamp.address;
  byId('lamp-api-key').value = lamp.api_key || '';
  if (lamp.type === 'hue') { const select = byId('hue-light-select'); if (select) select.innerHTML = `<option value="${escapeHtml(lamp.metadata?.light_id || lamp.address.split('/')[1] || '')}" selected>${escapeHtml(lamp.name)}</option>`; }
  byId('lamp-enabled').checked = lamp.enabled;
  renderLampWizardHelp();
  openModal('lamp-modal');
};
window.refreshLampEffects = async function(id) { await api(`/lamps/${id}/refresh-effects`, { method: 'POST' }); toast('Effektliste aktualisiert.'); await refreshAll(); };
window.testLampColor = async function(id) { const color = byId(`lamp-color-${id}`).value; await api(`/lamps/${id}/test`, { method: 'POST', body: JSON.stringify({ action: 'color', color }) }); toast('Testfarbe gesendet.'); };
window.testLampEffect = async function(id) { const effect_name = byId(`lamp-effect-${id}`).value; if (!effect_name) return toast('Bitte erst einen Effekt wählen.', true); await api(`/lamps/${id}/test`, { method: 'POST', body: JSON.stringify({ action: 'effect', effect_name, effect_speed: 128, effect_intensity: 128 }) }); toast('Effekt-Test gesendet.'); };
window.testLampOff = async function(id) { await api(`/lamps/${id}/test`, { method: 'POST', body: JSON.stringify({ action: 'off' }) }); toast('Lampe ausgeschaltet.'); };
window.diagnoseLamp = async function(id) {
  const data = await api(`/lamps/${id}/diagnose`, { method: 'POST' });
  const result = data.result;
  byId('lamp-diagnostics-box').innerHTML = `<strong>${escapeHtml(data.lamp.name)}</strong><br>${result.pingOk ? '✅ erreichbar' : '❌ nicht erreichbar'} · ${result.effectCount} Effekte/Presets erkannt<br>${escapeHtml(result.hint)}${result.refreshError ? `<br><span class="warn">Effekt-Refresh: ${escapeHtml(result.refreshError)}</span>` : ''}`;
  toast(result.pingOk ? 'Lampe antwortet.' : 'Lampe antwortet aktuell nicht.', !result.pingOk);
  await refreshAll();
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
  byId('online-rule-preset').value = '';
  renderTargets('online-rule-targets', rule.targets);
  updateTargetSummary('online-rule-targets', 'online-target-summary');
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
  byId('chat-rule-preset').value = '';
  renderTargets('chat-rule-targets', rule.targets);
  updateTargetSummary('chat-rule-targets', 'chat-target-summary');
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
  updateTargetSummary('chat-rule-targets', 'chat-target-summary');
  renderChatRulePreview();
  openModal('chat-rule-modal');
};

function renderLogs() { byId('log-list').innerHTML = state.logs.map((log) => `<div class="log-entry"><span>${escapeHtml(log.last_seen)}</span> <strong>${escapeHtml(log.level)}</strong> [${escapeHtml(log.source)}] ${escapeHtml(log.message)} ${log.count > 1 ? `×${log.count}` : ''}</div>`).join('') || '<div class="muted">Keine Logs.</div>'; }
function renderSettings() {
  byId('setting-online-poll').value = state.settings.online_poll_seconds;
  byId('setting-rotation').value = state.settings.rotation_seconds;
  byId('setting-health').value = state.settings.healthcheck_seconds;
  const discoveryBox = byId('discovery-results');
  if (discoveryBox) {
    const devices = state.discoveries?.result?.devices || {};
    const groups = [
      ...(devices.wled || []).map((item) => `WLED · ${item.name} · ${item.address}`),
      ...(devices.govee || []).map((item) => `Govee · ${item.name} · ${item.address}`),
      ...(devices.hue || []).map((item) => `Hue Bridge · ${item.address} · per Assistent koppelbar`)
    ];
    discoveryBox.innerHTML = groups.length ? groups.map((row) => `<div class="status-row"><span>•</span><span>${escapeHtml(row)}</span></div>`).join('') : 'Noch keine Discovery gelaufen.';
  }
  const ruleTest = byId('rule-test-results');
  if (ruleTest) {
    const actions = state.lastRuleTest?.result?.actions || [];
    const conflicts = state.lastRuleTest?.result?.conflicts || [];
    ruleTest.innerHTML = actions.length
      ? actions.map((entry) => `<div class="status-row"><span>•</span><span>${escapeHtml(`${entry.lamp_name}: ${entry.action === 'color' ? entry.nextState?.color : entry.action === 'effect' ? `Effekt ${entry.nextState?.effect_name}` : entry.action}`)}</span></div>`).join('') + (conflicts.length ? `<div class="priority-box"><strong>Priorität:</strong> Chat-Regeln gewinnen bei Konflikten. ${conflicts.map((c) => escapeHtml(c.lamp_name)).join(', ')}</div>` : '')
      : 'Noch kein Regel-Test gelaufen.';
  }
}
function fillStreamerSelects(onlineValue = null, chatValue = null) { const options = ['<option value="">Bitte wählen</option>'].concat(state.streamers.map((s) => `<option value="${s.id}">${escapeHtml(s.login)}</option>`)).join(''); byId('online-rule-streamer').innerHTML = options; byId('chat-rule-streamer').innerHTML = options; if (onlineValue) byId('online-rule-streamer').value = onlineValue; if (chatValue) byId('chat-rule-streamer').value = chatValue; }
function fillRuleTestSelects() {
  const online = byId('rule-test-online');
  const chat = byId('rule-test-chat');
  if (online) online.innerHTML = ['<option value="">Keine Online-Szene</option>'].concat(state.onlineRules.map((rule) => `<option value="${rule.id}">${escapeHtml(rule.streamer_login)}</option>`)).join('');
  if (chat) chat.innerHTML = ['<option value="">Keine Chat-Regel</option>'].concat(state.chatRules.map((rule) => `<option value="${rule.id}">${escapeHtml(rule.name)}</option>`)).join('');
}

function renderTargets(containerId, values = null) {
  const container = byId(containerId);
  if (!state.lamps.length) { container.innerHTML = '<div class="muted">Bitte erst Lampen anlegen.</div>'; return; }
  const current = values || state.lamps.map((lamp) => ({ lamp_id: lamp.id, enabled: false, mode: 'static', color: '#9147ff', effect_name: '', effect_speed: 128, effect_intensity: 128 }));
  container.innerHTML = state.lamps.map((lamp) => {
    const target = current.find((x) => x.lamp_id === lamp.id) || { lamp_id: lamp.id, enabled: false, mode: 'static', color: '#9147ff', effect_name: '', effect_speed: 128, effect_intensity: 128 };
    const effects = (lamp.effects || []).map((fx) => { const value = String(fx.id ?? fx.name); return `<option value="${escapeHtml(value)}" ${value === String(target.effect_name || '') ? 'selected' : ''}>${escapeHtml(fx.name ?? fx.id)}</option>`; }).join('');
    const checked = values ? !!values.find((x) => x.lamp_id === lamp.id) : target.enabled !== false;
    return `
      <div class="target-card" data-target-card="${lamp.id}">
        <div class="target-top">
          <label class="inline"><input type="checkbox" data-field="enabled" data-lamp="${lamp.id}" ${checked ? 'checked' : ''}> ${escapeHtml(lamp.name)}</label>
          <span class="meta">${escapeHtml(lamp.type.toUpperCase())} · ${(lamp.effects || []).length} Effekte</span>
        </div>
        <label>Modus<select data-field="mode" data-lamp="${lamp.id}"><option value="static" ${target.mode !== 'effect' ? 'selected' : ''}>Statisch</option><option value="effect" ${target.mode === 'effect' ? 'selected' : ''}>Effekt</option></select></label>
        <label>Farbe<input type="color" data-field="color" data-lamp="${lamp.id}" value="${escapeHtml(target.color || '#9147ff')}"></label>
        <label>Effekt<select data-field="effect_name" data-lamp="${lamp.id}"><option value="">Bitte wählen</option>${effects}</select></label>
        <label>Speed<input type="range" min="0" max="255" value="${Number(target.effect_speed || 128)}" data-field="effect_speed" data-lamp="${lamp.id}"></label>
        <label>Intensität<input type="range" min="0" max="255" value="${Number(target.effect_intensity || 128)}" data-field="effect_intensity" data-lamp="${lamp.id}"></label>
        <div class="target-actions">
          <button type="button" class="btn btn-ghost" onclick="copyTargetToAll('${containerId}','${lamp.id}')">Auf alle kopieren</button>
          <button type="button" class="btn btn-ghost" onclick="previewTarget('${lamp.id}','${containerId}')">Jetzt testen</button>
        </div>
      </div>`;
  }).join('');
  container.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', () => updateTargetSummary(containerId, containerId === 'online-rule-targets' ? 'online-target-summary' : 'chat-target-summary')));
}

window.copyTargetToAll = function(containerId, lampId) {
  const source = readTarget(containerId, lampId); if (!source) return;
  bulkSetTargets(containerId, source);
  toast('Einstellung auf alle Lampen kopiert.');
};
window.previewTarget = async function(lampId, containerId) {
  const target = readTarget(containerId, lampId); if (!target) return toast('Bitte Lampe erst aktivieren.', true);
  if (target.mode === 'effect' && target.effect_name) await api(`/lamps/${lampId}/test`, { method: 'POST', body: JSON.stringify({ action: 'effect', effect_name: target.effect_name, effect_speed: target.effect_speed, effect_intensity: target.effect_intensity }) });
  else await api(`/lamps/${lampId}/test`, { method: 'POST', body: JSON.stringify({ action: 'color', color: target.color }) });
  toast('Vorschau an Lampe gesendet.');
};

function readTarget(containerId, lampId) {
  const enabled = byId(containerId).querySelector(`[data-field="enabled"][data-lamp="${lampId}"]`)?.checked;
  if (!enabled) return null;
  return {
    mode: byId(containerId).querySelector(`[data-field="mode"][data-lamp="${lampId}"]`).value,
    color: byId(containerId).querySelector(`[data-field="color"][data-lamp="${lampId}"]`).value,
    effect_name: byId(containerId).querySelector(`[data-field="effect_name"][data-lamp="${lampId}"]`).value,
    effect_speed: Number(byId(containerId).querySelector(`[data-field="effect_speed"][data-lamp="${lampId}"]`).value),
    effect_intensity: Number(byId(containerId).querySelector(`[data-field="effect_intensity"][data-lamp="${lampId}"]`).value)
  };
}

function bulkSetTargets(containerId, presetTarget) {
  state.lamps.forEach((lamp) => {
    const enabled = byId(containerId).querySelector(`[data-field="enabled"][data-lamp="${lamp.id}"]`);
    const mode = byId(containerId).querySelector(`[data-field="mode"][data-lamp="${lamp.id}"]`);
    const color = byId(containerId).querySelector(`[data-field="color"][data-lamp="${lamp.id}"]`);
    const effect = byId(containerId).querySelector(`[data-field="effect_name"][data-lamp="${lamp.id}"]`);
    const speed = byId(containerId).querySelector(`[data-field="effect_speed"][data-lamp="${lamp.id}"]`);
    const intensity = byId(containerId).querySelector(`[data-field="effect_intensity"][data-lamp="${lamp.id}"]`);
    if (enabled) enabled.checked = true;
    if (mode && presetTarget.mode) mode.value = presetTarget.mode;
    if (color && presetTarget.color) color.value = presetTarget.color;
    if (effect && presetTarget.effect_name != null) {
      const existingOption = [...effect.options].find((option) => option.value === presetTarget.effect_name);
      effect.value = existingOption ? presetTarget.effect_name : '';
    }
    if (speed && presetTarget.effect_speed != null) speed.value = presetTarget.effect_speed;
    if (intensity && presetTarget.effect_intensity != null) intensity.value = presetTarget.effect_intensity;
  });
  updateTargetSummary(containerId, containerId === 'online-rule-targets' ? 'online-target-summary' : 'chat-target-summary');
}

function updateTargetSummary(containerId, summaryId) {
  const targets = collectTargets(containerId);
  const box = byId(summaryId);
  if (box) box.innerHTML = targets.length ? `${targets.length} Lampen aktiv · ${escapeHtml(targets.map(effectLabel).slice(0, 3).join(' · '))}${targets.length > 3 ? ' …' : ''}` : 'Noch keine Lampe ausgewählt.';
}

function applyPresetTarget(containerId, presetTarget) { bulkSetTargets(containerId, presetTarget); }
function applyOnlinePreset() { const preset = RULE_PRESETS.online.find((entry) => entry.id === byId('online-rule-preset').value); if (!preset?.target) return; applyPresetTarget('online-rule-targets', preset.target); toast(`Vorlage „${preset.name}“ übernommen.`); }
function applyChatPreset() { const preset = RULE_PRESETS.chat.find((entry) => entry.id === byId('chat-rule-preset').value); if (!preset) return; if (preset.form) { byId('chat-rule-name').value = preset.form.name; byId('chat-rule-text').value = preset.form.match_text; byId('chat-rule-match-type').value = preset.form.match_type; byId('chat-rule-window').value = preset.form.window_seconds; byId('chat-rule-min').value = preset.form.min_matches; } if (preset.target) applyPresetTarget('chat-rule-targets', preset.target); renderChatRulePreview(); if (preset.id) toast(`Vorlage „${preset.name}“ übernommen.`); }

function collectTargets(containerId) {
  return state.lamps.map((lamp) => {
    const enabled = byId(containerId).querySelector(`[data-field="enabled"][data-lamp="${lamp.id}"]`)?.checked;
    if (!enabled) return null;
    return { lamp_id: lamp.id, mode: byId(containerId).querySelector(`[data-field="mode"][data-lamp="${lamp.id}"]`).value, color: byId(containerId).querySelector(`[data-field="color"][data-lamp="${lamp.id}"]`).value, effect_name: byId(containerId).querySelector(`[data-field="effect_name"][data-lamp="${lamp.id}"]`).value, effect_speed: Number(byId(containerId).querySelector(`[data-field="effect_speed"][data-lamp="${lamp.id}"]`).value), effect_intensity: Number(byId(containerId).querySelector(`[data-field="effect_intensity"][data-lamp="${lamp.id}"]`).value) };
  }).filter(Boolean);
}

function summarizeTargets(targets = []) { if (!targets.length) return 'keine Lampen gewählt'; return targets.map((target) => { const lamp = state.lamps.find((entry) => entry.id === target.lamp_id); const name = lamp?.name || target.lamp_id; return `${name}: ${effectLabel(target)}`; }).join(' · '); }

function renderChatRulePreview() {
  const text = byId('chat-rule-text')?.value?.trim() || 'Kappa';
  const type = byId('chat-rule-match-type')?.value || 'contains';
  const windowSeconds = Number(byId('chat-rule-window')?.value || 10);
  const minMatches = Number(byId('chat-rule-min')?.value || 5);
  const behavior = type === 'exact' ? 'muss exakt gleich sein' : 'darf Teil einer Nachricht sein';
  const strictness = minMatches > Math.max(10, windowSeconds) ? 'relativ streng' : minMatches <= Math.max(3, Math.round(windowSeconds / 3)) ? 'eher locker' : 'ganz gut balanciert';
  const box = byId('chat-rule-preview');
  if (box) box.innerHTML = `<strong>Vorschau:</strong> Die Regel reagiert auf <code>${escapeHtml(text)}</code>, ${behavior}, braucht <strong>${minMatches}</strong> Treffer in <strong>${windowSeconds}</strong> Sekunden und ist damit <strong>${strictness}</strong>.`;
}

function applyChatAssistant() {
  const goal = byId('chat-assistant-goal').value;
  const mapping = {
    stable: { window: 15, min: 6, type: 'contains', hint: 'Für dauerhafte, nicht zu nervöse Trigger.' },
    fast: { window: 8, min: 4, type: 'contains', hint: 'Für Memes und kurze Chat-Spitzen.' },
    exact: { window: 12, min: 5, type: 'exact', hint: 'Gut, wenn nur die exakte Nachricht zählen soll.' }
  }[goal] || { window: 10, min: 5, type: 'contains', hint: 'Solider Standard.' };
  byId('chat-rule-window').value = mapping.window;
  byId('chat-rule-min').value = mapping.min;
  byId('chat-rule-match-type').value = mapping.type;
  byId('chat-assistant-result').textContent = mapping.hint;
  renderChatRulePreview();
  toast('Empfohlene Chat-Regel-Werte übernommen.');
}

function renderLampWizardHelp() {
  const type = byId('lamp-type')?.value || 'wled';
  const box = byId('lamp-helper-box');
  if (!box) return;
  const content = type === 'wled'
    ? '<strong>WLED Schnellhilfe</strong><br>Trage am besten nur IP oder Hostname ein, z. B. <code>192.168.1.50</code> oder <code>wled-kueche.local</code>. Danach kannst du direkt „Diagnose“ und „Effekte neu laden“ nutzen.'
    : type === 'govee'
      ? '<strong>Govee Schnellhilfe</strong><br>Für lokale Steuerung meist IP eintragen. Falls dein Modell es braucht oder Cloud-Steuerung genutzt wird, zusätzlich den API-Key hinterlegen. Eine kurze Preset-Liste ist bei Govee normal.'
      : '<strong>Hue Schnellhilfe</strong><br>Am einfachsten unten im Hue-Assistenten: Bridge suchen, Link-Button drücken, koppeln, Licht auswählen, speichern. Adresse wird dabei automatisch gebaut.';
  box.innerHTML = content;
}


function renderHueAssistant() {
  const type = byId('lamp-type')?.value || 'wled';
  const box = byId('hue-assistant-box');
  if (!box) return;
  box.classList.toggle('hidden', type !== 'hue');
}

async function pairHueBridge() {
  const bridgeIp = byId('lamp-address').value.trim().split('/')[0];
  if (!bridgeIp) return toast('Bitte zuerst die Hue-Bridge-IP eintragen oder per Discovery kopieren.', true);
  const data = await api('/discover/hue/pair', { method: 'POST', body: JSON.stringify({ address: bridgeIp }) });
  byId('lamp-api-key').value = data.result.username;
  toast('Hue Bridge gekoppelt. Jetzt Lichter laden.');
  await loadHueLights();
}

async function loadHueLights() {
  const bridgeIp = byId('lamp-address').value.trim().split('/')[0];
  const username = byId('lamp-api-key').value.trim();
  if (!bridgeIp || !username) return toast('Für Hue werden Bridge-IP und Username benötigt.', true);
  const data = await api(`/discover/hue/lights?bridge_ip=${encodeURIComponent(bridgeIp)}&username=${encodeURIComponent(username)}`);
  const select = byId('hue-light-select');
  select.innerHTML = ['<option value="">Bitte Licht wählen</option>'].concat((data.lights || []).map((light) => `<option value="${escapeHtml(light.light_id || light.id)}" data-name="${escapeHtml(light.name)}">${escapeHtml(light.name)}</option>`)).join('');
  byId('hue-assistant-result').textContent = data.lights?.length ? `${data.lights.length} Hue-Lichter gefunden.` : 'Keine Hue-Lichter gefunden.';
}
function handleLampAddressHelper() {
  const type = byId('lamp-type').value;
  const raw = byId('lamp-address').value.trim();
  if (!raw) return;
  if (type === 'wled') byId('lamp-address').value = raw.replace(/^https?:\/\//, '').replace(/\/json.*$/,'').replace(/\/$/, '');
  if (type === 'hue') byId('lamp-address').value = raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function runHealthcheckNow() { await api('/diagnostics/healthcheck', { method: 'POST' }); toast('Healthcheck gestartet.'); await refreshAll(); }
async function discoverLampsNow() {
  const address = byId('discovery-address')?.value?.trim();
  state.discoveries = await api(`/discover/lamps${address ? `?address=${encodeURIComponent(address)}` : ''}`);
  toast('Discovery abgeschlossen.');
  renderSettings();
}
async function runRuleTestNow() {
  const payload = {
    online_rule_id: byId('rule-test-online')?.value || null,
    chat_rule_id: byId('rule-test-chat')?.value || null,
    streamer_login: byId('rule-test-streamer-login')?.value?.trim() || null,
    message: byId('rule-test-message')?.value?.trim() || null
  };
  state.lastRuleTest = await api('/rule-test', { method: 'POST', body: JSON.stringify(payload) });
  toast('Regel-Test berechnet. Keine echte Lampe wurde verändert.');
  renderSettings();
}

async function saveLamp(e) {
  e.preventDefault();
  const type = byId('lamp-type').value;
  const id = byId('lamp-id').value;
  const payload = { name: byId('lamp-name').value.trim(), type, address: byId('lamp-address').value.trim(), api_key: byId('lamp-api-key').value.trim() || null, enabled: byId('lamp-enabled').checked };
  if (type === 'hue') {
    const lightId = byId('hue-light-select').value;
    const lightName = byId('hue-light-select').selectedOptions?.[0]?.textContent || payload.name;
    payload.metadata = { bridge_ip: payload.address.split('/')[0], light_id: lightId };
    payload.address = `${payload.metadata.bridge_ip}/${lightId}`;
    if (!payload.name) payload.name = lightName;
  }
  await api(id ? `/lamps/${id}` : '/lamps', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
  closeModal('lamp-modal'); resetLampForm(); toast('Lampe gespeichert.'); await refreshAll();
}
async function saveStreamer(e) { e.preventDefault(); const id = byId('streamer-id').value; const payload = { login: byId('streamer-login').value.trim().toLowerCase(), enabled: byId('streamer-enabled').checked }; await api(id ? `/streamers/${id}` : '/streamers', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); closeModal('streamer-modal'); resetStreamerForm(); toast('Streamer gespeichert.'); await refreshAll(); }
async function saveOnlineRule(e) { e.preventDefault(); const id = byId('online-rule-id').value; const payload = { streamer_id: byId('online-rule-streamer').value, enabled: byId('online-rule-enabled').checked, targets: collectTargets('online-rule-targets') }; await api(id ? `/online-rules/${id}` : '/online-rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); closeModal('online-rule-modal'); resetOnlineRuleForm(); toast('Online-Szene gespeichert.'); await refreshAll(); }
async function saveChatRule(e) { e.preventDefault(); const id = byId('chat-rule-id').value; const payload = { name: byId('chat-rule-name').value.trim(), streamer_id: byId('chat-rule-streamer').value, match_text: byId('chat-rule-text').value.trim(), match_type: byId('chat-rule-match-type').value, window_seconds: Number(byId('chat-rule-window').value), min_matches: Number(byId('chat-rule-min').value), enabled: byId('chat-rule-enabled').checked, targets: collectTargets('chat-rule-targets') }; await api(id ? `/chat-rules/${id}` : '/chat-rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); closeModal('chat-rule-modal'); resetChatRuleForm(); toast('Chat-Regel gespeichert.'); await refreshAll(); }
async function saveSettings() { await api('/settings', { method: 'PUT', body: JSON.stringify({ online_poll_seconds: Number(byId('setting-online-poll').value), rotation_seconds: Number(byId('setting-rotation').value), healthcheck_seconds: Number(byId('setting-health').value) }) }); toast('Einstellungen gespeichert.'); await refreshAll(); }

async function exportConfig() {
  const payload = await api('/config/export');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `twitch-lamp-config-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`; link.click(); URL.revokeObjectURL(link.href);
  byId('import-hint').innerHTML = 'Backup exportiert. Du kannst jetzt entspannt importieren.'; toast('Config exportiert.');
}

async function importConfig(event) {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const mode = byId('import-mode-select').value; const text = await file.text(); const payload = JSON.parse(text); const validation = await api('/config/validate', { method: 'POST', body: JSON.stringify(payload) });
    const summary = `Datei ok: ${validation.summary.lamps} Lampen, ${validation.summary.streamers} Streamer, ${validation.summary.onlineRules} Online-Szenen, ${validation.summary.chatRules} Chat-Regeln.`;
    byId('import-hint').innerHTML = `${summary}<br>${validation.warnings?.length ? `Hinweise: ${validation.warnings.map(escapeHtml).join(' · ')}` : 'Keine Warnungen erkannt.'}`;
    const confirmText = `${summary}\n\nModus: ${mode === 'merge' ? 'ergänzen' : 'alles ersetzen'}\n${validation.warnings?.length ? `\nHinweise:\n- ${validation.warnings.join('\n- ')}` : ''}\n\nFortfahren?`;
    if (!confirm(confirmText)) { event.target.value = ''; return; }
    const result = await api('/config/import', { method: 'POST', body: JSON.stringify({ mode, config: payload }) });
    byId('import-hint').innerHTML = `Import fertig (${result.result.mode}). Neu: ${result.result.created.lamps} Lampen, ${result.result.created.streamers} Streamer, ${result.result.created.onlineRules} Online-Szenen, ${result.result.created.chatRules} Chat-Regeln.${result.result.skipped.length ? `<br>Übersprungen: ${result.result.skipped.map(escapeHtml).join(' · ')}` : ''}`;
    event.target.value = ''; toast('Config importiert.'); await refreshAll();
  } catch (error) {
    byId('import-hint').textContent = error.message || 'Import fehlgeschlagen.'; toast(error.message || 'Import fehlgeschlagen.', true); event.target.value = '';
  }
}

window.deleteEntity = async function(endpoint) { if (!confirm('Wirklich löschen?')) return; await api(endpoint, { method: 'DELETE' }); toast('Eintrag gelöscht.'); await refreshAll(); };
function resetLampForm() { byId('lamp-form').reset(); byId('lamp-id').value = ''; byId('lamp-enabled').checked = true; byId('lamp-type').value = 'wled'; byId('lamp-diagnostics-box').textContent = 'Noch keine Diagnose gelaufen.'; const select = byId('hue-light-select'); if (select) select.innerHTML = '<option value=>Bitte Licht wählen</option>'; const result = byId('hue-assistant-result'); if (result) result.textContent = 'Noch keine Hue-Kopplung gestartet.'; renderLampWizardHelp(); renderHueAssistant(); }
function resetStreamerForm() { byId('streamer-form').reset(); byId('streamer-id').value = ''; byId('streamer-enabled').checked = true; }
function resetOnlineRuleForm() { byId('online-rule-form').reset(); byId('online-rule-id').value = ''; byId('online-rule-enabled').checked = true; byId('online-rule-preset').value = ''; fillStreamerSelects(); renderTargets('online-rule-targets'); updateTargetSummary('online-rule-targets', 'online-target-summary'); }
function resetChatRuleForm() { byId('chat-rule-form').reset(); byId('chat-rule-id').value = ''; byId('chat-rule-window').value = 10; byId('chat-rule-min').value = 5; byId('chat-rule-enabled').checked = true; byId('chat-rule-preset').value = ''; fillStreamerSelects(); renderTargets('chat-rule-targets'); updateTargetSummary('chat-rule-targets', 'chat-target-summary'); renderChatRulePreview(); byId('chat-assistant-result').textContent = 'Wähle kurz dein Ziel, dann fülle ich gute Startwerte ein.'; }
function setSetupStatus(message, isError = false) {
  const box = byId('setup-status-box');
  if (!box) return;
  box.textContent = message;
  box.className = `preview-box small-box spaced-top ${isError ? 'error-box' : ''}`;
}

function toast(message, isError = false) { const box = byId('toast'); box.textContent = message; box.className = `toast ${isError ? 'error' : ''}`; box.classList.remove('hidden'); setTimeout(() => box.classList.add('hidden'), 2600); }
