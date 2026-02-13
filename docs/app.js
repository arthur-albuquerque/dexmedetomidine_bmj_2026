const state = {
  trials: [],
  filtered: [],
  validation: null,
  filters: {
    search: '',
    rob: 'all',
    timing: 'all',
    route: 'all',
    dose: 'all'
  }
};

function doseBand(trial) {
  if (trial.infusion_low == null || trial.infusion_high == null) return 'not_reported';
  if (!trial.infusion_weight_normalized || trial.infusion_unit !== 'mcg/kg/h') return 'not_weight_normalized';
  const mid = (trial.infusion_low + trial.infusion_high) / 2;
  if (mid <= 0.2) return '0-0.2';
  if (mid <= 0.5) return '0.2-0.5';
  if (mid <= 0.8) return '0.5-0.8';
  return '>0.8';
}

function weighted(rows, getter) {
  const map = new Map();
  rows.forEach((r) => {
    const key = getter(r) || 'missing';
    const n = Number(r.n_total || 0);
    map.set(key, (map.get(key) || 0) + n);
  });
  return [...map.entries()].map(([label, weighted_n]) => ({ label, weighted_n })).sort((a, b) => b.weighted_n - a.weighted_n);
}

function robClass(rob) {
  if (rob === 'Low risk') return 'rob-low';
  if (rob === 'High risk') return 'rob-high';
  return 'rob-some';
}

function infusionText(row) {
  if (row.infusion_low == null) return 'NR';
  if (row.infusion_high == null || row.infusion_low === row.infusion_high) return `${row.infusion_low} ${row.infusion_unit || ''}`.trim();
  return `${row.infusion_low}-${row.infusion_high} ${row.infusion_unit || ''}`.trim();
}

function applyFilters() {
  const s = state.filters.search.trim().toLowerCase();
  state.filtered = state.trials.filter((r) => {
    if (state.filters.rob !== 'all' && r.rob_overall_std !== state.filters.rob) return false;
    if (state.filters.timing !== 'all' && r.timing_phase !== state.filters.timing) return false;
    if (state.filters.route !== 'all' && r.route_std !== state.filters.route) return false;
    if (state.filters.dose !== 'all' && doseBand(r) !== state.filters.dose) return false;
    if (!s) return true;
    const hay = `${r.study_label} ${r.country} ${r.dex_arm_text_raw} ${r.control_arm_text_raw}`.toLowerCase();
    return hay.includes(s);
  });
}

function renderStats() {
  const participants = state.filtered.reduce((acc, r) => acc + Number(r.n_total || 0), 0);
  document.getElementById('trials-total').textContent = String(state.filtered.length);
  document.getElementById('participants-total').textContent = participants.toLocaleString();
  document.getElementById('review-total').textContent = String(state.validation?.n_review_queue ?? '-');

  const flagged = state.filtered.filter((r) => (r.validation_flags || []).length > 0).length;
  const critical = state.filtered.filter((r) => (r.critical_flags || []).length > 0).length;
  document.getElementById('qa-flags').textContent = String(flagged);
  document.getElementById('qa-critical').textContent = String(critical);
  document.getElementById('qa-unresolved').textContent = String(state.validation?.n_unresolved_critical ?? '-');

  const routeDist = weighted(state.filtered, (r) => r.route_std);
  const top = routeDist[0];
  document.getElementById('qa-route').textContent = top ? `${top.label} (${top.weighted_n.toLocaleString()})` : 'NR';
}

function renderCharts() {
  const dose = weighted(state.filtered, (r) => doseBand(r));
  Plotly.react('dose-chart', [{
    type: 'bar',
    x: dose.map((d) => d.label),
    y: dose.map((d) => d.weighted_n),
    marker: { color: '#2f6fdf' }
  }], {
    margin: { l: 45, r: 15, t: 20, b: 60 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    yaxis: { title: 'Weighted participants' }
  }, { displayModeBar: false, responsive: true });

  const timing = weighted(state.filtered, (r) => r.timing_phase);
  Plotly.react('timing-chart', [{
    type: 'pie',
    labels: timing.map((d) => d.label),
    values: timing.map((d) => d.weighted_n),
    hole: 0.45,
    marker: { colors: ['#2f6fdf', '#2ca58d', '#f3a712', '#d1495b', '#7b6d8d'] }
  }], {
    margin: { l: 10, r: 10, t: 20, b: 10 },
    paper_bgcolor: 'transparent'
  }, { displayModeBar: false, responsive: true });
}

function renderTable() {
  const body = document.getElementById('trials-body');
  body.innerHTML = '';
  state.filtered.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${row.study_label}</strong><br/><small>${row.country}</small></td>
      <td>${row.n_total ?? 'NR'}</td>
      <td><span class="rob-pill ${robClass(row.rob_overall_std)}">${row.rob_overall_std}</span></td>
      <td>${row.bolus_value == null ? 'NR' : `${row.bolus_value} ${row.bolus_unit || ''}`}</td>
      <td>${infusionText(row)}</td>
      <td>${row.timing_phase}</td>
      <td>${row.route_std}</td>
      <td>${(row.validation_flags || []).join(', ') || 'None'}</td>
    `;
    body.appendChild(tr);
  });
}

function rerender() {
  applyFilters();
  renderStats();
  renderCharts();
  renderTable();
}

function bindFilter(id, key) {
  document.getElementById(id).addEventListener('input', (event) => {
    state.filters[key] = event.target.value;
    rerender();
  });
}

function populateSelect(id, values) {
  const select = document.getElementById(id);
  values.forEach((v) => {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = v;
    select.appendChild(option);
  });
}

async function init() {
  const [trials, validation] = await Promise.all([
    fetch('./data/trials_curated.json').then((r) => r.json()),
    fetch('./data/validation_report.json').then((r) => r.json())
  ]);
  state.trials = trials;
  state.validation = validation;

  populateSelect('rob-filter', [...new Set(trials.map((r) => r.rob_overall_std))]);
  populateSelect('timing-filter', [...new Set(trials.map((r) => r.timing_phase))]);
  populateSelect('route-filter', [...new Set(trials.map((r) => r.route_std))]);

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
  const subtitle = document.getElementById('subtitle');
  subtitle.textContent = `Failed to load data: ${error.message}`;
});
