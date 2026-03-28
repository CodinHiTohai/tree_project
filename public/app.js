// =========================================================
// TreeGuard — Smart Tree Water Monitoring System
// Frontend Application Logic (Proof-based Watering)
// =========================================================

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---- Time Ago Utility ----
  function timeAgo(dateStr) {
    const now = new Date();
    const past = new Date(dateStr);
    const diffMs = now - past;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffSec < 60) return 'Abhi abhi';
    if (diffMin < 60) return `${diffMin} minute${diffMin > 1 ? 's' : ''} pehle`;
    if (diffHr < 24) return `${diffHr} ghante pehle`;
    if (diffDay === 1) return 'Kal';
    if (diffDay < 7) return `${diffDay} din pehle`;
    if (diffDay < 30) return `${Math.floor(diffDay / 7)} hafte pehle`;
    return `${Math.floor(diffDay / 30)} mahine pehle`;
  }

  function getWaterUrgency(dateStr) {
    if (!dateStr) return { urgency: 'none', colorClass: 'text-muted', iconClass: 'status-none' };
    const hours = (new Date() - new Date(dateStr)) / (1000 * 60 * 60);
    if (hours < 24) return { urgency: 'good', colorClass: 'text-green', iconClass: 'status-good' };
    if (hours < 72) return { urgency: 'warning', colorClass: 'text-amber', iconClass: 'status-warning' };
    return { urgency: 'danger', colorClass: 'text-red', iconClass: 'status-danger' };
  }

  // ---- Toast Notifications ----
  function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const icons = {
      success: 'fa-check-circle',
      error: 'fa-exclamation-circle',
      info: 'fa-info-circle',
      warning: 'fa-exclamation-triangle',
    };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <i class="fas ${icons[type] || icons.info} toast-icon"></i>
      <span>${message}</span>
    `;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 350);
    }, 3500);
  }

  // ---- Background Particles ----
  function createParticles() {
    const container = $('#bg-particles');
    if (!container) return;
    const colors = ['#4e9af1', '#8b5cf6', '#4ade80', '#22d3ee'];
    for (let i = 0; i < 30; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const size = Math.random() * 6 + 2;
      const color = colors[Math.floor(Math.random() * colors.length)];
      p.style.cssText = `
        width:${size}px; height:${size}px;
        background:${color};
        left:${Math.random() * 100}%;
        animation-duration:${Math.random() * 15 + 10}s;
        animation-delay:${Math.random() * 10}s;
      `;
      container.appendChild(p);
    }
  }

  // ---- Navigation ----
  let currentView = 'home';
  let scannerInstance = null;

  function navigateTo(viewName, pushState = true) {
    if (currentView === 'scan' && scannerInstance) {
      try { scannerInstance.stop(); } catch (_) {}
      scannerInstance = null;
      $('#start-scan-btn').classList.remove('hidden');
      $('#stop-scan-btn').classList.add('hidden');
    }

    $$('.view').forEach((v) => v.classList.remove('active'));
    const target = $(`#view-${viewName}`);
    if (target) {
      target.classList.add('active');
      target.style.animation = 'none';
      target.offsetHeight;
      target.style.animation = '';
    }

    $$('.nav-link').forEach((l) => {
      l.classList.toggle('active', l.dataset.view === viewName);
    });

    currentView = viewName;
    $('.nav-links').classList.remove('open');

    if (pushState) {
      const url = viewName === 'home' ? '/' : `?view=${viewName}`;
      history.pushState({ view: viewName }, '', url);
    }

    if (viewName === 'home') loadHomeSummary();
    if (viewName === 'trees') loadAllTrees();
  }

  // Event delegation for navigation
  document.addEventListener('click', (e) => {
    const navLink = e.target.closest('.nav-link');
    if (navLink) { e.preventDefault(); navigateTo(navLink.dataset.view); }

    const navBtn = e.target.closest('[data-navigate]');
    if (navBtn) { e.preventDefault(); navigateTo(navBtn.dataset.navigate); }
  });

  const navToggle = $('#nav-toggle');
  if (navToggle) navToggle.addEventListener('click', () => $('.nav-links').classList.toggle('open'));

  const brand = $('.nav-brand');
  if (brand) brand.addEventListener('click', () => navigateTo('home'));

  // ---- API Helper ----
  async function api(url, options = {}) {
    const resp = await fetch(url, options);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || resp.statusText);
    }
    return resp.json();
  }

  // ---- Home Summary ----
  async function loadHomeSummary() {
    try {
      const trees = await api('/api/trees');
      $('#stat-trees').textContent = trees.length;
      let totalEvents = 0, wet = 0, dry = 0;
      for (const tree of trees) {
        try {
          const history = await api(`/api/trees/${tree.id}/history`);
          totalEvents += history.length;
          const latest = history[0];
          if (latest) {
            if (latest.status === 'wet' || latest.status === 'watered') wet++;
            else if (latest.status === 'dry') dry++;
          }
        } catch (_) {}
      }
      $('#stat-events').textContent = totalEvents;
      $('#stat-healthy').textContent = wet;
      $('#stat-dry').textContent = dry;
    } catch (err) { console.error('Error loading summary', err); }
  }

  // ---- Register Tree ----
  let lastRegisteredId = null;
  let lastRegisteredSpecies = '';
  const registerForm = $('#register-form');
  const qrResultCard = $('#qr-result-card');

  // GPS
  const gpsBtn = $('#use-gps-btn');
  if (gpsBtn) {
    gpsBtn.addEventListener('click', () => {
      if (!navigator.geolocation) { showToast('Geolocation not supported', 'error'); return; }
      gpsBtn.disabled = true;
      gpsBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Location le rahe hain...';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          $('#lat').value = pos.coords.latitude.toFixed(6);
          $('#lng').value = pos.coords.longitude.toFixed(6);
          gpsBtn.disabled = false;
          gpsBtn.innerHTML = '<i class="fas fa-crosshairs"></i> Use My Location';
          showToast('Location mil gayi!', 'success');
        },
        (err) => {
          showToast('Location nahi mili: ' + err.message, 'error');
          gpsBtn.disabled = false;
          gpsBtn.innerHTML = '<i class="fas fa-crosshairs"></i> Use My Location';
        }
      );
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = $('#register-submit-btn');
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Register ho raha hai...';

      const species = $('#species').value.trim();
      const lat = parseFloat($('#lat').value);
      const lng = parseFloat($('#lng').value);

      if (isNaN(lat) || isNaN(lng)) {
        showToast('Sahi coordinates daalo', 'error');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-check"></i> Register Tree';
        return;
      }

      try {
        const data = await api('/api/trees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ species: species || undefined, latitude: lat, longitude: lng }),
        });

        lastRegisteredId = data.treeId;
        lastRegisteredSpecies = species || 'Tree';
        const dashUrl = `${window.location.origin}/?view=dashboard&tree=${data.treeId}`;

        qrResultCard.classList.remove('hidden');
        const qrDiv = $('#qr-display');
        qrDiv.innerHTML = '';
        new QRCode(qrDiv, {
          text: dashUrl,
          width: 200,
          height: 200,
          colorDark: '#1a1a3d',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H,
        });

        $('#qr-tree-id').textContent = data.treeId;

        // Download QR
        const dlBtn = $('#download-qr-btn');
        dlBtn.onclick = () => {
          const canvas = qrDiv.querySelector('canvas');
          if (canvas) {
            const link = document.createElement('a');
            link.download = `tree-${data.treeId.substring(0, 8)}-qr.png`;
            link.href = canvas.toDataURL();
            link.click();
          }
        };

        // View dashboard
        const vdBtn = $('#view-dashboard-btn');
        vdBtn.onclick = () => openDashboard(data.treeId);

        showToast('Tree register ho gaya! QR code print karo.', 'success');
        registerForm.reset();
      } catch (err) {
        showToast('Registration fail: ' + err.message, 'error');
      }

      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fas fa-check"></i> Register Tree';
    });
  }

  // ---- Print QR ----
  const printQrBtn = $('#print-qr-btn');
  if (printQrBtn) {
    printQrBtn.addEventListener('click', () => {
      if (!lastRegisteredId) { showToast('Pehle tree register karo', 'warning'); return; }
      showPrintOverlay(lastRegisteredId, lastRegisteredSpecies);
    });
  }

  function showPrintOverlay(treeId, species) {
    const overlay = $('#print-overlay');
    const dashUrl = `${window.location.origin}/?view=dashboard&tree=${treeId}`;

    // Set info
    $('#print-species').textContent = species || 'Tree';
    $('#print-id').textContent = `ID: ${treeId}`;

    // Generate QR
    const qrDiv = $('#print-qr-code');
    qrDiv.innerHTML = '';
    new QRCode(qrDiv, {
      text: dashUrl,
      width: 220,
      height: 220,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    });

    overlay.classList.remove('hidden');

    // Auto print after small delay
    setTimeout(() => window.print(), 500);
  }

  // ---- QR Scanning ----
  const startScanBtn = $('#start-scan-btn');
  const stopScanBtn = $('#stop-scan-btn');

  if (startScanBtn) {
    startScanBtn.addEventListener('click', async () => {
      try {
        scannerInstance = new Html5Qrcode('qr-reader');
        await scannerInstance.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => handleScannedCode(decodedText),
          () => {}
        );
        startScanBtn.classList.add('hidden');
        stopScanBtn.classList.remove('hidden');
        $('#scan-instructions').classList.add('hidden');
        showToast('Scanner active — QR code dikhao', 'info');
      } catch (err) {
        showToast('Camera error: ' + (err.message || err), 'error');
      }
    });
  }

  if (stopScanBtn) {
    stopScanBtn.addEventListener('click', async () => {
      if (scannerInstance) { try { await scannerInstance.stop(); } catch (_) {} scannerInstance = null; }
      startScanBtn.classList.remove('hidden');
      stopScanBtn.classList.add('hidden');
    });
  }

  function handleScannedCode(text) {
    if (scannerInstance) {
      try { scannerInstance.stop(); } catch (_) {}
      scannerInstance = null;
      startScanBtn.classList.remove('hidden');
      stopScanBtn.classList.add('hidden');
    }

    let treeId = text;
    try {
      const url = new URL(text);
      treeId = url.searchParams.get('tree') || url.searchParams.get('id') || text;
    } catch (_) {}

    showToast('QR code scan ho gaya!', 'success');
    openDashboard(treeId);
  }

  // Manual lookup
  const manualBtn = $('#manual-lookup-btn');
  if (manualBtn) {
    manualBtn.addEventListener('click', () => {
      const id = $('#manual-tree-id').value.trim();
      if (!id) { showToast('Tree ID daalo', 'warning'); return; }
      openDashboard(id);
    });
  }

  // ---- All Trees ----
  async function loadAllTrees() {
    const grid = $('#trees-grid');
    if (!grid) return;
    grid.innerHTML = '<p class="loading-msg"><i class="fas fa-spinner fa-spin"></i> Trees load ho rahe hain...</p>';

    try {
      const trees = await api('/api/trees');
      if (trees.length === 0) {
        grid.innerHTML = `
          <div class="empty-state">
            <i class="fas fa-seedling fa-3x"></i>
            <p>Koi tree register nahi hua abhi tak.</p>
            <button class="btn btn-outline" data-navigate="register">Pehla tree register karo</button>
          </div>`;
        return;
      }

      const treeCards = await Promise.all(
        trees.map(async (tree) => {
          let latestStatus = null;
          try { latestStatus = await api(`/api/trees/${tree.id}/latest`); } catch (_) {}
          return buildTreeCard(tree, latestStatus);
        })
      );
      grid.innerHTML = treeCards.join('');
    } catch (err) {
      grid.innerHTML = '<p class="loading-msg" style="color:var(--accent-red)">Error loading trees</p>';
    }
  }

  function buildTreeCard(tree, latest) {
    const statusClass = latest ? latest.status : 'unknown';
    const statusLabel = latest ? (latest.status === 'watered' || latest.status === 'wet' ? '💧 ' + timeAgo(latest.timestamp) : latest.status) : 'No data';
    const statusIcon = { wet: 'fa-tint', dry: 'fa-sun', watered: 'fa-check-circle', unknown: 'fa-question-circle' }[statusClass] || 'fa-question-circle';

    return `
      <div class="tree-card" onclick="window.__openDashboard('${tree.id}')">
        <div class="tree-card-header">
          <div class="tree-card-icon"><i class="fas fa-tree"></i></div>
          <div>
            <div class="tree-card-title">${tree.species || 'Unknown Species'}</div>
            <div class="tree-card-id">${tree.id}</div>
          </div>
        </div>
        <div class="tree-card-meta">
          <span><i class="fas fa-map-marker-alt"></i> ${tree.latitude.toFixed(4)}, ${tree.longitude.toFixed(4)}</span>
          <span><i class="fas fa-calendar"></i> ${new Date(tree.created_at).toLocaleDateString()}</span>
        </div>
        <div class="tree-card-status status-${statusClass}">
          <i class="fas ${statusIcon}"></i> ${statusLabel}
        </div>
      </div>`;
  }

  // Search filter
  const searchInput = $('#tree-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      $$('.tree-card').forEach((card) => {
        card.style.display = card.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  // ---- Dashboard ----
  let currentDashTreeId = null;

  window.__openDashboard = function (treeId) { openDashboard(treeId); };

  function openDashboard(treeId) {
    currentDashTreeId = treeId;
    history.pushState({ view: 'dashboard', tree: treeId }, '', `?view=dashboard&tree=${treeId}`);
    navigateTo('dashboard', false);
    loadDashboardData(treeId);
  }

  async function loadDashboardData(treeId) {
    // Reset UI
    $('#analysis-result').classList.add('hidden');
    const previewWrap = $('#img-preview-wrap');
    if (previewWrap) previewWrap.classList.add('hidden');
    const uploadZone = $('#upload-zone');
    if (uploadZone) uploadZone.classList.remove('hidden');
    const analyzeBtn = $('#analyze-btn');
    if (analyzeBtn) analyzeBtn.disabled = true;

    try {
      const tree = await api(`/api/trees/${treeId}`);
      $('#dash-species').textContent = tree.species || 'Unknown Species';
      $('#dash-tree-id').textContent = treeId;
      $('#dash-location').innerHTML = `<i class="fas fa-map-marker-alt"></i> ${tree.latitude.toFixed(5)}, ${tree.longitude.toFixed(5)}`;
      $('#dash-registered').innerHTML = `<i class="fas fa-calendar"></i> ${new Date(tree.created_at).toLocaleString()}`;

      // Mini QR
      const qrDiv = $('#dash-qr');
      qrDiv.innerHTML = '';
      new QRCode(qrDiv, {
        text: `${window.location.origin}/?view=dashboard&tree=${treeId}`,
        width: 80, height: 80,
        colorDark: '#1a1a3d', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });

      await loadLastWatered(treeId);
      await loadHistory(treeId);
    } catch (err) {
      showToast('Tree nahi mila ya error aayi', 'error');
    }
  }

  // ---- Last Watered — Prominent Display ----
  async function loadLastWatered(treeId) {
    const timeEl = $('#last-watered-time');
    const dateEl = $('#last-watered-date');
    const iconEl = $('#last-watered-icon');

    try {
      // Find last watering event (status = 'watered' or 'wet')
      const history = await api(`/api/trees/${treeId}/history`);
      const lastWaterEvent = history.find(e => e.status === 'watered' || e.status === 'wet');

      if (lastWaterEvent) {
        const ago = timeAgo(lastWaterEvent.timestamp);
        const { colorClass, iconClass } = getWaterUrgency(lastWaterEvent.timestamp);

        timeEl.textContent = ago;
        timeEl.className = `last-watered-time ${colorClass}`;
        dateEl.textContent = new Date(lastWaterEvent.timestamp).toLocaleString();
        iconEl.className = `last-watered-icon ${iconClass}`;
      } else {
        timeEl.textContent = 'Kabhi nahi';
        timeEl.className = 'last-watered-time text-red';
        dateEl.textContent = 'Is tree ko abhi tak pani nahi mila';
        iconEl.className = 'last-watered-icon status-danger';
      }
    } catch (err) {
      timeEl.textContent = 'Error';
      timeEl.className = 'last-watered-time text-muted';
      dateEl.textContent = '';
      iconEl.className = 'last-watered-icon status-none';
    }
  }

  // ---- History ----
  async function loadHistory(treeId) {
    const div = $('#history-timeline');
    try {
      const history = await api(`/api/trees/${treeId}/history`);
      if (history.length === 0) {
        div.innerHTML = `
          <div class="history-empty">
            <i class="fas fa-inbox"></i>
            <p>Abhi tak koi watering record nahi hai.</p>
          </div>`;
        return;
      }

      div.innerHTML = history.map((event, i) => {
        const icon = { wet: 'fa-tint', dry: 'fa-sun', watered: 'fa-check-circle' }[event.status] || 'fa-question';
        const label = event.status === 'wet' ? '💧 Bheegi zameen (pani mila)' :
                      event.status === 'dry' ? '☀️ Sukhi zameen (pani nahi)' :
                      event.status === 'watered' ? '✅ Pani diya gaya' : event.status;
        return `
          <div class="history-item" style="animation-delay:${i * 0.06}s">
            <div class="history-dot ${event.status}"><i class="fas ${icon}"></i></div>
            <div class="history-info">
              <div class="history-status">${label}</div>
              <div class="history-time">${timeAgo(event.timestamp)} — ${new Date(event.timestamp).toLocaleString()}</div>
              <div class="history-confidence">Confidence: ${event.confidence}%</div>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      div.innerHTML = '<p style="color:var(--accent-red);">Error loading history.</p>';
    }
  }

  // ---- Soil Upload & Proof-based Watering ----
  const soilForm = $('#soil-upload-form');
  const fileInput = $('#soil-image-input');
  const uploadZoneEl = $('#upload-zone');
  const previewWrapEl = $('#img-preview-wrap');
  const soilPreview = $('#soil-preview');
  const removePreviewBtn = $('#remove-preview-btn');
  const analyzeBtnEl = $('#analyze-btn');

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) {
        const reader = new FileReader();
        reader.onload = (e) => {
          soilPreview.src = e.target.result;
          previewWrapEl.classList.remove('hidden');
          uploadZoneEl.classList.add('hidden');
          analyzeBtnEl.disabled = false;
        };
        reader.readAsDataURL(fileInput.files[0]);
      }
    });
  }

  if (removePreviewBtn) {
    removePreviewBtn.addEventListener('click', () => {
      fileInput.value = '';
      previewWrapEl.classList.add('hidden');
      uploadZoneEl.classList.remove('hidden');
      analyzeBtnEl.disabled = true;
      $('#analysis-result').classList.add('hidden');
    });
  }

  if (soilForm) {
    soilForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!currentDashTreeId || !fileInput.files.length) return;

      analyzeBtnEl.disabled = true;
      analyzeBtnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Check ho raha hai...';

      const formData = new FormData();
      formData.append('soilImage', fileInput.files[0]);

      try {
        const result = await api(`/api/trees/${currentDashTreeId}/soil`, {
          method: 'POST',
          body: formData,
        });

        const resultDiv = $('#analysis-result');
        const badge = $('#result-badge');
        const msgEl = $('#result-message');

        badge.className = `result-badge ${result.status}`;
        badge.innerHTML = `<i class="fas ${result.status === 'wet' ? 'fa-tint' : 'fa-sun'}"></i> <span>${result.status === 'wet' ? 'BHEEGI ZAMEEN ✅' : 'SUKHI ZAMEEN ❌'}</span>`;
        $('#result-confidence').textContent = result.confidence;

        if (result.status === 'wet') {
          // ✅ Zameen bheegi hai → Watering auto-record
          msgEl.textContent = '✅ Pani confirm ho gaya! Watering record ho gayi.';
          msgEl.className = 'result-message success';
          try {
            await api(`/api/trees/${currentDashTreeId}/watered`, { method: 'POST' });
          } catch (_) {}
          showToast('Pani confirm! Watering record ho gayi 💧', 'success');
        } else {
          // ❌ Zameen sukhi hai → Watering NOT recorded
          msgEl.textContent = '⚠️ Zameen sukhi hai. Pehle pani do, phir dobara photo lo.';
          msgEl.className = 'result-message warning';
          showToast('Zameen sukhi hai — pani do phir try karo', 'warning');
        }

        resultDiv.classList.remove('hidden');
        await loadLastWatered(currentDashTreeId);
        await loadHistory(currentDashTreeId);
      } catch (err) {
        showToast('Analysis fail: ' + err.message, 'error');
      }

      analyzeBtnEl.disabled = false;
      analyzeBtnEl.innerHTML = '<i class="fas fa-flask"></i> Check Karo — Kya Zameen Bheegi Hai?';
    });
  }

  // Dashboard back button
  const backBtn = $('#dashboard-back-btn');
  if (backBtn) backBtn.addEventListener('click', () => navigateTo('trees'));

  // ---- URL Routing ----
  function initRouter() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const treeId = params.get('tree');

    if (view === 'dashboard' && treeId) {
      currentDashTreeId = treeId;
      navigateTo('dashboard', false);
      loadDashboardData(treeId);
    } else if (view) {
      navigateTo(view, false);
    } else {
      navigateTo('home', false);
    }
  }

  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.view) {
      if (e.state.view === 'dashboard' && e.state.tree) {
        currentDashTreeId = e.state.tree;
        navigateTo('dashboard', false);
        loadDashboardData(e.state.tree);
      } else {
        navigateTo(e.state.view, false);
      }
    } else {
      navigateTo('home', false);
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    createParticles();
    initRouter();
  });

})();
