const API_ROOT = 'https://india-energy-data.vercel.app/api/v1';
const SLOT_MS = 30 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const CACHE_MS = 3 * 60 * 1000;

const JOBS = [
  { id: 'train', name: 'Foundation model training', duration_hours: 3, power_kw: 8 },
  { id: 'batch', name: 'Nightly batch analytics', duration_hours: 1.5, power_kw: 3 },
  { id: 'eval', name: 'Model evaluation suite', duration_hours: 1, power_kw: 2 },
];

let cachedGrid = null;
let cachedAt = 0;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify(payload),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(16000),
  });
  if (!response.ok) throw new Error(`Grid feed returned HTTP ${response.status}.`);
  return response.json();
}

async function fetchGrid(force) {
  if (!force && cachedGrid && Date.now() - cachedAt < CACHE_MS) return cachedGrid;

  const [live, history] = await Promise.all([
    fetchJson(`${API_ROOT}/zone/IN-MH/live`),
    fetchJson(`${API_ROOT}/zone/IN-MH/history?metric=demand_met&hours=48`),
  ]);
  const metric = (live.metrics || []).find((item) => item.metric === 'demand_met');
  if (!metric || !Number.isFinite(Number(metric.value)) || Number(metric.value) <= 0) {
    throw new Error('The Maharashtra feed did not return a valid current demand reading.');
  }

  const points = (history.points || []).filter((item) =>
    item.metric === 'demand_met' && item.ts && Number.isFinite(Number(item.value)) && Number(item.value) > 0,
  ).map((item) => ({
    ts: new Date(item.ts).toISOString(),
    value_mw: Number(item.value),
    estimated: Boolean(item.estimated),
    source: item.source || 'unknown',
  }));
  if (!points.length) throw new Error('No valid Maharashtra demand history was returned for the scheduler.');

  cachedGrid = {
    zone: live.zone || 'IN-MH',
    demand_mw: Number(metric.value),
    demand_ts: metric.ts ? new Date(metric.ts).toISOString() : null,
    demand_source: metric.source || 'unknown',
    demand_estimated: Boolean(metric.estimated),
    history: points,
    history_source: 'India Electricity Data API; underlying source is reported per reading',
    carbon_intensity_available: (live.metrics || []).some((item) => item.metric === 'carbon_intensity'),
    fetched_at: new Date().toISOString(),
  };
  cachedAt = Date.now();
  return cachedGrid;
}

function clockBin(timestamp) {
  const local = new Date(new Date(timestamp).getTime() + IST_OFFSET_MS);
  return local.getUTCHours() * 2 + (local.getUTCMinutes() >= 30 ? 1 : 0);
}

