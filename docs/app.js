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
    search: '',
    rob: 'all',
    timing: 'all',
    route: 'all',
    dose: 'all'
  },
  tableFilters: {
    study: '',
    country: '',
    rob: 'all',
    bolus: '',
    infusion: '',
    timing: 'all',
    route: 'all'
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
  const searchTerm = state.filters.search.trim().toLowerCase();
  state.filtered = state.trials.filter((row) => {
    if (state.filters.rob !== 'all' && row.rob_overall_std !== state.filters.rob) return false;
    if (state.filters.timing !== 'all' && row.timing_phase !== state.filters.timing) return false;
    if (state.filters.route !== 'all' && row.route_std !== state.filters.route) return false;
    if (state.filters.dose !== 'all' && doseBand(row) !== state.filters.dose) return false;

    if (!searchTerm) return true;
    const haystack = `${row.study_label} ${row.country} ${row.dex_arm_text_raw} ${row.control_arm_text_raw}`.toLowerCase();
    return haystack.includes(searchTerm);
  });
}

function applyTableFilters() {
  state.tableFiltered = state.filtered.filter((row) => {
    const studyText = (row.study_label || '').toLowerCase();
    const countryText = (row.country || '').toLowerCase();
    const bolusText = formatBolus(row).toLowerCase();
    const infusionText = formatInfusion(row).toLowerCase();

    if (state.tableFilters.study && !studyText.includes(state.tableFilters.study)) return false;
    if (state.tableFilters.country && !countryText.includes(state.tableFilters.country)) return false;
    if (state.tableFilters.bolus && !bolusText.includes(state.tableFilters.bolus)) return false;
    if (state.tableFilters.infusion && !infusionText.includes(state.tableFilters.infusion)) return false;
    if (state.tableFilters.rob !== 'all' && row.rob_overall_std !== state.tableFilters.rob) return false;
    if (state.tableFilters.timing !== 'all' && row.timing_phase !== state.tableFilters.timing) return false;
    if (state.tableFilters.route !== 'all' && row.route_std !== state.tableFilters.route) return false;
    return true;
  });
}

function renderStats() {
  const totalTrials = state.tableFiltered.length;
  const participants = state.tableFiltered.reduce((acc, row) => acc + Number(row.n_total || 0), 0);

  const intraTrials = state.tableFiltered.filter((row) => row.timing_phase === 'intra_op').length;
  const postTrials = state.tableFiltered.filter((row) => row.timing_phase === 'post_op').length;
  const preTrials = state.tableFiltered.filter((row) => row.timing_phase === 'pre_op').length;

  document.getElementById('trials-total').textContent = String(totalTrials);
  document.getElementById('participants-total').textContent = participants.toLocaleString();
  document.getElementById('trials-intra').textContent = String(intraTrials);
  document.getElementById('trials-post').textContent = String(postTrials);
  document.getElementById('trials-pre').textContent = String(preTrials);
}

function renderDoseChart() {
  const isDark = document.body.classList.contains('theme-dark');
  const counts = countTrials(state.tableFiltered, (row) => doseBand(row));
  const keys = DOSE_BAND_ORDER.filter((key) => counts.has(key));
  const labels = keys.map((key) => doseBandLabel(key));
  const values = keys.map((key) => counts.get(key));

  Plotly.react(
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
  const isDark = document.body.classList.contains('theme-dark');
  const counts = countTrials(state.tableFiltered, (row) => row.timing_phase || 'unknown');
  const keys = TIMING_ORDER.filter((key) => counts.has(key));
  const labels = keys.map((key) => timingLabel(key));
  const values = keys.map((key) => counts.get(key));

  Plotly.react(
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

function renderTable() {
  const body = document.getElementById('trials-body');
  body.innerHTML = '';

  state.tableFiltered.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="study-name">${row.study_label}</span></td>
      <td>${row.country || 'Not reported'}</td>
      <td><span class="rob-pill ${robClass(row.rob_overall_std)}">${row.rob_overall_std}</span></td>
      <td>${formatBolus(row)}</td>
      <td>${formatInfusion(row)}</td>
      <td>${timingLabel(row.timing_phase)}</td>
      <td>${routeLabel(row.route_std)}</td>
    `;
    body.appendChild(tr);
  });
}

function rerender() {
  applyFilters();
  applyTableFilters();
  renderStats();
  renderDoseChart();
  renderTimingChart();
  renderTable();
}

function bindFilter(id, key) {
  document.getElementById(id).addEventListener('input', (event) => {
    state.filters[key] = event.target.value;
    rerender();
  });
}

function bindTableFilter(id, key, mode = 'input') {
  const eventName = mode === 'select' ? 'change' : 'input';
  document.getElementById(id).addEventListener(eventName, (event) => {
    const value = event.target.value;
    state.tableFilters[key] = mode === 'select' ? value : value.trim().toLowerCase();
    rerender();
  });
}

function populateSelect(id, values, labeler) {
  const select = document.getElementById(id);
  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labeler(value);
    select.appendChild(option);
  });
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

  const robValues = [...new Set(state.trials.map((row) => row.rob_overall_std))].sort();
  const timingValues = TIMING_ORDER.filter((key) => state.trials.some((row) => row.timing_phase === key));
  const routeValues = [...new Set(state.trials.map((row) => row.route_std))].sort();

  populateSelect('rob-filter', robValues, (value) => value);
  populateSelect('timing-filter', timingValues, (value) => timingLabel(value));
  populateSelect('route-filter', routeValues, (value) => routeLabel(value));
  populateSelect('tbl-filter-rob', robValues, (value) => value);
  populateSelect('tbl-filter-timing', timingValues, (value) => timingLabel(value));
  populateSelect('tbl-filter-route', routeValues, (value) => routeLabel(value));

  bindFilter('search', 'search');
  bindFilter('rob-filter', 'rob');
  bindFilter('timing-filter', 'timing');
  bindFilter('route-filter', 'route');
  bindFilter('dose-filter', 'dose');
  bindTableFilter('tbl-filter-study', 'study');
  bindTableFilter('tbl-filter-country', 'country');
  bindTableFilter('tbl-filter-rob', 'rob', 'select');
  bindTableFilter('tbl-filter-bolus', 'bolus');
  bindTableFilter('tbl-filter-infusion', 'infusion');
  bindTableFilter('tbl-filter-timing', 'timing', 'select');
  bindTableFilter('tbl-filter-route', 'route', 'select');

  document.getElementById('reset-filters').addEventListener('click', () => {
    state.filters = { search: '', rob: 'all', timing: 'all', route: 'all', dose: 'all' };
    state.tableFilters = { study: '', country: '', rob: 'all', bolus: '', infusion: '', timing: 'all', route: 'all' };
    document.getElementById('search').value = '';
    document.getElementById('rob-filter').value = 'all';
    document.getElementById('timing-filter').value = 'all';
    document.getElementById('route-filter').value = 'all';
    document.getElementById('dose-filter').value = 'all';
    document.getElementById('tbl-filter-study').value = '';
    document.getElementById('tbl-filter-country').value = '';
    document.getElementById('tbl-filter-rob').value = 'all';
    document.getElementById('tbl-filter-bolus').value = '';
    document.getElementById('tbl-filter-infusion').value = '';
    document.getElementById('tbl-filter-timing').value = 'all';
    document.getElementById('tbl-filter-route').value = 'all';
    rerender();
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
    setTheme(next);
    rerender();
  });

  rerender();
}

initializeTheme();
init().catch((error) => {
  const subtitle = document.querySelector('.subtitle');
  subtitle.textContent = `Failed to load app data: ${error.message}`;
});
