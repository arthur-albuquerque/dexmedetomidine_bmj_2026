const TIMING_LABELS = {
  pre_op: 'Pre-operatively',
  intra_op: 'Intra-operatively',
  post_op: 'Post-operatively',
  unknown: 'Timing not clearly reported'
};

const TIMING_ORDER = ['pre_op', 'intra_op', 'post_op'];

const ROUTE_LABELS = {
  IV: 'Intravenous',
  IN: 'Intranasal',
  INH: 'Inhalational',
  PO: 'Oral',
  IM: 'Intramuscular',
  'IN+IV': 'Intranasal + Intravenous',
  'INH+IV': 'Inhalational + Intravenous',
  Unknown: 'Not clearly reported'
};

const ROB_ORDER = ['High risk', 'Some concerns', 'Low risk'];

const DOSE_BAND_LABELS = {
  '0-0.2': '0.0 to 0.2 mcg/kg/h',
  '0.2-0.5': '0.2 to 0.5 mcg/kg/h',
  '0.5-0.8': '0.5 to 0.8 mcg/kg/h',
  '>0.8': 'Above 0.8 mcg/kg/h',
  bolus_only: 'Bolus only',
  not_reported: 'Dosage not reported',
  not_weight_normalized: 'Infusion not weight-normalized'
};

const DOSE_BAND_ORDER = ['0-0.2', '0.2-0.5', '0.5-0.8', '>0.8', 'bolus_only', 'not_weight_normalized', 'not_reported'];
const THEME_KEY = 'dex-theme';
const DATA_VERSION = '20260214-20';
const TRIAL_SUFFIX_PATTERN = /_p\d+$/i;
const DEFAULT_META_X_LIMITS = [0.1, 3.5];
const DEFAULT_META_X_TICKS = [0.1, 0.3, 0.7, 1, 3];
const META_PLOT_WIDTH = 300;
const META_PLOT_HEIGHT = 34;
const META_PLOT_PAD_LEFT = 18;
const META_PLOT_PAD_RIGHT = 12;

const state = {
  trials: [],
  filtered: [],
  tableFiltered: [],
  activeTab: 'overview',
  filters: {
    rob: [],
    timing: [],
    route: [],
    dose: []
  },
  tableFilters: {
    study: [],
    country: [],
    rob: [],
    bolus: [],
    infusion: [],
    timing: [],
    route: []
  },
  meta: {
    loaded: false,
    rows: [],
    rowsByTrialId: new Map(),
    overall: null,
    gridOr: [],
    xLimitsOr: DEFAULT_META_X_LIMITS,
    xTicksOr: DEFAULT_META_X_TICKS,
    allCounts: {
      dex_events: 0,
      dex_total: 0,
      control_events: 0,
      control_total: 0
    },
    coverage: null
  }
};

function timingLabel(value) {
  return TIMING_LABELS[value] || 'Timing not clearly reported';
}

function routeLabel(value) {
  return ROUTE_LABELS[value] || value;
}

function doseBandLabel(value) {
  return DOSE_BAND_LABELS[value] || value;
}

function canonicalTrialId(value) {
  return String(value || '').trim().replace(TRIAL_SUFFIX_PATTERN, '');
}

function isFilterActive(values) {
  return Array.isArray(values) && values.length > 0;
}

function matchesMultiSelect(value, selectedValues) {
  if (!isFilterActive(selectedValues)) return true;
  return selectedValues.includes(value);
}

function summarizeFilterSelection(selectedValues, labeler, allLabel) {
  if (!selectedValues || selectedValues.length === 0) return allLabel;
  if (selectedValues.length === 1) return labeler(selectedValues[0]);
  return `${selectedValues.length} selected`;
}

function closeAllFilterPopovers() {
  document.querySelectorAll('.filter-popover[open]').forEach((element) => {
    element.open = false;
  });
}

function bindPopoverDismissBehavior() {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.filter-popover')) return;
    closeAllFilterPopovers();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAllFilterPopovers();
    }
  });
}

function setupCheckboxPopoverFilter({
  id,
  values,
  labeler,
  stateGroup,
  stateKey,
  allLabel,
  onChange
}) {
  const details = document.getElementById(id);
  if (!details) return () => {};
  const trigger = details.querySelector('.popover-trigger');
  const menu = details.querySelector('.popover-menu');
  if (!trigger || !menu) return () => {};

  menu.innerHTML = '';
  const checkboxNodes = [];

  values.forEach((value, index) => {
    const checkboxId = `${id}-opt-${index}`;
    const option = document.createElement('label');
    option.className = 'filter-option';
    option.setAttribute('for', checkboxId);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = checkboxId;
    checkbox.value = value;

    const text = document.createElement('span');
    text.textContent = labeler(value);

    option.appendChild(checkbox);
    option.appendChild(text);
    menu.appendChild(option);
    checkboxNodes.push(checkbox);
  });

  function syncFromState() {
    const selected = stateGroup[stateKey] || [];
    checkboxNodes.forEach((checkbox) => {
      checkbox.checked = selected.includes(checkbox.value);
    });
    trigger.textContent = summarizeFilterSelection(selected, labeler, allLabel);
  }

  checkboxNodes.forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const selectedSet = new Set(
        checkboxNodes.filter((node) => node.checked).map((node) => node.value)
      );
      stateGroup[stateKey] = values.filter((value) => selectedSet.has(value));
      if (typeof onChange === 'function') {
        onChange();
      }
      syncFromState();
      rerender();
    });
  });

  syncFromState();
  return syncFromState;
}

function clearFilterStateInPlace() {
  Object.keys(state.filters).forEach((key) => {
    state.filters[key] = [];
  });
  Object.keys(state.tableFilters).forEach((key) => {
    state.tableFilters[key] = [];
  });
}

function parseFlags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(';').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeTrial(row) {
  return {
    ...row,
    validation_flags: parseFlags(row.validation_flags),
    critical_flags: parseFlags(row.critical_flags)
  };
}