function makeForecast(history) {
  const bins = Array.from({ length: 48 }, () => []);
  history.forEach((point) => bins[clockBin(point.ts)].push(Number(point.value_mw)));
  const observed = bins.map((values) => {
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
  const known = observed.map((value, index) => value === null ? -1 : index).filter((index) => index >= 0);
  if (known.length < 12) throw new Error('Not enough recent demand samples to build a useful time-of-day forecast.');
  for (let i = 0; i < 48; i += 1) {
    if (observed[i] === null) {
      const nearest = known.reduce((best, candidate) => {
        const distance = Math.min((i - candidate + 48) % 48, (candidate - i + 48) % 48);
        return distance < best.distance ? { index: candidate, distance } : best;
      }, { index: known[0], distance: 49 });
      observed[i] = observed[nearest.index];
    }
  }
  const smoothed = observed.map((_, i) => ([observed[(i + 47) % 48], observed[i], observed[(i + 1) % 48]].reduce((sum, x) => sum + x, 0) / 3));
  const istNow = Date.now() + IST_OFFSET_MS;
  const firstIstSlot = Math.floor(istNow / SLOT_MS) * SLOT_MS + SLOT_MS;
  return smoothed.map((_, step) => {
    const ts = new Date(firstIstSlot + step * SLOT_MS - IST_OFFSET_MS);
    return { ts: ts.toISOString(), demand_mw: Math.round(smoothed[clockBin(ts.toISOString())] * 10) / 10, estimated: true };
  });
}

function optimizeSchedule(forecast, maxDelayHours = 12, avoidancePriority = 0.72) {
  const demand = forecast.map((point) => point.demand_mw);
  const low = Math.min(...demand);
  const spread = Math.max(Math.max(...demand) - low, 1);
  const stress = demand.map((value) => (value - low) / spread);
  const priority = Math.min(1, Math.max(0, Number(avoidancePriority)));
  const delay = Math.min(24, Math.max(2, Number(maxDelayHours)));
  const maxStart = Math.min(forecast.length - 1, Math.floor(delay / 0.5));
  const lengthOf = (job) => Math.max(1, Math.ceil(job.duration_hours / 0.5));
  const jobCost = (job, start) => {
    const length = lengthOf(job);
    if (start + length > forecast.length) return Infinity;
    const exposure = stress.slice(start, start + length).reduce((sum, value) => sum + value * job.power_kw * 0.5, 0);
    const waitCost = start * 0.5 * job.power_kw * (1 - priority) * 0.055;
    return exposure * (0.2 + 2.8 * priority) + waitCost;
  };

  let states = new Map([[0, { cost: 0, plan: [] }]]);
  for (const job of JOBS) {
    const next = new Map();
    for (const [available, partial] of states) {
      const latestStart = Math.min(maxStart, forecast.length - lengthOf(job));
      for (let start = available; start <= latestStart; start += 1) {
        const finish = start + lengthOf(job);
        const cost = partial.cost + jobCost(job, start);
        if (!next.has(finish) || cost < next.get(finish).cost) {
          next.set(finish, { cost, plan: [...partial.plan, { job, start, finish }] });
        }
      }
    }
    if (!next.size) throw new Error('The delay window is too short to fit all flexible workloads.');
    states = next;
  }
  const best = [...states.values()].reduce((winner, candidate) => candidate.cost < winner.cost ? candidate : winner);
  let cursor = 0;
  let baselineCost = 0;
  for (const job of JOBS) {
    baselineCost += jobCost(job, cursor);
    cursor += lengthOf(job);
  }
  const firstMs = new Date(forecast[0].ts).getTime();
  const jobs = best.plan.map(({ job, start, finish }) => ({
    ...job,
    start: new Date(firstMs + start * SLOT_MS).toISOString(),
    finish: new Date(firstMs + finish * SLOT_MS).toISOString(),
    delay_hours: Math.round(start * 0.5 * 10) / 10,
  }));
  const reduction = baselineCost ? Math.max(0, (baselineCost - best.cost) / baselineCost * 100) : 0;
  return {
    algorithm: 'seasonal-naive demand forecast + dynamic-programming schedule search',
    max_delay_hours: delay,
    avoidance_priority: priority,
    flexible_jobs_moved: jobs.filter((job) => job.delay_hours > 0).length,
    flexible_jobs_total: jobs.length,
    average_delay_hours: Math.round(jobs.reduce((sum, job) => sum + job.delay_hours, 0) / jobs.length * 10) / 10,
    demand_weighted_stress_reduction_pct: Math.round(reduction * 10) / 10,
    baseline_stress_score: Math.round(baselineCost * 100) / 100,
    optimized_stress_score: Math.round(best.cost * 100) / 100,
    jobs,
  };
}

async function buildDashboard(force, maxDelay, priority) {
  const grid = await fetchGrid(force);
  const forecast = makeForecast(grid.history);
  return {
    status: 'live',
    location: 'Thane, Maharashtra',
    grid_boundary: 'Maharashtra state grid; Thane is the load-location proxy',
    grid: {
      zone: grid.zone,
      demand_mw: grid.demand_mw,
      demand_ts: grid.demand_ts,
      demand_source: grid.demand_source,
      demand_estimated: grid.demand_estimated,
      fetched_at: grid.fetched_at,
      carbon_intensity_available: grid.carbon_intensity_available,
    },
    history: grid.history,
    forecast,
    schedule: optimizeSchedule(forecast, maxDelay, priority),
    limitations: [
      'Maharashtra state demand is a grid-stress proxy, not a Thane feeder measurement.',
      'This public feed currently does not provide a live Maharashtra carbon-intensity series; CO2 savings are therefore not calculated.',
      'The 24-hour forecast is seasonal-naive (recent time-of-day median), not a trained deep-learning forecast.',
    ],
  };
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod || 'GET';
    const path = event.path || new URL(event.rawUrl || 'https://netlify.local/').pathname;
    const query = new URLSearchParams(event.rawQuery || '');
    const route = query.get('route');
    if (method === 'OPTIONS') return json(204, {});
    if (method === 'GET' && (route === 'grid' || path.endsWith('/grid/mh'))) {
      return json(200, await buildDashboard(query.get('refresh') === '1', 12, 0.72));
    }
    if (method === 'POST' && (route === 'schedule' || path.endsWith('/schedule'))) {
      const body = JSON.parse(event.body || '{}');
      return json(200, await buildDashboard(
        Boolean(body.refresh ?? true),
        Number(body.max_delay_hours ?? 12),
        Number(body.avoidance_priority ?? 0.72),
      ));
    }
    return json(404, { error: 'Unknown endpoint' });
  } catch (error) {
    return json(502, {
      status: 'unavailable',
      error: error.message || 'The grid service is unavailable.',
      location: 'Thane, Maharashtra',
      source: 'India Electricity Data API',
    });
  }
};
