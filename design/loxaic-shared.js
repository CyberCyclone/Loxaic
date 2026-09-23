/* Loxaic — shared components: settings modal, model modal v2, smart routing, location badges */
(function () {
  'use strict';

  // ===== Shared fixtures =====
  const LOXAIC_MODELS = [
    { id: 'm1', display_name: 'Llama 3.1 8B', quant: 'Q4_K_M', context_tokens: 32768, location: 'server', price: 0 },
    { id: 'm2', display_name: 'Qwen 2.5 14B', quant: 'Q5_K_M', context_tokens: 32768, location: 'server', price: 0 },
    { id: 'm3', display_name: 'Phi 3 Mini', quant: 'Q8_0', context_tokens: 4096, location: 'device', price: 0 },
    { id: 'm4', display_name: 'Gemma 2 2B', quant: 'Q4_K_M', context_tokens: 8192, location: 'device', price: 0 },
    { id: 'r1', display_name: 'GPT-4o', quant: '—', context_tokens: 128000, location: 'remote', price: 2.50 },
    { id: 'r2', display_name: 'Mistral Large', quant: '—', context_tokens: 128000, location: 'remote', price: 2.00 },
    { id: 'r3', display_name: 'DeepSeek V3', quant: '—', context_tokens: 64000, location: 'remote', price: 0.27 },
  ];

  const LOXAIC_WORKSPACES = [
    { name: 'Loxaic/design', path: '/home/casey/projects/loxaic/design' },
    { name: 'Loxaic/api', path: '/home/casey/projects/loxaic/api' },
    { name: 'Loxaic/sync', path: '/home/casey/projects/loxaic/sync' },
  ];

  const THINKING_LEVELS = ['None', 'Low', 'Medium', 'High'];

  // ===== Location badge =====
  function locationBadge(location) {
    if (location === 'device') return '<span class="badge badge-device">On device</span>';
    return '<span class="badge badge-server">Server</span>';
  }

  // ===== Settings persistence =====
  function getSettings() {
    return JSON.parse(localStorage.getItem('loxaic-settings') || '{}');
  }
  function saveSettingsData(data) {
    localStorage.setItem('loxaic-settings', JSON.stringify(data));
  }

  // ===== Smart routing persistence =====
  function getSmartRouting() {
    return JSON.parse(localStorage.getItem('loxaic-smart-routing') || '{"profile":"server","planning":"m1","heavyThinking":"m2","simpleJobs":"m3"}');
  }
  function saveSmartRouting(data) {
    localStorage.setItem('loxaic-smart-routing', JSON.stringify(data));
  }

  // ===== Thinking level persistence (per conversation) =====
  function getThinkingLevel(convKey) {
    const levels = JSON.parse(localStorage.getItem('loxaic-thinking-levels') || '{}');
    return levels[convKey] || getSettings().defaultThinkingLevel || 'Medium';
  }
  function setThinkingLevel(convKey, level) {
    const levels = JSON.parse(localStorage.getItem('loxaic-thinking-levels') || '{}');
    levels[convKey] = level;
    localStorage.setItem('loxaic-thinking-levels', JSON.stringify(levels));
  }

  // ===== Toast =====
  function showToast(msg) {
    let toast = document.getElementById('loxaic-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'loxaic-toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:10px 18px;font-size:13px;z-index:500;box-shadow:0 8px 24px rgba(0,0,0,.3);display:none';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.style.display = 'none', 2500);
  }

  // ===== Settings Modal =====
  function injectSettingsModal() {
    if (document.getElementById('settings-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'settings-modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="modal settings-modal">
        <div class="modal-header">
          <span style="font-size:16px;font-weight:600">Settings</span>
          <button class="btn btn-ghost btn-sm" id="settings-close">✕</button>
        </div>
        <div class="settings-modal-body">
          <nav class="settings-modal-nav" id="settings-nav">
            <div class="settings-nav-item active" data-section="general" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--r-sm);font-size:14px;color:var(--fg-2);cursor:pointer;margin-bottom:2px"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/></svg>General</div>
            <div class="settings-nav-item" data-section="models" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--r-sm);font-size:14px;color:var(--fg-2);cursor:pointer;margin-bottom:2px"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.4"/></svg>Models</div>
            <div class="settings-nav-item" data-section="workspaces" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--r-sm);font-size:14px;color:var(--fg-2);cursor:pointer;margin-bottom:2px"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 011-1h3l1 1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" stroke-width="1.4"/></svg>Workspaces</div>
            <div class="settings-nav-item" data-section="devices" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--r-sm);font-size:14px;color:var(--fg-2);cursor:pointer;margin-bottom:2px"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M2 14h12" stroke="currentColor" stroke-width="1.4"/></svg>Devices</div>
            <div class="settings-nav-item" data-section="server" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--r-sm);font-size:14px;color:var(--fg-2);cursor:pointer;margin-bottom:2px"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="4" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="12" height="4" rx="1" stroke="currentColor" stroke-width="1.4"/></svg>Server</div>
            <div class="settings-nav-item" data-section="usage" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--r-sm);font-size:14px;color:var(--fg-2);cursor:pointer;margin-bottom:2px"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 13h12M4 13V7M7 13V4M10 13V8M13 13V6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>Usage</div>
          </nav>
          <div class="settings-modal-content" id="settings-content">
            <!-- General -->
            <div class="settings-modal-section active" data-section="general">
              <h2>General</h2>
              <p class="desc">Profile and default agent behavior.</p>
              <div class="setting-row"><div><div class="setting-label">Display name</div><div class="setting-hint">Shown on synced devices</div></div><input class="input" style="width:200px" value="Casey Gibson" data-setting="name"></div>
              <div class="setting-row"><div><div class="setting-label">Default mode</div><div class="setting-hint">Starting permission level for new agent runs</div></div>
                <select class="input" style="width:150px" data-setting="default-mode"><option value="planning">Planning</option><option value="manual" selected>Manual</option><option value="auto">Auto</option></select></div>
              <div class="setting-row"><div><div class="setting-label">Default thinking level</div><div class="setting-hint">Applied to new conversations</div></div>
                <select class="input" style="width:150px" data-setting="defaultThinkingLevel"><option value="None">None</option><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select></div>
              <div class="setting-row"><div><div class="setting-label">Appearance</div><div class="setting-hint">Light, dark, or follow system</div></div>
                <div class="theme-seg" id="theme-seg">
                  <button class="theme-seg-btn" data-theme-pref="light">Light</button>
                  <button class="theme-seg-btn" data-theme-pref="dark">Dark</button>
                  <button class="theme-seg-btn" data-theme-pref="system">System</button>
                </div></div>
            </div>
            <!-- Models -->
            <div class="settings-modal-section" data-section="models">
              <h2>Models</h2>
              <p class="desc">Manage server and on-device models.</p>
              <h3 style="font-size:14px;font-weight:600;margin-bottom:8px">Server Models</h3>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">Llama 3.1 8B</div><div class="model-row-meta">Q4_K_M · 4.9 GB · 32K context · llama.cpp server</div></div><button class="btn btn-ghost btn-sm">Remove</button></div>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">Qwen 2.5 14B</div><div class="model-row-meta">Q5_K_M · 9.8 GB · 32K context · llama.cpp server</div></div><button class="btn btn-ghost btn-sm">Remove</button></div>
              <button class="btn btn-secondary btn-sm" style="margin-bottom:16px">+ Add model by URL</button>
              <h3 style="font-size:14px;font-weight:600;margin-bottom:8px">On-Device Models</h3>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">Phi 3 Mini</div><div class="model-row-meta">Q8_0 · 2.1 GB · 4K context · downloaded</div></div><button class="btn btn-ghost btn-sm">Remove</button></div>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">Gemma 2 2B</div><div class="model-row-meta">Q4_K_M · 1.6 GB · downloading... 67%</div><div class="download-progress"><div class="download-fill" style="width:67%"></div></div></div><button class="btn btn-ghost btn-sm">Cancel</button></div>
              <h3 style="font-size:14px;font-weight:600;margin:16px 0 8px">Smart Routing</h3>
              <p style="font-size:13px;color:var(--fg-3);margin-bottom:8px">Automatically select models based on task type.</p>
              <div class="smart-routing-profile" id="sr-profile">
                <button class="profile-btn" data-profile="cloud">Cloud</button>
                <button class="profile-btn active" data-profile="server">Server</button>
                <button class="profile-btn" data-profile="hybrid">Hybrid</button>
              </div>
              <div class="task-mappings">
                <div><label class="label">Planning</label><select class="input" id="sr-planning"></select></div>
                <div><label class="label">Heavy thinking</label><select class="input" id="sr-heavy"></select></div>
                <div><label class="label">Simple jobs</label><select class="input" id="sr-simple"></select></div>
              </div>
            </div>
            <!-- Workspaces -->
            <div class="settings-modal-section" data-section="workspaces">
              <h2>Workspaces</h2>
              <p class="desc">Server-side directories available as agent context.</p>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">Loxaic/design</div><div class="model-row-meta">/home/casey/projects/loxaic/design</div></div><button class="btn btn-ghost btn-sm">Remove</button></div>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">Loxaic/api</div><div class="model-row-meta">/home/casey/projects/loxaic/api</div></div><button class="btn btn-ghost btn-sm">Remove</button></div>
              <button class="btn btn-secondary btn-sm">+ Register directory</button>
            </div>
            <!-- Devices -->
            <div class="settings-modal-section" data-section="devices">
              <h2>Devices</h2>
              <p class="desc">Synced devices on your account.</p>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">MacBook Pro</div><div class="model-row-meta">macOS · last seen now</div></div><span class="badge badge-success">This device</span></div>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">iPhone 15</div><div class="model-row-meta">iOS · last seen 2h ago</div></div><button class="btn btn-danger btn-sm" data-revoke>Revoke</button></div>
              <div class="model-row"><div class="model-row-info"><div class="model-row-name">iPad Air</div><div class="model-row-meta">iPadOS · last seen 3d ago</div></div><button class="btn btn-danger btn-sm" data-revoke>Revoke</button></div>
            </div>
            <!-- Server -->
            <div class="settings-modal-section" data-section="server">
              <h2>Server</h2>
              <p class="desc">Connection to your llama.cpp inference server.</p>
              <div class="setting-row"><div><div class="setting-label">Tailscale address</div><div class="setting-hint">MagicDNS hostname for your tailnet</div></div><input class="input" style="width:240px" value="loxaic.example.ts.net" data-setting="tailscale"></div>
              <div class="setting-row"><div><div class="setting-label">Inference endpoint</div><div class="setting-hint">llama.cpp server URL</div></div><input class="input" style="width:240px" value="http://loxaic:8080" data-setting="endpoint"></div>
              <div class="setting-row"><div><div class="setting-label">Connection status</div><div class="setting-hint">Server reachable · llama.cpp v0.2.1</div></div><span class="badge badge-success">Connected</span></div>
            </div>
            <!-- Usage -->
            <div class="settings-modal-section" data-section="usage">
              <h2>Usage</h2>
              <p class="desc">Per-model token consumption. <a href="loxaic-stats.html" style="font-size:14px">View full stats →</a></p>
              <table>
                <thead><tr><th>Model</th><th>Conversations</th><th>Tokens</th><th>Cache %</th></tr></thead>
                <tbody>
                  <tr><td>Llama 3.1 8B</td><td>142</td><td>1,847,291</td><td>68%</td></tr>
                  <tr><td>Qwen 2.5 14B</td><td>67</td><td>820,103</td><td>58%</td></tr>
                  <tr><td>Phi 3 Mini</td><td>34</td><td>180,000</td><td>71%</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="save-bar" id="settings-save-bar">
          <span style="font-size:13px;color:var(--fg-3);align-self:center;margin-right:auto">Unsaved changes</span>
          <button class="btn btn-ghost" id="settings-discard">Discard</button>
          <button class="btn btn-primary" id="settings-save">Save changes</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Section nav
    overlay.querySelectorAll('.settings-nav-item').forEach(item => {
      item.onclick = () => {
        overlay.querySelectorAll('.settings-nav-item').forEach(i => { i.classList.remove('active'); i.style.background = ''; i.style.color = 'var(--fg-2)'; });
        overlay.querySelectorAll('.settings-modal-section').forEach(s => s.classList.remove('active'));
        item.classList.add('active');
        item.style.background = 'var(--muted)';
        item.style.color = 'var(--fg)';
        const sec = overlay.querySelector(`.settings-modal-section[data-section="${item.dataset.section}"]`);
        if (sec) sec.classList.add('active');
      };
    });
    // Set initial active styling
    const firstNav = overlay.querySelector('.settings-nav-item.active');
    if (firstNav) { firstNav.style.background = 'var(--muted)'; firstNav.style.color = 'var(--fg)'; }

    // Close
    overlay.querySelector('#settings-close').onclick = () => { overlay.style.display = 'none'; };
    overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };

    // Dirty tracking
    let dirty = false;
    const saveBar = overlay.querySelector('#settings-save-bar');
    overlay.querySelectorAll('[data-setting]').forEach(el => {
      el.addEventListener('input', () => { dirty = true; saveBar.classList.add('show'); });
    });
    // Load saved settings
    const settings = getSettings();
    overlay.querySelectorAll('[data-setting]').forEach(el => {
      if (settings[el.dataset.setting] !== undefined) el.value = settings[el.dataset.setting];
    });

    // Save
    overlay.querySelector('#settings-save').onclick = () => {
      const data = {};
      overlay.querySelectorAll('[data-setting]').forEach(el => { data[el.dataset.setting] = el.value; });
      saveSettingsData(data);
      dirty = false; saveBar.classList.remove('show');
      showToast('Settings saved');
    };
    overlay.querySelector('#settings-discard').onclick = () => { overlay.style.display = 'none'; };

    // Smart routing
    const sr = getSmartRouting();
    overlay.querySelectorAll('.profile-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.profile === sr.profile);
      btn.onclick = () => {
        overlay.querySelectorAll('.profile-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sr.profile = btn.dataset.profile;
        saveSmartRouting(sr);
      };
    });
    function populateSRSelects() {
      const modelOpts = LOXAIC_MODELS.map(m => `<option value="${m.id}">${m.display_name}</option>`).join('');
      ['planning', 'heavy', 'simple'].forEach(key => {
        const sel = overlay.querySelector(key === 'heavy' ? '#sr-heavy' : key === 'simple' ? '#sr-simple' : '#sr-planning');
        sel.innerHTML = modelOpts;
        const field = key === 'planning' ? 'planning' : key === 'heavy' ? 'heavyThinking' : 'simpleJobs';
        sel.value = sr[field] || LOXAIC_MODELS[0].id;
        sel.onchange = () => { sr[field] = sel.value; saveSmartRouting(sr); };
      });
    }
    populateSRSelects();

    // Revoke confirm
    overlay.querySelectorAll('[data-revoke]').forEach(btn => {
      btn.onclick = () => {
        if (confirm('Revoke this device? It will lose sync access.')) {
          btn.closest('.model-row').remove();
          showToast('Device revoked');
        }
      };
    });

    // Theme segmented control
    if (window.LoxaicTheme) {
      const currentPref = LoxaicTheme.get();
      overlay.querySelectorAll('.theme-seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.themePref === currentPref);
        btn.onclick = () => {
          overlay.querySelectorAll('.theme-seg-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          LoxaicTheme.set(btn.dataset.themePref);
        };
      });
    }
  }

  function openSettings(tab) {
    injectSettingsModal();
    const overlay = document.getElementById('settings-modal-overlay');
    overlay.style.display = 'flex';
    if (tab) {
      const navItem = overlay.querySelector(`.settings-nav-item[data-section="${tab}"]`);
      if (navItem) navItem.click();
    }
  }

  // ===== Model Modal v2 =====
  let modelModalState = { onSelect: null, thinkingLevel: 'Medium', convKey: 'default' };

  function injectModelModal() {
    if (document.getElementById('model-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'model-modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="modal model-modal">
        <div class="modal-header">
          <span style="font-size:16px;font-weight:600">Select Model</span>
          <button class="btn btn-ghost btn-sm" id="mm-close">✕</button>
        </div>
        <div class="model-modal-search">
          <input class="input" id="mm-search" placeholder="Search models..." style="width:100%">
        </div>
        <div class="model-modal-list" id="mm-list"></div>
        <div class="model-modal-footer">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;color:var(--fg-3)">Thinking</span>
            <div class="thinking-levels" id="mm-thinking">
              <button class="thinking-chip" data-level="None">None</button>
              <button class="thinking-chip" data-level="Low">Low</button>
              <button class="thinking-chip active" data-level="Medium">Medium</button>
              <button class="thinking-chip" data-level="High">High</button>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" id="mm-gear" title="Model settings">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 5a3 3 0 100 6 3 3 0 000-6zM8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#mm-close').onclick = () => overlay.style.display = 'none';
    overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };

    overlay.querySelector('#mm-gear').onclick = () => {
      overlay.style.display = 'none';
      openSettings('models');
    };

    // Thinking level chips
    overlay.querySelectorAll('.thinking-chip').forEach(chip => {
      chip.onclick = () => {
        overlay.querySelectorAll('.thinking-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        modelModalState.thinkingLevel = chip.dataset.level;
        setThinkingLevel(modelModalState.convKey, chip.dataset.level);
      };
    });

    // Search
    overlay.querySelector('#mm-search').oninput = e => renderModelList(e.target.value);
  }

  function renderModelList(filter) {
    const list = document.getElementById('mm-list');
    if (!list) return;
    list.innerHTML = '';
    const f = (filter || '').toLowerCase();
    const groups = [
      { key: 'server', label: 'Server Models', models: LOXAIC_MODELS.filter(m => m.location === 'server') },
      { key: 'device', label: 'On-Device Models', models: LOXAIC_MODELS.filter(m => m.location === 'device') },
      { key: 'remote', label: 'Remote Models (Cloud)', models: LOXAIC_MODELS.filter(m => m.location === 'remote') },
    ];
    groups.forEach(g => {
      const filtered = g.models.filter(m => m.display_name.toLowerCase().includes(f));
      if (!filtered.length) return;
      const gl = document.createElement('div');
      gl.className = 'model-group';
      gl.textContent = g.label;
      list.appendChild(gl);
      filtered.forEach(m => {
        const opt = document.createElement('div');
        opt.className = 'model-option' + (window.__loxaicCurrentModelId === m.id ? ' selected' : '');
        const meta = `${m.quant} · ${(m.context_tokens / 1024).toFixed(0)}K ctx${m.price ? ' · $' + m.price + '/1M' : ' · local'}`;
        opt.innerHTML = `<div><div class="model-option-name">${m.display_name}</div><div class="model-option-meta">${meta}</div></div>${window.__loxaicCurrentModelId === m.id ? '<span class="check">✓</span>' : ''}`;
        opt.onclick = () => {
          window.__loxaicCurrentModelId = m.id;
          if (modelModalState.onSelect) modelModalState.onSelect(m);
          renderModelList(filter);
          document.getElementById('model-modal-overlay').style.display = 'none';
        };
        list.appendChild(opt);
      });
    });
  }

  function openModelModal(currentModelId, convKey, onSelect) {
    injectModelModal();
    window.__loxaicCurrentModelId = currentModelId;
    modelModalState.convKey = convKey || 'default';
    modelModalState.onSelect = onSelect;
    modelModalState.thinkingLevel = getThinkingLevel(modelModalState.convKey);

    // Set thinking chip active
    document.querySelectorAll('#mm-thinking .thinking-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.level === modelModalState.thinkingLevel);
    });

    renderModelList('');
    document.getElementById('mm-search').value = '';
    document.getElementById('model-modal-overlay').style.display = 'flex';
  }

  // ===== Export =====
  Object.assign(window, {
    LOXAIC_MODELS,
    LOXAIC_WORKSPACES,
    THINKING_LEVELS,
    locationBadge,
    openSettings,
    openModelModal,
    getSmartRouting,
    saveSmartRouting,
    getThinkingLevel,
    setThinkingLevel,
    getSettings,
    showToast: typeof window.showToast === 'function' ? window.showToast : showToast,
  });
})();