function constrainTrialsToMeta(trials, metaState) {
  if (!metaState || !metaState.loaded || !(metaState.rowsByTrialId instanceof Map)) return trials;
  if (metaState.rowsByTrialId.size === 0) return trials;
  const allowedIds = new Set(metaState.rowsByTrialId.keys());
  return trials.filter((row) => allowedIds.has(canonicalTrialId(row.trial_id)));
}

function doseBand(trial) {
  if (trial.infusion_low == null || trial.infusion_high == null) {
    if (trial.bolus_value != null) return 'bolus_only';
    return 'not_reported';
  }
  if (!trial.infusion_weight_normalized || trial.infusion_unit !== 'mcg/kg/h') return 'not_weight_normalized';

  const midpoint = (trial.infusion_low + trial.infusion_high) / 2;
  if (midpoint <= 0.2) return '0-0.2';
  if (midpoint <= 0.5) return '0.2-0.5';
  if (midpoint <= 0.8) return '0.5-0.8';
  return '>0.8';
}

function countTrials(rows, getter) {
  const map = new Map();
  rows.forEach((row) => {
    const key = getter(row) || 'unknown';
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

function renderChartFallback(containerId, message) {
  const element = document.getElementById(containerId);
  if (!element) return;
  element.innerHTML = `<p class="chart-fallback">${escapeHtml(message)}</p>`;
}

function hasPlotly() {
  return typeof window !== 'undefined' && typeof window.Plotly !== 'undefined';
}

function formatBolus(row) {
  if (row.bolus_value == null) return 'Not reported';
  return `${row.bolus_value} ${row.bolus_unit || ''}`.trim();
}

function formatInfusion(row) {
  if (row.infusion_low == null) return 'Not reported';
  if (row.infusion_high == null || row.infusion_low === row.infusion_high) {
    return `${row.infusion_low} ${row.infusion_unit || ''}`.trim();
  }
  return `${row.infusion_low} to ${row.infusion_high} ${row.infusion_unit || ''}`.trim();
}

function robClass(rob) {
  if (rob === 'Low risk') return 'rob-low';
  if (rob === 'High risk') return 'rob-high';
  return 'rob-some';
}

function applyFilters() {
  state.filtered = state.trials.filter((row) => {
    if (!matchesMultiSelect(row.rob_overall_std, state.filters.rob)) return false;
    if (!matchesMultiSelect(row.timing_phase, state.filters.timing)) return false;
    if (!matchesMultiSelect(row.route_std, state.filters.route)) return false;
    if (!matchesMultiSelect(doseBand(row), state.filters.dose)) return false;
    return true;
  });
}

function applyTableFilters() {
  state.tableFiltered = state.filtered.filter((row) => {
    const countryValue = row.country || 'Not reported';
    const bolusValue = formatBolus(row);
    const infusionValue = formatInfusion(row);

    if (!matchesMultiSelect(row.study_label, state.tableFilters.study)) return false;
    if (!matchesMultiSelect(countryValue, state.tableFilters.country)) return false;
    if (!matchesMultiSelect(row.rob_overall_std, state.tableFilters.rob)) return false;
    if (!matchesMultiSelect(bolusValue, state.tableFilters.bolus)) return false;
    if (!matchesMultiSelect(infusionValue, state.tableFilters.infusion)) return false;
    if (!matchesMultiSelect(row.timing_phase, state.tableFilters.timing)) return false;
    if (!matchesMultiSelect(row.route_std, state.tableFilters.route)) return false;
    return true;
  });
}

function renderStats() {
  const totalNode = document.getElementById('trials-total');
  const participantsNode = document.getElementById('participants-total');
  const intraNode = document.getElementById('trials-intra');
  const postNode = document.getElementById('trials-post');
  const preNode = document.getElementById('trials-pre');
  if (!totalNode || !participantsNode || !intraNode || !postNode || !preNode) return;

  const totalTrials = state.tableFiltered.length;
  const participants = state.tableFiltered.reduce((acc, row) => acc + Number(row.n_total || 0), 0);

  const intraTrials = state.tableFiltered.filter((row) => row.timing_phase === 'intra_op').length;
  const postTrials = state.tableFiltered.filter((row) => row.timing_phase === 'post_op').length;
  const preTrials = state.tableFiltered.filter((row) => row.timing_phase === 'pre_op').length;

  totalNode.textContent = String(totalTrials);
  participantsNode.textContent = participants.toLocaleString();
  intraNode.textContent = String(intraTrials);
  postNode.textContent = String(postTrials);
  preNode.textContent = String(preTrials);
}

function renderDoseChart() {
  if (!document.getElementById('dose-chart')) return;
  if (!hasPlotly()) {
    renderChartFallback('dose-chart', 'Chart unavailable: Plotly failed to load.');
    return;
  }

  const isDark = document.body.classList.contains('theme-dark');
  const doseSummary = new Map();
  const robCategories = new Set();

  state.tableFiltered.forEach((row) => {
    const band = doseBand(row);
    const rob = row.rob_overall_std || 'Some concerns';
    robCategories.add(rob);
    if (!doseSummary.has(band)) {
      doseSummary.set(band, { total: 0, robCounts: new Map() });
    }
    const bucket = doseSummary.get(band);
    bucket.total += 1;
    bucket.robCounts.set(rob, (bucket.robCounts.get(rob) || 0) + 1);
  });

  const doseKeys = DOSE_BAND_ORDER.filter((key) => doseSummary.has(key));
  const doseLabels = doseKeys.map((key) => doseBandLabel(key));
  const totals = doseKeys.map((key) => doseSummary.get(key).total);

  const orderedRobs = ROB_ORDER.filter((rob) => robCategories.has(rob));
  const extraRobs = [...robCategories].filter((rob) => !ROB_ORDER.includes(rob)).sort((a, b) => a.localeCompare(b));
  const robKeys = [...orderedRobs, ...extraRobs];

  const robPalette = isDark
    ? {
        'High risk': '#ff6b6b',
        'Some concerns': '#f3d34a',
        'Low risk': '#53c653'
      }
    : {
        'High risk': '#e63737',
        'Some concerns': '#f2d100',
        'Low risk': '#50b848'
      };

  const traces = robKeys.map((rob) => {
    const counts = doseKeys.map((band) => doseSummary.get(band).robCounts.get(rob) || 0);
    const customdata = counts.map((count, index) => {
      const total = totals[index];
      const percent = total > 0 ? (count / total) * 100 : 0;
      const roundedPercent = Math.round(percent * 10) / 10;
      const percentLabel = Number.isInteger(roundedPercent)
        ? `${roundedPercent.toFixed(0)}%`
        : `${roundedPercent.toFixed(1)}%`;
      return [count, total, percentLabel];
    });

    return {
      type: 'bar',
      name: rob,
      x: doseLabels,
      y: counts,
      customdata,
      marker: { color: robPalette[rob] || (isDark ? '#8bb4d8' : '#5d88b0') },
      hovertemplate:
        '<b>%{x}</b><br>Risk of Bias: %{fullData.name}<br>Trials %{customdata[0]} of %{customdata[1]} (%{customdata[2]})<extra></extra>'
    };
  });

  const maxTotal = totals.length > 0 ? Math.max(...totals) : 0;
  const annotationOffset = Math.max(0.2, maxTotal * 0.06);
  const annotations = doseLabels.map((label, index) => ({
    x: label,
    y: totals[index] + annotationOffset,
    text: `n=${totals[index]}`,
    showarrow: false,
    font: { family: 'IBM Plex Sans, sans-serif', size: 13, color: isDark ? '#d8e7f5' : '#1d3f5e' }
  }));

  window.Plotly.react(
    'dose-chart',
    traces,
    {
      barmode: 'stack',
      margin: { l: 28, r: 12, b: 120, t: 40 },
      annotations,
      legend: {
        title: { text: 'Risk of Bias' },
        orientation: 'h',
        x: 0,
        y: 1.2
      },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Sans, sans-serif', color: isDark ? '#d8e7f5' : '#1d3f5e' },
      xaxis: {
        tickangle: -18,
        automargin: true,
        showline: false,
        showgrid: false,
        zeroline: false
      },
      yaxis: {
        title: { text: 'Number of trials' },
        rangemode: 'tozero',
        range: [0, maxTotal + annotationOffset * 3],
        dtick: 1,
        showline: false,
        showgrid: false,
        zeroline: false,
        showticklabels: false,
        ticks: ''
      }
    },
    { responsive: true, displayModeBar: false }
  );
}

function renderTimingChart() {
  if (!document.getElementById('timing-chart')) return;
  if (!hasPlotly()) {
    renderChartFallback('timing-chart', 'Chart unavailable: Plotly failed to load.');
    return;
  }

  const isDark = document.body.classList.contains('theme-dark');
  const counts = countTrials(state.tableFiltered, (row) => row.timing_phase || 'unknown');
  const keys = TIMING_ORDER.filter((key) => counts.has(key));
  const labels = keys.map((key) => timingLabel(key));
  const values = keys.map((key) => counts.get(key));

  window.Plotly.react(
    'timing-chart',
    [
      {
        type: 'bar',
        orientation: 'h',
        y: labels,
        x: values,
        marker: { color: isDark ? '#3fc8b9' : '#1f8f85' },
        text: values,
        textposition: 'outside',
        cliponaxis: false,
        hovertemplate: '%{y}<br>%{x} trial(s)<extra></extra>'
      }
    ],
    {
      margin: { l: 185, r: 15, b: 40, t: 10 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Sans, sans-serif', color: isDark ? '#d8e7f5' : '#1d3f5e' },
      xaxis: {
        rangemode: 'tozero',
        dtick: 1,
        showline: false,
        showgrid: false,
        zeroline: false,
        showticklabels: false,
        ticks: ''
      }
    },
    { responsive: true, displayModeBar: false }
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeStudyUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return trimmed;
  }
  return '';
}

function renderTable() {
  const body = document.getElementById('trials-body');
  if (!body) return;
  body.innerHTML = '';

  state.tableFiltered.forEach((row) => {
    const studyUrl = normalizeStudyUrl(row.study_url);
    const studyLabel = escapeHtml(row.study_label);
    const studyCell = studyUrl
      ? `<a class="study-link" href="${escapeHtml(studyUrl)}" target="_blank" rel="noopener noreferrer">${studyLabel}</a>`
      : `<span class="study-name">${studyLabel}</span>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${studyCell}</td>
      <td>${escapeHtml(row.country || 'Not reported')}</td>
      <td><span class="rob-pill ${robClass(row.rob_overall_std)}">${escapeHtml(row.rob_overall_std)}</span></td>
      <td>${escapeHtml(formatBolus(row))}</td>
      <td>${escapeHtml(formatInfusion(row))}</td>
      <td>${escapeHtml(timingLabel(row.timing_phase))}</td>
      <td>${escapeHtml(routeLabel(row.route_std))}</td>
    `;
    body.appendChild(tr);
  });
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseMetaBundle(rawBundle) {
  if (!rawBundle || !Array.isArray(rawBundle.rows)) return null;

  const gridOrRaw = Array.isArray(rawBundle.grid_or) ? rawBundle.grid_or : [];
  const gridOr = gridOrRaw
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (gridOr.length < 10) return null;

  const xLimits = Array.isArray(rawBundle.x_limits_or) && rawBundle.x_limits_or.length === 2
    ? rawBundle.x_limits_or.map((value) => Number(value))
    : DEFAULT_META_X_LIMITS;
  const xTicksRaw = Array.isArray(rawBundle.x_ticks_or) && rawBundle.x_ticks_or.length > 1
    ? rawBundle.x_ticks_or.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
    : DEFAULT_META_X_TICKS;
  const xTicks = [...new Set([...xTicksRaw, 0.7])].sort((a, b) => a - b);

  const rows = rawBundle.rows
    .map((row) => {
      const trialIdCanonical = canonicalTrialId(row.trial_id_canonical || row.trial_id);
      const dexArmIndex = Number(row.dex_arm_index);
      if (!trialIdCanonical || !Number.isFinite(dexArmIndex)) return null;

      const densityNormRaw = Array.isArray(row.density_norm) ? row.density_norm : [];
      const densityNorm = gridOr.map((_, index) => {
        const value = Number(densityNormRaw[index]);
        return Number.isFinite(value) && value >= 0 ? value : 0;
      });

      return {
        comparisonId: String(row.comparison_id || `${trialIdCanonical}__arm${dexArmIndex}`),
        trialIdCanonical,
        studyLabel: String(row.study_label || trialIdCanonical.replaceAll('_', ' ')),
        dexArmIndex,
        dexArmLabel: String(row.dex_arm_label || '').trim(),
        dexEvents: Number(row.dex_events || 0),
        dexTotal: Number(row.dex_total || 0),
        controlEvents: Number(row.control_events || 0),
        controlTotal: Number(row.control_total || 0),
        hasModel: Boolean(row.has_model),
        shrinkageOr: parsePositiveNumber(row.shrinkage_or),
        shrinkageOrLow: parsePositiveNumber(row.shrinkage_or_low),
        shrinkageOrHigh: parsePositiveNumber(row.shrinkage_or_high),
        crudeOr: parsePositiveNumber(row.crude_or),
        crudeOrLow: parsePositiveNumber(row.crude_or_low),
        crudeOrHigh: parsePositiveNumber(row.crude_or_high),
        densityNorm
      };
    })
    .filter(Boolean);

  const rowsByTrialId = new Map();
  rows.forEach((row) => {
    if (!rowsByTrialId.has(row.trialIdCanonical)) {
      rowsByTrialId.set(row.trialIdCanonical, []);
    }
    rowsByTrialId.get(row.trialIdCanonical).push(row);
  });
  rowsByTrialId.forEach((studyRows) => {
    studyRows.sort((a, b) => a.dexArmIndex - b.dexArmIndex);
  });

  const overall = rawBundle.overall
    ? {
        medianOr: parsePositiveNumber(rawBundle.overall.median_or),
        lowerOr: parsePositiveNumber(rawBundle.overall.lower_or),
        upperOr: parsePositiveNumber(rawBundle.overall.upper_or),
        densityNorm: gridOr.map((_, index) => {
          const raw =
            Array.isArray(rawBundle.overall.density_norm) && index < rawBundle.overall.density_norm.length
              ? Number(rawBundle.overall.density_norm[index])
              : 0;
          return Number.isFinite(raw) && raw >= 0 ? raw : 0;
        })
      }
    : null;

  const allCounts = rawBundle.all_counts || {};
  return {
    loaded: true,
    rows,
    rowsByTrialId,
    overall,
    gridOr,
    xLimitsOr:
      xLimits.length === 2 && xLimits[0] > 0 && xLimits[1] > xLimits[0]
        ? xLimits
        : DEFAULT_META_X_LIMITS,
    xTicksOr: xTicks.length > 1 ? xTicks : DEFAULT_META_X_TICKS,
    allCounts: {
      dex_events: Number(allCounts.dex_events || 0),
      dex_total: Number(allCounts.dex_total || 0),
      control_events: Number(allCounts.control_events || 0),
      control_total: Number(allCounts.control_total || 0)
    },
    coverage: rawBundle.coverage || null
  };
}

function ensureMetaBundleShape() {
  if (state.meta && state.meta.loaded) return;
  state.meta = {
    loaded: false,
    rows: [],
    rowsByTrialId: new Map(),
    overall: null,
    gridOr: [],
    xLimitsOr: DEFAULT_META_X_LIMITS,
    xTicksOr: DEFAULT_META_X_TICKS,
    allCounts: {
      dex_events: 0,
      dex_total: 0,
      control_events: 0,
      control_total: 0
    },
    coverage: null
  };
}

function formatArmSuffix(dexArmLabel, dexArmIndex) {
  const raw = String(dexArmLabel || '').trim();
  if (!raw) return `arm ${dexArmIndex}`;

  let cleaned = raw.replace(/^dexmedetomidine\s*/i, '').trim();
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/^dex\s*\d+\s*,\s*/i, '').trim();
  cleaned = cleaned.replace(/^dex\s*\d+\s*-\s*/i, '').trim();
  if (!cleaned) return `arm ${dexArmIndex}`;
  return cleaned;
}

function metaFormatNumber(value) {
  return Number(value).toFixed(2);
}

function formatOrInterval(median, lower, upper) {
  if (![median, lower, upper].every((value) => Number.isFinite(value))) return 'Not available';
  return `${metaFormatNumber(median)} [${metaFormatNumber(lower)}, ${metaFormatNumber(upper)}]`;
}

function formatCounts(events, total) {
  return `${Number(events)}/${Number(total)}`;
}

function createSvgNode(tagName, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  Object.entries(attrs).forEach(([name, value]) => {
    node.setAttribute(name, String(value));
  });
  return node;
}

function smoothDensity(values, passes = 1) {
  if (!Array.isArray(values) || values.length < 5 || passes < 1) return values || [];
  let output = values.slice();
  for (let pass = 0; pass < passes; pass += 1) {
    const next = output.slice();
    for (let i = 2; i < output.length - 2; i += 1) {
      next[i] =
        (output[i - 2] + 2 * output[i - 1] + 3 * output[i] + 2 * output[i + 1] + output[i + 2]) / 9;
    }
    output = next;
  }
  const peak = Math.max(...output, 0);
  if (peak <= 0) return output.map(() => 0);
  return output.map((value) => value / peak);
}

function makeDensityPoints({
  gridOr,
  densityNorm,
  xMin,
  xMax,
  scaleX,
  baselineY,
  amplitude
}) {
  const points = [];
  const n = Math.min(gridOr.length, densityNorm.length);
  for (let i = 0; i < n; i += 1) {
    const xValue = Number(gridOr[i]);
    const dValue = Number(densityNorm[i]);
    if (!Number.isFinite(xValue) || !Number.isFinite(dValue)) continue;
    if (xValue < xMin || xValue > xMax) continue;
    const yValue = baselineY - Math.max(0, Math.min(1, dValue)) * amplitude;
    points.push({ x: scaleX(xValue), y: yValue });
  }
  return points;
}

function pointsToPath(points) {
  if (!points.length) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
}

function metaXScaleFactory(xLimitsOr) {
  const [xMin, xMax] = xLimitsOr;
  const logMin = Math.log(xMin);
  const logMax = Math.log(xMax);
  const plotWidth = META_PLOT_WIDTH - META_PLOT_PAD_LEFT - META_PLOT_PAD_RIGHT;
  return (orValue) => {
    const ratio = (Math.log(orValue) - logMin) / (logMax - logMin);
    return META_PLOT_PAD_LEFT + Math.max(0, Math.min(1, ratio)) * plotWidth;
  };
}

function getMetaPalette() {
  const isDark = document.body.classList.contains('theme-dark');
  return {
    grid: isDark ? '#2d4459' : '#d5d5d5',
    vlineMain: isDark ? '#f4f8ff' : '#111111',
    vlineOverall: isDark ? '#b5bfcb' : '#6d6d6d',
    shrinkage: '#9f33ff',
    pooledFill: isDark ? '#2f6dff' : '#1f53ff',
    pooledStroke: isDark ? '#8db0ff' : '#1543d4',
    observedStroke: isDark ? '#f1f6ff' : '#111111',
    observedFill: isDark ? '#0f1f30' : '#ffffff',
    axisText: isDark ? '#d8e7f5' : '#1d3f5e'
  };
}

function buildMetaRowPlotSvg(rowConfig) {
  const {
    gridOr,
    xLimitsOr,
    overall,
    row,
    isPooled
  } = rowConfig;

  const palette = getMetaPalette();
  const width = META_PLOT_WIDTH;
  const height = META_PLOT_HEIGHT;
  const baselineY = Math.round(height * 0.56);
  const amplitude = isPooled ? 9.8 : 8.8;
  const [xMin, xMax] = xLimitsOr;
  const scaleX = metaXScaleFactory(xLimitsOr);
  const densityNorm = isPooled ? smoothDensity(row.densityNorm || [], 5) : row.densityNorm || [];

  const svg = createSvgNode('svg', {
    class: 'meta-plot-svg',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-hidden': 'true'
  });

  const baseline = createSvgNode('line', {
    x1: META_PLOT_PAD_LEFT,
    y1: baselineY,
    x2: width - META_PLOT_PAD_RIGHT,
    y2: baselineY,
    stroke: palette.grid,
    'stroke-width': 1
  });
  svg.appendChild(baseline);

  const oneLine = createSvgNode('line', {
    x1: scaleX(1),
    y1: 2,
    x2: scaleX(1),
    y2: height - 2,
    stroke: palette.vlineMain,
    'stroke-width': 1.5
  });
  svg.appendChild(oneLine);

  if (overall && Number.isFinite(overall.medianOr)) {
    const overallLine = createSvgNode('line', {
      x1: scaleX(overall.medianOr),
      y1: 2,
      x2: scaleX(overall.medianOr),
      y2: height - 2,
      stroke: palette.vlineOverall,
      'stroke-width': 1.2
    });
    svg.appendChild(overallLine);
  }
  if (overall && Number.isFinite(overall.lowerOr)) {
    const lowerLine = createSvgNode('line', {
      x1: scaleX(overall.lowerOr),
      y1: 2,
      x2: scaleX(overall.lowerOr),
      y2: height - 2,
      stroke: palette.vlineOverall,
      'stroke-width': 1,
      'stroke-dasharray': '4 4'
    });
    svg.appendChild(lowerLine);
  }
  if (overall && Number.isFinite(overall.upperOr)) {
    const upperLine = createSvgNode('line', {
      x1: scaleX(overall.upperOr),
      y1: 2,
      x2: scaleX(overall.upperOr),
      y2: height - 2,
      stroke: palette.vlineOverall,
      'stroke-width': 1,
      'stroke-dasharray': '4 4'
    });
    svg.appendChild(upperLine);
  }

  const densityPoints = makeDensityPoints({
    gridOr,
    densityNorm,
    xMin,
    xMax,
    scaleX,
    baselineY,
    amplitude
  });

  if (densityPoints.length > 1) {
    if (isPooled) {
      const areaPath = [
        `M ${densityPoints[0].x.toFixed(2)} ${baselineY.toFixed(2)}`,
        ...densityPoints.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
        `L ${densityPoints[densityPoints.length - 1].x.toFixed(2)} ${baselineY.toFixed(2)}`,
        'Z'
      ].join(' ');
      svg.appendChild(
        createSvgNode('path', {
          d: areaPath,
          fill: palette.pooledFill,
          opacity: 0.9
        })
      );
      svg.appendChild(
        createSvgNode('path', {
          d: pointsToPath(densityPoints),
          fill: 'none',
          stroke: palette.pooledStroke,
          'stroke-width': 1.6
        })
      );
    } else {
      svg.appendChild(
        createSvgNode('path', {
          d: pointsToPath(densityPoints),
          fill: 'none',
          stroke: palette.shrinkage,
          'stroke-width': 1.8,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        })
      );
    }
  }

  if (!isPooled && Number.isFinite(row.crudeOr) && row.crudeOr > 0) {
    svg.appendChild(
      createSvgNode('circle', {
        cx: scaleX(row.crudeOr),
        cy: baselineY - 2,
        r: 5.8,
        fill: palette.observedFill,
        stroke: palette.observedStroke,
        'stroke-width': 1.2
      })
    );
  }

  return svg;
}

function buildMetaAxisSvg({ xLimitsOr, xTicksOr }) {
  const palette = getMetaPalette();
  const width = META_PLOT_WIDTH;
  const height = 56;
  const axisY = 12;
  const [xMin, xMax] = xLimitsOr;
  const scaleX = metaXScaleFactory(xLimitsOr);

  const svg = createSvgNode('svg', {
    class: 'meta-axis-svg',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-hidden': 'true'
  });

  svg.appendChild(
    createSvgNode('line', {
      x1: META_PLOT_PAD_LEFT,
      y1: axisY,
      x2: width - META_PLOT_PAD_RIGHT,
      y2: axisY,
      stroke: palette.vlineMain,
      'stroke-width': 1.7
    })
  );

  xTicksOr.forEach((tick) => {
    if (!Number.isFinite(tick) || tick <= 0 || tick < xMin || tick > xMax) return;
    const x = scaleX(tick);
    svg.appendChild(
      createSvgNode('line', {
        x1: x,
        y1: axisY,
        x2: x,
        y2: axisY + 5,
        stroke: palette.vlineMain,
        'stroke-width': 1.2
      })
    );
    const label = createSvgNode('text', {
      x,
      y: axisY + 17,
      fill: palette.axisText,
      'font-size': '12.5',
      'text-anchor': 'middle',
      'font-family': 'IBM Plex Sans, sans-serif'
    });
    label.textContent = tick === 1 ? '1.0' : String(tick);
    svg.appendChild(label);
  });

  const axisTitle = createSvgNode('text', {
    x: width / 2,
    y: height - 5,
    fill: palette.axisText,
    'font-size': '16.8',
    'font-weight': '500',
    'text-anchor': 'middle',
    'font-family': 'IBM Plex Sans, sans-serif'
  });
  axisTitle.textContent = 'Odds Ratio (log scale)';
  svg.appendChild(axisTitle);

  return svg;
}

function makeMetaCell(text, classNames = []) {
  const cell = document.createElement('div');
  cell.className = ['meta-cell', ...classNames].join(' ').trim();
  cell.textContent = text;
  return cell;
}

function makeMetaPlotCell(svgNode, classNames = []) {
  const cell = document.createElement('div');
  cell.className = ['meta-plot-cell', ...classNames].join(' ').trim();
  if (svgNode) cell.appendChild(svgNode);
  return cell;
}

function selectMetaRowsForCurrentFilter() {
  const selectedStudyLabels = new Map();
  state.tableFiltered.forEach((trialRow) => {
    const trialId = canonicalTrialId(trialRow.trial_id);
    if (!trialId || selectedStudyLabels.has(trialId)) return;
    selectedStudyLabels.set(trialId, trialRow.study_label || trialId.replaceAll('_', ' '));
  });

  const filteredRows = [];
  const missingInMeta = [];
  const modelMissing = new Set();

  [...selectedStudyLabels.entries()].forEach(([trialId, appStudyLabel]) => {
    const candidates = state.meta.rowsByTrialId.get(trialId) || [];
    if (candidates.length === 0) {
      missingInMeta.push(appStudyLabel);
      return;
    }

    const candidatesWithModel = candidates.filter((row) => row.hasModel);
    if (candidatesWithModel.length === 0) {
      modelMissing.add(appStudyLabel);
      return;
    }

    if (candidates.length > candidatesWithModel.length) {
      modelMissing.add(appStudyLabel);
    }

    const hasMultipleArms = candidatesWithModel.length > 1;
    candidatesWithModel.forEach((row) => {
      const displayLabel = hasMultipleArms
        ? `${appStudyLabel} (${formatArmSuffix(row.dexArmLabel, row.dexArmIndex)})`
        : appStudyLabel;
      filteredRows.push({
        ...row,
        displayLabel
      });
    });
  });

  filteredRows.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));
  return {
    rows: filteredRows,
    missingInMeta,
    modelMissing: [...modelMissing].sort((a, b) => a.localeCompare(b))
  };
}

function renderMetaForest() {
  const host = document.getElementById('meta-forest');
  const coverageNode = document.getElementById('meta-coverage-note');
  if (!host || !coverageNode) return;
  host.innerHTML = '';

  if (!state.meta.loaded) {
    coverageNode.textContent = 'Meta-analysis bundle not loaded.';
    host.innerHTML = '<p class="chart-fallback">Meta-analysis data unavailable for this build.</p>';
    return;
  }

  const selected = selectMetaRowsForCurrentFilter();
  if (selected.rows.length === 0) {
    const notes = [];
    if (selected.missingInMeta.length > 0) notes.push(`${selected.missingInMeta.length} study labels are not mapped to the meta-analysis table`);
    if (selected.modelMissing.length > 0) {
      notes.push(
        `${selected.modelMissing.join(', ')} ${
          selected.modelMissing.length === 1 ? 'is' : 'are'
        } missing in the current model summary files`
      );
    }
    coverageNode.textContent = notes.length ? `${notes.join('; ')}.` : 'No studies match the active filters.';
    host.innerHTML = '<p class="chart-fallback">No meta-analysis rows available for the current filters.</p>';
    return;
  }

  const coverageNotes = [];
  if (selected.missingInMeta.length > 0) {
    coverageNotes.push(`${selected.missingInMeta.length} selected studies are missing from the arm-level meta table`);
  }
  if (selected.modelMissing.length > 0) {
    coverageNotes.push(
      `${selected.modelMissing.join(', ')} ${
        selected.modelMissing.length === 1 ? 'is' : 'are'
      } selected but absent from current posterior summary CSVs`
    );
  }
  coverageNode.textContent = coverageNotes.length ? `${coverageNotes.join('; ')}.` : 'Showing all selected studies with posterior shrinkage and observed OR.';

  const filteredCounts = selected.rows.reduce(
    (acc, row) => {
      acc.dex_events += row.dexEvents;
      acc.dex_total += row.dexTotal;
      acc.control_events += row.controlEvents;
      acc.control_total += row.controlTotal;
      return acc;
    },
    { dex_events: 0, dex_total: 0, control_events: 0, control_total: 0 }
  );

  const overall = state.meta.overall || {};
  const pooledRow = {
    displayLabel: 'Pooled Effect',
    dexEvents: filteredCounts.dex_events,
    dexTotal: filteredCounts.dex_total,
    controlEvents: filteredCounts.control_events,
    controlTotal: filteredCounts.control_total,
    shrinkageOr: overall.medianOr,
    shrinkageOrLow: overall.lowerOr,
    shrinkageOrHigh: overall.upperOr,
    crudeOr: null,
    crudeOrLow: null,
    crudeOrHigh: null,
    densityNorm: Array.isArray(overall.densityNorm) ? overall.densityNorm : []
  };

  const grid = document.createElement('div');
  grid.className = 'meta-forest-grid';

  grid.appendChild(makeMetaCell('Study', ['meta-cell-head']));
  grid.appendChild(makeMetaCell('Dexmedetomidine\n(Events/Total)', ['meta-cell-head']));
  grid.appendChild(makeMetaCell('Control\n(Events/Total)', ['meta-cell-head']));

  const plotHead = document.createElement('div');
  plotHead.className = 'meta-cell meta-cell-head meta-plot-head';
  plotHead.innerHTML = `
    <div class="meta-favours">
      <span>Favours<br>Dexmedetomidine</span>
      <span>Favours<br>Control</span>
    </div>
  `;
  grid.appendChild(plotHead);

  grid.appendChild(makeMetaCell('Shrinkage OR\n[95% CrI]', ['meta-cell-head']));
  grid.appendChild(makeMetaCell('Observed OR\n[95% CI]', ['meta-cell-head']));

  selected.rows.forEach((row) => {
    grid.appendChild(makeMetaCell(row.displayLabel, ['meta-study-col']));
    grid.appendChild(makeMetaCell(formatCounts(row.dexEvents, row.dexTotal), ['meta-count-col']));
    grid.appendChild(makeMetaCell(formatCounts(row.controlEvents, row.controlTotal), ['meta-count-col']));
    grid.appendChild(
      makeMetaPlotCell(
        buildMetaRowPlotSvg({
          row,
          isPooled: false,
          gridOr: state.meta.gridOr,
          xLimitsOr: state.meta.xLimitsOr,
          overall: state.meta.overall
        })
      )
    );
    grid.appendChild(makeMetaCell(formatOrInterval(row.shrinkageOr, row.shrinkageOrLow, row.shrinkageOrHigh)));
    grid.appendChild(makeMetaCell(formatOrInterval(row.crudeOr, row.crudeOrLow, row.crudeOrHigh)));
  });

  const pooledCountTreatmentCompact = formatCounts(pooledRow.dexEvents, pooledRow.dexTotal);
  const pooledCountControlCompact = formatCounts(pooledRow.controlEvents, pooledRow.controlTotal);

  grid.appendChild(makeMetaCell(pooledRow.displayLabel, ['meta-study-col', 'meta-row-pooled']));
  grid.appendChild(makeMetaCell(pooledCountTreatmentCompact, ['meta-count-col', 'meta-row-pooled']));
  grid.appendChild(makeMetaCell(pooledCountControlCompact, ['meta-count-col', 'meta-row-pooled']));
  grid.appendChild(
    makeMetaPlotCell(
      buildMetaRowPlotSvg({
        row: pooledRow,
        isPooled: true,
        gridOr: state.meta.gridOr,
        xLimitsOr: state.meta.xLimitsOr,
        overall: state.meta.overall
      }),
      ['meta-row-pooled']
    )
  );
  grid.appendChild(
    makeMetaCell(
      formatOrInterval(pooledRow.shrinkageOr, pooledRow.shrinkageOrLow, pooledRow.shrinkageOrHigh),
      ['meta-row-pooled']
    )
  );
  grid.appendChild(makeMetaCell('\u00A0', ['meta-row-pooled']));

  grid.appendChild(makeMetaCell('', ['meta-axis-spacer']));
  grid.appendChild(makeMetaCell('', ['meta-axis-spacer']));
  grid.appendChild(makeMetaCell('', ['meta-axis-spacer']));

  const axisCell = document.createElement('div');
  axisCell.className = 'meta-cell meta-axis-cell';
  axisCell.appendChild(
    buildMetaAxisSvg({
      xLimitsOr: state.meta.xLimitsOr,
      xTicksOr: state.meta.xTicksOr
    })
  );
  grid.appendChild(axisCell);
  grid.appendChild(makeMetaCell('', ['meta-axis-spacer']));
  grid.appendChild(makeMetaCell('', ['meta-axis-spacer']));

  grid.appendChild(makeMetaCell('', ['meta-footnote-row']));
  grid.appendChild(makeMetaCell('', ['meta-footnote-row']));
  grid.appendChild(makeMetaCell('', ['meta-footnote-row']));
  grid.appendChild(makeMetaCell('', ['meta-footnote-row']));

  const footnote = document.createElement('div');
  footnote.className = 'meta-cell meta-footnote-row meta-inspiration';
  footnote.innerHTML = `
    <span class="meta-inspiration-block">
      <span class="meta-inspiration-line1">Data visualization inspired by the</span>
      <br />
      <a href="https://blmoran.github.io/bayesfoRest/index.html" target="_blank" rel="noopener noreferrer">bayesfoRest package</a>
    </span>
  `;
  grid.appendChild(footnote);

  host.appendChild(grid);
}

function rerender() {
  applyFilters();
  applyTableFilters();
  try {
    renderStats();
  } catch (error) {
    console.error('renderStats failed', error);
  }
  try {
    renderDoseChart();
  } catch (error) {
    console.error('renderDoseChart failed', error);
    renderChartFallback('dose-chart', 'Chart unavailable due to render error.');
  }
  try {
    renderTimingChart();
  } catch (error) {
    console.error('renderTimingChart failed', error);
    renderChartFallback('timing-chart', 'Chart unavailable due to render error.');
  }
  try {
    renderTable();
  } catch (error) {
    console.error('renderTable failed', error);
  }
  try {
    renderMetaForest();
  } catch (error) {
    console.error('renderMetaForest failed', error);
  }
}

function setTheme(theme) {
  const isDark = theme === 'dark';
  document.body.classList.toggle('theme-dark', isDark);
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.textContent = isDark ? 'Light mode' : 'Dark mode';
    toggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
  }
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
}

function initializeTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') {
    setTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(prefersDark ? 'dark' : 'light');
}

