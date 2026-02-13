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

const state = {
  trials: [],
  filtered: [],
  filters: {
    search: '',
    rob: 'all',
    timing: 'all',
    route: 'all',
    dose: 'all'
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

function renderStats() {
  const totalTrials = state.filtered.length;
  const participants = state.filtered.reduce((acc, row) => acc + Number(row.n_total || 0), 0);

  const intraTrials = state.filtered.filter((row) => row.timing_phase === 'intra_op').length;
  const postTrials = state.filtered.filter((row) => row.timing_phase === 'post_op').length;
  const preTrials = state.filtered.filter((row) => row.timing_phase === 'pre_op').length;

  document.getElementById('trials-total').textContent = String(totalTrials);
  document.getElementById('participants-total').textContent = participants.toLocaleString();
  document.getElementById('trials-intra').textContent = String(intraTrials);
  document.getElementById('trials-post').textContent = String(postTrials);
  document.getElementById('trials-pre').textContent = String(preTrials);
}

function renderDoseChart() {
  const counts = countTrials(state.filtered, (row) => doseBand(row));
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
        marker: { color: ['#1f6fb2', '#267ac2', '#2d86cf', '#3493dd', '#74a9d8', '#9cb9d0'] },
        text: values,
        textposition: 'outside',
        hovertemplate: '%{x}<br>%{y} trial(s)<extra></extra>'
      }
    ],
    {
      margin: { l: 48, r: 12, b: 84, t: 10 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Sans, sans-serif', color: '#1d3f5e' },
      yaxis: {
        rangemode: 'tozero',
        dtick: 1,
        gridcolor: '#e5eef7',
        showticklabels: false,
        ticks: ''
      }
    },
    { responsive: true, displayModeBar: false }
  );
}

function renderTimingChart() {
  const counts = countTrials(state.filtered, (row) => row.timing_phase || 'unknown');
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
        marker: { color: '#1f8f85' },
        text: values,
        textposition: 'outside',
        hovertemplate: '%{y}<br>%{x} trial(s)<extra></extra>'
      }
    ],
    {
      margin: { l: 185, r: 15, b: 40, t: 10 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Sans, sans-serif', color: '#1d3f5e' },
      xaxis: {
        rangemode: 'tozero',
        dtick: 1,
        gridcolor: '#e5eef7',
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

  state.filtered.forEach((row) => {
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

function populateSelect(id, values, labeler) {
  const select = document.getElementById(id);
  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labeler(value);
    select.appendChild(option);
  });
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

  bindFilter('search', 'search');
  bindFilter('rob-filter', 'rob');
  bindFilter('timing-filter', 'timing');
  bindFilter('route-filter', 'route');
  bindFilter('dose-filter', 'dose');

  document.getElementById('reset-filters').addEventListener('click', () => {
    state.filters = { search: '', rob: 'all', timing: 'all', route: 'all', dose: 'all' };
    document.getElementById('search').value = '';
    document.getElementById('rob-filter').value = 'all';
    document.getElementById('timing-filter').value = 'all';
    document.getElementById('route-filter').value = 'all';
    document.getElementById('dose-filter').value = 'all';
    rerender();
  });

  rerender();
}

init().catch((error) => {
  const subtitle = document.querySelector('.subtitle');
  subtitle.textContent = `Failed to load app data: ${error.message}`;
});
