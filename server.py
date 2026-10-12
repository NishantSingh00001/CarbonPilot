"""CarbonPilot local API: public Maharashtra grid feed + demand-aware scheduler."""

from __future__ import annotations

import json
import math
import os
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
API_ROOT = "https://india-energy-data.vercel.app/api/v1"
IST = ZoneInfo("Asia/Kolkata")
CACHE_SECONDS = 180
_cache: dict[str, object] = {"at": 0.0, "data": None}
_cache_lock = threading.Lock()

JOBS = [
    {"id": "train", "name": "Foundation model training", "duration_hours": 3.0, "power_kw": 8.0, "flexible": True},
    {"id": "batch", "name": "Nightly batch analytics", "duration_hours": 1.5, "power_kw": 3.0, "flexible": True},
    {"id": "eval", "name": "Model evaluation suite", "duration_hours": 1.0, "power_kw": 2.0, "flexible": True},
    {"id": "inference", "name": "Customer inference", "duration_hours": 24.0, "power_kw": 4.0, "flexible": False},
    {"id": "api", "name": "API service", "duration_hours": 24.0, "power_kw": 1.5, "flexible": False},
]


def fetch_json(url: str) -> dict:
    # Use the operating system's trusted CA bundle. Some macOS Python installs
    # ship without a configured CA store, while curl uses the system keychain.
    try:
        response = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "16", "-H", "Accept: application/json", url],
            check=True,
            capture_output=True,
            text=True,
            timeout=18,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        detail = exc.stderr.strip() if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        raise RuntimeError(f"Grid feed request failed: {detail}") from exc
    return json.loads(response.stdout)


