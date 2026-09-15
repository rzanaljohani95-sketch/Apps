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
        // Known period/cycle length from the user's own tracking history —
        // used instead of the computed average until enough logged periods
        // build up their own average (see computeCycleInfo).
        periodLenOverride: 7,
        cycleLenOverride: 26,
      },
      // One-time data-seeding markers so a migration only ever runs once,
      // even after it syncs to the cloud and reloads elsewhere.
      seedFlags: {},
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
        periodLenOverride: parsed.settings?.periodLenOverride ?? base.settings.periodLenOverride,
        cycleLenOverride: parsed.settings?.cycleLenOverride ?? base.settings.cycleLenOverride,
      },
      seedFlags: { ...base.seedFlags, ...(parsed.seedFlags || {}) },
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
      // A local write before this read resolved should normally win (it's
      // the viewer editing while the read was still in flight) — but ONLY
      // when the local copy actually has real data. A brand-new/empty
      // session (fresh device, cleared storage, ...) must never push an
      // empty state over a cloud document that already has history in it;
      // that would silently destroy everything already saved.
      const localHasData = Object.keys(state.dailyLogs).length > 0 || state.measurements.length > 0;
      if (localWritesBeforeCloudReady && (localHasData || !snap.exists)) {
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

  // Week: Sunday -> Saturday
  function weekStart(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0 = Sunday ... 6 = Saturday
    d.setDate(d.getDate() - day);
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

  /* ---------- menstrual cycle tracking (simple estimate, not medical advice) ---------- */

  const CYCLE_PHASES = {
    menstrual: { icon: '🩸', label: 'الدورة الشهرية', tip: 'قد ينخفض مستوى الطاقة هذه الأيام — خففي شدة التمرين حسب راحتك، واهتمي بالراحة والبروتين.' },
    follicular: { icon: '🌱', label: 'المرحلة الجريبية', tip: 'الطاقة ترتفع تدريجيًا — وقت مناسب لزيادة شدة التمارين تدريجيًا.' },
    ovulation: { icon: '🥚', label: 'الإباضة', tip: 'عادة ما تكون ذروة الطاقة والأداء البدني — وقت جيد للتمارين عالية الشدة إن رغبتِ.' },
    luteal: { icon: '🌗', label: 'المرحلة الأصفرية', tip: 'قد يزيد الشعور بالتعب أو الرغبة الغذائية قرب نهاية المرحلة — راقبي جسمك وعدّلي حسب حاجتك.' },
  };
  // A warm, supportive line per phase — several options each so it doesn't
  // repeat verbatim every time the same phase comes around, picked
  // deterministically from the day so it stays stable within one day.
  const CYCLE_ENCOURAGEMENT = {
    menstrual: [
      'جسمك يبذل مجهودًا حقيقيًا هذي الأيام — الراحة إنجاز مو كسل 💗',
      'كوني لطيفة مع نفسك اليوم، أنتِ تستاهلين الرفق 🩷',
      'كل يوم تعدينه بلطف مع نفسك هذي الأيام هو انتصار 💗',
    ],
    follicular: [
      'طاقتك بترجع تدريجيًا — استقبليها بثقة وابدئي بخطوة 🌱',
      'جسمك يستعيد نشاطه شوي شوي، وقتك الحين ✨',
      'كل يوم أقوى من اللي قبله — استمري 🌱',
    ],
    ovulation: [
      'أنتِ في قمة قوتك الآن — استمتعي فيها وحققي أقصى استفادة 🥳',
      'هذا وقتك تلمعين فيه — اذهبي واستغلّيه 🔥',
      'طاقتك اليوم في أعلى مستوياتها، لا تبخسي نفسك حقك 🥚',
    ],
    luteal: [
      'جسمك يستعد لدورة جديدة — كوني صبورة معه، وهذا كافٍ 🌗',
      'لو حسيتِ إنك أبطأ شوي، هذا طبيعي — استمري بلطف 💛',
      'أنتِ تسوّين أكثر مما تتخيلين حتى بالأيام الأصعب 🌗',
    ],
  };
  function cycleEncouragement(phase, forDate) {
    const options = CYCLE_ENCOURAGEMENT[phase];
    const dayIndex = Number(forDate.slice(-2)) || 0;
    return options[dayIndex % options.length];
  }
  // What to typically expect this phase, across four practical areas —
  // general patterns, not medical advice, and every body differs.
  const CYCLE_PHASE_EXPECT = {
    menstrual: {
      body: 'تقلصات وتعب عام محتمل، وانتفاخ خفيف قد يستمر من المرحلة السابقة.',
      appetite: 'الشهية غالبًا طبيعية، وقد تزيد قليلًا في اليوم الأول أو الثاني.',
      intensity: 'تحمّل شدة التمرين ينخفض — قلّلي الحمل حسب راحتك، ولا بأس بالراحة.',
      sugar: 'الرغبة بالسكريات خفيفة إلى متوسطة عادة.',
    },
    follicular: {
      body: 'الانتفاخ يخف بوضوح، والجسم يشعر بخفة ونشاط أكبر.',
      appetite: 'الشهية معتدلة ومستقرة نسبيًا.',
      intensity: 'تحمّل شدة التمرين يتحسن تدريجيًا — وقت مناسب لزيادة الأحمال أو الشدة.',
      sugar: 'الرغبة بالسكريات منخفضة نسبيًا.',
    },
    ovulation: {
      body: 'ذروة النشاط والحيوية، وقد يظهر انتفاخ بسيط جدًا حول يوم الإباضة نفسه.',
      appetite: 'الشهية عادة في أدنى مستوياتها خلال الشهر.',
      intensity: 'أعلى تحمّل لشدة التمرين — وقت جيد للتمارين عالية الكثافة إن رغبتِ.',
      sugar: 'الرغبة بالسكريات منخفضة عادة.',
    },
    luteal: {
      body: 'انتفاخ وحساسية بالثدي واردة، وزيادة طفيفة بالوزن قرب نهاية المرحلة بسبب احتباس الماء.',
      appetite: 'الشهية ترتفع تدريجيًا، خصوصًا بالأسبوع الأخير قبل الدورة.',
      intensity: 'تحمّل شدة التمرين يقل تدريجيًا — استمعي لجسمك وخففي إذا احتجتِ.',
      sugar: 'الرغبة بالسكريات والكربوهيدرات ترتفع بشكل ملحوظ (من أعراض ما قبل الدورة الشائعة).',
    },
  };
  const CYCLE_EXPECT_ROWS = [
    { key: 'body', icon: '🧍‍♀️', label: 'تغيّر الجسم' },
    { key: 'appetite', icon: '🍽️', label: 'الشهية' },
    { key: 'intensity', icon: '💪', label: 'تحمّل شدة التمرين' },
    { key: 'sugar', icon: '🍬', label: 'الرغبة بالسكريات' },
  ];
  const BLOAT_PRONE_FIELDS = ['waist', 'lowerBelly', 'hips', 'weight'];

  function daysBetween(d1, d2) {
    return Math.round((new Date(d2 + 'T00:00:00') - new Date(d1 + 'T00:00:00')) / 86400000);
  }

  function getPeriodClusters() {
    const periodDates = Object.keys(state.dailyLogs).filter(d => state.dailyLogs[d].onPeriod).sort();
    const clusters = [];
    let clusterStart = null, prev = null;
    periodDates.forEach(d => {
      if (!clusterStart) {
        clusterStart = d;
      } else if (daysBetween(prev, d) > 1) {
        clusters.push({ start: clusterStart, end: prev });
        clusterStart = d;
      }
      prev = d;
    });
    if (clusterStart) clusters.push({ start: clusterStart, end: prev });
    return clusters;
  }

  function computeCycleInfo(forDate) {
    const clusters = getPeriodClusters();
    if (clusters.length === 0) return null;

    // A single logged period isn't enough to average from, so fall back to
    // the length the user already knows from tracking elsewhere (set in
    // الإعدادات) until she's logged enough cycles here for her own average.
    let periodLen;
    if (clusters.length >= 2) {
      const lens = clusters.map(c => daysBetween(c.start, c.end) + 1);
      periodLen = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
      periodLen = Math.min(10, Math.max(3, periodLen));
    } else {
      periodLen = state.settings.periodLenOverride || Math.min(10, Math.max(3, daysBetween(clusters[0].start, clusters[0].end) + 1));
    }

    const starts = clusters.map(c => c.start);
    let cycleLen = state.settings.cycleLenOverride || 28;
    if (starts.length >= 2) {
      const gaps = [];
      for (let i = 1; i < starts.length; i++) gaps.push(daysBetween(starts[i - 1], starts[i]));
      cycleLen = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      cycleLen = Math.min(35, Math.max(21, cycleLen));
    }

    // Use the latest period start on or before forDate — a future-dated
    // log entry (wrong date picked by mistake) should never make forDate
    // look like it precedes its own cycle.
    const priorStarts = starts.filter(s => s <= forDate);
    const lastStart = priorStarts.length ? priorStarts[priorStarts.length - 1] : starts[0];
    const daysSinceStart = daysBetween(lastStart, forDate);
    const cycleDay = daysSinceStart + 1;
    const daysUntilNextPeriod = cycleLen - daysSinceStart;

    const ovulationDay = Math.max(periodLen + 2, cycleLen - 14);
    let phase;
    if (cycleDay <= periodLen) phase = 'menstrual';
    else if (cycleDay <= ovulationDay - 2) phase = 'follicular';
    else if (cycleDay <= ovulationDay + 1) phase = 'ovulation';
    else phase = 'luteal';

    return { cycleDay, cycleLen, periodLen, phase, daysUntilNextPeriod, lastStart, ovulationDay };
  }

  function cycleRingSegment(dayStart, dayEnd, cycleLen, circumference) {
    const start = Math.max(1, dayStart);
    const end = Math.min(cycleLen, dayEnd);
    if (end < start) return null;
    const fraction = (end - start + 1) / cycleLen;
    const length = fraction * circumference;
    const rotateDeg = ((start - 1) / cycleLen) * 360 - 90;
    return { length, rotateDeg };
  }

  function polarPoint(cx, cy, r, dayIndex, cycleLen) {
    const angle = ((dayIndex - 1) / cycleLen) * 2 * Math.PI - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  }

  // A grey track for the full cycle, with only the period (fading red to
  // pink) and the fertile window (blue) picked out in color — mirrors how
  // period-tracking apps like Clue draw this ring, rather than tinting
  // every phase a different hue.
  function buildCycleRingSvg(info) {
    const size = 220, r = 88, cx = size / 2, cy = size / 2, sw = 20;
    const circumference = 2 * Math.PI * r;

    const periodMid = Math.ceil(info.periodLen / 2);
    const arcs = [
      { range: [1, periodMid], color: 'var(--cycle-period-dark)' },
      { range: [periodMid + 1, info.periodLen], color: 'var(--cycle-period-light)' },
      { range: [info.ovulationDay - 1, info.ovulationDay + 1], color: 'var(--cycle-fertile)' },
    ];

    const arcEls = arcs.map(seg => {
      const s = cycleRingSegment(seg.range[0], seg.range[1], info.cycleLen, circumference);
      if (!s) return '';
      return `<circle cx="${cx}" cy="${cy}" r="${r}" class="cycle-ring-seg" style="stroke:${seg.color};stroke-dasharray:${s.length} ${circumference - s.length};transform:rotate(${s.rotateDeg}deg)"/>`;
    }).join('');

    const dropPoint = polarPoint(cx, cy, r, 1, info.cycleLen);
    const dropEl = `<text x="${dropPoint.x.toFixed(1)}" y="${(dropPoint.y - 16).toFixed(1)}" text-anchor="middle" class="cycle-ring-drop">💧</text>`;

    const todayCycleDay = Math.min(info.cycleLen, Math.max(1, info.cycleDay));
    const badgePoint = polarPoint(cx, cy, r, todayCycleDay, info.cycleLen);

    return `
      <svg viewBox="0 0 ${size} ${size}" class="cycle-ring-svg">
        <circle cx="${cx}" cy="${cy}" r="${r}" class="cycle-ring-bg" style="stroke-width:${sw}"/>
        <g style="stroke-width:${sw}">${arcEls}</g>
        ${dropEl}
        <circle cx="${badgePoint.x.toFixed(1)}" cy="${badgePoint.y.toFixed(1)}" r="21" class="cycle-ring-badge-bg"/>
        <text x="${badgePoint.x.toFixed(1)}" y="${(badgePoint.y - 4).toFixed(1)}" text-anchor="middle" class="cycle-ring-badge-label">اليوم</text>
        <text x="${badgePoint.x.toFixed(1)}" y="${(badgePoint.y + 12).toFixed(1)}" text-anchor="middle" class="cycle-ring-badge-num">${todayCycleDay}</text>
      </svg>
    `;
  }

  function renderCycleCard() {
    const card = document.getElementById('cycleCard');
    const info = computeCycleInfo(todayStr());
    if (!info) {
      card.innerHTML = `<p class="muted">فعّلي هذه الميزة بتسجيل أيام دورتك من خانة "🩸 على الدورة اليوم؟" في تسجيل اليوم، وسأحسب لك المراحل تلقائيًا بعد ذلك.</p>`;
      return;
    }
    const phaseInfo = CYCLE_PHASES[info.phase];
    const expect = CYCLE_PHASE_EXPECT[info.phase];
    const expectRows = CYCLE_EXPECT_ROWS.map(r => `
      <div class="cycle-expect-row">
        <span class="cycle-expect-icon">${r.icon}</span>
        <div class="cycle-expect-text">
          <span class="cycle-expect-label">${r.label}</span>
          <span class="cycle-expect-desc">${expect[r.key]}</span>
        </div>
      </div>
    `).join('');
    const centerHeadline = info.daysUntilNextPeriod <= 0
      ? `متأخرة ${Math.abs(info.daysUntilNextPeriod)} يوم تقريبًا`
      : `${info.daysUntilNextPeriod} يوم حتى دورتك القادمة`;

    const clusters = getPeriodClusters();
    const lastCluster = clusters[clusters.length - 1];
    const stillOngoing = info.phase === 'menstrual' && lastCluster && lastCluster.end >= todayStr();
    const datesRow = lastCluster ? `
      <div class="cycle-dates-row">
        <div class="cycle-date-item">
          <span class="cycle-date-label">بداية الدورة</span>
          <span class="cycle-date-value">${formatDateAr(lastCluster.start)}</span>
        </div>
        <div class="cycle-date-item">
          <span class="cycle-date-label">نهاية الدورة</span>
          <span class="cycle-date-value">${stillOngoing ? 'مستمرة الآن' : formatDateAr(lastCluster.end)}</span>
        </div>
      </div>
    ` : '';

    card.innerHTML = `
      <div class="cycle-ring-wrap">
        ${buildCycleRingSvg(info)}
        <div class="cycle-ring-center">
          <div class="cycle-ring-today">اليوم، ${formatDateAr(todayStr())}</div>
          <div class="cycle-ring-headline">${centerHeadline}</div>
        </div>
      </div>
      ${datesRow}
      <div class="cycle-encourage">${cycleEncouragement(info.phase, todayStr())}</div>
      <div class="cycle-phase-line">
        <span class="cycle-phase-icon">${phaseInfo.icon}</span>
        <span><strong>${phaseInfo.label}</strong> — ${phaseInfo.tip}</span>
      </div>
      <div class="cycle-expect-title">👀 ايش المتوقع هذي المرحلة</div>
      <div class="cycle-expect-grid">${expectRows}</div>
      <p class="muted cycle-disclaimer">تقدير تقريبي بناءً على الأيام التي سجّلتِها، وليس بديلاً عن استشارة طبية — وكل جسم يختلف عن الآخر.</p>
    `;
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
    });
  });

  /* ============================ DAILY FORM ============================ */

  const dailyDateInput = document.getElementById('dailyDate');
  const workoutDoneInput = document.getElementById('workoutDone');
  const workoutDetails = document.getElementById('workoutDetails');
  const onPeriodInput = document.getElementById('onPeriod');

  dailyDateInput.value = todayStr();

  workoutDoneInput.addEventListener('change', () => {
    workoutDetails.classList.toggle('hidden', !workoutDoneInput.checked);
  });

  onPeriodInput.addEventListener('change', () => {
    updatePeriodFieldUI(dailyDateInput.value);
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
    const totalMin = w?.duration ?? null;
    document.getElementById('workoutDurationHours').value = totalMin !== null ? Math.floor(totalMin / 60) : '';
    document.getElementById('workoutDurationMinutes').value = totalMin !== null ? totalMin % 60 : '';
    document.getElementById('workoutNotes').value = w?.notes ?? '';
    // A day with no saved entry yet inherits the previous day's period
    // state, so marking "on period" once carries forward automatically
    // instead of needing a fresh tap every day — the viewer only needs to
    // uncheck it on the day the period actually ends.
    onPeriodInput.checked = entry ? !!entry.onPeriod : periodCarriesInto(date);
    updatePeriodFieldUI(date);
    updateDailyGoalBadges();
    renderWeekCalendar();
  }

  function periodCarriesInto(date) {
    const prevDate = toDateStr(new Date(new Date(date + 'T00:00:00').getTime() - 86400000));
    return !!state.dailyLogs[prevDate]?.onPeriod;
  }

  // The period field only earns its place on the form when it's actually
  // relevant: no cycle logged yet (so she can start one), currently mid-
  // period, or the next period is expected soon — not on every ordinary day.
  function updatePeriodFieldUI(date) {
    const info = computeCycleInfo(date);
    // computeCycleInfo only knows about saved days, so a period still being
    // logged (checked here but not saved past today yet) can look "already
    // over" to it — onPeriodInput.checked is the ground truth for "currently
    // on period" and always keeps the field visible regardless.
    const relevant = !info || info.phase === 'menstrual' || info.daysUntilNextPeriod <= 3 || onPeriodInput.checked;
    const field = document.getElementById('onPeriodField');
    field.classList.toggle('hidden', !relevant);

    // info.cycleDay counts calendar days since the period's saved start
    // regardless of whether the in-between days were saved yet. Once a
    // full 7 days have passed while still checked, surface a pointed
    // "did it end?" prompt instead of the quiet everyday wording — a
    // fixed 7 days rather than the learned/overridden periodLen, so this
    // trigger stays predictable even as that average drifts over time.
    const PERIOD_OVERDUE_DAYS = 7;
    const overdue = !!(onPeriodInput.checked && info && info.cycleDay >= PERIOD_OVERDUE_DAYS);
    field.classList.toggle('period-overdue', overdue);

    const label = document.getElementById('onPeriodLabel');
    if (!onPeriodInput.checked) {
      label.textContent = '🩸 على الدورة اليوم؟';
    } else if (overdue) {
      label.textContent = `⚠️ مرّ ${info.cycleDay} أيام — هل انتهت دورتك؟ اضغطي هنا لإنهائها`;
    } else {
      label.textContent = '🩸 دورتك مستمرة — اضغطي هنا إذا انتهت اليوم';
    }
  }

  const AR_DAY_NAMES = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

  function renderWeekCalendar() {
    const container = document.getElementById('weekCalendar');
    const ws = weekStart(new Date());
    const selected = dailyDateInput.value;
    const today = todayStr();
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(ws);
      d.setDate(d.getDate() + i);
      const dStr = toDateStr(d);
      const done = !!state.dailyLogs[dStr]?.workout?.done;
      const cls = ['week-cal-day'];
      if (dStr === selected) cls.push('selected');
      if (dStr === today) cls.push('today');
      html += `<div class="${cls.join(' ')}" data-date="${dStr}">
        <span class="wcd-name">${AR_DAY_NAMES[i].slice(0, 2)}</span>
        <span class="wcd-num">${d.getDate()}</span>
        ${done ? '<span class="wcd-dot"></span>' : ''}
      </div>`;
    }
    container.innerHTML = html;
    container.querySelectorAll('[data-date]').forEach(el => {
      el.addEventListener('click', () => {
        dailyDateInput.value = el.dataset.date;
        loadDailyFormForDate();
      });
    });
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
          duration: readWorkoutDurationMinutes(),
          notes: document.getElementById('workoutNotes').value.trim(),
        },
        onPeriod: onPeriodInput.checked,
      };
      saveState();
      renderAll();
      showToast('تم حفظ يوم ' + formatDateAr(date) + '.');
    } catch (err) {
      console.error('Daily save failed:', err);
      showToast('⚠️ فشل الحفظ: ' + (err && err.message ? err.message : String(err)), 8000);
    }
  });

  function readWorkoutDurationMinutes() {
    const h = numOrNull(document.getElementById('workoutDurationHours').value);
    const m = numOrNull(document.getElementById('workoutDurationMinutes').value);
    if (h === null && m === null) return null;
    return (h || 0) * 60 + (m || 0);
  }

  function formatDuration(totalMin) {
    if (totalMin === null || totalMin === undefined) return null;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h && m) return `${h}س ${m}د`;
    if (h) return `${h}س`;
    return `${m}د`;
  }

  function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function editDailyLog(date) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'today'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-today'));
    dailyDateInput.value = date;
    loadDailyFormForDate();
    document.getElementById('dailyForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('عدّلي بيانات يوم ' + formatDateAr(date) + ' واحفظي.');
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

  function computeWeeklyStreak() {
    let streak = 0;
    let cursor = weekStart(new Date());
    const today = todayStr();
    for (let i = 0; i < 52; i++) {
      const we = new Date(cursor);
      we.setDate(we.getDate() + 6);
      const weekEnded = toDateStr(we) < today;
      const datesInWeek = Object.keys(state.dailyLogs).filter(d => {
        const dd = new Date(d + 'T00:00:00');
        return dd >= cursor && dd <= we;
      });
      const doneCount = datesInWeek.filter(d => state.dailyLogs[d].workout?.done).length;
      if (doneCount >= state.settings.weeklyWorkoutGoal) {
        streak++;
      } else if (i === 0 && !weekEnded) {
        // The current week is still in progress and hasn't hit the goal
        // yet — that's not a broken streak, it just hasn't been earned
        // (or lost) this week. Keep looking at completed weeks before it.
      } else {
        break;
      }
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() - 7);
    }
    return streak;
  }

  function arWeeksLabel(n) {
    if (n === 1) return 'أسبوع واحد';
    if (n === 2) return 'أسبوعين';
    return `${n} أسابيع`;
  }

  // Tiered milestone phrases: as the streak climbs past each threshold the
  // wording itself changes (not just the number), so every new personal
  // best feels like a fresh achievement instead of the same sentence again.
  const WEEK_STREAK_MILESTONES = [
    { min: 12, text: n => `🏆 إنجاز استثنائي — سلسلة ${arWeeksLabel(n)} متتالية بدون انقطاع!` },
    { min: 8,  text: n => `🌟 مذهلة! سلسلة ${arWeeksLabel(n)} متتالية` },
    { min: 4,  text: n => `💪 شهر كامل من الالتزام — سلسلة ${arWeeksLabel(n)} متتالية` },
    { min: 2,  text: n => `🔥 استمراريتك رائعة — سلسلة ${arWeeksLabel(n)} متتالية` },
    { min: 1,  text: n => `🔥 سلسلة ${arWeeksLabel(n)} متتالية` },
    { min: 0,  text: () => 'أكملي هدفك الأسبوعي لتبدئي سلسلتك 🔥' },
  ];
  function milestonePhrase(milestones, n) {
    return milestones.find(t => n >= t.min).text(n);
  }

  function renderWeeklyProgress() {
    const now = new Date();
    const dates = Object.keys(state.dailyLogs).filter(d => inSameWeek(d, now));
    const workoutDays = dates.filter(d => state.dailyLogs[d].workout?.done).length;
    const goal = state.settings.weeklyWorkoutGoal;
    const pct = Math.min(1, goal ? workoutDays / goal : 0);
    const weekStreak = computeWeeklyStreak();

    const r = 34, circumference = 2 * Math.PI * r;
    const offset = circumference * (1 - pct);
    const streakText = milestonePhrase(WEEK_STREAK_MILESTONES, weekStreak);

    const el = document.getElementById('weeklyWorkoutProgress');
    el.innerHTML = `
      <div class="streak-row">
        <div class="streak-ring-wrap">
          <svg viewBox="0 0 84 84">
            <circle cx="42" cy="42" r="${r}" class="ring-bg"/>
            <circle cx="42" cy="42" r="${r}" class="ring-fg" style="stroke-dasharray:${circumference};stroke-dashoffset:${offset}"/>
          </svg>
          <div class="streak-ring-center">${workoutDays}/${goal}</div>
        </div>
        <div class="streak-info">
          <div class="streak-flame">${streakText}</div>
          <div class="streak-sub">${workoutDays} من ${goal} أيام تمرين هذا الأسبوع</div>
        </div>
      </div>
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
      <div class="stat-box tile-1"><div class="stat-value">${stepsAvg ?? '—'}</div><div class="stat-label">متوسط الخطوات اليومي</div></div>
      <div class="stat-box tile-2"><div class="stat-value">${calAvg ?? '—'}</div><div class="stat-label">متوسط السعرات اليومي</div>${goalBadgeHtml(calAvgStatus, 'سعرة', state.settings.calorieGoal, true)}</div>
      <div class="stat-box tile-3"><div class="stat-value">${proteinAvg ?? '—'} جم</div><div class="stat-label">متوسط البروتين اليومي</div>${goalBadgeHtml(proteinAvgStatus, 'جم', state.settings.proteinGoal, true)}</div>
      <div class="stat-box tile-4"><div class="stat-value">${workoutDays}</div><div class="stat-label">أيام تمرين هذا الأسبوع</div></div>
    `;
  }

  // Simple minimal line chart (one point per week overlapping the current
  // calendar month) showing workout days logged that week — a light
  // sparkline rather than a heavy bar grid.
  // Month calendar grid with workout days circled — the same idea as the
  // "streak calendar" screens common in fitness apps, in the app's own
  // warm palette instead of a line chart. Each displayed row is also a
  // full Sunday-Saturday week, so a row that hit the weekly workout goal
  // gets a highlighted band + flame — a weekly streak marker laid over
  // the monthly view.
  function renderMonthlyProgressChart() {
    const el = document.getElementById('monthlyProgressChart');
    const now = new Date();
    const year = now.getFullYear(), month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
    const today = todayStr();
    const goal = state.settings.weeklyWorkoutGoal || 4;
    const streak = computeWeeklyStreak();

    const header = AR_DAY_NAMES.map(n => `<div class="month-cal-dow">${n.slice(0, 2)}</div>`).join('');

    const flat = [];
    for (let i = 0; i < firstWeekday; i++) flat.push(null);
    for (let d = 1; d <= daysInMonth; d++) flat.push(d);
    while (flat.length % 7 !== 0) flat.push(null);

    let rows = '';
    for (let r = 0; r < flat.length; r += 7) {
      const rowDays = flat.slice(r, r + 7);
      const workoutDays = rowDays.filter(d => d && state.dailyLogs[toDateStr(new Date(year, month, d))]?.workout?.done).length;
      const rowGoalMet = rowDays.some(d => d !== null) && workoutDays >= goal;
      const cells = rowDays.map(d => {
        if (d === null) return '<div class="month-cal-cell empty"></div>';
        const ds = toDateStr(new Date(year, month, d));
        const done = !!state.dailyLogs[ds]?.workout?.done;
        const cls = ['month-cal-cell'];
        if (done) cls.push('done');
        if (ds === today) cls.push('today');
        return `<div class="${cls.join(' ')}"><span>${d}</span></div>`;
      }).join('');
      rows += `
        <div class="month-cal-row-wrap">
          <span class="month-cal-row-flame">${rowGoalMet ? '🔥' : ''}</span>
          <div class="month-cal-row${rowGoalMet ? ' week-streak' : ''}">${cells}</div>
        </div>
      `;
    }

    // Short label so the flame rows read as "these weeks are the streak"
    // without a full sentence.
    const streakNote = streak > 0
      ? `🔥 ${arWeeksLabel(streak)} التزام`
      : 'ابدئي سلسلتك 🔥';

    el.innerHTML = `
      <div class="month-cal-streak-note">${streakNote}</div>
      <div class="month-cal-row-wrap month-cal-header-wrap">
        <span class="month-cal-row-flame"></span>
        <div class="month-cal-row month-cal-dow-row">${header}</div>
      </div>
      ${rows}
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
      const details = w?.done ? [w.type, formatDuration(w.duration), w.notes].filter(Boolean).join(' · ') : '—';
      return `<tr>
        <td>${formatDateAr(d)}</td>
        <td>${e.steps ?? '—'}</td>
        <td>${calorieCellHtml(e.calories)}</td>
        <td>${proteinCellHtml(e.protein)}</td>
        <td>${w?.done ? '✅' : '—'}</td>
        <td>${details}</td>
        <td class="row-actions">
          <button class="btn-icon-small" data-edit="${d}" title="تعديل">✏️</button>
          <button class="btn-icon-small" data-del="${d}" title="حذف">🗑️</button>
        </td>
      </tr>`;
    }).join('') || `<tr><td colspan="7" class="muted">لا توجد بيانات بعد</td></tr>`;
    attachRowHandlers(tbody);
  }

  function rowHtml(d) {
    const e = state.dailyLogs[d];
    return `<tr>
      <td>${formatDateAr(d)}</td>
      <td>${e.steps ?? '—'}</td>
      <td>${calorieCellHtml(e.calories)}</td>
      <td>${proteinCellHtml(e.protein)}</td>
      <td>${e.workout?.done ? '✅' : '—'}</td>
      <td class="row-actions">
        <button class="btn-icon-small" data-edit="${d}" title="تعديل">✏️</button>
        <button class="btn-icon-small" data-del="${d}" title="حذف">🗑️</button>
      </td>
    </tr>`;
  }

  function attachRowHandlers(tbody) {
    tbody.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteDailyLog(btn.dataset.del));
    });
    tbody.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => editDailyLog(btn.dataset.edit));
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

  let editingMeasurementId = null;

  // Flags a measurement that jumped an unusual amount from the last one on
  // record, so a typo doesn't quietly distort the chart. Excludes `excludeId`
  // so editing an entry doesn't compare it against itself.
  function findSuspiciousFields(newEntry, excludeId) {
    const prior = [...state.measurements]
      .filter(m => m.id !== excludeId && m.date <= newEntry.date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .pop();
    if (!prior) return [];

    const cycleInfo = computeCycleInfo(newEntry.date);
    const premenstrualWindow = !!cycleInfo && cycleInfo.phase === 'luteal' &&
      cycleInfo.daysUntilNextPeriod >= 1 && cycleInfo.daysUntilNextPeriod <= 7;

    const suspicious = [];
    MEASURE_FIELDS.forEach(f => {
      const oldV = prior[f.key], newV = newEntry[f.key];
      if (oldV === null || oldV === undefined || newV === null || newV === undefined || oldV === 0) return;
      const relChange = (newV - oldV) / oldV;
      if (Math.abs(relChange) <= 0.15) return;
      const possiblyBloat = premenstrualWindow && BLOAT_PRONE_FIELDS.includes(f.key) && relChange > 0 && relChange <= 0.25;
      suspicious.push({ label: f.label, unit: f.unit, oldV, newV, possiblyBloat });
    });
    return suspicious;
  }

  function buildSuspiciousMessage(suspicious) {
    const allBloat = suspicious.every(s => s.possiblyBloat);
    const lines = suspicious.map(s => {
      const arrow = s.newV > s.oldV ? '↑' : '↓';
      const note = s.possiblyBloat ? ' (قد يكون طبيعيًا بسبب اقتراب الدورة الشهرية)' : '';
      return `• ${s.label}: ${s.oldV} ${arrow} ${s.newV} ${s.unit}${note}`;
    }).join('\n');
    const heading = allBloat
      ? '💧 بعض القياسات ارتفعت أكثر من المعتاد، وهذا شائع في الأيام التي تسبق الدورة الشهرية بسبب احتباس الماء:'
      : '⚠️ بعض القياسات تبدو مختلفة كثيرًا عن آخر قياس مسجّل، وقد تكون خطأ بالإدخال:';
    return `${heading}\n\n${lines}\n\nتأكّدي من صحة الأرقام — احفظي إن كانت صحيحة، أو ألغي لإعادة القياس.`;
  }

  function readMeasureFormValues() {
    const values = {};
    MEASURE_FIELDS.forEach(f => {
      const input = document.getElementById(`m_${f.key}`);
      values[f.key] = input ? numOrNull(input.value) : null;
    });
    return values;
  }

  function clearMeasureForm() {
    MEASURE_FIELDS.forEach(f => {
      const input = document.getElementById(`m_${f.key}`);
      if (input) input.value = '';
    });
    document.getElementById('measureDate').value = todayStr();
  }

  function startEditMeasurement(id) {
    const m = state.measurements.find(x => x.id === id);
    if (!m) return;
    editingMeasurementId = id;
    document.getElementById('measureDate').value = m.date;
    MEASURE_FIELDS.forEach(f => {
      const input = document.getElementById(`m_${f.key}`);
      if (input) input.value = m[f.key] ?? '';
    });
    document.getElementById('measureSaveBtn').textContent = '💾 حفظ التعديلات';
    document.getElementById('measureCancelEditBtn').classList.remove('hidden');
    document.getElementById('measureForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('وضع التعديل مفعّل — عدّلي القيم واحفظي.');
  }

  function cancelEditMeasurement() {
    editingMeasurementId = null;
    document.getElementById('measureSaveBtn').textContent = 'حفظ القياسات';
    document.getElementById('measureCancelEditBtn').classList.add('hidden');
    clearMeasureForm();
  }

  document.getElementById('measureCancelEditBtn').addEventListener('click', cancelEditMeasurement);

  document.getElementById('measureSaveBtn').addEventListener('click', () => {
    try {
      const date = document.getElementById('measureDate').value;
      if (!date) { showToast('اختر تاريخ القياس أولًا.'); return; }
      const values = readMeasureFormValues();

      if (editingMeasurementId) {
        const existing = state.measurements.find(m => m.id === editingMeasurementId);
        if (!existing) { cancelEditMeasurement(); showToast('تعذّر إيجاد القياس، حاولي من جديد.'); return; }
        const candidate = { ...existing, date, ...values };
        const suspicious = findSuspiciousFields(candidate, editingMeasurementId);
        const proceed = () => {
          Object.assign(existing, { date, ...values });
          state.measurements.sort((a, b) => a.date.localeCompare(b.date));
          saveState();
          cancelEditMeasurement();
          renderAll();
          showToast('تم تحديث القياس.');
        };
        if (suspicious.length) showConfirm(buildSuspiciousMessage(suspicious), proceed);
        else proceed();
        return;
      }

      const entry = { id: `${date}-${Date.now()}`, date, ...values };
      const suspicious = findSuspiciousFields(entry);
      const proceed = () => {
        clearMeasureForm();
        state.measurements.push(entry);
        state.measurements.sort((a, b) => a.date.localeCompare(b.date));
        saveState();
        renderAll();
        showToast('تم حفظ القياسات.');
      };
      if (suspicious.length) showConfirm(buildSuspiciousMessage(suspicious), proceed);
      else proceed();
    } catch (err) {
      console.error('Measurement save failed:', err);
      showToast('⚠️ فشل الحفظ: ' + (err && err.message ? err.message : String(err)), 8000);
    }
  });

  function deleteMeasurement(id) {
    showConfirm('حذف هذا القياس؟', () => {
      state.measurements = state.measurements.filter(m => m.id !== id);
      if (id === editingMeasurementId) cancelEditMeasurement();
      saveState();
      renderAll();
      showToast('تم الحذف.');
    });
  }

  let measureSortKey = 'date';
  let measureSortDir = 'desc';

  function renderMeasureTable() {
    const head = document.getElementById('measureTableHead');
    const arrowFor = key => measureSortKey === key ? (measureSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    head.innerHTML = `<th class="sortable" data-sort="date">التاريخ${arrowFor('date')}</th>` +
      MEASURE_FIELDS.map(f => `<th class="sortable" data-sort="${f.key}">${f.label}${arrowFor(f.key)}</th>`).join('') +
      `<th></th>`;
    head.querySelectorAll('[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (measureSortKey === key) {
          measureSortDir = measureSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          measureSortKey = key;
          measureSortDir = key === 'date' ? 'desc' : 'asc';
        }
        renderMeasureTable();
      });
    });

    const tbody = document.querySelector('#measureTable tbody');
    const rows = [...state.measurements].sort((a, b) => {
      const av = a[measureSortKey], bv = b[measureSortKey];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return measureSortDir === 'asc' ? -1 : 1;
      if (av > bv) return measureSortDir === 'asc' ? 1 : -1;
      return 0;
    });
    tbody.innerHTML = rows.map(m => `
      <tr>
        <td>${formatDateAr(m.date)}</td>
        ${MEASURE_FIELDS.map(f => `<td>${m[f.key] ?? '—'}</td>`).join('')}
        <td class="row-actions">
          <button class="btn-icon-small" data-edit="${m.id}" title="تعديل">✏️</button>
          <button class="btn-icon-small" data-del="${m.id}" title="حذف">🗑️</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="${MEASURE_FIELDS.length + 2}" class="muted">لا توجد قياسات بعد</td></tr>`;

    tbody.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteMeasurement(btn.dataset.del));
    });
    tbody.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => startEditMeasurement(btn.dataset.edit));
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

  /* ---------- measurements overview (all fields at a glance) ---------- */

  // A minimal sparkline path for one field's whole history, scaled to its
  // own min/max — not meant to carry an axis, just the shape of the trend.
  function buildSparklinePath(values, w, h, pad) {
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) { min -= 1; max += 1; }
    const stepX = (w - pad * 2) / (values.length - 1);
    const yFor = v => pad + (h - pad * 2) - ((v - min) / (max - min)) * (h - pad * 2);
    return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * stepX).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
  }

  function renderMeasureOverview() {
    const el = document.getElementById('measureOverviewGrid');
    const emptyMsg = document.getElementById('chartEmptyMsg');
    if (state.measurements.length === 0) {
      el.innerHTML = '';
      emptyMsg.classList.remove('hidden');
      return;
    }
    emptyMsg.classList.add('hidden');

    const sorted = [...state.measurements].sort((a, b) => a.date.localeCompare(b.date));

    el.innerHTML = MEASURE_FIELDS.map(f => {
      const points = sorted.filter(m => m[f.key] !== null && m[f.key] !== undefined);
      if (points.length === 0) {
        return `
          <div class="mo-card">
            <div class="mo-header"><span class="mo-label">${f.label}</span></div>
            <p class="muted mo-empty">لا يوجد قياس بعد</p>
          </div>
        `;
      }

      const values = points.map(p => p[f.key]);
      const latest = values[values.length - 1];
      const first = values[0];
      const diff = round1(latest - first);
      const goal = state.settings.goalDirections[f.key];
      let deltaCls = 'flat';
      if (diff !== 0 && goal) {
        const improved = (goal === 'down' && diff < 0) || (goal === 'up' && diff > 0);
        deltaCls = improved ? 'good' : 'bad';
      }
      const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '→';

      const sparkline = points.length >= 2
        ? `<svg viewBox="0 0 100 32" class="mo-spark mo-spark-${deltaCls}" preserveAspectRatio="none">
             <path d="${buildSparklinePath(values, 100, 32, 4)}"/>
           </svg>`
        : `<p class="muted mo-empty">قياس واحد فقط لحد الآن</p>`;

      const deltaLine = points.length >= 2
        ? `<div class="mo-delta ${deltaCls}">${arrow} ${diff > 0 ? '+' : ''}${diff} ${f.unit} منذ أول قياس</div>`
        : '';

      return `
        <div class="mo-card">
          <div class="mo-header">
            <span class="mo-label">${f.label}</span>
            <span class="mo-latest">${latest} ${f.unit}</span>
          </div>
          ${sparkline}
          ${deltaLine}
        </div>
      `;
    }).join('');
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
    document.getElementById('periodLenInput').value = state.settings.periodLenOverride ?? '';
    document.getElementById('cycleLenInput').value = state.settings.cycleLenOverride ?? '';
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
    const periodLenVal = numOrNull(document.getElementById('periodLenInput').value);
    state.settings.periodLenOverride = periodLenVal ? Math.min(15, Math.max(2, periodLenVal)) : null;
    const cycleLenVal = numOrNull(document.getElementById('cycleLenInput').value);
    state.settings.cycleLenOverride = cycleLenVal ? Math.min(60, Math.max(15, cycleLenVal)) : null;
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
              periodLenOverride: parsed.settings?.periodLenOverride ?? base.settings.periodLenOverride,
              cycleLenOverride: parsed.settings?.cycleLenOverride ?? base.settings.cycleLenOverride,
            },
            seedFlags: { ...base.seedFlags, ...(parsed.seedFlags || {}) },
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
  const TIPS_BUTTON_IDS = ['tipsTodayBtn', 'tipsMeasureBtn', 'tipsHistoryBtn'];

  const ASSISTANT_RULES =
    'أنت مساعد صحي ولياقة بدنية شخصي داخل تطبيق متابعة يستخدمه شخص واحد. ' +
    'أمامك بيانات المستخدم الفعلية بصيغة JSON (آخر 14 يومًا من سجله اليومي، وآخر قياساته، وأهدافه، ومرحلة دورته الشهرية الحالية إن وُجدت في currentCyclePhase). ' +
    'اعتمد فقط على هذه الأرقام — لا تخترع بيانات غير موجودة، ولا تقدّم نصائح طبية عامة لا علاقة لها بالأرقام المعطاة. ' +
    'إذا توفّرت currentCyclePhase، خذها بعين الاعتبار عند الحديث عن الطاقة أو الأداء أو الشهية (مثلًا: طاقة أقل بمرحلة الدورة، أو رغبة غذائية أعلى بالمرحلة الأصفرية) دون المبالغة أو تقديم تشخيص طبي. ' +
    'إن سُئلت عن شيء خارج بيانات اللياقة/الصحة المتاحة هنا، وضّح بأدب أنك مخصص لتحليل بيانات هذا التطبيق فقط. ' +
    'أجب بالعربية الفصحى المبسطة، بإيجاز ووضوح.';

  function buildAssistantContext() {
    const dates = Object.keys(state.dailyLogs).sort().slice(-14);
    const dailyLogsLast14Days = dates.map(d => ({ date: d, ...state.dailyLogs[d] }));
    const recentMeasurements = [...state.measurements]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-6);
    const cycleInfo = computeCycleInfo(todayStr());
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
      currentCyclePhase: cycleInfo ? { phase: cycleInfo.phase, cycleDay: cycleInfo.cycleDay, daysUntilNextPeriod: cycleInfo.daysUntilNextPeriod } : null,
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
    TIPS_BUTTON_IDS.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !available;
    });
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

  // One "professional tips" block per tab, all reading the FULL data (not
  // just that tab's), each focused on what that tab is about.
  const TIPS_SECTIONS = [
    {
      btnId: 'tipsTodayBtn',
      outId: 'tipsTodayOutput',
      focus: 'ركّزي في نصيحتك على: مدى انتظام تسجيله اليومي، واتساق التمرين والسعرات والبروتين مقابل الهدف خلال آخر الأيام المسجّلة، وأي ملاحظة تتعلق بمرحلة الدورة الحالية إن وُجدت.',
    },
    {
      btnId: 'tipsMeasureBtn',
      outId: 'tipsMeasureOutput',
      focus: 'ركّزي في نصيحتك على: اتجاه التغيّر في قياسات الجسم عبر الوقت (تحسّن أو تراجع) مقارنة بهدف كل قياس، وأي قياس يستحق انتباهًا أكبر.',
    },
    {
      btnId: 'tipsHistoryBtn',
      outId: 'tipsHistoryOutput',
      focus: 'لخّصي أداءه العام على المدى الأطول: الانتظام بالتسجيل، ونمط الالتزام بالتمرين والسعرات والبروتين عبر الأسابيع، وأي اتجاه عام يستحق الانتباه.',
    },
  ];

  TIPS_SECTIONS.forEach(({ btnId, outId, focus }) => {
    const btn = document.getElementById(btnId);
    const out = document.getElementById(outId);
    if (!btn || !out) return;
    btn.addEventListener('click', async () => {
      if (!sampleCap) { showToast('المساعد الذكي غير متاح في هذا العرض.'); return; }
      btn.disabled = true;
      out.innerHTML = '<span class="thinking">🤔 يفكر...</span>';
      try {
        const context = buildAssistantContext();
        const prompt =
          ASSISTANT_RULES +
          '\n\n' + focus +
          ' اكتبي 3 إلى 4 نصائح عملية قصيرة (سطر أو سطرين لكل واحدة)، كل نصيحة تبدأ برمز تعبيري مناسب، سطر مستقل لكل نصيحة، بدون مقدمة أو خاتمة.' +
          '\n\nبيانات المستخدم:\n' + JSON.stringify(context);
        const { text } = await sampleCap(prompt, {
          modelTier: 'default',
          onText: ({ text }) => { out.textContent = text; },
        });
        out.textContent = text;
      } catch (err) {
        out.textContent = assistantErrorMessage(err);
      } finally {
        btn.disabled = !sampleCap;
      }
    });
  });

  /* ============================ RENDER ALL ============================ */

  function renderAll() {
    loadDailyFormForDate();
    renderCycleCard();
    renderWeeklyProgress();
    renderMonthlyProgressChart();
    renderRecentDailyTable();
    renderFullDailyTable();
    renderMeasureTable();
    renderDeltaSummary();
    renderMeasureOverview();
  }

  renderAll();
  initCloudSync();
  initAssistant();
})();
