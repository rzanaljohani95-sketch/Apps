(() => {
  'use strict';

  /* ============================ DATA MODEL ============================ */

  const STORAGE_KEY = 'fitnessTracker.v1';

  const MEASURE_FIELDS = [
    { key: 'weight',     label: 'الوزن',            unit: 'كجم', defaultGoal: 'down' },
    { key: 'chest',      label: 'الصدر',             unit: 'سم',  defaultGoal: 'down' },
    { key: 'waist',      label: 'الخصر',             unit: 'سم',  defaultGoal: 'down' },
    { key: 'lowerBelly', label: 'أسفل البطن',        unit: 'سم',  defaultGoal: 'down' },
    { key: 'hips',       label: 'محيط الأرداف',      unit: 'سم',  defaultGoal: 'down' },
    { key: 'thigh',      label: 'الفخذ',             unit: 'سم',  defaultGoal: 'up'   },
    { key: 'arm',        label: 'الزند',             unit: 'سم',  defaultGoal: 'up'   },
    { key: 'calves',     label: 'البطات',            unit: 'سم',  defaultGoal: 'up'   },
  ];

  function defaultState() {
    return {
      dailyLogs: {},      // { 'YYYY-MM-DD': { steps, calories, protein, workout: {done, type, duration, notes} } }
      measurements: [],   // [{ id, date, weight, chest, waist, lowerBelly, hips, thigh, arm, calves }]
      settings: {
        weeklyWorkoutGoal: 4,
        calorieGoal: 1810,
        proteinGoal: 120,
        calorieMarginPct: 5,
        proteinMarginPct: 8,
        goalDirections: Object.fromEntries(MEASURE_FIELDS.map(f => [f.key, f.defaultGoal])),
      },
    };
  }

  function normalizeState(parsed) {
    const base = defaultState();
    if (!parsed) return base;
    // Cloud snapshots (db.doc().get() / onSnapshot) are frozen by the
    // platform — deep-clone before letting later code push/assign into
    // dailyLogs or measurements, or those mutations throw.
    parsed = JSON.parse(JSON.stringify(parsed));
    return {
      dailyLogs: parsed.dailyLogs || base.dailyLogs,
      measurements: parsed.measurements || base.measurements,
      settings: {
        weeklyWorkoutGoal: parsed.settings?.weeklyWorkoutGoal ?? base.settings.weeklyWorkoutGoal,
        calorieGoal: parsed.settings?.calorieGoal ?? base.settings.calorieGoal,
        proteinGoal: parsed.settings?.proteinGoal ?? base.settings.proteinGoal,
        calorieMarginPct: parsed.settings?.calorieMarginPct ?? base.settings.calorieMarginPct,
        proteinMarginPct: parsed.settings?.proteinMarginPct ?? base.settings.proteinMarginPct,
        goalDirections: { ...base.settings.goalDirections, ...(parsed.settings?.goalDirections || {}) },
      },
    };
  }

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return normalizeState(JSON.parse(raw));
    } catch (e) {
      console.error('Failed to read local data.', e);
      return null;
    }
  }

  // Browser localStorage alone is not reliable everywhere this page can run
  // (private windows, mobile app webviews that clear site data between
  // sessions, ...). When the page runs inside an Artifact viewer with the
  // `db` capability granted, mirror every write to durable cloud storage
  // and treat it as the source of truth; outside that context (e.g. a
  // plain static hosting of this file) localStorage alone still works.
  let state = loadLocalState() || defaultState();
  let dbCap = null;
  let syncStatus = 'local'; // 'local' | 'checking' | 'cloud'

  // Closes a startup race: the very first cloud read is in flight for a
  // moment after the page opens, and if the viewer saves something during
  // that window, the in-memory state is already ahead of what that read
  // will return. Track it so the initial reconciliation pushes the
  // viewer's edit up instead of clobbering it with the stale read.
  let cloudReady = false;
  let localWritesBeforeCloudReady = false;

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to write local data.', e);
    }
    if (!cloudReady) localWritesBeforeCloudReady = true;
    if (dbCap) {
      dbCap.doc('app/state').set(state).catch(e => console.error('Cloud save failed.', e));
    }
  }

  async function initCloudSync() {
    if (typeof window.claude === 'undefined' || typeof window.claude.use !== 'function') return;
    syncStatus = 'checking';
    let db;
    try {
      db = await window.claude.use('db');
    } catch (e) {
      db = null;
    }
    if (!db) return;
    dbCap = db;

    try {
      const snap = await db.doc('app/state').get();
      if (localWritesBeforeCloudReady) {
        // The viewer already changed something in-memory while this read
        // was in flight — that edit wins; push it up instead of pulling
        // the (now stale) snapshot over it.
        await db.doc('app/state').set(state);
      } else if (snap.exists) {
        state = normalizeState(snap.data());
      } else {
        await db.doc('app/state').set(state);
      }
      cloudReady = true;
      syncStatus = 'cloud';
      renderAll();
      showToast('☁️ الحفظ السحابي مفعّل — بياناتك محفوظة بأمان');
    } catch (e) {
      console.error('Cloud load failed, staying on local data.', e);
    }

    db.doc('app/state').onSnapshot(snap => {
      if (!cloudReady || !snap.exists || snap.metadata.hasPendingWrites) return;
      state = normalizeState(snap.data());
      renderAll();
    }, e => console.error('Cloud sync error.', e));
  }

  /* ============================ HELPERS ============================ */

  function todayStr() {
    return toDateStr(new Date());
  }

  function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDateAr(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('ar-u-ca-gregory', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Arabic week: Saturday -> Friday
  function weekStart(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0 = Sunday ... 6 = Saturday
    const diff = (day + 1) % 7; // days since Saturday
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function inSameWeek(dateStr, refDate) {
    const ws = weekStart(refDate);
    const we = new Date(ws);
    we.setDate(we.getDate() + 6);
    const d = new Date(dateStr + 'T00:00:00');
    return d >= ws && d <= we;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  /* ---------- in-page confirm/toast (native confirm()/alert() are blocked in some mobile app views) ---------- */

  function showConfirm(message, onYes) {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmMessage').textContent = message;
    const yesBtn = document.getElementById('confirmYesBtn');
    const noBtn = document.getElementById('confirmNoBtn');

    const cleanup = () => {
      modal.classList.add('hidden');
      yesBtn.removeEventListener('click', onYesClick);
      noBtn.removeEventListener('click', onNoClick);
    };
    const onYesClick = () => { cleanup(); onYes(); };
    const onNoClick = () => cleanup();

    yesBtn.addEventListener('click', onYesClick);
    noBtn.addEventListener('click', onNoClick);
    modal.classList.remove('hidden');
  }

  let toastTimer = null;
  function showToast(message, durationMs) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), durationMs || 2800);
  }

  /* ---------- daily goal status (calories / protein) ---------- */

  function computeGoalStatus(value, goal, marginPct) {
    if (value === null || value === undefined || !goal) return null;
    const margin = goal * (marginPct / 100);
    const diff = round1(value - goal);
    if (diff === 0) return { state: 'exact', diff };
    if (value > goal + margin) return { state: 'over', diff };
    if (value < goal - margin) return { state: 'under', diff };
    return { state: 'met', diff };
  }

  const GOAL_STATUS_CONFIG = {
    exact: { icon: '🎯', cls: 'good', text: goal => `بالضبط على الهدف (${goal})` },
    met:   { icon: '✅', cls: 'good', text: () => 'ضمن الهدف' },
    over:  { icon: '⬆️', cls: 'bad', text: (goal, diff, unit) => `فوق الهدف بـ ${round1(Math.abs(diff))} ${unit}` },
    under: { icon: '⬇️', cls: 'bad', text: (goal, diff, unit) => `أقل من الهدف بـ ${round1(Math.abs(diff))} ${unit}` },
  };

  function goalBadgeHtml(status, unit, goal, compact) {
    if (!status) return '';
    const cfg = GOAL_STATUS_CONFIG[status.state];
    const text = cfg.text(goal, status.diff, unit);
    if (compact) return `<span class="goal-badge-mini" title="${text}">${cfg.icon}</span>`;
    return `<span class="goal-badge ${cfg.cls}">${cfg.icon} ${text}</span>`;
  }

  /* ============================ TABS ============================ */

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'measurements') renderChart();
    });
  });

  /* ============================ DAILY FORM ============================ */

  const dailyDateInput = document.getElementById('dailyDate');
  const workoutDoneInput = document.getElementById('workoutDone');
  const workoutDetails = document.getElementById('workoutDetails');

  dailyDateInput.value = todayStr();

  workoutDoneInput.addEventListener('change', () => {
    workoutDetails.classList.toggle('hidden', !workoutDoneInput.checked);
  });

  dailyDateInput.addEventListener('change', loadDailyFormForDate);

  const caloriesInput = document.getElementById('calories');
  const proteinInput = document.getElementById('protein');
  caloriesInput.addEventListener('input', updateDailyGoalBadges);
  proteinInput.addEventListener('input', updateDailyGoalBadges);

  function updateDailyGoalBadges() {
    const cal = numOrNull(caloriesInput.value);
    const prot = numOrNull(proteinInput.value);
    const calStatus = computeGoalStatus(cal, state.settings.calorieGoal, state.settings.calorieMarginPct);
    const protStatus = computeGoalStatus(prot, state.settings.proteinGoal, state.settings.proteinMarginPct);
    document.getElementById('caloriesBadge').innerHTML = goalBadgeHtml(calStatus, 'سعرة', state.settings.calorieGoal);
    document.getElementById('proteinBadge').innerHTML = goalBadgeHtml(protStatus, 'جم', state.settings.proteinGoal);
  }

  function loadDailyFormForDate() {
    const date = dailyDateInput.value;
    const entry = state.dailyLogs[date];
    document.getElementById('steps').value = entry?.steps ?? '';
    caloriesInput.value = entry?.calories ?? '';
    proteinInput.value = entry?.protein ?? '';
    const w = entry?.workout;
    workoutDoneInput.checked = !!w?.done;
    workoutDetails.classList.toggle('hidden', !w?.done);
    document.getElementById('workoutType').value = w?.type ?? '';
    document.getElementById('workoutDuration').value = w?.duration ?? '';
    document.getElementById('workoutNotes').value = w?.notes ?? '';
    updateDailyGoalBadges();
  }

  document.getElementById('dailySaveBtn').addEventListener('click', () => {
    try {
      const date = dailyDateInput.value;
      if (!date) { showToast('اختر التاريخ أولًا.'); return; }

      state.dailyLogs[date] = {
        steps: numOrNull(document.getElementById('steps').value),
        calories: numOrNull(document.getElementById('calories').value),
        protein: numOrNull(document.getElementById('protein').value),
        workout: {
          done: workoutDoneInput.checked,
          type: document.getElementById('workoutType').value.trim(),
          duration: numOrNull(document.getElementById('workoutDuration').value),
          notes: document.getElementById('workoutNotes').value.trim(),
        },
      };
      saveState();
      renderAll();
      showToast('تم حفظ يوم ' + formatDateAr(date) + '.');
    } catch (err) {
      console.error('Daily save failed:', err);
      showToast('⚠️ فشل الحفظ: ' + (err && err.message ? err.message : String(err)), 8000);
    }
  });

  function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function deleteDailyLog(date) {
    showConfirm(`حذف تسجيل يوم ${formatDateAr(date)}؟`, () => {
      delete state.dailyLogs[date];
      saveState();
      renderAll();
      showToast('تم الحذف.');
    });
  }

  /* ---------- weekly workout progress + weekly stats ---------- */

  function renderWeeklyProgress() {
    const now = new Date();
    const dates = Object.keys(state.dailyLogs).filter(d => inSameWeek(d, now));
    const workoutDays = dates.filter(d => state.dailyLogs[d].workout?.done).length;
    const goal = state.settings.weeklyWorkoutGoal;
    const pct = Math.min(100, Math.round((workoutDays / goal) * 100));

    const el = document.getElementById('weeklyWorkoutProgress');
    el.innerHTML = `
      <div class="progress-label">أيام التمرين هذا الأسبوع: <strong>${workoutDays} / ${goal}</strong></div>
      <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
    `;

    const nums = k => dates.map(d => state.dailyLogs[d][k]).filter(v => v !== null && v !== undefined);
    const avg = arr => arr.length ? round1(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    const sum = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0)) : null;

    const stepsAvg = avg(nums('steps'));
    const calAvg = avg(nums('calories'));
    const proteinAvg = avg(nums('protein'));

    const calAvgStatus = computeGoalStatus(calAvg, state.settings.calorieGoal, state.settings.calorieMarginPct);
    const proteinAvgStatus = computeGoalStatus(proteinAvg, state.settings.proteinGoal, state.settings.proteinMarginPct);

    const statsEl = document.getElementById('weeklyStats');
    statsEl.innerHTML = `
      <div class="stat-box"><div class="stat-value">${stepsAvg ?? '—'}</div><div class="stat-label">متوسط الخطوات اليومي</div></div>
      <div class="stat-box"><div class="stat-value">${calAvg ?? '—'}</div><div class="stat-label">متوسط السعرات اليومي</div>${goalBadgeHtml(calAvgStatus, 'سعرة', state.settings.calorieGoal, true)}</div>
      <div class="stat-box"><div class="stat-value">${proteinAvg ?? '—'} جم</div><div class="stat-label">متوسط البروتين اليومي</div>${goalBadgeHtml(proteinAvgStatus, 'جم', state.settings.proteinGoal, true)}</div>
      <div class="stat-box"><div class="stat-value">${workoutDays}</div><div class="stat-label">أيام تمرين هذا الأسبوع</div></div>
    `;
  }

  function calorieCellHtml(value) {
    if (value === null || value === undefined) return '—';
    const status = computeGoalStatus(value, state.settings.calorieGoal, state.settings.calorieMarginPct);
    return `${value}${goalBadgeHtml(status, 'سعرة', state.settings.calorieGoal, true)}`;
  }

  function proteinCellHtml(value) {
    if (value === null || value === undefined) return '—';
    const status = computeGoalStatus(value, state.settings.proteinGoal, state.settings.proteinMarginPct);
    return `${value}${goalBadgeHtml(status, 'جم', state.settings.proteinGoal, true)}`;
  }

  function renderRecentDailyTable() {
    const tbody = document.querySelector('#recentDailyTable tbody');
    const dates = Object.keys(state.dailyLogs).sort().reverse().slice(0, 7);
    tbody.innerHTML = dates.map(rowHtml).join('') ||
      `<tr><td colspan="6" class="muted">لا توجد بيانات بعد</td></tr>`;
    attachRowHandlers(tbody);
  }

  function renderFullDailyTable() {
    const tbody = document.querySelector('#fullDailyTable tbody');
    const dates = Object.keys(state.dailyLogs).sort().reverse();
    tbody.innerHTML = dates.map(d => {
      const e = state.dailyLogs[d];
      const w = e.workout;
      const details = w?.done ? [w.type, w.duration ? `${w.duration} دقيقة` : null, w.notes].filter(Boolean).join(' · ') : '—';
      return `<tr>
        <td>${formatDateAr(d)}</td>
        <td>${e.steps ?? '—'}</td>
        <td>${calorieCellHtml(e.calories)}</td>
        <td>${proteinCellHtml(e.protein)}</td>
        <td>${w?.done ? '✅' : '—'}</td>
        <td>${details}</td>
        <td><button class="btn-icon-small" data-del="${d}" title="حذف">🗑️</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="7" class="muted">لا توجد بيانات بعد</td></tr>`;
    tbody.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteDailyLog(btn.dataset.del));
    });
  }

  function rowHtml(d) {
    const e = state.dailyLogs[d];
    return `<tr>
      <td>${formatDateAr(d)}</td>
      <td>${e.steps ?? '—'}</td>
      <td>${calorieCellHtml(e.calories)}</td>
      <td>${proteinCellHtml(e.protein)}</td>
      <td>${e.workout?.done ? '✅' : '—'}</td>
      <td><button class="btn-icon-small" data-del="${d}" title="حذف">🗑️</button></td>
    </tr>`;
  }

  function attachRowHandlers(tbody) {
    tbody.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteDailyLog(btn.dataset.del));
    });
  }

  /* ============================ MEASUREMENTS FORM ============================ */

  const measureFieldsEl = document.getElementById('measureFields');
  measureFieldsEl.innerHTML = MEASURE_FIELDS.map(f => `
    <div class="field">
      <label for="m_${f.key}">${f.label} (${f.unit})</label>
      <input type="number" step="0.1" min="0" id="m_${f.key}" placeholder="—">
    </div>
  `).join('');

  document.getElementById('measureDate').value = todayStr();

  document.getElementById('measureSaveBtn').addEventListener('click', () => {
    try {
      const date = document.getElementById('measureDate').value;
      if (!date) { showToast('اختر تاريخ القياس أولًا.'); return; }
      const entry = { id: `${date}-${Date.now()}`, date };
      MEASURE_FIELDS.forEach(f => {
        const input = document.getElementById(`m_${f.key}`);
        entry[f.key] = input ? numOrNull(input.value) : null;
        if (input) input.value = '';
      });
      state.measurements.push(entry);
      state.measurements.sort((a, b) => a.date.localeCompare(b.date));
      saveState();
      document.getElementById('measureDate').value = todayStr();
      renderAll();
      showToast('تم حفظ القياسات.');
    } catch (err) {
      console.error('Measurement save failed:', err);
      showToast('⚠️ فشل الحفظ: ' + (err && err.message ? err.message : String(err)), 8000);
    }
  });

  function deleteMeasurement(id) {
    showConfirm('حذف هذا القياس؟', () => {
      state.measurements = state.measurements.filter(m => m.id !== id);
      saveState();
      renderAll();
      showToast('تم الحذف.');
    });
  }

  function renderMeasureTable() {
    const head = document.getElementById('measureTableHead');
    head.innerHTML = `<th>التاريخ</th>` + MEASURE_FIELDS.map(f => `<th>${f.label}</th>`).join('') + `<th></th>`;

    const tbody = document.querySelector('#measureTable tbody');
    const rows = [...state.measurements].sort((a, b) => b.date.localeCompare(a.date));
    tbody.innerHTML = rows.map(m => `
      <tr>
        <td>${formatDateAr(m.date)}</td>
        ${MEASURE_FIELDS.map(f => `<td>${m[f.key] ?? '—'}</td>`).join('')}
        <td><button class="btn-icon-small" data-del="${m.id}" title="حذف">🗑️</button></td>
      </tr>
    `).join('') || `<tr><td colspan="${MEASURE_FIELDS.length + 2}" class="muted">لا توجد قياسات بعد</td></tr>`;

    tbody.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteMeasurement(btn.dataset.del));
    });
  }

  /* ---------- delta summary (up/down indicators) ---------- */

  function renderDeltaSummary() {
    const el = document.getElementById('deltaSummary');
    const sorted = [...state.measurements].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length === 0) {
      el.innerHTML = `<p class="muted">سجّل قياسًا واحدًا على الأقل لعرض الملخص.</p>`;
      return;
    }
    const latest = sorted[sorted.length - 1];
    const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;

    el.innerHTML = MEASURE_FIELDS.map(f => {
      const cur = latest[f.key];
      const prior = prev ? prev[f.key] : null;
      if (cur === null || cur === undefined) {
        return `<div class="delta-card"><div class="delta-name">${f.label}</div><div class="delta-value muted">لا يوجد</div></div>`;
      }
      if (prior === null || prior === undefined) {
        return `<div class="delta-card"><div class="delta-name">${f.label}</div><div class="delta-value">${cur} ${f.unit}</div></div>`;
      }
      const diff = round1(cur - prior);
      let cls = 'delta-flat';
      let arrow = '→';
      if (diff > 0) { arrow = '▲'; cls = 'delta-up'; }
      else if (diff < 0) { arrow = '▼'; cls = 'delta-down'; }

      // colour by whether this direction matches the user's goal for this measurement
      let goalCls = '';
      const goal = state.settings.goalDirections[f.key];
      if (diff !== 0 && goal) {
        const improved = (goal === 'down' && diff < 0) || (goal === 'up' && diff > 0);
        goalCls = improved ? 'delta-good' : 'delta-bad';
      }

      return `<div class="delta-card">
        <div class="delta-name">${f.label}</div>
        <div class="delta-value">${cur} ${f.unit}</div>
        <div class="delta-value ${goalCls || cls}">${arrow} ${diff > 0 ? '+' : ''}${diff}</div>
      </div>`;
    }).join('');
  }

  /* ---------- chart ---------- */

  const chartMetricSelect = document.getElementById('chartMetric');
  chartMetricSelect.innerHTML = MEASURE_FIELDS.map(f => `<option value="${f.key}">${f.label}</option>`).join('');
  chartMetricSelect.addEventListener('change', renderChart);

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function renderChart() {
    const canvas = document.getElementById('progressChart');
    const ctx = canvas.getContext('2d');
    const emptyMsg = document.getElementById('chartEmptyMsg');
    const metric = chartMetricSelect.value || MEASURE_FIELDS[0].key;
    const field = MEASURE_FIELDS.find(f => f.key === metric);

    const points = state.measurements
      .filter(m => m[metric] !== null && m[metric] !== undefined)
      .sort((a, b) => a.date.localeCompare(b.date));

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (points.length < 2) {
      emptyMsg.classList.remove('hidden');
      return;
    }
    emptyMsg.classList.add('hidden');

    const colorBorder = cssVar('--border') || '#dbe1d7';
    const colorMuted = cssVar('--muted') || '#5c6b63';
    const colorInk = cssVar('--ink') || '#182420';
    const colorAccent = cssVar('--accent') || '#1f7a4d';
    const colorWarn = cssVar('--warn') || '#b5622c';

    const W = canvas.width, H = canvas.height;
    const padL = 52, padR = 20, padT = 24, padB = 40;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const values = points.map(p => p[metric]);
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.2;
    min -= pad; max += pad;

    const xFor = i => padL + (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
    const yFor = v => padT + plotH - ((v - min) / (max - min)) * plotH;

    // faint grid + axis values
    ctx.strokeStyle = colorBorder;
    ctx.lineWidth = 1;
    ctx.font = '11px "IBM Plex Sans Arabic", sans-serif';
    ctx.fillStyle = colorMuted;
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (plotH * i) / gridLines;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      const val = max - ((max - min) * i) / gridLines;
      ctx.textAlign = 'left';
      ctx.fillText(round1(val).toString(), 6, y + 4);
    }

    // area fill under the line
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(points[0][metric]));
    points.forEach((p, i) => ctx.lineTo(xFor(i), yFor(p[metric])));
    ctx.lineTo(xFor(points.length - 1), padT + plotH);
    ctx.lineTo(xFor(0), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(colorAccent, 0.12);
    ctx.fill();

    // segments coloured by whether the change matches the user's goal
    points.forEach((p, i) => {
      if (i === 0) return;
      const prevVal = points[i - 1][metric];
      const diff = p[metric] - prevVal;
      const goal = state.settings.goalDirections[metric];
      let color = colorMuted;
      if (diff !== 0 && goal) {
        const improved = (goal === 'down' && diff < 0) || (goal === 'up' && diff > 0);
        color = improved ? colorAccent : colorWarn;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(xFor(i - 1), yFor(prevVal));
      ctx.lineTo(xFor(i), yFor(p[metric]));
      ctx.stroke();
    });

    // points + date labels
    points.forEach((p, i) => {
      const x = xFor(i), y = yFor(p[metric]);
      const isLast = i === points.length - 1;

      if (isLast) {
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(colorAccent, 0.18);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, isLast ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isLast ? colorAccent : cssVar('--surface') || '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = colorAccent;
      ctx.stroke();

      const showEvery = Math.ceil(points.length / 8);
      if (i % showEvery === 0 || isLast) {
        ctx.fillStyle = colorMuted;
        ctx.textAlign = 'center';
        const label = new Date(p.date + 'T00:00:00').toLocaleDateString('ar-u-ca-gregory', { month: 'numeric', day: 'numeric' });
        ctx.fillText(label, x, H - padB + 18);
      }
    });

    // last-value callout
    ctx.fillStyle = colorInk;
    ctx.font = 'bold 13px "IBM Plex Sans Arabic", sans-serif';
    ctx.textAlign = 'right';
    const last = points[points.length - 1][metric];
    ctx.fillText(`${field.label}: ${round1(last)} ${field.unit}`, W - padR, 16);
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (document.getElementById('tab-measurements').classList.contains('active')) renderChart();
    });
  }

  /* ============================ SETTINGS MODAL ============================ */

  const settingsModal = document.getElementById('settingsModal');
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', closeSettings);

  function openSettings() {
    const syncEl = document.getElementById('syncStatusLine');
    if (syncStatus === 'cloud') {
      syncEl.textContent = '☁️ الحفظ السحابي مفعّل — بياناتك محفوظة بأمان ولا تُفقد.';
      syncEl.className = 'sync-status sync-ok';
    } else if (syncStatus === 'checking') {
      syncEl.textContent = '⏳ يتم التحقق من الحفظ السحابي...';
      syncEl.className = 'sync-status';
    } else {
      syncEl.textContent = '💾 يُحفظ محليًا في هذا المتصفح فقط (الحفظ السحابي غير متاح هنا).';
      syncEl.className = 'sync-status sync-local';
    }

    document.getElementById('weeklyGoalInput').value = state.settings.weeklyWorkoutGoal;
    document.getElementById('calorieGoalInput').value = state.settings.calorieGoal;
    document.getElementById('calorieMarginInput').value = state.settings.calorieMarginPct;
    document.getElementById('proteinGoalInput').value = state.settings.proteinGoal;
    document.getElementById('proteinMarginInput').value = state.settings.proteinMarginPct;
    const el = document.getElementById('goalDirections');
    el.innerHTML = MEASURE_FIELDS.map(f => `
      <div class="goal-direction-row">
        <span>${f.label}</span>
        <select data-goal="${f.key}">
          <option value="down" ${state.settings.goalDirections[f.key] === 'down' ? 'selected' : ''}>الهدف: تقليله ⬇️</option>
          <option value="up" ${state.settings.goalDirections[f.key] === 'up' ? 'selected' : ''}>الهدف: زيادته ⬆️</option>
        </select>
      </div>
    `).join('');
    settingsModal.classList.remove('hidden');
  }

  function closeSettings() {
    const goal = Number(document.getElementById('weeklyGoalInput').value) || 4;
    state.settings.weeklyWorkoutGoal = Math.min(7, Math.max(1, goal));
    state.settings.calorieGoal = Number(document.getElementById('calorieGoalInput').value) || state.settings.calorieGoal;
    state.settings.proteinGoal = Number(document.getElementById('proteinGoalInput').value) || state.settings.proteinGoal;
    state.settings.calorieMarginPct = Math.max(0, Number(document.getElementById('calorieMarginInput').value) || 0);
    state.settings.proteinMarginPct = Math.max(0, Number(document.getElementById('proteinMarginInput').value) || 0);
    document.querySelectorAll('#goalDirections [data-goal]').forEach(sel => {
      state.settings.goalDirections[sel.dataset.goal] = sel.value;
    });
    saveState();
    settingsModal.classList.add('hidden');
    renderAll();
  }

  document.getElementById('exportData').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  });

  document.getElementById('importDataBtn').addEventListener('click', () => {
    document.getElementById('importDataInput').click();
  });

  document.getElementById('importDataInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const base = defaultState();
        showConfirm('سيتم استبدال جميع البيانات الحالية بالبيانات المستوردة. متابعة؟', () => {
          state = {
            dailyLogs: parsed.dailyLogs || base.dailyLogs,
            measurements: parsed.measurements || base.measurements,
            settings: {
              weeklyWorkoutGoal: parsed.settings?.weeklyWorkoutGoal ?? base.settings.weeklyWorkoutGoal,
              calorieGoal: parsed.settings?.calorieGoal ?? base.settings.calorieGoal,
              proteinGoal: parsed.settings?.proteinGoal ?? base.settings.proteinGoal,
              calorieMarginPct: parsed.settings?.calorieMarginPct ?? base.settings.calorieMarginPct,
              proteinMarginPct: parsed.settings?.proteinMarginPct ?? base.settings.proteinMarginPct,
              goalDirections: { ...base.settings.goalDirections, ...(parsed.settings?.goalDirections || {}) },
            },
          };
          saveState();
          renderAll();
          closeSettings();
          showToast('تم استيراد البيانات بنجاح.');
        });
      } catch (err) {
        showToast('تعذّر قراءة الملف. تأكد أنه ملف JSON صحيح تم تصديره من هذا التطبيق.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* ============================ AI ASSISTANT ============================ */

  let sampleCap = null;
  let chatTurns = []; // { role: 'user' | 'assistant', content: string }

  const ASSISTANT_RULES =
    'أنت مساعد صحي ولياقة بدنية شخصي داخل تطبيق متابعة يستخدمه شخص واحد. ' +
    'أمامك بيانات المستخدم الفعلية بصيغة JSON (آخر 14 يومًا من سجله اليومي، وآخر قياساته، وأهدافه). ' +
    'اعتمد فقط على هذه الأرقام — لا تخترع بيانات غير موجودة، ولا تقدّم نصائح طبية عامة لا علاقة لها بالأرقام المعطاة. ' +
    'إن سُئلت عن شيء خارج بيانات اللياقة/الصحة المتاحة هنا، وضّح بأدب أنك مخصص لتحليل بيانات هذا التطبيق فقط. ' +
    'أجب بالعربية الفصحى المبسطة، بإيجاز ووضوح.';

  function buildAssistantContext() {
    const dates = Object.keys(state.dailyLogs).sort().slice(-14);
    const dailyLogsLast14Days = dates.map(d => ({ date: d, ...state.dailyLogs[d] }));
    const recentMeasurements = [...state.measurements]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-6);
    return {
      today: todayStr(),
      goals: {
        weeklyWorkoutGoal: state.settings.weeklyWorkoutGoal,
        calorieGoal: state.settings.calorieGoal,
        calorieMarginPct: state.settings.calorieMarginPct,
        proteinGoal: state.settings.proteinGoal,
        proteinMarginPct: state.settings.proteinMarginPct,
      },
      measurementGoalDirections: state.settings.goalDirections,
      dailyLogsLast14Days,
      recentMeasurements,
    };
  }

  function assistantErrorMessage(err) {
    const code = err && err.code;
    switch (code) {
      case 'not_granted':
      case 'sampling_disabled':
      case 'not_declared':
      case 'capability_disabled':
      case 'capability_removed':
        sampleCap = null;
        updateAssistantAvailability(false);
        return '⚠️ المساعد الذكي غير متاح في هذا العرض.';
      case 'rate_limited':
        return '⏳ عدد الطلبات كبير حاليًا، حاول بعد قليل.';
      case 'session_expired':
        return '🔒 يلزم تسجيل الدخول من جديد لاستخدام المساعد.';
      case 'cancelled':
        return '';
      case 'prompt_too_large':
        return '⚠️ سجلّك أكبر من اللازم لهذا الطلب حاليًا.';
      case 'empty_completion':
      case 'refused':
        return '⚠️ لم يتمكن المساعد من الإجابة، جرّب صياغة مختلفة.';
      default:
        return '⚠️ حدث خطأ غير متوقع، حاول مرة أخرى.';
    }
  }

  function updateAssistantAvailability(available) {
    document.getElementById('insightsBtn').disabled = !available;
    document.getElementById('assistantAskBtn').disabled = !available;
    document.getElementById('assistantQuestion').disabled = !available;
    document.getElementById('assistantUnavailable').classList.toggle('hidden', available);
  }

  async function initAssistant() {
    updateAssistantAvailability(false);
    if (typeof window.claude === 'undefined' || typeof window.claude.use !== 'function') return;
    let s;
    try {
      s = await window.claude.use('sample');
    } catch (e) {
      s = null;
    }
    sampleCap = s;
    updateAssistantAvailability(!!s);
  }

  document.getElementById('insightsBtn').addEventListener('click', async () => {
    if (!sampleCap) { showToast('المساعد الذكي غير متاح في هذا العرض.'); return; }
    const btn = document.getElementById('insightsBtn');
    const out = document.getElementById('insightsOutput');
    btn.disabled = true;
    out.innerHTML = '<span class="thinking">🤔 يفكر...</span>';
    try {
      const context = buildAssistantContext();
      const prompt =
        ASSISTANT_RULES +
        '\n\nاكتب 3 إلى 5 ملاحظات أو نصائح قصيرة (سطر أو سطرين لكل واحدة) بناءً على البيانات التالية. ' +
        'ركّز على: الالتزام بهدف أيام التمرين الأسبوعية، اتساق السعرات والبروتين مقابل الهدف، وأي اتجاه ملحوظ بالقياسات. ' +
        'اجعل كل نصيحة تبدأ برمز تعبيري مناسب، سطر مستقل لكل نصيحة، بدون مقدمة أو خاتمة.' +
        '\n\nبيانات المستخدم:\n' + JSON.stringify(context);
      const { text } = await sampleCap(prompt, {
        modelTier: 'quick',
        onText: ({ text }) => { out.textContent = text; },
      });
      out.textContent = text;
    } catch (err) {
      out.textContent = assistantErrorMessage(err);
    } finally {
      btn.disabled = !sampleCap;
    }
  });

  function appendChatBubble(role, text, thinking) {
    const wrap = document.getElementById('chatMessages');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + role + (thinking ? ' thinking' : '');
    bubble.textContent = text;
    wrap.appendChild(bubble);
    wrap.scrollTop = wrap.scrollHeight;
    return bubble;
  }

  async function sendAssistantQuestion() {
    if (!sampleCap) { showToast('المساعد الذكي غير متاح في هذا العرض.'); return; }
    const input = document.getElementById('assistantQuestion');
    const question = input.value.trim();
    if (!question) return;

    appendChatBubble('user', question);
    input.value = '';
    const askBtn = document.getElementById('assistantAskBtn');
    askBtn.disabled = true;
    const replyBubble = appendChatBubble('assistant', '🤔 يفكر...', true);

    const context = buildAssistantContext();
    const instructions = ASSISTANT_RULES + '\n\nبيانات المستخدم:\n' + JSON.stringify(context);
    const turnsToSend = [{ role: 'user', content: instructions }, ...chatTurns, { role: 'user', content: question }];

    try {
      const { text } = await sampleCap(turnsToSend, {
        cache: false,
        modelTier: 'quick',
        onText: ({ text }) => {
          replyBubble.classList.remove('thinking');
          replyBubble.textContent = text;
        },
      });
      replyBubble.classList.remove('thinking');
      replyBubble.textContent = text;
      chatTurns.push({ role: 'user', content: question }, { role: 'assistant', content: text });
      if (chatTurns.length > 12) chatTurns = chatTurns.slice(-12);
    } catch (err) {
      replyBubble.classList.remove('thinking');
      replyBubble.textContent = assistantErrorMessage(err) || '⚠️ تم الإلغاء.';
    } finally {
      askBtn.disabled = !sampleCap;
    }
  }

  document.getElementById('assistantAskBtn').addEventListener('click', sendAssistantQuestion);
  document.getElementById('assistantQuestion').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendAssistantQuestion(); }
  });

  /* ============================ RENDER ALL ============================ */

  function renderAll() {
    loadDailyFormForDate();
    renderWeeklyProgress();
    renderRecentDailyTable();
    renderFullDailyTable();
    renderMeasureTable();
    renderDeltaSummary();
    renderChart();
  }

  renderAll();
  initCloudSync();
  initAssistant();
})();
