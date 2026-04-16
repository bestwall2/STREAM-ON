/**
 * FB Live Streamer — Dashboard
 * ============================
 * Pure vanilla ES2020.  No build step, no framework.
 * Communicates with the server via REST + Socket.IO.
 */

'use strict';

(function () {

  // ─── State ─────────────────────────────────────────────────────────────────

  const state = {
    streams:  new Map(),   // id → stream data object
    presets:  {},          // preset key → preset info
    editingId: null,       // null = creating, string = editing
    logPanels: new Map(),  // id → { open, autoscroll, el }
  };

  // ─── DOM refs ───────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);

  const grid         = $('streamGrid');
  const emptyState   = $('emptyState');
  const wsBadge      = $('wsBadge');
  const hTotal       = $('hTotalStreams');
  const hLive        = $('hLiveStreams');
  const hFallback    = $('hFallback');
  const btnAdd       = $('btnAddStream');
  const modal        = $('modalBackdrop');
  const modalTitle   = $('modalTitle');
  const modalSave    = $('modalSave');
  const modalCancel  = $('modalCancel');
  const modalClose   = $('modalClose');
  const streamForm   = $('streamForm');
  const formError    = $('formError');
  const confirmDlg   = $('confirmBackdrop');
  const confirmMsg   = $('confirmMsg');
  const confirmOk    = $('confirmOk');
  const confirmCancel= $('confirmCancel');
  const toastBox     = $('toastContainer');
  const presetSel    = $('fPreset');
  const customBlock  = $('customSettingsBlock');
  const fStreamId    = $('fStreamId');
  const fName        = $('fName');
  const fSourceUrl   = $('fSourceUrl');
  const fFbKey       = $('fFbKey');
  const fAutoStart   = $('fAutoStart');
  const fWidth       = $('fWidth');
  const fHeight      = $('fHeight');
  const fFps         = $('fFps');
  const fVBitrate    = $('fVBitrate');
  const fABitrate    = $('fABitrate');
  const btnToggleKey = $('btnToggleKey');
  const templateCard = $('tmplStreamCard');

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    wsBadge.classList.add('connected');
    wsBadge.classList.remove('disconnected');
    wsBadge.title = 'Connected';
  });

  socket.on('disconnect', () => {
    wsBadge.classList.add('disconnected');
    wsBadge.classList.remove('connected');
    wsBadge.title = 'Disconnected — reconnecting…';
  });

  socket.on('init', ({ streams, presets }) => {
    state.presets = presets;
    buildPresetOptions();
    for (const s of streams) state.streams.set(s.id, s);
    renderAllCards();
    updateHeaderStats();
  });

  socket.on('stream:created', s => {
    state.streams.set(s.id, s);
    insertCard(s);
    updateHeaderStats();
    emptyState.classList.add('hidden');
    toast(`Stream "${s.name}" created`, 'success');
  });

  socket.on('stream:updated', s => {
    state.streams.set(s.id, s);
    syncCard(s);
    updateHeaderStats();
  });

  socket.on('stream:deleted', ({ id }) => {
    state.streams.delete(id);
    const card = cardEl(id);
    if (card) card.remove();
    updateHeaderStats();
    if (state.streams.size === 0) emptyState.classList.remove('hidden');
  });

  socket.on('stream:state', ({ id, state: st, status }) => {
    if (status) state.streams.set(id, { ...(state.streams.get(id) || {}), ...status });
    updateCardState(id, st, status);
    updateHeaderStats();
  });

  // Bulk stats every 2 s
  socket.on('streams:stats', list => {
    for (const item of list) {
      const existing = state.streams.get(item.id);
      if (existing) Object.assign(existing, item);
      updateCardStats(item.id, item);
    }
    updateHeaderStats();
  });

  // Per-stream live log lines (only when log panel is open)
  socket.on('stream:log', entry => {
    const panel = state.logPanels.get(entry.streamId);
    if (!panel || !panel.open) return;
    appendLogLine(entry.streamId, entry);
  });

  // ─── REST helpers ───────────────────────────────────────────────────────────

  const api = {
    async get(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      return r.json();
    },
    async post(url, body) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      return r.json();
    },
    async put(url, body) {
      const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      return r.json();
    },
    async del(url) {
      const r = await fetch(url, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      return r.json();
    },
  };

  // ─── Card rendering ─────────────────────────────────────────────────────────

  function renderAllCards() {
    // Remove existing cards (but not the empty state)
    grid.querySelectorAll('.stream-card').forEach(c => c.remove());
    state.logPanels.clear();

    const streams = [...state.streams.values()];
    if (streams.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');
    for (const s of streams) insertCard(s);
  }

  function insertCard(s) {
    const node = templateCard.content.cloneNode(true);
    const card = node.querySelector('.stream-card');

    card.dataset.id    = s.id;
    card.dataset.state = s.state || 'idle';

    // Populate static parts
    card.querySelector('.card-name').textContent = s.name;
    card.querySelector('.state-badge').textContent = labelForState(s.state);
    card.querySelector('.meta-source').textContent = s.sourceUrl;
    card.querySelector('.meta-source').title       = s.sourceUrl;
    card.querySelector('.meta-preset').textContent = s.preset || '720p30';

    // Init stats
    applyStats(card, s);

    // Fallback chip
    if (s.usingFallback) card.querySelector('.fallback-chip').classList.remove('hidden');

    // Wire buttons
    card.querySelector('.btn-start').addEventListener('click',   () => controlStream(s.id, 'start'));
    card.querySelector('.btn-stop').addEventListener('click',    () => controlStream(s.id, 'stop'));
    card.querySelector('.btn-restart').addEventListener('click', () => controlStream(s.id, 'restart'));
    card.querySelector('.btn-edit').addEventListener('click',    () => openModal(s.id));
    card.querySelector('.btn-delete').addEventListener('click',  () => confirmDelete(s.id, s.name));

    // Log panel
    const logPanel  = card.querySelector('.log-panel');
    const logBody   = card.querySelector('.log-body');
    const logToggle = card.querySelector('.btn-logs-toggle');
    const cbScroll  = card.querySelector('.cb-autoscroll');
    const btnClear  = card.querySelector('.btn-clear-logs');

    state.logPanels.set(s.id, { open: false, autoscroll: true, body: logBody });

    logToggle.addEventListener('click', () => toggleLogPanel(s.id));
    cbScroll.addEventListener('change', () => {
      const p = state.logPanels.get(s.id);
      if (p) p.autoscroll = cbScroll.checked;
    });
    logBody.addEventListener('scroll', () => {
      const p = state.logPanels.get(s.id);
      if (!p) return;
      const atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 30;
      if (!atBottom) cbScroll.checked = p.autoscroll = false;
    });
    btnClear.addEventListener('click', () => {
      logBody.innerHTML = '';
    });

    grid.insertBefore(card, emptyState);
  }

  function cardEl(id) {
    return grid.querySelector(`.stream-card[data-id="${id}"]`);
  }

  // Full re-sync (name, source, preset, state, stats)
  function syncCard(s) {
    const card = cardEl(s.id);
    if (!card) return;
    card.querySelector('.card-name').textContent   = s.name;
    card.querySelector('.meta-source').textContent = s.sourceUrl;
    card.querySelector('.meta-source').title       = s.sourceUrl;
    card.querySelector('.meta-preset').textContent = s.preset || '720p30';
    updateCardState(s.id, s.state, s);
    applyStats(card, s);
  }

  function updateCardState(id, newState, status) {
    const card = cardEl(id);
    if (!card) return;
    card.dataset.state = newState || 'idle';
    card.querySelector('.state-badge').textContent = labelForState(newState);
    const chip = card.querySelector('.fallback-chip');
    if (status) {
      chip.classList.toggle('hidden', !status.usingFallback);
      applyStats(card, status);
    }
  }

  function updateCardStats(id, data) {
    const card = cardEl(id);
    if (!card) return;
    card.dataset.state = data.state || 'idle';
    card.querySelector('.state-badge').textContent = labelForState(data.state);
    const chip = card.querySelector('.fallback-chip');
    chip.classList.toggle('hidden', !data.usingFallback);
    applyStats(card, data);
  }

  function applyStats(card, data) {
    const s = data.stats || {};

    card.querySelector('.stat-uptime').textContent     = fmtUptime(data.uptime || 0);
    card.querySelector('.stat-reconnects').textContent = data.reconnectCount || 0;
    card.querySelector('.stat-fps').textContent        = fmtFps(s.fps);
    card.querySelector('.stat-bitrate').textContent    = fmtBitrate(s.bitrate);
    card.querySelector('.stat-frames').textContent     = s.frames ? s.frames.toLocaleString() : '—';
    card.querySelector('.stat-dropped').textContent    = s.droppedFrames || 0;
    card.querySelector('.stat-speed').textContent      = s.speed ? `${s.speed.toFixed(2)}x` : '—';

    // Colour the dropped frames cell red when > 0
    const droppedEl = card.querySelector('.stat-dropped');
    droppedEl.classList.toggle('stat-dropped', (s.droppedFrames || 0) > 0);
  }

  // ─── Header stats ───────────────────────────────────────────────────────────

  function updateHeaderStats() {
    const all = [...state.streams.values()];
    const live     = all.filter(s => s.state === 'streaming').length;
    const fallback = all.filter(s => s.state === 'fallback' || s.state === 'reconnecting').length;
    hTotal.textContent    = all.length;
    hLive.textContent     = live;
    hFallback.textContent = fallback;
  }

  // ─── Log panel ──────────────────────────────────────────────────────────────

  function toggleLogPanel(id) {
    const card  = cardEl(id);
    if (!card) return;
    const panel   = card.querySelector('.log-panel');
    const toggle  = card.querySelector('.btn-logs-toggle');
    const pState  = state.logPanels.get(id);
    if (!pState) return;

    const opening = !pState.open;
    pState.open = opening;
    panel.classList.toggle('hidden', !opening);
    toggle.textContent = opening ? 'Logs ▲' : 'Logs ▼';
    toggle.classList.toggle('open', opening);

    if (opening) {
      // Subscribe to live log room
      socket.emit('logs:subscribe', { id });
      // Fetch log history
      socket.emit('logs:fetch', { id, limit: 200 });
      socket.once(`logs:history:${id}`, lines => {
        pState.body.innerHTML = '';
        for (const entry of lines) appendLogLine(id, entry);
      });
    } else {
      socket.emit('logs:unsubscribe', { id });
    }
  }

  function appendLogLine(id, entry) {
    const pState = state.logPanels.get(id);
    if (!pState || !pState.open) return;

    const span = document.createElement('span');
    span.className = `log-line lvl-${entry.level || 'info'}`;

    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = entry.ts ? entry.ts.slice(11, 19) : '';
    span.appendChild(ts);
    span.appendChild(document.createTextNode(entry.msg || ''));

    pState.body.appendChild(span);

    // Cap DOM to 300 lines
    while (pState.body.childElementCount > 300) {
      pState.body.removeChild(pState.body.firstChild);
    }

    if (pState.autoscroll) {
      pState.body.scrollTop = pState.body.scrollHeight;
    }
  }

  // ─── Stream control ─────────────────────────────────────────────────────────

  async function controlStream(id, action) {
    try {
      await api.post(`/api/streams/${id}/${action}`);
    } catch (e) {
      toast(`Failed to ${action}: ${e.message}`, 'error');
    }
  }

  // ─── Confirm delete ─────────────────────────────────────────────────────────

  function confirmDelete(id, name) {
    confirmMsg.textContent = `Delete stream "${name}"? This cannot be undone.`;
    confirmDlg.classList.remove('hidden');

    const doDelete = async () => {
      cleanup();
      try {
        await api.del(`/api/streams/${id}`);
        toast(`Stream "${name}" deleted`, 'info');
      } catch (e) {
        toast(`Delete failed: ${e.message}`, 'error');
      }
    };
    const cleanup = () => {
      confirmDlg.classList.add('hidden');
      confirmOk.removeEventListener('click', doDelete);
      confirmCancel.removeEventListener('click', cleanup);
    };
    confirmOk.addEventListener('click', doDelete);
    confirmCancel.addEventListener('click', cleanup);
  }

  // ─── Modal (add / edit) ─────────────────────────────────────────────────────

  function openModal(id) {
    clearFormError();
    state.editingId = id || null;
    modalTitle.textContent = id ? 'Edit Stream' : 'Add Stream';

    if (id) {
      const s = state.streams.get(id);
      if (!s) return;
      fStreamId.value  = s.id;
      fName.value      = s.name;
      fSourceUrl.value = s.sourceUrl;
      fFbKey.value     = s.fbStreamKey;
      fAutoStart.checked = !!s.autoStart;

      const isCustom = s.preset === 'custom' || !state.presets[s.preset];
      presetSel.value = isCustom ? 'custom' : (s.preset || '720p30');
      fWidth.value    = s.customWidth        || '';
      fHeight.value   = s.customHeight       || '';
      fFps.value      = s.customFps          || '';
      fVBitrate.value = s.customVideoBitrate || '';
      fABitrate.value = s.customAudioBitrate || '';
    } else {
      streamForm.reset();
      fStreamId.value = '';
      presetSel.value = '720p30';
    }

    toggleCustomSettings();
    modal.classList.remove('hidden');
    fName.focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
    state.editingId = null;
    clearFormError();
  }

  async function saveStream() {
    clearFormError();

    const body = {
      name:               fName.value.trim(),
      sourceUrl:          fSourceUrl.value.trim(),
      fbStreamKey:        fFbKey.value.trim(),
      preset:             presetSel.value,
      customWidth:        parseInt(fWidth.value)    || null,
      customHeight:       parseInt(fHeight.value)   || null,
      customFps:          parseInt(fFps.value)      || null,
      customVideoBitrate: parseInt(fVBitrate.value) || null,
      customAudioBitrate: parseInt(fABitrate.value) || null,
      autoStart:          fAutoStart.checked,
    };

    if (!body.name)         return showFormError('Stream name is required.');
    if (!body.sourceUrl)    return showFormError('Source URL is required.');
    if (!body.fbStreamKey)  return showFormError('Facebook Stream Key is required.');

    modalSave.disabled = true;
    modalSave.textContent = 'Saving…';

    try {
      if (state.editingId) {
        await api.put(`/api/streams/${state.editingId}`, body);
        toast(`Stream "${body.name}" updated`, 'success');
      } else {
        await api.post('/api/streams', body);
        // toast shown by stream:created event
      }
      closeModal();
    } catch (e) {
      showFormError(e.message);
    } finally {
      modalSave.disabled = false;
      modalSave.textContent = 'Save Stream';
    }
  }

  function showFormError(msg) {
    formError.textContent = msg;
    formError.classList.remove('hidden');
  }
  function clearFormError() {
    formError.textContent = '';
    formError.classList.add('hidden');
  }

  // ─── Preset UI ──────────────────────────────────────────────────────────────

  function buildPresetOptions() {
    presetSel.innerHTML = '';
    for (const [key, info] of Object.entries(state.presets)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = info.label || key;
      if (key === '720p30') opt.textContent += ' (Recommended)';
      presetSel.appendChild(opt);
    }
    // Always add a "Custom" option at the end
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = 'Custom Settings';
    presetSel.appendChild(customOpt);
  }

  function toggleCustomSettings() {
    const isCustom = presetSel.value === 'custom';
    if (isCustom) customBlock.setAttribute('open', '');
    else          customBlock.removeAttribute('open');
  }

  // ─── Formatting ────────────────────────────────────────────────────────────

  function fmtUptime(secs) {
    if (!secs) return '—';
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600).toString().padStart(2, '0');
    const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return d > 0 ? `${d}d ${h}:${m}:${s}` : `${h}:${m}:${s}`;
  }

  function fmtFps(fps) {
    if (!fps && fps !== 0) return '—';
    return fps.toFixed(1);
  }

  function fmtBitrate(kbps) {
    if (!kbps && kbps !== 0) return '—';
    if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
    return `${Math.round(kbps)} kbps`;
  }

  function labelForState(s) {
    const map = {
      idle:         'IDLE',
      starting:     'STARTING',
      streaming:    'LIVE',
      fallback:     'FALLBACK',
      reconnecting: 'RECONNECTING',
      stopping:     'STOPPING',
      stopped:      'STOPPED',
    };
    return map[s] || (s ? s.toUpperCase() : 'UNKNOWN');
  }

  // ─── Toast ──────────────────────────────────────────────────────────────────

  function toast(msg, type = 'info', duration = 3500) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    toastBox.appendChild(el);
    setTimeout(() => {
      el.classList.add('removing');
      el.addEventListener('animationend', () => el.remove());
    }, duration);
  }

  // ─── Event wiring ───────────────────────────────────────────────────────────

  btnAdd.addEventListener('click', () => openModal(null));
  modalSave.addEventListener('click', saveStream);
  modalCancel.addEventListener('click', closeModal);
  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Keyboard: submit on Ctrl+Enter inside form, Escape to close
  streamForm.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveStream();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!modal.classList.contains('hidden'))       closeModal();
      if (!confirmDlg.classList.contains('hidden'))  confirmDlg.classList.add('hidden');
    }
  });

  presetSel.addEventListener('change', toggleCustomSettings);

  btnToggleKey.addEventListener('click', () => {
    const isPass = fFbKey.type === 'password';
    fFbKey.type = isPass ? 'text' : 'password';
    btnToggleKey.textContent = isPass ? '🙈' : '👁';
  });

  // ─── Init ───────────────────────────────────────────────────────────────────

  // Uptime tick (re-render uptime every second without waiting for server push)
  setInterval(() => {
    for (const s of state.streams.values()) {
      if (s.state === 'streaming' || s.state === 'fallback' || s.state === 'reconnecting') {
        s.uptime = (s.uptime || 0) + 1;
        const card = cardEl(s.id);
        if (card) card.querySelector('.stat-uptime').textContent = fmtUptime(s.uptime);
      }
    }
  }, 1000);

})();
