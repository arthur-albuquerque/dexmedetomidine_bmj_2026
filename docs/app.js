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

const DOSE_BAND_LABELS = {
  '0-0.2': '0.0 to 0.2 mcg/kg/h',
  '0.2-0.5': '0.2 to 0.5 mcg/kg/h',
  '0.5-0.8': '0.5 to 0.8 mcg/kg/h',
  '>0.8': 'Above 0.8 mcg/kg/h',
  not_reported: 'Infusion not reported',
  not_weight_normalized: 'Infusion not weight-normalized'
};

const DOSE_BAND_ORDER = ['0-0.2', '0.2-0.5', '0.5-0.8', '>0.8', 'not_weight_normalized', 'not_reported'];
const THEME_KEY = 'dex-theme';

const state = {
  trials: [],
  filtered: [],
  tableFiltered: [],
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
  allLabel
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
      syncFromState();
      rerender();
    });
  });

  syncFromState();
  return syncFromState;
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

function doseBand(trial) {
  if (trial.infusion_low == null || trial.infusion_high == null) return 'not_reported';
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
  const counts = countTrials(state.tableFiltered, (row) => doseBand(row));
  const keys = DOSE_BAND_ORDER.filter((key) => counts.has(key));
  const labels = keys.map((key) => doseBandLabel(key));
  const values = keys.map((key) => counts.get(key));

  window.Plotly.react(
    'dose-chart',
    [
      {
        type: 'bar',
        x: labels,
        y: values,
        marker: { color: isDark ? ['#59c6f2', '#47b8e9', '#39a9df', '#2c9bd4', '#2387bb', '#206f98'] : ['#1f6fb2', '#267ac2', '#2d86cf', '#3493dd', '#74a9d8', '#9cb9d0'] },
        text: values,
        textposition: 'outside',
        cliponaxis: false,
        hovertemplate: '%{x}<br>%{y} trial(s)<extra></extra>'
      }
    ],
    {
      margin: { l: 28, r: 12, b: 120, t: 24 },
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

async function init() {
  const trialsRaw = await fetch('./data/trials_curated.json').then((response) => response.json());
  state.trials = trialsRaw.map((row) => normalizeTrial(row));

  const robValues = [...new Set(state.trials.map((row) => row.rob_overall_std))].sort((a, b) => a.localeCompare(b));
  const timingValues = TIMING_ORDER.filter((key) => state.trials.some((row) => row.timing_phase === key));
  const routeValues = [...new Set(state.trials.map((row) => row.route_std))].sort((a, b) => routeLabel(a).localeCompare(routeLabel(b)));
  const studyValues = [...new Set(state.trials.map((row) => row.study_label))].sort((a, b) => a.localeCompare(b));
  const countryValues = [...new Set(state.trials.map((row) => row.country || 'Not reported'))].sort((a, b) => a.localeCompare(b));
  const bolusValues = [...new Set(state.trials.map((row) => formatBolus(row)))].sort((a, b) => a.localeCompare(b));
  const infusionValues = [...new Set(state.trials.map((row) => formatInfusion(row)))].sort((a, b) => a.localeCompare(b));
  const doseValues = DOSE_BAND_ORDER;

  const refreshPopoverUIs = [
    setupCheckboxPopoverFilter({
      id: 'rob-filter',
      values: robValues,
      labeler: (value) => value,
      stateGroup: state.filters,
      stateKey: 'rob',
      allLabel: 'All risk categories'
    }),
    setupCheckboxPopoverFilter({
      id: 'timing-filter',
      values: timingValues,
      labeler: (value) => timingLabel(value),
      stateGroup: state.filters,
      stateKey: 'timing',
      allLabel: 'All timing categories'
    }),
    setupCheckboxPopoverFilter({
      id: 'route-filter',
      values: routeValues,
      labeler: (value) => routeLabel(value),
      stateGroup: state.filters,
      stateKey: 'route',
      allLabel: 'All routes'
    }),
    setupCheckboxPopoverFilter({
      id: 'dose-filter',
      values: doseValues,
      labeler: (value) => doseBandLabel(value),
      stateGroup: state.filters,
      stateKey: 'dose',
      allLabel: 'All dose bands'
    }),
    setupCheckboxPopoverFilter({
      id: 'tbl-filter-study',
      values: studyValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'study',
      allLabel: 'All studies'
    }),
    setupCheckboxPopoverFilter({
      id: 'tbl-filter-country',
      values: countryValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'country',
      allLabel: 'All countries'
    }),
    setupCheckboxPopoverFilter({
      id: 'tbl-filter-rob',
      values: robValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'rob',
      allLabel: 'All risk categories'
    }),
    setupCheckboxPopoverFilter({
      id: 'tbl-filter-bolus',
      values: bolusValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'bolus',
      allLabel: 'All bolus values'
    }),
    setupCheckboxPopoverFilter({
      id: 'tbl-filter-infusion',
      values: infusionValues,
      labeler: (value) => value,
      stateGroup: state.tableFilters,
      stateKey: 'infusion',
      allLabel: 'All infusion values'
    }),
    setupCheckboxPopoverFilter({
      id: 'tbl-filter-timing',
      values: timingValues,
      labeler: (value) => timingLabel(value),
      stateGroup: state.tableFilters,
      stateKey: 'timing',
      allLabel: 'All timing categories'
    }),
    setupCheckboxPopoverFilter({
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
      state.filters = { rob: [], timing: [], route: [], dose: [] };
      state.tableFilters = { study: [], country: [], rob: [], bolus: [], infusion: [], timing: [], route: [] };
      refreshPopoverUIs.forEach((refresh) => refresh());
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
