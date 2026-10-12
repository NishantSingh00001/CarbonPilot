const $ = (selector) => document.querySelector(selector);
const priority = $('#priority');
const deadline = $('#deadline');
let latestDashboard = null;

function paintRange(input) {
  const value = Number(input.value);
  const pct = ((value - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.background = `linear-gradient(90deg, #86a948 0 ${pct}%, #d9ddce ${pct}% 100%)`;
}

function displayTime(iso) {
  if (!iso) return 'Timestamp unavailable';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) + ' IST';
}

function shortTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

function setFeedStatus(mode, text) {
  const target = $('#feed-status');
  target.className = `simulation-status feed-${mode}`;
  target.innerHTML = `<span class="status-dot"></span> ${text}`;
}

function renderChart(data) {
  const forecast = data.forecast || [];
  if (!forecast.length) return;
  const values = [data.grid.demand_mw, ...forecast.map((item) => item.demand_mw)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const points = values.map((value, i) => ({
    x: (i / (values.length - 1)) * 700,
    y: 155 - ((value - min) / span) * 120,
  }));
  const line = points.map((point, i) => `${i ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  $('#demand-line').setAttribute('d', line);
  $('#demand-area').setAttribute('d', `${line} L700,180 L0,180 Z`);
  const bars = $('#job-bars');
  bars.replaceChildren();
  const startAt = new Date(forecast[0].ts).getTime();
  const plotEnd = new Date(forecast[forecast.length - 1].ts).getTime() + 30 * 60 * 1000;
  (data.schedule.jobs || []).forEach((job, index) => {
    const left = Math.max(0, (new Date(job.start).getTime() - startAt) / (plotEnd - startAt) * 100);
    const width = Math.max(1, (job.duration_hours * 60 * 60 * 1000) / (plotEnd - startAt) * 100);
    const bar = document.createElement('span');
    bar.style.setProperty('--x', `${left}%`);
    bar.style.setProperty('--w', `${Math.min(width, 100 - left)}%`);
    bar.style.setProperty('--y', `${15 + index * 11}%`);
    bar.title = `${job.name} · ${displayTime(job.start)}`;
    bars.append(bar);
  });
}

function renderJobs(data) {
  const list = $('#job-list');
  list.replaceChildren();
  const symbols = ['◈', '◉', '◇'];
  (data.schedule.jobs || []).forEach((job, index) => {
    const row = document.createElement('div');
    row.className = 'job-row';
    const symbol = document.createElement('span');
    symbol.className = `job-symbol ${index % 2 ? 'symbol-sky' : 'symbol-lime'}`;
    symbol.textContent = symbols[index % symbols.length];
    const name = document.createElement('span');
    name.className = 'job-name';
    name.append(document.createTextNode(job.name));
    const small = document.createElement('small');
    small.textContent = `${job.duration_hours} hrs · flexible · ${job.power_kw} kW`;
    name.append(small);
    const time = document.createElement('span');
    time.className = 'job-time';
    time.textContent = `${shortTime(job.start)} → ${shortTime(job.finish)} IST`;
    const state = document.createElement('span');
    state.className = `job-state ${job.delay_hours ? 'state-moved' : 'state-fixed'}`;
    state.textContent = job.delay_hours ? `+${job.delay_hours}H` : 'NOW';
    row.append(symbol, name, time, state);
    list.append(row);
  });
}

function renderDashboard(data) {
  latestDashboard = data;
  $('#current-demand').textContent = (data.grid.demand_mw / 1000).toFixed(1);
  $('#demand-timestamp').textContent = `${displayTime(data.grid.demand_ts)} · ${data.grid.demand_source}`;
  $('#stress-reduction').textContent = data.schedule.demand_weighted_stress_reduction_pct.toFixed(1);
  $('#average-delay').textContent = data.schedule.average_delay_hours.toFixed(1);
  $('#updated-label').textContent = `MEASURED ${displayTime(data.grid.demand_ts)}`;
  setFeedStatus('live', data.grid.demand_estimated ? 'GRID ESTIMATE' : 'LIVE GRID FEED');
  renderChart(data);
  renderJobs(data);
}

async function requestDashboard(url, body) {
  const response = await fetch(url, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Grid service returned ${response.status}`);
  return payload;
}

async function loadGrid() {
  setFeedStatus('loading', 'CONNECTING TO GRID');
  try {
    renderDashboard(await requestDashboard('/api/grid/mh'));
  } catch (error) {
    setFeedStatus('error', 'GRID FEED UNAVAILABLE');
    $('#updated-label').textContent = 'NO LIVE READING';
    $('#demand-timestamp').textContent = error.message;
  }
}

async function recalculate() {
  const button = $('#run-simulation');
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="run-icon">↻</span> Fetching grid &amp; planning…';
  setFeedStatus('loading', 'REFRESHING GRID FEED');
  try {
    const data = await requestDashboard('/api/schedule', {
      refresh: true,
      max_delay_hours: Number(deadline.value),
      avoidance_priority: Number(priority.value) / 100,
    });
    renderDashboard(data);
  } catch (error) {
    setFeedStatus('error', 'GRID FEED UNAVAILABLE');
    $('#updated-label').textContent = 'SCHEDULE NOT UPDATED';
    $('#demand-timestamp').textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}

priority.addEventListener('input', () => {
  $('#priority-output').value = `${priority.value}%`;
  paintRange(priority);
});
deadline.addEventListener('input', () => {
  $('#deadline-output').value = `${deadline.value} hours`;
  paintRange(deadline);
});
$('#run-simulation').addEventListener('click', recalculate);
paintRange(priority);
paintRange(deadline);
loadGrid();

const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
  if (entry.isIntersecting) {
    entry.target.classList.add('is-visible');
    observer.unobserve(entry.target);
  }
}), { threshold: .12 });
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));