def parse_time(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def fetch_grid() -> dict:
    live = fetch_json(f"{API_ROOT}/zone/IN-MH/live")
    history = fetch_json(f"{API_ROOT}/zone/IN-MH/history?metric=demand_met&hours=48")
    metric = next((item for item in live.get("metrics", []) if item.get("metric") == "demand_met"), None)
    if not metric or not isinstance(metric.get("value"), (int, float)) or metric["value"] <= 0:
        raise ValueError("The Maharashtra feed did not return a valid current demand reading.")
    points = []
    for item in history.get("points", []):
        stamp = parse_time(item.get("ts"))
        value = item.get("value")
        if item.get("metric") == "demand_met" and stamp and isinstance(value, (int, float)) and value > 0:
            points.append({"ts": stamp.isoformat(), "value_mw": float(value), "estimated": bool(item.get("estimated", False)), "source": item.get("source", "unknown")})
    latest_time = parse_time(metric.get("ts"))
    if not points:
        raise ValueError("No valid Maharashtra demand history was returned for the scheduler.")
    return {
        "zone": live.get("zone", "IN-MH"),
        "demand_mw": float(metric["value"]),
        "demand_ts": latest_time.isoformat() if latest_time else None,
        "demand_source": metric.get("source", "unknown"),
        "demand_estimated": bool(metric.get("estimated", False)),
        "history": points,
        "history_source": "India Electricity Data API; underlying source is reported per reading",
        "carbon_intensity_available": any(item.get("metric") == "carbon_intensity" for item in live.get("metrics", [])),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def get_grid(force: bool = False) -> dict:
    with _cache_lock:
        if not force and _cache["data"] and time.time() - float(_cache["at"]) < CACHE_SECONDS:
            return _cache["data"]  # type: ignore[return-value]
    data = fetch_grid()
    with _cache_lock:
        _cache["at"] = time.time()
        _cache["data"] = data
    return data


def clock_bin(stamp: datetime) -> int:
    local = stamp.astimezone(IST)
    return local.hour * 2 + (1 if local.minute >= 30 else 0)


def make_forecast(history: list[dict], horizon_slots: int = 48) -> list[dict]:
    """Seasonal-naive half-hour forecast from recent observed Maharashtra demand."""
    bins: list[list[float]] = [[] for _ in range(48)]
    for point in history:
        stamp = parse_time(point["ts"])
        if stamp:
            bins[clock_bin(stamp)].append(float(point["value_mw"]))
    observed = [sorted(group)[len(group) // 2] if group else None for group in bins]
    known = [i for i, value in enumerate(observed) if value is not None]
    if len(known) < 12:
        raise ValueError("Not enough recent demand samples to build a useful time-of-day forecast.")
    for i in range(48):
        if observed[i] is None:
            nearest = min(known, key=lambda j: min((i - j) % 48, (j - i) % 48))
            observed[i] = observed[nearest]
    smoothed = []
    for i in range(48):
        smoothed.append(sum(float(observed[(i + offset) % 48]) for offset in (-1, 0, 1)) / 3)
    now = datetime.now(IST)
    first = now.replace(minute=0 if now.minute < 30 else 30, second=0, microsecond=0) + timedelta(minutes=30)
    result = []
    for step in range(horizon_slots):
        stamp = first + timedelta(minutes=30 * step)
        result.append({"ts": stamp.isoformat(), "demand_mw": round(smoothed[clock_bin(stamp)], 1), "estimated": True})
    return result


def optimize_schedule(forecast: list[dict], max_delay_hours: float = 12.0, avoidance_priority: float = 0.72) -> dict:
    """DP scheduler: minimize demand-weighted flexible compute while respecting deadlines."""
    slot_hours = 0.5
    slots = len(forecast)
    demand = [float(point["demand_mw"]) for point in forecast]
    lo, hi = min(demand), max(demand)
    spread = max(hi - lo, 1.0)
    stress = [(value - lo) / spread for value in demand]
    priority = min(1.0, max(0.0, float(avoidance_priority)))
    delay = min(24.0, max(2.0, float(max_delay_hours)))
    max_start = min(slots - 1, int(delay / slot_hours))
    flexible = [job for job in JOBS if job["flexible"]]

    def job_cost(job: dict, start: int) -> float:
        length = max(1, math.ceil(job["duration_hours"] / slot_hours))
        if start + length > slots:
            return float("inf")
        demand_exposure = sum(stress[i] * job["power_kw"] * slot_hours for i in range(start, start + length))
        wait_cost = (start * slot_hours) * job["power_kw"] * (1 - priority) * 0.055
        return demand_exposure * (0.2 + 2.8 * priority) + wait_cost

    # Dynamic programming over jobs in queue order; the accelerator is single-capacity.
    # State maps the finish slot to its lowest-cost partial plan.
    states: dict[int, tuple[float, list[dict]]] = {0: (0.0, [])}
    for job in flexible:
        length = max(1, math.ceil(job["duration_hours"] / slot_hours))
        next_states: dict[int, tuple[float, list[dict]]] = {}
        for available, (partial_cost, partial_plan) in states.items():
            latest_start = min(max_start, slots - length)
            for start in range(available, latest_start + 1):
                finish = start + length
                cost = partial_cost + job_cost(job, start)
                prior = next_states.get(finish)
                if prior is None or cost < prior[0]:
                    next_states[finish] = (cost, partial_plan + [{"job": job, "start": start, "finish": finish, "cost": cost - partial_cost}])
        if not next_states:
            raise ValueError("The delay window is too short to fit all flexible workloads.")
        states = next_states
    best_cost, plan = min(states.values(), key=lambda item: item[0])

    baseline = []
    cursor = 0
    baseline_cost = 0.0
    for job in flexible:
        length = max(1, math.ceil(job["duration_hours"] / slot_hours))
        baseline_cost += job_cost(job, cursor)
        baseline.append({"job": job, "start": cursor, "finish": cursor + length})
        cursor += length

    start_at = parse_time(forecast[0]["ts"])
    assert start_at is not None
    jobs = []
    for row in plan:
        job = row["job"]
        start = start_at + timedelta(minutes=30 * row["start"])
        finish = start_at + timedelta(minutes=30 * row["finish"])
        jobs.append({"id": job["id"], "name": job["name"], "duration_hours": job["duration_hours"], "power_kw": job["power_kw"], "start": start.isoformat(), "finish": finish.isoformat(), "delay_hours": round(row["start"] * slot_hours, 1)})
    stress_reduction = max(0.0, (baseline_cost - best_cost) / baseline_cost * 100) if baseline_cost else 0.0
    return {
        "algorithm": "seasonal-naive demand forecast + dynamic-programming schedule search",
        "max_delay_hours": delay,
        "avoidance_priority": priority,
        "flexible_jobs_moved": sum(job["delay_hours"] > 0 for job in jobs),
        "flexible_jobs_total": len(jobs),
        "average_delay_hours": round(sum(job["delay_hours"] for job in jobs) / len(jobs), 1),
        "demand_weighted_stress_reduction_pct": round(stress_reduction, 1),
        "baseline_stress_score": round(baseline_cost, 2),
        "optimized_stress_score": round(best_cost, 2),
        "jobs": jobs,
    }


def build_dashboard(force: bool = False, max_delay_hours: float = 12, avoidance_priority: float = .72) -> dict:
    grid = get_grid(force)
    forecast = make_forecast(grid["history"])
    schedule = optimize_schedule(forecast, max_delay_hours, avoidance_priority)
    return {
        "status": "live",
        "location": "Thane, Maharashtra",
        "grid_boundary": "Maharashtra state grid; Thane is the load-location proxy",
        "grid": {key: grid[key] for key in ("zone", "demand_mw", "demand_ts", "demand_source", "demand_estimated", "fetched_at", "carbon_intensity_available")},
        "history": grid["history"],
        "forecast": forecast,
        "schedule": schedule,
        "limitations": ["Maharashtra state demand is a grid-stress proxy, not a Thane feeder measurement.", "This public feed currently does not provide a live Maharashtra carbon-intensity series; CO2 savings are therefore not calculated.", "The 24-hour forecast is seasonal-naive (recent time-of-day median), not a trained deep-learning forecast."],
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        route = urlparse(self.path)
        if route.path == "/api/health":
            self.send_json(200, {"ok": True, "service": "CarbonPilot local scheduler"})
            return
        if route.path == "/api/grid/mh":
            query = parse_qs(route.query)
            try:
                result = build_dashboard(force=query.get("refresh") == ["1"])
                self.send_json(200, result)
            except (RuntimeError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                self.send_json(502, {"status": "unavailable", "error": str(exc), "location": "Thane, Maharashtra", "source": "India Electricity Data API"})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/schedule":
            self.send_json(404, {"error": "Unknown endpoint"})
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            payload = json.loads(self.rfile.read(length) or b"{}")
            result = build_dashboard(
                force=bool(payload.get("refresh", True)),
                max_delay_hours=float(payload.get("max_delay_hours", 12)),
                avoidance_priority=float(payload.get("avoidance_priority", .72)),
            )
            self.send_json(200, result)
        except (RuntimeError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            self.send_json(502, {"status": "unavailable", "error": str(exc), "location": "Thane, Maharashtra", "source": "India Electricity Data API"})

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    port = int(os.environ.get("CARBONPILOT_PORT", "8000"))
    print(f"CarbonPilot local server: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