function setActiveTab(tab) {
  state.activeTab = tab === 'analysis' ? 'analysis' : 'overview';
  document.body.setAttribute('data-active-tab', state.activeTab);
  const overviewTab = document.getElementById('tab-overview');
  const analysisTab = document.getElementById('tab-analysis');
  if (overviewTab) {
    overviewTab.classList.toggle('is-active', state.activeTab === 'overview');
    overviewTab.setAttribute('aria-pressed', state.activeTab === 'overview' ? 'true' : 'false');
  }
  if (analysisTab) {
    analysisTab.classList.toggle('is-active', state.activeTab === 'analysis');
    analysisTab.setAttribute('aria-pressed', state.activeTab === 'analysis' ? 'true' : 'false');
  }
}

function setupTabs() {
  const overviewTab = document.getElementById('tab-overview');
  const analysisTab = document.getElementById('tab-analysis');
  if (overviewTab) {
    overviewTab.addEventListener('click', () => {
      setActiveTab('overview');
      rerender();
    });
  }
  if (analysisTab) {
    analysisTab.addEventListener('click', () => {
      setActiveTab('analysis');
      rerender();
    });
  }
  setActiveTab('overview');
}

async function fetchOptionalJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn(`Optional fetch failed for ${url}`, error);
    return null;
  }
}

