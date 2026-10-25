(() => {
  'use strict';

  /* ============================ DATA MODEL ============================ */

  const STORAGE_KEY = 'fitnessTracker.v1';

  const MEASURE_FIELDS = [
    { key: 'weight',     label: 'الوزن',            unit: 'كجم', defaultGoal: 'down' },
    { key: 'neck',       label: 'الرقبة',            unit: 'سم',  defaultGoal: 'down' },
    { key: 'chest',      label: 'الصدر',             unit: 'سم',  defaultGoal: 'down' },
    { key: 'waist',      label: 'الخصر',             unit: 'سم',  defaultGoal: 'down' },
    { key: 'lowerBelly', label: 'أسفل البطن',        unit: 'سم',  defaultGoal: 'down' },
    { key: 'hips',       label: 'محيط الأرداف',      unit: 'سم',  defaultGoal: 'down' },
    { key: 'thigh',      label: 'الفخذ',             unit: 'سم',  defaultGoal: 'up'   },
    { key: 'arm',        label: 'الزند',             unit: 'سم',  defaultGoal: 'up'   },
    { key: 'calves',     label: 'البطات',            unit: 'سم',  defaultGoal: 'up'   },
  ];

  const INBODY_FIELDS = [
    { key: 'weight',             label: 'الوزن',              unit: 'كجم',   defaultGoal: 'down' },
    { key: 'skeletalMuscleMass', label: 'الكتلة العضلية',     unit: 'كجم',   defaultGoal: 'up'   },
    { key: 'bodyFatMass',        label: 'كتلة الدهون',        unit: 'كجم',   defaultGoal: 'down' },
    { key: 'bodyFatPct',         label: 'نسبة الدهون',        unit: '%',     defaultGoal: 'down' },
    { key: 'bmi',                label: 'مؤشر كتلة الجسم',    unit: '',      defaultGoal: 'down' },
    { key: 'visceralFatLevel',   label: 'الدهون الحشوية',     unit: '',      defaultGoal: 'down' },
    { key: 'bmr',                label: 'معدل الحرق الأساسي', unit: 'سعرة',  defaultGoal: 'up'   },
    { key: 'totalBodyWater',     label: 'ماء الجسم',          unit: 'لتر',   defaultGoal: 'up'   },
  ];

  // InBody's segmental lean/fat analysis reports each body region as a
  // percentage of its own "normal" range (not an absolute mass) — e.g. 105%
  // means 5% above the standard for that region. These stay separate from
  // INBODY_FIELDS (which drives the plain measurement form/table) because
  // they get their own body-shaped distribution view, colored by trend
  // direction (fat down / muscle up is an improvement) rather than the
  // plain up/down goal-direction table.
  const SEGMENTAL_REGIONS = [
    { key: 'rightArm', label: 'الذراع الأيمن' },
    { key: 'leftArm', label: 'الذراع الأيسر' },
    { key: 'trunk', label: 'الجذع' },
    { key: 'rightLeg', label: 'الرجل اليمنى' },
    { key: 'leftLeg', label: 'الرجل اليسرى' },
  ];
  const SEGMENTAL_FIELDS = [
    ...SEGMENTAL_REGIONS.map(r => ({ key: `${r.key}FatPct`, region: r.key, regionLabel: r.label, metric: 'fat', metricLabel: 'الدهون', unit: '%' })),
    ...SEGMENTAL_REGIONS.map(r => ({ key: `${r.key}MusclePct`, region: r.key, regionLabel: r.label, metric: 'muscle', metricLabel: 'العضلات', unit: '%' })),
  ];
  // The band InBody's own segmental analysis treats as "normal" for a
  // region (percentage of the standard reference for that region/metric).
  const SEGMENTAL_NORMAL_LOW = 90;
  const SEGMENTAL_NORMAL_HIGH = 110;
  // All InBody-report fields the entry/edit form and PDF extraction handle.
  const INBODY_ALL_FIELDS = [...INBODY_FIELDS, ...SEGMENTAL_FIELDS];

  // MEASURE_FIELDS and INBODY_FIELDS both have a 'weight' entry (same real-world
  // quantity, one goal direction) — de-duplicated by key for anything that lists
  // every trackable field once, like the settings' goal-direction picker.
  const ALL_GOAL_FIELDS = [...MEASURE_FIELDS];
  INBODY_FIELDS.forEach(f => {
    if (!ALL_GOAL_FIELDS.some(x => x.key === f.key)) ALL_GOAL_FIELDS.push(f);
  });

  function defaultState() {
    return {
      dailyLogs: {},      // { 'YYYY-MM-DD': { steps, calories, protein, workout: {done, type, duration, notes} } }
      measurements: [],   // [{ id, date, weight, chest, waist, lowerBelly, hips, thigh, arm, calves }]
      inbody: [],         // [{ id, date, weight, skeletalMuscleMass, bodyFatMass, bodyFatPct, bmi, visceralFatLevel, bmr, totalBodyWater }]
      settings: {
        weeklyWorkoutGoal: 4,
        calorieGoal: 1810,
        // Protein floor: any amount at/above this is fine (see
        // computeGoalStatus's overIsGood) — only falling under it matters,
        // so no cushion margin on top of the floor itself.
        proteinGoal: 100,
        calorieMarginPct: 5,
        proteinMarginPct: 0,
        goalDirections: Object.fromEntries(ALL_GOAL_FIELDS.map(f => [f.key, f.defaultGoal])),
        // Known period/cycle length from the user's own tracking history —
        // used instead of the computed average until enough logged periods
        // build up their own average (see computeCycleInfo).
        periodLenOverride: 7,
        cycleLenOverride: 26,
        // Marks the start of a new training program/schedule (e.g. with a
        // trainer) so days from this date on can be highlighted in the log.
        programStartDate: null,
      },
      // One-time data-seeding markers so a migration only ever runs once,
      // even after it syncs to the cloud and reloads elsewhere.
      seedFlags: {},
    };
  }

  // Segmental tracking used to be 3 regions (upper/trunk/lower, each an
  // average of its two limbs) before it became InBody's real 5-segment
  // model (right/left arm, trunk, right/left leg). Readings saved under the
  // old keys would otherwise just go blank for arms/legs — fill both sides
  // from the old averaged value instead (an approximation, but better than
  // losing the reading; re-uploading that report gets the real split).
  function migrateSegmentalFields(entry) {
    const pairs = [
      ['upperFatPct', 'rightArmFatPct', 'leftArmFatPct'],
      ['lowerFatPct', 'rightLegFatPct', 'leftLegFatPct'],
      ['upperMusclePct', 'rightArmMusclePct', 'leftArmMusclePct'],
      ['lowerMusclePct', 'rightLegMusclePct', 'leftLegMusclePct'],
    ];
    pairs.forEach(([oldKey, rightKey, leftKey]) => {
      const oldVal = entry[oldKey];
      if (oldVal === null || oldVal === undefined) return;
      if (entry[rightKey] === undefined || entry[rightKey] === null) entry[rightKey] = oldVal;
      if (entry[leftKey] === undefined || entry[leftKey] === null) entry[leftKey] = oldVal;
    });
    return entry;
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
      inbody: (parsed.inbody || base.inbody).map(migrateSegmentalFields),
      settings: {
        weeklyWorkoutGoal: parsed.settings?.weeklyWorkoutGoal ?? base.settings.weeklyWorkoutGoal,
        calorieGoal: parsed.settings?.calorieGoal ?? base.settings.calorieGoal,
        proteinGoal: parsed.settings?.proteinGoal ?? base.settings.proteinGoal,
        calorieMarginPct: parsed.settings?.calorieMarginPct ?? base.settings.calorieMarginPct,
        proteinMarginPct: parsed.settings?.proteinMarginPct ?? base.settings.proteinMarginPct,
        goalDirections: { ...base.settings.goalDirections, ...(parsed.settings?.goalDirections || {}) },
        periodLenOverride: parsed.settings?.periodLenOverride ?? base.settings.periodLenOverride,
        cycleLenOverride: parsed.settings?.cycleLenOverride ?? base.settings.cycleLenOverride,
        programStartDate: parsed.settings?.programStartDate ?? base.settings.programStartDate,
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

  // Each list below is ordered early → late within that phase (not random
  // variants) — pickByProgress() picks the entry matching how far the
  // viewer actually is into the current phase, so the text tracks real
  // cycle-day progress instead of just alternating.
  const CYCLE_PHASES = {
    menstrual: {
      icon: '🩸', label: 'الدورة الشهرية',
      tips: [
        'قد ينخفض مستوى الطاقة هذه الأيام — خففي شدة التمرين حسب راحتك، واهتمي بالراحة والبروتين.',
        'مع تقدّم أيام الدورة تبدأ الطاقة بالتحسن تدريجيًا — زيدي النشاط بالتدريج حسب راحتك.',
      ],
    },
    follicular: {
      icon: '🌱', label: 'المرحلة الجريبية',
      tips: [
        'الطاقة ترتفع تدريجيًا — وقت مناسب لبدء زيادة شدة التمارين تدريجيًا.',
        'التركيز والحافز والطاقة تقترب من ذروتها استعدادًا للإباضة — استغليها لتخطيط أسبوعك الرياضي.',
      ],
    },
    ovulation: {
      icon: '🥚', label: 'الإباضة',
      tips: [
        'عادة ما تكون ذروة الطاقة والأداء البدني — وقت جيد للتمارين عالية الشدة إن رغبتِ.',
        'قوتك وتحملك لا يزالان مرتفعين — انتبهي فقط لأي انزعاج خفيف حول هذه الأيام.',
      ],
    },
    luteal: {
      icon: '🌗', label: 'المرحلة الأصفرية',
      tips: [
        'الطاقة لا تزال جيدة بأول هذه المرحلة — استمري ببرنامجك المعتاد.',
        'قد يزيد الشعور بالتعب أو الرغبة الغذائية قرب نهاية المرحلة — راقبي جسمك وعدّلي حسب حاجتك.',
      ],
    },
  };

  // How far into the current phase today's cycleDay falls (0 = just
  // started, 1 = about to move to the next phase).
  function phaseBounds(info) {
    switch (info.phase) {
      case 'menstrual': return { start: 1, end: info.periodLen };
      case 'follicular': return { start: info.periodLen + 1, end: info.ovulationDay - 2 };
      case 'ovulation': return { start: info.ovulationDay - 1, end: info.ovulationDay + 1 };
      case 'luteal': return { start: info.ovulationDay + 2, end: info.cycleLen };
      default: return { start: 0, end: 1 };
    }
  }
  function pickByProgress(list, info) {
    const { start, end } = phaseBounds(info);
    const progress = end > start ? (info.cycleDay - start) / (end - start) : 0;
    const idx = Math.min(list.length - 1, Math.max(0, Math.floor(progress * list.length)));
    return list[idx];
  }

  // What to typically expect this phase, across four practical areas —
  // general patterns, not medical advice, and every body differs.
  const CYCLE_PHASE_EXPECT = {
    menstrual: {
      body: [
        'شد أسفل البطن وربما ألم أسفل الظهر، خصوصًا بالأيام الأولى.',
        'الانتفاخ والتقلصات عادة يخفّان تدريجيًا كل ما اقتربتِ من نهاية الدورة.',
      ],
      appetite: [
        'الشهية غالبًا طبيعية، وقد تزيد قليلًا في اليوم الأول أو الثاني.',
        'الشهية تميل للاستقرار كل ما تقدّمتِ بأيام الدورة.',
      ],
      intensity: [
        'تحمّل شدة التمرين ينخفض — قلّلي الحمل حسب راحتك، ولا بأس بالراحة.',
        'طاقتك تبدأ بالتحسن تدريجيًا قرب نهاية الدورة — يمكنك زيادة النشاط بالتدريج.',
      ],
      sugar: [
        'الرغبة بالسكريات خفيفة إلى متوسطة عادة.',
        'الرغبة بالسكريات عادة تهدأ كل ما اقتربتِ من نهاية الدورة.',
      ],
    },
    follicular: {
      body: [
        'الانتفاخ يخف بوضوح، والجسم يبدأ يشعر بخفة أكبر.',
        'بحلول نهاية هذه المرحلة يصل النشاط والحيوية إلى أعلى مستوياتهما استعدادًا للإباضة.',
      ],
      appetite: [
        'الشهية معتدلة ومستقرة نسبيًا.',
        'قد تلاحظين انخفاضًا طفيفًا بالشهية كل ما اقتربتِ من الإباضة.',
      ],
      intensity: [
        'تحمّل شدة التمرين يتحسن تدريجيًا — ابدئي بزيادة بسيطة بالحمل.',
        'القوة والتحمل يقتربان من ذروتهما — وقت جيد لزيادة الشدة أكثر.',
      ],
      sugar: [
        'الرغبة بالسكريات منخفضة نسبيًا.',
        'شهيتك للسكريات عادة هادئة كل ما اقتربتِ من الإباضة.',
      ],
    },
    ovulation: {
      body: [
        'الطاقة والحيوية ترتفعان بقوة مع بداية نافذة الإباضة.',
        'قد يظهر انتفاخ بسيط جدًا أو انزعاج خفيف جانبي مع اقتراب نهاية الإباضة — طبيعي وعادة يزول بسرعة.',
      ],
      appetite: [
        'الشهية عادة في أدنى مستوياتها مع بداية الإباضة.',
        'الشهية تبقى معتدلة مع اقتراب نهاية هذه المرحلة القصيرة.',
      ],
      intensity: [
        'تحمّل شدة التمرين يبدأ بالوصول لذروته — وقت ممتاز للتمارين عالية الكثافة.',
        'قوتك وتحملك في أعلى مستوياتهما — استغلّي الأيام الأخيرة من هذه المرحلة.',
      ],
      sugar: [
        'الرغبة بالسكريات منخفضة مع بداية الإباضة.',
        'شهيتك للحلويات تبقى هادئة حتى نهاية هذه المرحلة.',
      ],
    },
    luteal: {
      body: [
        'لا تغيّرات ملحوظة غالبًا بأول هذه المرحلة.',
        'انتفاخ وحساسية بالثدي واردة، وزيادة طفيفة بالوزن قرب نهاية المرحلة بسبب احتباس الماء.',
      ],
      appetite: [
        'الشهية تبدأ بالارتفاع تدريجيًا مع بداية هذه المرحلة.',
        'الشهية ترتفع أكثر بالأسبوع الأخير قبل الدورة — من أعراض ما قبل الدورة الشائعة.',
      ],
      intensity: [
        'تحمّل شدة التمرين لا يزال جيدًا بأول المرحلة الأصفرية.',
        'تحمّل شدة التمرين يقل تدريجيًا قرب نهاية المرحلة — استمعي لجسمك وخففي إذا احتجتِ.',
      ],
      sugar: [
        'الرغبة بالسكريات تبدأ بالارتفاع تدريجيًا.',
        'الرغبة بالسكريات والكربوهيدرات ترتفع بشكل ملحوظ قرب الدورة (من أعراض ما قبل الدورة الشائعة).',
      ],
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
    const phaseTip = pickByProgress(phaseInfo.tips, info);
    const expect = CYCLE_PHASE_EXPECT[info.phase];
    const expectRows = CYCLE_EXPECT_ROWS.map(r => `
      <div class="cycle-expect-row">
        <span class="cycle-expect-icon">${r.icon}</span>
        <div class="cycle-expect-text">
          <span class="cycle-expect-label">${r.label}</span>
          <span class="cycle-expect-desc">${pickByProgress(expect[r.key], info)}</span>
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
      <div class="cycle-phase-line">
        <span class="cycle-phase-icon">${phaseInfo.icon}</span>
        <span><strong>${phaseInfo.label}</strong> — ${phaseTip}</span>
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

  function computeGoalStatus(value, goal, marginPct, overIsGood) {
    if (value === null || value === undefined || !goal) return null;
    const margin = goal * (marginPct / 100);
    const diff = round1(value - goal);
    if (diff === 0) return { state: 'exact', diff };
    if (value > goal + margin) return { state: overIsGood ? 'overOk' : 'over', diff };
    if (value < goal - margin) return { state: 'under', diff };
    return { state: 'met', diff };
  }

  const GOAL_STATUS_CONFIG = {
    exact:  { icon: '🎯', cls: 'good', text: goal => `بالضبط على الهدف (${goal})` },
    met:    { icon: '✅', cls: 'good', text: () => 'ضمن الهدف' },
    // Protein above goal isn't flagged as a problem — only a real shortfall is.
    overOk: { icon: '✅', cls: 'good', text: (goal, diff, unit) => `فوق الهدف بـ ${round1(Math.abs(diff))} ${unit}` },
    over:   { icon: '⬆️', cls: 'bad', text: (goal, diff, unit) => `فوق الهدف بـ ${round1(Math.abs(diff))} ${unit}` },
    under:  { icon: '⬇️', cls: 'bad', text: (goal, diff, unit) => `أقل من الهدف بـ ${round1(Math.abs(diff))} ${unit}` },
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
      // Sparkline charts are sized to their card's real rendered width, which
      // is 0 while the tab is hidden — re-measure now that it's visible.
      if (btn.dataset.tab === 'measurements') renderMeasureOverview();
      if (btn.dataset.tab === 'inbody') { renderInbodyOverview(); renderSegmentalDistribution(); }
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
    // The whole row (checkbox + descriptive text) is one clickable <label>,
    // so a stray tap on the text itself — not just the box — toggles it.
    // Unchecking silently ends period tracking from today on, so confirm
    // before accepting that instead of applying it immediately.
    if (!onPeriodInput.checked) {
      onPeriodInput.checked = true;
      updatePeriodFieldUI(dailyDateInput.value);
      showConfirm('هل انتهت دورتك الشهرية اليوم؟', () => {
        onPeriodInput.checked = false;
        updatePeriodFieldUI(dailyDateInput.value);
      });
      return;
    }
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
    const protStatus = computeGoalStatus(prot, state.settings.proteinGoal, state.settings.proteinMarginPct, true);
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
    document.getElementById('workoutHiit').checked = !!w?.hiit;
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

  // Her real sessions never run under 30 minutes, so anything logged under
  // this is almost certainly a typo in the hours/minutes fields rather than
  // an actually short workout — worth a confirm instead of saving silently.
  const SHORT_WORKOUT_THRESHOLD_MIN = 20;

  document.getElementById('dailySaveBtn').addEventListener('click', () => {
    try {
      const date = dailyDateInput.value;
      if (!date) { showToast('اختر التاريخ أولًا.'); return; }

      const duration = readWorkoutDurationMinutes();

      const proceed = () => {
        state.dailyLogs[date] = {
          steps: numOrNull(document.getElementById('steps').value),
          calories: numOrNull(document.getElementById('calories').value),
          protein: numOrNull(document.getElementById('protein').value),
          workout: {
            done: workoutDoneInput.checked,
            type: document.getElementById('workoutType').value.trim(),
            duration,
            notes: document.getElementById('workoutNotes').value.trim(),
            hiit: document.getElementById('workoutHiit').checked,
          },
          onPeriod: onPeriodInput.checked,
        };
        saveState();
        renderAll();
        showToast('تم حفظ يوم ' + formatDateAr(date) + '.');
      };

      if (workoutDoneInput.checked && duration !== null && duration < SHORT_WORKOUT_THRESHOLD_MIN) {
        showConfirm(
          `⚠️ مدة التمرين المسجّلة ${formatDuration(duration)} فقط، وهذا أقل من المعتاد (جلساتك عادة لا تقل عن 30 دقيقة). تأكّدي من مدة الساعات/الدقائق — هل تحفظين كما هي؟`,
          proceed
        );
      } else {
        proceed();
      }
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

  // A streak week only needs at least one logged workout, not the full
  // weekly goal — it activates as soon as you show up that week, rather
  // than only once every day of the goal is complete.
  const STREAK_MIN_WORKOUTS_PER_WEEK = 1;

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
      if (doneCount >= STREAK_MIN_WORKOUTS_PER_WEEK) {
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
    { min: 0,  text: () => 'سجّلي تمرين واحد هذا الأسبوع لتبدئي سلسلتك 🔥' },
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
    const proteinAvgStatus = computeGoalStatus(proteinAvg, state.settings.proteinGoal, state.settings.proteinMarginPct, true);

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
  const AR_WEEK_ORDINALS = ['الأول', 'الثاني', 'الثالث', 'الرابع'];

  // "Goal completion" dot grid: always exactly 4 rows of 7 ("a month = 4
  // weeks"), sequential day chunks (not aligned to actual weekdays), each
  // labeled "الأسبوع الأول/الثاني/...". Days 29-31 in longer months fall
  // outside this 28-day view, same trade-off as elsewhere in the app.
  function renderMonthlyProgressChart() {
    const el = document.getElementById('monthlyProgressChart');
    const now = new Date();
    const year = now.getFullYear(), month = now.getMonth();
    const today = todayStr();
    const monthlyGoal = (state.settings.weeklyWorkoutGoal || 4) * 4;

    let completed = 0;
    let rows = '';
    for (let w = 0; w < 4; w++) {
      const weekStart = w * 7 + 1;
      let dots = '';
      for (let i = 0; i < 7; i++) {
        const d = weekStart + i;
        const ds = toDateStr(new Date(year, month, d));
        const done = !!state.dailyLogs[ds]?.workout?.done;
        if (done) completed++;
        const cls = ['goal-dot'];
        if (done) cls.push('done');
        if (ds === today) cls.push('today');
        dots += `<span class="${cls.join(' ')}"></span>`;
      }
      rows += `
        <div class="goal-week-row">
          <span class="goal-week-label">الأسبوع ${AR_WEEK_ORDINALS[w]}</span>
          <span class="goal-week-dots">${dots}</span>
        </div>
      `;
    }

    el.innerHTML = `
      <div class="goal-completion-head">
        <div class="goal-completion-title">🎯 إكمال الهدف</div>
        <div class="goal-completion-sub">${completed}/${monthlyGoal} يوم</div>
      </div>
      <div class="goal-week-rows">${rows}</div>
    `;
  }

  function calorieCellHtml(value) {
    if (value === null || value === undefined) return '—';
    const status = computeGoalStatus(value, state.settings.calorieGoal, state.settings.calorieMarginPct);
    return `${value}${goalBadgeHtml(status, 'سعرة', state.settings.calorieGoal, true)}`;
  }

  function proteinCellHtml(value) {
    if (value === null || value === undefined) return '—';
    const status = computeGoalStatus(value, state.settings.proteinGoal, state.settings.proteinMarginPct, true);
    return `${value}${goalBadgeHtml(status, 'جم', state.settings.proteinGoal, true)}`;
  }

  function renderRecentDailyTable() {
    const tbody = document.querySelector('#recentDailyTable tbody');
    const dates = Object.keys(state.dailyLogs).sort().reverse();
    tbody.innerHTML = dates.map(rowHtml).join('') ||
      `<tr><td colspan="6" class="muted">لا توجد بيانات بعد</td></tr>`;
    attachRowHandlers(tbody);
  }

  // Highlights days on/after a saved program start date (e.g. a new
  // trainer schedule) in the daily-log tables.
  function isInProgramPeriod(d) {
    return !!(state.settings.programStartDate && d >= state.settings.programStartDate);
  }
  function dateCellHtml(d) {
    const label = formatDateAr(d);
    return d === state.settings.programStartDate
      ? `${label} <span class="program-badge" title="بداية البرنامج الحالي">🎯</span>`
      : label;
  }

  function renderFullDailyTable() {
    const tbody = document.querySelector('#fullDailyTable tbody');
    const dates = Object.keys(state.dailyLogs).sort().reverse();
    tbody.innerHTML = dates.map(d => {
      const e = state.dailyLogs[d];
      const w = e.workout;
      const details = w?.done ? [w.type, w.hiit ? 'HIIT 🔥' : null, formatDuration(w.duration), w.notes].filter(Boolean).join(' · ') : '—';
      return `<tr${isInProgramPeriod(d) ? ' class="program-row"' : ''}>
        <td>${dateCellHtml(d)}</td>
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
    return `<tr${isInProgramPeriod(d) ? ' class="program-row"' : ''}>
      <td>${dateCellHtml(d)}</td>
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

  // Shows the most recent recorded value as a placeholder (grey hint, not
  // a real value) so she has her last reading for reference without
  // needing to look it up separately — not auto-filled, so an unchanged
  // field never gets silently resubmitted as if it were measured again.
  function updateMeasurePlaceholders() {
    const sorted = [...state.measurements].sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    MEASURE_FIELDS.forEach(f => {
      const input = document.getElementById(`m_${f.key}`);
      if (!input) return;
      const prior = latest ? latest[f.key] : null;
      input.placeholder = prior !== null && prior !== undefined ? String(prior) : '—';
    });
  }

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

      if (state.measurements.some(m => m.date === date)) {
        showToast('⚠️ يوجد قياس مسجّل بالفعل لهذا التاريخ — لم يُحفظ لتجنّب التكرار. استخدمي ✏️ لتعديل القياس الموجود إذا تبغين تغييره.', 8000);
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

  /* ---------- big single-field chart (one field at a time, picked via pills) ---------- */

  const BIG_CHART_HEIGHT = 240;

  // Round a min/max span to clean, evenly-spaced axis ticks instead of the
  // raw data range — "60 / 55 / 52" is noise, "60 / 56 / 52 / 48" reads.
  function niceTicks(rawMin, rawMax, count) {
    let min = rawMin, max = rawMax;
    if (min === max) { min -= 1; max += 1; }
    const range = max - min;
    const rawStep = range / Math.max(1, count - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    let step;
    if (norm < 1.5) step = 1 * mag;
    else if (norm < 3) step = 2 * mag;
    else if (norm < 7) step = 5 * mag;
    else step = 10 * mag;
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step * 0.5; v += step) {
      ticks.push(Math.round(v * 1000) / 1000);
    }
    return ticks;
  }

  function fmtAxisNum(v) {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }

  function buildBigChartSvg(points, key, unit, width, height, statusCls) {
    const values = points.map(p => p[key]);
    const n = values.length;
    const ticks = niceTicks(Math.min(...values), Math.max(...values), 5);
    const niceMin = ticks[0], niceMax = ticks[ticks.length - 1];

    const padTop = 34, padBottom = 26, padRight = 42, padLeft = 10;
    const plotW = Math.max(1, width - padLeft - padRight);
    const plotH = height - padTop - padBottom;
    const xFor = i => padLeft + (n > 1 ? i * (plotW / (n - 1)) : plotW / 2);
    const yFor = v => padTop + plotH - ((v - niceMin) / (niceMax - niceMin)) * plotH;

    const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
    const baseY = (padTop + plotH).toFixed(1);
    const areaPath = `${linePath} L${xFor(n - 1).toFixed(1)},${baseY} L${xFor(0).toFixed(1)},${baseY} Z`;

    const gridLines = ticks.map(t => `
      <line x1="${padLeft}" y1="${yFor(t).toFixed(1)}" x2="${(width - padRight).toFixed(1)}" y2="${yFor(t).toFixed(1)}" class="chart-grid-line"/>
      <text x="${(width - padRight + 6).toFixed(1)}" y="${yFor(t).toFixed(1)}" dy="0.32em" text-anchor="start" class="chart-axis-label">${fmtAxisNum(t)}</text>
    `).join('');

    // A visible 5px dot plus a larger transparent one laid over it as the
    // actual tap target — a real finger needs more room than the mark itself.
    const dots = values.map((v, i) => `
      <circle cx="${xFor(i).toFixed(1)}" cy="${yFor(v).toFixed(1)}" r="5" class="chart-dot"/>
      <circle cx="${xFor(i).toFixed(1)}" cy="${yFor(v).toFixed(1)}" r="14" class="chart-dot-hit" data-point-idx="${i}"/>
    `).join('');

    const maxXLabels = 4;
    const idxs = n <= maxXLabels
      ? Array.from({ length: n }, (_, i) => i)
      : [...new Set(Array.from({ length: maxXLabels }, (_, i) => Math.round(i * (n - 1) / (maxXLabels - 1))))];
    const xLabels = idxs.map(i => {
      const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      return `<text x="${xFor(i).toFixed(1)}" y="${(height - 6).toFixed(1)}" text-anchor="${anchor}" class="chart-x-label">${formatDateAr(points[i].date)}</text>`;
    }).join('');

    // Every point gets a badge in the markup, but only the first/last start
    // visible (per the "label selectively" rule) — tapping a dot reveals its
    // own badge (see renderBigFieldChart's click wiring below).
    const badge = (i, alwaysVisible) => {
      const vDisp = Math.round(values[i] * 10) / 10;
      const text = `${vDisp}${unit ? ' ' + unit : ''}`;
      const w = Math.max(34, text.length * 7 + 16);
      const h = 22;
      const cx = xFor(i), cy = yFor(values[i]);
      const bx = Math.max(2, Math.min(width - w - 2, cx - w / 2));
      const by = Math.max(2, cy - h - 10);
      return `<g class="chart-badge${alwaysVisible ? '' : ' chart-badge-hidden'}" data-badge-idx="${i}">
        <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w}" height="${h}" rx="11" class="chart-badge-bg"/>
        <text x="${(bx + w / 2).toFixed(1)}" y="${(by + h / 2).toFixed(1)}" dy="0.32em" text-anchor="middle" class="chart-badge-text">${text}</text>
      </g>`;
    };
    const badges = values.map((v, i) => badge(i, i === 0 || i === n - 1)).join('');

    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="big-chart-svg chart-${statusCls}">
      ${gridLines}
      <path d="${areaPath}" class="chart-area"/>
      <path d="${linePath}" class="chart-line"/>
      ${dots}
      ${xLabels}
      ${badges}
    </svg>`;
  }

  function renderBigFieldChart(containerEl, field, points, goalDirection) {
    if (points.length === 0) {
      containerEl.innerHTML = `<p class="muted mo-empty">لا توجد بيانات لهذا الحقل بعد</p>`;
      return;
    }
    const values = points.map(p => p[field.key]);
    const diff = round1(values[values.length - 1] - values[0]);
    let statusCls = 'flat';
    if (diff !== 0 && goalDirection) {
      const improved = (goalDirection === 'down' && diff < 0) || (goalDirection === 'up' && diff > 0);
      statusCls = improved ? 'good' : 'bad';
    }

    containerEl.innerHTML = `
      <div class="big-chart-title">${field.label}</div>
      <div class="big-chart-canvas"></div>
      ${points.length < 2 ? '<p class="muted mo-empty">قياس واحد فقط لحد الآن — سجّلي قياسًا آخر ليظهر الرسم البياني.</p>' : ''}
    `;
    if (points.length < 2) return;
    const canvas = containerEl.querySelector('.big-chart-canvas');
    const width = canvas.clientWidth || 320;
    canvas.innerHTML = buildBigChartSvg(points, field.key, field.unit, width, BIG_CHART_HEIGHT, statusCls);

    const lastIdx = points.length - 1;
    canvas.querySelectorAll('.chart-dot-hit').forEach(hit => {
      hit.addEventListener('click', () => {
        const idx = hit.dataset.pointIdx;
        canvas.querySelectorAll('.chart-badge').forEach(g => {
          const isEndpoint = g.dataset.badgeIdx === '0' || g.dataset.badgeIdx === String(lastIdx);
          g.classList.toggle('chart-badge-hidden', !(isEndpoint || g.dataset.badgeIdx === idx));
        });
      });
    });
  }

  let selectedMeasureField = null;

  function renderMeasureOverview() {
    const pillsEl = document.getElementById('measureFieldPills');
    const chartEl = document.getElementById('measureBigChart');
    const emptyMsg = document.getElementById('chartEmptyMsg');
    if (state.measurements.length === 0) {
      pillsEl.innerHTML = '';
      chartEl.innerHTML = '';
      emptyMsg.classList.remove('hidden');
      return;
    }

    const sorted = [...state.measurements].sort((a, b) => a.date.localeCompare(b.date));
    const fieldsWithData = MEASURE_FIELDS.filter(f => sorted.some(m => m[f.key] !== null && m[f.key] !== undefined));
    if (fieldsWithData.length === 0) {
      pillsEl.innerHTML = '';
      chartEl.innerHTML = '';
      emptyMsg.classList.remove('hidden');
      return;
    }
    emptyMsg.classList.add('hidden');

    if (!selectedMeasureField || !fieldsWithData.some(f => f.key === selectedMeasureField)) {
      selectedMeasureField = fieldsWithData[0].key;
    }

    pillsEl.innerHTML = fieldsWithData.map(f => `
      <button type="button" class="field-pill ${f.key === selectedMeasureField ? 'active' : ''}" data-field-pill="${f.key}">${f.label}</button>
    `).join('');
    pillsEl.querySelectorAll('[data-field-pill]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedMeasureField = btn.dataset.fieldPill;
        renderMeasureOverview();
      });
    });

    const field = fieldsWithData.find(f => f.key === selectedMeasureField);
    const points = sorted.filter(m => m[field.key] !== null && m[field.key] !== undefined);
    renderBigFieldChart(chartEl, field, points, state.settings.goalDirections[field.key]);
  }

  /* ============================ INBODY FORM ============================ */

  const inbodyFieldsEl = document.getElementById('inbodyFields');
  inbodyFieldsEl.innerHTML = INBODY_FIELDS.map(f => `
    <div class="field">
      <label for="ib_${f.key}">${f.label}${f.unit ? ` (${f.unit})` : ''}</label>
      <input type="number" step="0.1" min="0" id="ib_${f.key}" placeholder="—">
    </div>
  `).join('');

  const inbodySegmentalFieldsEl = document.getElementById('inbodySegmentalFields');
  if (inbodySegmentalFieldsEl) {
    inbodySegmentalFieldsEl.innerHTML = SEGMENTAL_FIELDS.map(f => `
      <div class="field">
        <label for="ib_${f.key}">${f.regionLabel} — ${f.metricLabel} (%)</label>
        <input type="number" step="0.1" min="0" id="ib_${f.key}" placeholder="—">
      </div>
    `).join('');
  }

  document.getElementById('inbodyDate').value = todayStr();

  function updateInbodyPlaceholders() {
    const sorted = [...state.inbody].sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    INBODY_ALL_FIELDS.forEach(f => {
      const input = document.getElementById(`ib_${f.key}`);
      if (!input) return;
      const prior = latest ? latest[f.key] : null;
      input.placeholder = prior !== null && prior !== undefined ? String(prior) : '—';
    });
  }

  let editingInbodyId = null;

  function readInbodyFormValues() {
    const values = {};
    INBODY_ALL_FIELDS.forEach(f => {
      const input = document.getElementById(`ib_${f.key}`);
      values[f.key] = input ? numOrNull(input.value) : null;
    });
    return values;
  }

  function clearInbodyForm() {
    INBODY_ALL_FIELDS.forEach(f => {
      const input = document.getElementById(`ib_${f.key}`);
      if (input) input.value = '';
    });
    document.getElementById('inbodyDate').value = todayStr();
  }

  function startEditInbody(id) {
    const r = state.inbody.find(x => x.id === id);
    if (!r) return;
    editingInbodyId = id;
    document.getElementById('inbodyDate').value = r.date;
    INBODY_ALL_FIELDS.forEach(f => {
      const input = document.getElementById(`ib_${f.key}`);
      if (input) input.value = r[f.key] ?? '';
    });
    document.getElementById('inbodySaveBtn').textContent = '💾 حفظ التعديلات';
    document.getElementById('inbodyCancelEditBtn').classList.remove('hidden');
    document.getElementById('inbodyForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('وضع التعديل مفعّل — عدّلي القيم واحفظي.');
  }

  function cancelEditInbody() {
    editingInbodyId = null;
    document.getElementById('inbodySaveBtn').textContent = 'حفظ القراءة';
    document.getElementById('inbodyCancelEditBtn').classList.add('hidden');
    clearInbodyForm();
  }

  document.getElementById('inbodyCancelEditBtn').addEventListener('click', cancelEditInbody);

  document.getElementById('inbodySaveBtn').addEventListener('click', () => {
    try {
      const date = document.getElementById('inbodyDate').value;
      if (!date) { showToast('اختر تاريخ القراءة أولًا.'); return; }
      const values = readInbodyFormValues();

      if (editingInbodyId) {
        const existing = state.inbody.find(r => r.id === editingInbodyId);
        if (!existing) { cancelEditInbody(); showToast('تعذّر إيجاد القراءة، حاولي من جديد.'); return; }
        Object.assign(existing, { date, ...values });
        state.inbody.sort((a, b) => a.date.localeCompare(b.date));
        saveState();
        cancelEditInbody();
        renderAll();
        showToast('تم تحديث القراءة.');
        return;
      }

      if (state.inbody.some(r => r.date === date)) {
        showToast('⚠️ يوجد قراءة إنبودي مسجّلة بالفعل لهذا التاريخ — لم تُحفظ لتجنّب التكرار. استخدمي ✏️ لتعديل القراءة الموجودة إذا تبغين تغييرها.', 8000);
        return;
      }

      const entry = { id: `${date}-${Date.now()}`, date, ...values };
      clearInbodyForm();
      state.inbody.push(entry);
      state.inbody.sort((a, b) => a.date.localeCompare(b.date));
      saveState();
      renderAll();
      showToast('تم حفظ القراءة.');
    } catch (err) {
      console.error('Inbody save failed:', err);
      showToast('⚠️ فشل الحفظ: ' + (err && err.message ? err.message : String(err)), 8000);
    }
  });

  function deleteInbody(id) {
    showConfirm('حذف هذه القراءة؟', () => {
      state.inbody = state.inbody.filter(r => r.id !== id);
      if (id === editingInbodyId) cancelEditInbody();
      saveState();
      renderAll();
      showToast('تم الحذف.');
    });
  }

  let inbodySortKey = 'date';
  let inbodySortDir = 'desc';

  function renderInbodyTable() {
    const head = document.getElementById('inbodyTableHead');
    const arrowFor = key => inbodySortKey === key ? (inbodySortDir === 'asc' ? ' ▲' : ' ▼') : '';
    head.innerHTML = `<th class="sortable" data-sort="date">التاريخ${arrowFor('date')}</th>` +
      INBODY_FIELDS.map(f => `<th class="sortable" data-sort="${f.key}">${f.label}${arrowFor(f.key)}</th>`).join('') +
      `<th></th>`;
    head.querySelectorAll('[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (inbodySortKey === key) {
          inbodySortDir = inbodySortDir === 'asc' ? 'desc' : 'asc';
        } else {
          inbodySortKey = key;
          inbodySortDir = key === 'date' ? 'desc' : 'asc';
        }
        renderInbodyTable();
      });
    });

    const tbody = document.querySelector('#inbodyTable tbody');
    const rows = [...state.inbody].sort((a, b) => {
      const av = a[inbodySortKey], bv = b[inbodySortKey];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return inbodySortDir === 'asc' ? -1 : 1;
      if (av > bv) return inbodySortDir === 'asc' ? 1 : -1;
      return 0;
    });
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${formatDateAr(r.date)}</td>
        ${INBODY_FIELDS.map(f => `<td>${r[f.key] ?? '—'}</td>`).join('')}
        <td class="row-actions">
          <button class="btn-icon-small" data-edit="${r.id}" title="تعديل">✏️</button>
          <button class="btn-icon-small" data-del="${r.id}" title="حذف">🗑️</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="${INBODY_FIELDS.length + 2}" class="muted">لا توجد قراءات بعد</td></tr>`;

    tbody.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteInbody(btn.dataset.del));
    });
    tbody.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => startEditInbody(btn.dataset.edit));
    });
  }

  let selectedInbodyField = null;

  function renderInbodyOverview() {
    const pillsEl = document.getElementById('inbodyFieldPills');
    const chartEl = document.getElementById('inbodyBigChart');
    const emptyMsg = document.getElementById('inbodyChartEmptyMsg');
    if (state.inbody.length === 0) {
      pillsEl.innerHTML = '';
      chartEl.innerHTML = '';
      emptyMsg.classList.remove('hidden');
      return;
    }

    const sorted = [...state.inbody].sort((a, b) => a.date.localeCompare(b.date));
    const fieldsWithData = INBODY_FIELDS.filter(f => sorted.some(r => r[f.key] !== null && r[f.key] !== undefined));
    if (fieldsWithData.length === 0) {
      pillsEl.innerHTML = '';
      chartEl.innerHTML = '';
      emptyMsg.classList.remove('hidden');
      return;
    }
    emptyMsg.classList.add('hidden');

    if (!selectedInbodyField || !fieldsWithData.some(f => f.key === selectedInbodyField)) {
      selectedInbodyField = fieldsWithData[0].key;
    }

    pillsEl.innerHTML = fieldsWithData.map(f => `
      <button type="button" class="field-pill ${f.key === selectedInbodyField ? 'active' : ''}" data-field-pill="${f.key}">${f.label}</button>
    `).join('');
    pillsEl.querySelectorAll('[data-field-pill]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedInbodyField = btn.dataset.fieldPill;
        renderInbodyOverview();
      });
    });

    const field = fieldsWithData.find(f => f.key === selectedInbodyField);
    const points = sorted.filter(r => r[field.key] !== null && r[field.key] !== undefined);
    renderBigFieldChart(chartEl, field, points, state.settings.goalDirections[field.key]);
  }

  /* ---------- segmental fat/muscle distribution (upper/trunk/lower) ---------- */

  // Direction, not absolute level, is what matters here — same convention as
  // every other goal-directed field in the app: fat going down is an
  // improvement, muscle going up is, regardless of where either sits.
  function segmentGoalDirection(metric) {
    return metric === 'fat' ? 'down' : 'up';
  }

  // Whether the region itself sits in InBody's "normal" band — answers "is
  // this normal, low, or high", independent of whether it's trending well.
  function segmentLevelLabel(value) {
    if (value > SEGMENTAL_NORMAL_HIGH) return 'أعلى من الطبيعي';
    if (value < SEGMENTAL_NORMAL_LOW) return 'أقل من الطبيعي';
    return 'طبيعي';
  }

  // pointsForField: this field's own entries only, ascending by date. The
  // label text always states the absolute level (normal/low/high); the
  // color (cls) is trend-based once there's a prior reading to compare
  // against (fat down / muscle up is an improvement), and falls back to the
  // level itself (normal = good) for a lone first reading with no trend yet.
  function segmentTrend(f, pointsForField) {
    if (pointsForField.length === 0) return null;
    const latest = pointsForField[pointsForField.length - 1][f.key];
    const text = segmentLevelLabel(latest);
    if (pointsForField.length < 2) {
      const inRange = latest >= SEGMENTAL_NORMAL_LOW && latest <= SEGMENTAL_NORMAL_HIGH;
      return { latest, cls: inRange ? 'good' : 'bad', text };
    }
    const prior = pointsForField[pointsForField.length - 2][f.key];
    const diff = round1(latest - prior);
    if (diff === 0) return { latest, cls: 'flat', text };
    const improved = (segmentGoalDirection(f.metric) === 'down' && diff < 0) ||
                      (segmentGoalDirection(f.metric) === 'up' && diff > 0);
    return { latest, cls: improved ? 'good' : 'bad', text };
  }

  // A plain (uncolored) body silhouette — matches the flat grey figure on a
  // real InBody segmental printout. Status now lives in the floating value
  // labels placed around it (see buildGroup below), not in the shape's fill.
  // Same capsule proportions as the body illustration in the measurement guide.
  function bodyZoneSvg() {
    return `<svg viewBox="0 0 240 380" class="body-diagram-svg" role="img" aria-label="رسم توضيحي لشكل الجسم">
      <ellipse cx="120" cy="28" rx="17" ry="19" class="body-shape"/>
      <rect x="112" y="45" width="16" height="14" rx="4" class="body-shape"/>
      <rect x="68" y="58" width="104" height="54" rx="26" class="body-shape"/>
      <rect x="87" y="103" width="66" height="32" rx="16" class="body-shape"/>
      <rect x="74" y="126" width="92" height="42" rx="21" class="body-shape"/>
      <rect x="38" y="64" width="27" height="116" rx="13.5" class="body-shape"/>
      <rect x="175" y="64" width="27" height="116" rx="13.5" class="body-shape"/>
      <rect x="78" y="165" width="35" height="90" rx="17" class="body-shape"/>
      <rect x="127" y="165" width="35" height="90" rx="17" class="body-shape"/>
      <rect x="82" y="252" width="27" height="90" rx="13.5" class="body-shape"/>
      <rect x="131" y="252" width="27" height="90" rx="13.5" class="body-shape"/>
    </svg>`;
  }

  let selectedSegmentalField = null;

  function renderSegmentalDistribution() {
    const snapshotEl = document.getElementById('segmentalSnapshot');
    const pillsEl = document.getElementById('segmentalFieldPills');
    const chartEl = document.getElementById('segmentalBigChart');
    const emptyMsg = document.getElementById('segmentalEmptyMsg');
    if (!snapshotEl || !pillsEl || !chartEl || !emptyMsg) return;

    const sorted = [...state.inbody].sort((a, b) => a.date.localeCompare(b.date));
    const hasAny = sorted.some(r => SEGMENTAL_FIELDS.some(f => r[f.key] !== null && r[f.key] !== undefined));
    if (!hasAny) {
      snapshotEl.innerHTML = '';
      pillsEl.innerHTML = '';
      chartEl.innerHTML = '';
      emptyMsg.classList.remove('hidden');
      return;
    }
    emptyMsg.classList.add('hidden');

    const latestDate = [...sorted].reverse()
      .find(r => SEGMENTAL_FIELDS.some(f => r[f.key] !== null && r[f.key] !== undefined)).date;

    // Position class per region, matching a real InBody printout's layout:
    // arms label the top corners, trunk sits centered over the waist, legs
    // label the bottom corners — and "right" (يمين) is the screen's RIGHT
    // side here (as her own report shows it), not mirrored.
    const REGION_POSITION = {
      rightArm: 'right-arm', leftArm: 'left-arm', trunk: 'trunk',
      rightLeg: 'right-leg', leftLeg: 'left-leg',
    };

    const buildGroup = (metric, title) => {
      const labels = SEGMENTAL_REGIONS.map(r => {
        const f = SEGMENTAL_FIELDS.find(x => x.region === r.key && x.metric === metric);
        const pts = sorted.filter(row => row[f.key] !== null && row[f.key] !== undefined);
        const trend = segmentTrend(f, pts);
        const posCls = `bd-pos-${REGION_POSITION[r.key]}`;
        if (!trend) return `<div class="bd-label ${posCls} none"><div class="bd-value">—</div></div>`;
        return `<div class="bd-label ${posCls} ${trend.cls}">
          <div class="bd-value">${trend.latest}%</div>
          <div class="bd-status">${trend.text}</div>
        </div>`;
      }).join('');

      return `
        <div class="segment-group">
          <div class="segment-group-title">${title} — آخر قراءة (${formatDateAr(latestDate)})</div>
          <div class="body-diagram-figure">
            ${labels}
            ${bodyZoneSvg()}
            <div class="bd-side-label bd-side-right">يمين</div>
            <div class="bd-side-label bd-side-left">يسار</div>
          </div>
        </div>
      `;
    };

    snapshotEl.innerHTML = buildGroup('fat', 'توزيع الدهون') + buildGroup('muscle', 'توزيع العضلات');

    // Same pill-selector + single big chart pattern as the InBody/measurements
    // overview, instead of a grid of small cards, for one consistent style.
    const fieldsWithData = SEGMENTAL_FIELDS.filter(f => sorted.some(r => r[f.key] !== null && r[f.key] !== undefined));
    if (!selectedSegmentalField || !fieldsWithData.some(f => f.key === selectedSegmentalField)) {
      selectedSegmentalField = fieldsWithData[0].key;
    }

    pillsEl.innerHTML = fieldsWithData.map(f => `
      <button type="button" class="field-pill ${f.key === selectedSegmentalField ? 'active' : ''}" data-field-pill="${f.key}">${f.regionLabel} — ${f.metricLabel}</button>
    `).join('');
    pillsEl.querySelectorAll('[data-field-pill]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedSegmentalField = btn.dataset.fieldPill;
        renderSegmentalDistribution();
      });
    });

    const field = fieldsWithData.find(f => f.key === selectedSegmentalField);
    const points = sorted.filter(r => r[field.key] !== null && r[field.key] !== undefined);
    renderBigFieldChart(chartEl, { ...field, label: `${field.regionLabel} — ${field.metricLabel}` }, points, segmentGoalDirection(field.metric));
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
    document.getElementById('programStartInput').value = state.settings.programStartDate ?? '';
    document.getElementById('calorieGoalInput').value = state.settings.calorieGoal;
    document.getElementById('calorieMarginInput').value = state.settings.calorieMarginPct;
    document.getElementById('proteinGoalInput').value = state.settings.proteinGoal;
    document.getElementById('proteinMarginInput').value = state.settings.proteinMarginPct;
    document.getElementById('periodLenInput').value = state.settings.periodLenOverride ?? '';
    document.getElementById('cycleLenInput').value = state.settings.cycleLenOverride ?? '';
    const el = document.getElementById('goalDirections');
    el.innerHTML = ALL_GOAL_FIELDS.map(f => `
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
    state.settings.programStartDate = document.getElementById('programStartInput').value || null;
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

  document.getElementById('exportData').addEventListener('click', async () => {
    const json = JSON.stringify(state, null, 2);
    if (downloadsCap) {
      try {
        await downloadsCap.save({ filename: 'بيانات-التطبيق.json', data: json });
        showToast('تم حفظ ملف البيانات.');
      } catch (err) {
        if (err && err.code !== 'declined') showToast('تعذّر حفظ الملف، حاولي مرة أخرى.');
      }
      return;
    }
    // Outside the artifact sandbox (plain static hosting) a direct blob
    // download works fine in a normal browser tab.
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'بيانات-التطبيق.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // PDF export: window.print() is unreliable (or outright blocked, same
  // as native confirm()/alert() elsewhere in this app) inside embedded
  // mobile-app webviews, so build an actual PDF file instead — draw each
  // page on a canvas (the browser's own text engine handles Arabic
  // shaping/RTL correctly in canvas text, unlike jsPDF's raw glyph
  // placement) and hand the canvases to jsPDF as page images.
  function chunkRows(rows, size) {
    const pages = [];
    for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
    return pages.length ? pages : [[]];
  }

  function drawReportPageCanvas({ title, meta, columns, colWidths, rows, pageLabel }) {
    const W = 794, H = 1123, pad = 40;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';

    let y = 50;
    if (title) {
      ctx.fillStyle = '#2c2a24';
      ctx.font = 'bold 22px "IBM Plex Sans Arabic", Tahoma, sans-serif';
      ctx.fillText(title, W - pad, y);
      y += 26;
    }
    if (meta) {
      ctx.font = '13px "IBM Plex Sans Arabic", Tahoma, sans-serif';
      ctx.fillStyle = '#7a7566';
      ctx.fillText(meta, W - pad, y);
      y += 30;
    } else {
      y += 14;
    }

    const tableX = pad, tableW = W - pad * 2, rowH = 26;

    ctx.fillStyle = '#f0ede4';
    ctx.fillRect(tableX, y, tableW, rowH);
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.strokeRect(tableX, y, tableW, rowH);
    ctx.font = 'bold 12px "IBM Plex Sans Arabic", Tahoma, sans-serif';
    ctx.fillStyle = '#2c2a24';
    let cx = W - pad - 8;
    columns.forEach((col, i) => {
      ctx.fillText(col, cx, y + 17);
      cx -= colWidths[i];
    });
    y += rowH;

    ctx.font = '12px "IBM Plex Sans Arabic", Tahoma, sans-serif';
    rows.forEach((row, ri) => {
      if (ri % 2 === 1) {
        ctx.fillStyle = '#fafaf6';
        ctx.fillRect(tableX, y, tableW, rowH);
      }
      ctx.strokeStyle = '#e0ddd2';
      ctx.strokeRect(tableX, y, tableW, rowH);
      ctx.fillStyle = '#2c2a24';
      let cx2 = W - pad - 8;
      row.forEach((cell, i) => {
        ctx.fillText(String(cell ?? '—'), cx2, y + 17);
        cx2 -= colWidths[i];
      });
      y += rowH;
    });

    if (pageLabel) {
      ctx.font = '11px Tahoma, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#999';
      ctx.fillText(pageLabel, W / 2, H - 20);
    }

    return canvas;
  }

  async function generateReportPdfBlob(fromDate, toDate) {
    await document.fonts.ready;

    const W = 794, H = 1123;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'px', format: [W, H] });

    const inRange = d => (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
    const rangeLabel = fromDate || toDate
      ? `الفترة: من ${fromDate ? formatDateAr(fromDate) : 'البداية'} إلى ${toDate ? formatDateAr(toDate) : 'اليوم'}`
      : 'كل الفترة المسجّلة';

    const dates = Object.keys(state.dailyLogs).filter(inRange).sort().reverse();
    const dailyRows = dates.map(d => {
      const e = state.dailyLogs[d];
      const w = e.workout;
      const details = w?.done ? [w.type, w.hiit ? 'HIIT 🔥' : null, formatDuration(w.duration), w.notes].filter(Boolean).join(' · ') : '—';
      return [formatDateAr(d), e.steps ?? '—', e.calories ?? '—', e.protein ?? '—', w?.done ? '✅' : '—', details];
    });
    const dailyCols = ['التاريخ', 'خطوات', 'سعرات', 'بروتين', 'تمرين', 'تفاصيل'];
    const dailyColWidths = [110, 80, 80, 80, 60, 304];
    const dailyPages = chunkRows(dailyRows, 30);

    const sortedMeasurements = [...state.measurements].filter(m => inRange(m.date)).sort((a, b) => b.date.localeCompare(a.date));
    const measureCols = ['التاريخ', ...MEASURE_FIELDS.map(f => f.label)];
    const measureColW = Math.floor((714 - 120) / MEASURE_FIELDS.length);
    const measureColWidths = [120, ...MEASURE_FIELDS.map(() => measureColW)];
    const measureRows = sortedMeasurements.map(m => [formatDateAr(m.date), ...MEASURE_FIELDS.map(f => m[f.key] ?? '—')]);
    const measurePages = chunkRows(measureRows, 30);

    let firstPage = true;
    dailyPages.forEach((pageRows, i) => {
      if (!firstPage) doc.addPage();
      firstPage = false;
      const canvas = drawReportPageCanvas({
        title: i === 0 ? '📊 تقرير متابعة الأداء الصحي والرياضي' : null,
        meta: i === 0 ? `${rangeLabel} — السجل اليومي` : 'السجل اليومي (تابع)',
        columns: dailyCols,
        colWidths: dailyColWidths,
        rows: pageRows,
        pageLabel: dailyPages.length > 1 ? `صفحة ${i + 1} من ${dailyPages.length}` : null,
      });
      doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, W, H);
    });

    measurePages.forEach((pageRows, i) => {
      doc.addPage();
      const canvas = drawReportPageCanvas({
        title: i === 0 ? 'سجل القياسات' : null,
        meta: null,
        columns: measureCols,
        colWidths: measureColWidths,
        rows: pageRows,
        pageLabel: measurePages.length > 1 ? `صفحة ${i + 1} من ${measurePages.length}` : null,
      });
      doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, W, H);
    });

    return doc.output('blob');
  }

  const exportRangeModal = document.getElementById('exportRangeModal');
  const exportFromDateInput = document.getElementById('exportFromDate');
  const exportToDateInput = document.getElementById('exportToDate');
  const exportProgramRangeBtn = document.getElementById('exportProgramRangeBtn');

  document.getElementById('exportPdfBtn').addEventListener('click', () => {
    const allDates = Object.keys(state.dailyLogs).sort();
    exportFromDateInput.value = allDates[0] || '';
    exportToDateInput.value = todayStr();
    exportProgramRangeBtn.classList.toggle('hidden', !state.settings.programStartDate);
    exportRangeModal.classList.remove('hidden');
  });

  exportProgramRangeBtn.addEventListener('click', () => {
    exportFromDateInput.value = state.settings.programStartDate;
    exportToDateInput.value = todayStr();
  });

  document.getElementById('exportRangeCancelBtn').addEventListener('click', () => {
    exportRangeModal.classList.add('hidden');
  });

  document.getElementById('exportRangeConfirmBtn').addEventListener('click', async () => {
    if (typeof window.jspdf === 'undefined') {
      showToast('⚠️ تعذّر تحميل أداة PDF — تأكدي من الاتصال بالإنترنت وحاولي مرة أخرى.', 5000);
      return;
    }
    const fromDate = exportFromDateInput.value || null;
    const toDate = exportToDateInput.value || null;
    if (fromDate && toDate && fromDate > toDate) {
      showToast('تاريخ البداية بعد تاريخ النهاية — تأكدي من الفترة.');
      return;
    }
    exportRangeModal.classList.add('hidden');
    showToast('⏳ يتم تجهيز التقرير...');
    try {
      const blob = await generateReportPdfBlob(fromDate, toDate);
      if (downloadsCap) {
        await downloadsCap.save({ filename: 'تقرير-الأداء.pdf', data: blob });
        showToast('تم حفظ التقرير.');
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'تقرير-الأداء.pdf';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      if (err && err.code === 'declined') return;
      console.error('PDF export failed:', err);
      showToast('⚠️ تعذّر إنشاء التقرير، حاولي مرة أخرى.', 5000);
    }
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
        showConfirm('سيتم استبدال جميع البيانات الحالية بالبيانات المستوردة. متابعة؟', () => {
          state = normalizeState(parsed);
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
  const TIPS_BUTTON_IDS = ['tipsTodayBtn', 'qaBtnToday'];

  const ASSISTANT_RULES =
    'أنت مساعد صحي ولياقة بدنية شخصي داخل تطبيق متابعة يستخدمه شخص واحد. ' +
    'أمامك بيانات المستخدم الفعلية بصيغة JSON (آخر 14 يومًا من سجله اليومي، وآخر قياساته بالمتر recentMeasurements، وآخر قراءات جهاز الإنبودي recentInbody، وأهدافه، ومرحلة دورته الشهرية الحالية إن وُجدت في currentCyclePhase). ' +
    'تحليلك موحّد يغطي ثلاثة جوانب دائمًا عند توفر بياناتها: اللياقة العامة (الانتظام، التمرين، السعرات، البروتين، الخطوات)، وقياسات الجسم بالمتر، وقراءات الإنبودي (الوزن، الكتلة العضلية، نسبة ومستوى الدهون، الدهون الحشوية، معدل الحرق، ماء الجسم). ' +
    'لكل جانب من هذه الثلاثة اذكري فرصة تطوير واحدة محدّدة وقابلة للتنفيذ مبنية على أرقامه الفعلية، لا نصيحة عامة. ' +
    'اعتمد فقط على هذه الأرقام — لا تخترع بيانات غير موجودة، ولا تقدّم نصائح طبية عامة لا علاقة لها بالأرقام المعطاة. ' +
    'ضروري دائمًا مراعاة تقلبات الشهية والطاقة المرتبطة بالدورة الشهرية — لا تكتفي بذكر هذا أحيانًا، بل افحصي عند أي تذبذب بالسعرات أو البروتين أو شدة التمرين أو الخطوات هل يتزامن مع مرحلة معينة (خصوصًا الدورة أو المرحلة الأصفرية قبلها)، واذكري هذا كتفسير محتمل وطبيعي بدل تركه يبدو كتراجع أو تقصير. استخدمي currentCyclePhase وأيام onPeriod بالسجل اليومي لهذا الغرض كلما توفّرت، دون تقديم تشخيص طبي أو مبالغة. ' +
    'إن سُئلت عن شيء خارج بيانات اللياقة/الصحة المتاحة هنا، وضّح بأدب أنك مخصص لتحليل بيانات هذا التطبيق فقط. ' +
    'أسلوبك: متفهّم وداعم، مو ناقد. صاحبة الحساب عندها جدول يومي مزحوم، فلا تفترضي وقتًا فاضيًا أو التزامًا مثاليًا — أي اقتراح لازم يكون واقعي وسريع التطبيق يناسب يوم مشغول (مثلًا بديل أسرع، تعديل بسيط، لا حل يحتاج وقت أو تخطيط طويل). ' +
    'لا تخلي النصائح تطغى عليها السلبية أو التركيز على الأخطاء والنواقص فقط — ابدئي دائمًا بالإيجابي الموجود فعليًا بالأرقام (انتظام، تحسّن، التزام ولو جزئي) قبل أي ملاحظة، واذكري النقص كخطوة قادمة لا كفشل. ' +
    'كل ملاحظة لازم تكون مصحوبة بحل أو اقتراح عملي قابل للتنفيذ، لا تكتفي بعرض المشكلة أو الرقم بدون ما تقترحين إجراء واضح. ' +
    'أجب بالعربية الفصحى المبسطة، بإيجاز ووضوح.';

  function buildAssistantContext() {
    const dates = Object.keys(state.dailyLogs).sort().slice(-14);
    const dailyLogsLast14Days = dates.map(d => ({ date: d, ...state.dailyLogs[d] }));
    const recentMeasurements = [...state.measurements]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-6);
    const recentInbody = [...state.inbody]
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
      recentInbody,
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
      case 'images_unavailable':
        return '⚠️ هذا العرض لا يدعم تحليل الصور حاليًا، أدخلي القيم يدويًا.';
      case 'image_rejected':
        return '⚠️ تعذّر قبول الصورة المستخرجة من الملف، جرّبي ملفًا آخر أو أدخلي القيم يدويًا.';
      case 'invalid_json':
        return '⚠️ تعذّر فهم الأرقام في التقرير بوضوح، تحقّقي من جودة الملف أو أدخلي القيم يدويًا.';
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

  // The artifact sandbox blocks a page's own file downloads (no <a download>,
  // no blob/data saves) — the `downloads` capability is the sanctioned way
  // to hand the viewer a file, with an explicit accept/decline prompt.
  let downloadsCap = null;
  async function initDownloads() {
    if (typeof window.claude === 'undefined' || typeof window.claude.use !== 'function') return;
    try {
      downloadsCap = await window.claude.use('downloads');
    } catch (e) {
      downloadsCap = null;
    }
  }

  // A single unified "professional tips" block on the main page — one
  // analysis covering fitness + cm measurements + InBody together (rather
  // than three separate per-tab analyses that could read as disconnected
  // or even contradict each other), so there's one coherent goal.
  const TIPS_SECTIONS = [
    {
      btnId: 'tipsTodayBtn',
      outId: 'tipsTodayOutput',
      qaInputId: 'qaInputToday',
      qaBtnId: 'qaBtnToday',
      focus: 'غطّي الثلاثة جوانب معًا في نصيحة واحدة متكاملة: ' +
        '(1) اللياقة العامة — مدى انتظام تسجيله اليومي، واتساق التمرين والسعرات والبروتين مقابل الهدف خلال آخر الأيام المسجّلة، ' +
        '(2) قياسات الجسم بالمتر recentMeasurements — اتجاه التغيّر عبر الوقت مقارنة بهدف كل قياس، ' +
        '(3) قراءات الإنبودي recentInbody — اتجاه الوزن والكتلة العضلية ونسبة الدهون والدهون الحشوية ومعدل الحرق وماء الجسم عبر الوقت مقارنة بالهدف. ' +
        'لكل جانب من الثلاثة اذكري فرصة تطوير واحدة محددة وقابلة للتنفيذ. ' +
        'رتّبي نصيحة التمرين نفسها حسب مرحلة الدورة الحالية إن وُجدت currentCyclePhase: بالمرحلة الشهرية اقترحي تمارين أخف (مشي، إطالات) وخففي التوقعات، بالجريبية والإباضة اقترحي زيادة الشدة أو الأحمال تدريجيًا، وبالأصفرية اقترحي شدة متوسطة مع مراعاة التعب المحتمل قرب نهايتها. ' +
        'وإذا توفّرت currentCyclePhase، اربطي بها أيضًا عند تفسير القياسات والإنبودي: مثلًا ارتفاع طفيف بالوزن أو محيط الخصر/أسفل البطن/الأرداف أو نسبة ماء الجسم بالمرحلة الأصفرية أو قرب الدورة قد يكون احتباس ماء مؤقت وليس تراجعًا حقيقيًا.' +
        ' إن لم تتوفر بيانات لأحد الجوانب (مثلًا لا توجد قراءات إنبودي بعد)، تجاوزيه بدون ذكر غيابه كنقص.',
    },
  ];

  TIPS_SECTIONS.forEach(({ btnId, outId, qaInputId, qaBtnId, focus }) => {
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
          ' اكتبي 4 إلى 6 نصائح عملية قصيرة (سطر أو سطرين لكل واحدة)، كل نصيحة تبدأ برمز تعبيري مناسب، سطر مستقل لكل نصيحة، بدون مقدمة أو خاتمة.' +
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

    const qaInput = document.getElementById(qaInputId);
    const qaBtn = document.getElementById(qaBtnId);
    if (!qaInput || !qaBtn) return;
    const askQuestion = async () => {
      const question = qaInput.value.trim();
      if (!question) { showToast('اكتبي سؤالك أولًا.'); return; }
      if (!sampleCap) { showToast('المساعد الذكي غير متاح في هذا العرض.'); return; }
      qaBtn.disabled = true;
      out.innerHTML = '<span class="thinking">🤔 يفكر...</span>';
      try {
        const context = buildAssistantContext();
        const prompt =
          ASSISTANT_RULES +
          '\n\nأجيبي على سؤال المستخدم التالي اعتمادًا على بياناته أدناه فقط. إن كان السؤال خارج نطاق بيانات اللياقة/الصحة هنا، وضّحي ذلك بأدب.' +
          '\n\nسؤال المستخدم: ' + question +
          '\n\nبيانات المستخدم:\n' + JSON.stringify(context);
        const { text } = await sampleCap(prompt, {
          modelTier: 'default',
          onText: ({ text }) => { out.textContent = text; },
        });
        out.textContent = text;
      } catch (err) {
        out.textContent = assistantErrorMessage(err);
      } finally {
        qaBtn.disabled = !sampleCap;
      }
    };
    qaBtn.addEventListener('click', askQuestion);
    qaInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') askQuestion();
    });
  });

  /* ============================ INBODY PDF EXTRACTION ============================ */

  // Renders a PDF's pages to PNG images client-side (pdf.js), then hands them
  // to Claude's vision via the already-granted `sample` capability to read the
  // printed numbers off the report — works whether the PDF has a real text
  // layer or is just a scanned/photographed page, and needs no extra
  // capability declaration beyond `sample` (already granted for tips/Q&A).
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  async function renderPdfPagesToPngBlobs(arrayBuffer, maxPages) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pageCount = Math.min(pdf.numPages, maxPages);
    const blobs = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (blob) blobs.push(blob);
    }
    return blobs;
  }

  // A photo from the phone's gallery/camera is already an image — hand it to
  // Claude's vision as-is (no PDF rendering needed); only a real PDF goes
  // through pdf.js. Rejects a file type the current view's `sample` call
  // can't send as an image (e.g. HEIC, which Claude's vision doesn't accept).
  async function fileToImageBlobs(file, maxPages, limits) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) {
      if (typeof pdfjsLib === 'undefined') throw { code: 'pdfjs_unavailable' };
      const arrayBuffer = await file.arrayBuffer();
      return await renderPdfPagesToPngBlobs(arrayBuffer, maxPages);
    }
    const accepted = limits?.images?.mediaTypes || [];
    if (accepted.length && !accepted.includes(file.type)) {
      throw { code: 'image_rejected', message: `نوع الصورة (${file.type || 'غير معروف'}) غير مدعوم` };
    }
    return [file];
  }

  const INBODY_EXTRACT_PROMPT =
    'هذه صورة (أو عدة صور لصفحات) من تقرير جهاز قياس تكوين الجسم (إنبودي / InBody). ' +
    'اقرئي الأرقام المطبوعة في الصورة بدقة وأرجعي كائن JSON واحد فقط بهذه المفاتيح بالضبط، بدون أي نص آخر قبله أو بعده، ' +
    'وضعي null لأي قيمة غير موجودة أو غير واضحة في الصورة (لا تخترعي أرقامًا):\n' +
    '{\n' +
    '  "date": تاريخ القياس المطبوع بصيغة YYYY-MM-DD أو null,\n' +
    '  "weight": الوزن Weight بالكيلوغرام كرقم,\n' +
    '  "skeletalMuscleMass": الكتلة العضلية الهيكلية Skeletal Muscle Mass / SMM بالكيلوغرام,\n' +
    '  "bodyFatMass": كتلة الدهون Body Fat Mass بالكيلوغرام,\n' +
    '  "bodyFatPct": نسبة الدهون Percent Body Fat / PBF كرقم بدون علامة %,\n' +
    '  "bmi": مؤشر كتلة الجسم BMI كرقم,\n' +
    '  "visceralFatLevel": مستوى الدهون الحشوية Visceral Fat Level / VFL كرقم,\n' +
    '  "bmr": معدل الحرق الأساسي Basal Metabolic Rate / BMR بالسعرات,\n' +
    '  "totalBodyWater": ماء الجسم الكلي Total Body Water / TBW باللتر,\n' +
    '  "rightArmFatPct": نسبة دهون الذراع الأيمن Right Arm كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "leftArmFatPct": نسبة دهون الذراع الأيسر Left Arm كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "trunkFatPct": نسبة دهون الجذع Trunk كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "rightLegFatPct": نسبة دهون الرجل اليمنى Right Leg كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "leftLegFatPct": نسبة دهون الرجل اليسرى Left Leg كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "rightArmMusclePct": نسبة عضلات الذراع الأيمن كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "leftArmMusclePct": نسبة عضلات الذراع الأيسر كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "trunkMusclePct": نسبة عضلات الجذع كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "rightLegMusclePct": نسبة عضلات الرجل اليمنى كنسبة من المعدل الطبيعي، كرقم بدون %,\n' +
    '  "leftLegMusclePct": نسبة عضلات الرجل اليسرى كنسبة من المعدل الطبيعي، كرقم بدون %\n' +
    '}\n' +
    'ملاحظة مهمة حول الحقول العشرة الأخيرة: هذا هو تحليل "Segmental Lean/Fat Analysis" الموجود عادة في تقرير الإنبودي، ' +
    'وفيه نسبة لكل منطقة من الجسم (Right Arm, Left Arm, Trunk, Right Leg, Left Leg) مقارنة بالمعدل الطبيعي لكل تحليل (الدهون والعضلات) على حدة — ' +
    'خذي كل منطقة كما هي مطبوعة بالضبط، بدون حساب متوسطات أو دمج بين المناطق. ' +
    'إذا لم يتوفر هذا التحليل في التقرير أصلًا، ضعي null لكل الحقول العشرة.';

  // Each uploaded file becomes a pending review item here — never written to
  // state.inbody until she explicitly saves it, and never saved with a guessed
  // date: a reading whose date couldn't be read from the file stays blocked
  // (visibly flagged) until she fills it in herself, since a wrong default
  // (e.g. silently using today's date) would corrupt the trend history.
  let inbodyPdfQueue = []; // [{ uid, fileName, date, values, error }]

  // Reads whatever she may have edited in the still-open review cards back
  // into inbodyPdfQueue before any array mutation or re-render, so editing
  // one card while another file is still being processed (or being saved)
  // never gets silently overwritten.
  function syncPdfQueueDomToState() {
    inbodyPdfQueue.forEach(item => {
      if (item.error) return;
      const dateInput = document.getElementById(`pdfq_${item.uid}_date`);
      if (dateInput) item.date = dateInput.value || null;
      INBODY_ALL_FIELDS.forEach(f => {
        const input = document.getElementById(`pdfq_${item.uid}_${f.key}`);
        if (input) item.values[f.key] = numOrNull(input.value);
      });
    });
  }

  function renderInbodyPdfQueue() {
    const el = document.getElementById('inbodyPdfQueue');
    if (!el) return;
    if (inbodyPdfQueue.length === 0) { el.innerHTML = ''; return; }

    const hasSavable = inbodyPdfQueue.some(q => !q.error);
    el.innerHTML = inbodyPdfQueue.map(item => {
      if (item.error) {
        return `
          <div class="pdf-queue-item" id="pdfq-item-${item.uid}">
            <div class="pdf-queue-head">📄 ${item.fileName}</div>
            <p class="pdf-queue-warning">${item.error}</p>
            <div class="pdf-queue-actions">
              <button type="button" class="btn-secondary" data-pdfq-discard="${item.uid}">🗑️ تجاهل</button>
            </div>
          </div>
        `;
      }
      const missingDate = !item.date;
      return `
        <div class="pdf-queue-item ${missingDate ? 'needs-date' : ''}" id="pdfq-item-${item.uid}">
          <div class="pdf-queue-head">📄 ${item.fileName}</div>
          ${missingDate ? `<p class="pdf-queue-warning">⚠️ لم يُعثر على تاريخ القياس في هذا الملف — تاريخ القياس ضروري، أدخليه قبل الحفظ.</p>` : ''}
          <div class="field">
            <label for="pdfq_${item.uid}_date">تاريخ القراءة</label>
            <input type="date" id="pdfq_${item.uid}_date" value="${item.date || ''}">
          </div>
          <div class="grid-4">
            ${INBODY_FIELDS.map(f => `
              <div class="field">
                <label for="pdfq_${item.uid}_${f.key}">${f.label}${f.unit ? ` (${f.unit})` : ''}</label>
                <input type="number" step="0.1" min="0" id="pdfq_${item.uid}_${f.key}" value="${item.values[f.key] ?? ''}" placeholder="—">
              </div>
            `).join('')}
          </div>
          <p class="pdf-queue-subhead muted">توزيع الدهون والعضلات (إن وُجد في التقرير)</p>
          <div class="grid-4">
            ${SEGMENTAL_FIELDS.map(f => `
              <div class="field">
                <label for="pdfq_${item.uid}_${f.key}">${f.regionLabel} — ${f.metricLabel} (%)</label>
                <input type="number" step="0.1" min="0" id="pdfq_${item.uid}_${f.key}" value="${item.values[f.key] ?? ''}" placeholder="—">
              </div>
            `).join('')}
          </div>
          <div class="pdf-queue-actions">
            <button type="button" class="btn-primary" data-pdfq-save="${item.uid}">💾 حفظ هذه القراءة</button>
            <button type="button" class="btn-secondary" data-pdfq-discard="${item.uid}">🗑️ تجاهل</button>
          </div>
        </div>
      `;
    }).join('') + (hasSavable ? `
      <div class="pdf-queue-actions">
        <button type="button" class="btn-primary" id="pdfqSaveAllBtn">💾 حفظ كل القراءات الجاهزة</button>
      </div>
    ` : '');

    el.querySelectorAll('[data-pdfq-save]').forEach(btn => {
      btn.addEventListener('click', () => commitPdfQueueItem(btn.dataset.pdfqSave));
    });
    el.querySelectorAll('[data-pdfq-discard]').forEach(btn => {
      btn.addEventListener('click', () => discardPdfQueueItem(btn.dataset.pdfqDiscard));
    });
    const saveAllBtn = document.getElementById('pdfqSaveAllBtn');
    if (saveAllBtn) saveAllBtn.addEventListener('click', commitAllReadyPdfQueueItems);
  }

  function discardPdfQueueItem(uid) {
    syncPdfQueueDomToState();
    inbodyPdfQueue = inbodyPdfQueue.filter(q => q.uid !== uid);
    renderInbodyPdfQueue();
  }

  function commitPdfQueueItem(uid) {
    syncPdfQueueDomToState();
    const item = inbodyPdfQueue.find(q => q.uid === uid);
    if (!item || item.error) return;
    if (!item.date) {
      showToast('⚠️ تاريخ القياس ضروري قبل الحفظ — أدخليه أولًا.');
      document.getElementById(`pdfq_${uid}_date`)?.focus();
      return;
    }
    // A reading already on record for this exact date is almost certainly the
    // same report re-uploaded — discard it rather than create a duplicate row.
    if (state.inbody.some(r => r.date === item.date)) {
      inbodyPdfQueue = inbodyPdfQueue.filter(q => q.uid !== uid);
      renderInbodyPdfQueue();
      showToast(`⚠️ يوجد قراءة مسجّلة بالفعل بتاريخ ${item.date} — تم تجاهل (${item.fileName}) كقراءة مكرّرة.`, 8000);
      return;
    }
    const entry = { id: `${item.date}-${Date.now()}-${item.uid}`, date: item.date, ...item.values };
    state.inbody.push(entry);
    state.inbody.sort((a, b) => a.date.localeCompare(b.date));
    saveState();
    inbodyPdfQueue = inbodyPdfQueue.filter(q => q.uid !== uid);
    renderInbodyPdfQueue();
    renderAll();
    showToast(`تم حفظ القراءة (${item.fileName}).`);
  }

  function commitAllReadyPdfQueueItems() {
    syncPdfQueueDomToState();
    const ready = inbodyPdfQueue.filter(q => !q.error && q.date);
    const missing = inbodyPdfQueue.filter(q => !q.error && !q.date).length;
    if (ready.length === 0) {
      showToast(missing ? '⚠️ كل القراءات المتبقية بحاجة لتاريخ القياس قبل الحفظ.' : 'لا توجد قراءات جاهزة للحفظ.');
      return;
    }
    // Reject a date already on record, and reject a second file in this same
    // batch claiming a date another file in the batch already took — either
    // way it's a duplicate reading, discarded rather than saved twice.
    const existingDates = new Set(state.inbody.map(r => r.date));
    const seenInBatch = new Set();
    const saved = [];
    const duplicates = [];
    ready.forEach(item => {
      if (existingDates.has(item.date) || seenInBatch.has(item.date)) {
        duplicates.push(item);
        return;
      }
      seenInBatch.add(item.date);
      saved.push(item);
      state.inbody.push({ id: `${item.date}-${Date.now()}-${item.uid}`, date: item.date, ...item.values });
    });
    if (saved.length) {
      state.inbody.sort((a, b) => a.date.localeCompare(b.date));
      saveState();
    }
    const handledUids = new Set([...saved, ...duplicates].map(q => q.uid));
    inbodyPdfQueue = inbodyPdfQueue.filter(q => q.error || !q.date || !handledUids.has(q.uid));
    renderInbodyPdfQueue();
    if (saved.length) renderAll();
    let msg = saved.length ? `تم حفظ ${saved.length} قراءة.` : '';
    if (duplicates.length) msg += ` تم تجاهل ${duplicates.length} كقراءات مكرّرة (تاريخ موجود مسبقًا).`;
    if (missing) msg += ` وتبقّى ${missing} بحاجة لتاريخ.`;
    showToast(msg.trim() || 'لا توجد قراءات جاهزة للحفظ.');
  }

  document.getElementById('inbodyPdfBtn').addEventListener('click', () => {
    document.getElementById('inbodyPdfInput').click();
  });

  document.getElementById('inbodyPdfInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const statusEl = document.getElementById('inbodyPdfStatus');

    if (!sampleCap) { statusEl.textContent = '⚠️ المساعد الذكي غير متاح في هذا العرض، أدخلي القيم يدويًا.'; return; }

    const limits = await sampleCap.limits().catch(() => null);
    if (!limits || !limits.images) {
      statusEl.textContent = '⚠️ هذا العرض لا يدعم تحليل الصور حاليًا، أدخلي القيم يدويًا.';
      return;
    }
    const maxPages = Math.max(1, Math.min(limits.images.maxCount || 1, 3));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      statusEl.textContent = `⏳ جاري معالجة الملف ${i + 1} من ${files.length}: ${file.name}`;
      const uid = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
      let entry;
      try {
        const blobs = await fileToImageBlobs(file, maxPages, limits);
        if (blobs.length === 0) throw { code: 'render_failed' };

        const data = await sampleCap.json(INBODY_EXTRACT_PROMPT, { images: blobs, modelTier: 'default' });
        const values = {};
        INBODY_ALL_FIELDS.forEach(f => {
          const v = data && data[f.key];
          values[f.key] = (v !== null && v !== undefined && !Number.isNaN(Number(v))) ? Number(v) : null;
        });
        const date = (data && data.date && /^\d{4}-\d{2}-\d{2}$/.test(data.date)) ? data.date : null;
        entry = { uid, fileName: file.name, date, values, error: null };
      } catch (err) {
        console.error('Inbody image/PDF extraction failed for', file.name, err);
        let msg;
        if (err && err.code === 'render_failed') msg = '⚠️ تعذّر تحويل الملف إلى صورة، تأكّدي أنه ملف PDF سليم.';
        else if (err && err.code === 'pdfjs_unavailable') msg = '⚠️ تعذّر تحميل أداة قراءة PDF لهذا الملف، جرّبي رفعه كصورة بدلًا من PDF.';
        else if (err && err.code === 'image_rejected') msg = `⚠️ ${err.message} — جرّبي حفظها كـ JPEG أو PNG ثم رفعها.`;
        else msg = assistantErrorMessage(err) || '⚠️ تعذّر استخراج الأرقام من هذا الملف.';
        entry = { uid, fileName: file.name, error: msg };
      }
      syncPdfQueueDomToState(); // keep edits made to already-shown cards while this file was processing
      inbodyPdfQueue.push(entry);
      renderInbodyPdfQueue();
    }

    statusEl.textContent = '✅ راجعي القراءات المستخرجة أدناه وتأكّدي من تاريخ كل واحدة قبل الحفظ.';
    document.getElementById('inbodyPdfQueue').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    renderMeasureOverview();
    updateMeasurePlaceholders();
    renderInbodyTable();
    renderInbodyOverview();
    renderSegmentalDistribution();
    updateInbodyPlaceholders();
  }

  renderAll();
  initCloudSync();
  initAssistant();
  initDownloads();
})();