async function init() {
  setupTabs();

  const trialsPromise = fetch(`./data/trials_curated.json?v=${DATA_VERSION}`, { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error(`Failed to fetch trials_curated.json (${response.status})`);
    return response.json();
  });

  const [trialsRaw, metaBundleRaw] = await Promise.all([
    trialsPromise,
    fetchOptionalJson(`./data/meta_analysis_bundle.json?v=${DATA_VERSION}`)
  ]);

  const parsedMeta = parseMetaBundle(metaBundleRaw);
  if (parsedMeta) {
    state.meta = parsedMeta;
  } else {
    ensureMetaBundleShape();
  }

  state.trials = constrainTrialsToMeta(
    trialsRaw.map((row) => normalizeTrial(row)),
    state.meta
  );

  const robValues = [...new Set(state.trials.map((row) => row.rob_overall_std))].sort((a, b) => a.localeCompare(b));
  const timingValues = TIMING_ORDER.filter((key) => state.trials.some((row) => row.timing_phase === key));
  const routeValues = [...new Set(state.trials.map((row) => row.route_std))].sort((a, b) => routeLabel(a).localeCompare(routeLabel(b)));
  const studyValues = [...new Set(state.trials.map((row) => row.study_label))].sort((a, b) => a.localeCompare(b));
  const countryValues = [...new Set(state.trials.map((row) => row.country || 'Not reported'))].sort((a, b) => a.localeCompare(b));
  const bolusValues = [...new Set(state.trials.map((row) => formatBolus(row)))].sort((a, b) => a.localeCompare(b));
  const infusionValues = [...new Set(state.trials.map((row) => formatInfusion(row)))].sort((a, b) => a.localeCompare(b));
  const doseValues = DOSE_BAND_ORDER;
  const refreshById = {};
  const registerPopover = (name, config) => {
    const refresh = setupCheckboxPopoverFilter(config);
    refreshById[name] = refresh;
    return refresh;
  };
  const syncSharedFiltersToTable = () => {
    state.tableFilters.rob = [...state.filters.rob];
    state.tableFilters.timing = [...state.filters.timing];
    state.tableFilters.route = [...state.filters.route];
    if (refreshById.tblRob) refreshById.tblRob();
    if (refreshById.tblTiming) refreshById.tblTiming();
    if (refreshById.tblRoute) refreshById.tblRoute();
  };

  const refreshPopoverUIs = [
    registerPopover('rob', {
      id: 'rob-filter',
      values: robValues,
      labeler: (value) => value,
      stateGroup: state.filters,
      stateKey: 'rob',
      allLabel: 'All risk categories',
      onChange: syncSharedFiltersToTable
    }),
    registerPopover('timing', {
      id: 'timing-filter',
      values: timingValues,
      labeler: (value) => timingLabel(value),
      stateGroup: state.filters,
      stateKey: 'timing',
      allLabel: 'All timing categories',
      onChange: syncSharedFiltersToTable
    }),
    registerPopover('route', {
      id: 'route-filter',
      values: routeValues,
      labeler: (value) => routeLabel(value),
      stateGroup: state.filters,
      stateKey: 'route',
      allLabel: 'All routes',
      onChange: syncSharedFiltersToTable
    }),
    registerPopover('dose', {
      id: 'dose-filter',
      values: doseValues,
      labeler: (value) => doseBandLabel(value),
      stateGroup: state.filters,
      stateKey: 'dose',
      allLabel: 'All dose bands'
    }),
    registerPopover('tblStudy', {
      id: 'tbl-filter-study',
      values: studyValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'study',
      allLabel: 'All studies'
    }),
    registerPopover('tblCountry', {
      id: 'tbl-filter-country',
      values: countryValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'country',
      allLabel: 'All countries'
    }),
    registerPopover('tblRob', {
      id: 'tbl-filter-rob',
      values: robValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'rob',
      allLabel: 'All risk categories'
    }),
    registerPopover('tblBolus', {
      id: 'tbl-filter-bolus',
      values: bolusValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'bolus',
      allLabel: 'All bolus values'
    }),
    registerPopover('tblInfusion', {
      id: 'tbl-filter-infusion',
      values: infusionValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'infusion',
      allLabel: 'All infusion values'
    }),
    registerPopover('tblTiming', {
      id: 'tbl-filter-timing',
      values: timingValues,
      labeler: (value) => timingLabel(value),
      stateGroup: state.tableFilters,
      stateKey: 'timing',
      allLabel: 'All timing categories'
    }),
    registerPopover('tblRoute', {
      id: 'tbl-filter-route',
      values: routeValues,
      labeler: (value) => routeLabel(value),
      stateGroup: state.tableFilters,
      stateKey: 'route',
      allLabel: 'All routes'
    })
  ];

  bindPopoverDismissBehavior();

  const resetButton = document.getElementById('reset-filters');
  if (resetButton) {
    resetButton.addEventListener('click', () => {
      clearFilterStateInPlace();
      refreshPopoverUIs.forEach((refresh) => refresh());
      closeAllFilterPopovers();
      rerender();
    });
  }

  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
    const next = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
    setTheme(next);
    rerender();
    });
  }

  rerender();
}

initializeTheme();
init().catch((error) => {
  const subtitle = document.querySelector('.subtitle');
  subtitle.textContent = `Failed to load app data: ${error.message}`;
});
