# CarbonPilot

An animated, responsive concept website and interactive scheduling study for carbon-aware AI compute, scoped to Thane, Maharashtra. Built with plain HTML, CSS, and JavaScript: no API keys, paid services, framework, or build step.

## Live Demo: https://carbonpilot-nishant.netlify.app/

## Run it locally

1. Download or clone this folder.
2. Run `python3 server.py` from this folder.
3. Open `http://127.0.0.1:8000` in a modern browser.
4. Adjust grid-stress avoidance and maximum job delay, then select **Refresh & schedule**.

Python 3 is the only runtime requirement. The local server fetches public grid data and provides same-origin endpoints to the browser. The feed currently refreshes on demand and is cached for three minutes.

## Publish with GitHub and Netlify

This folder includes a Netlify Function, so the live grid and scheduling endpoints work after deployment too.

1. Extract `CarbonPilot-Netlify.zip` on your Mac.
2. Create a new **public or private GitHub repository**. In the extracted folder, upload the project files and folders (`index.html`, CSS/JS, `netlify.toml`, and `netlify/`) to the repository root. Do not upload only the ZIP as a repository file.
3. In Netlify, choose **Add new project → Import an existing project**, connect GitHub, and select that repository.
4. Keep the settings from `netlify.toml` (publish directory `.`; no build command) and deploy.

No API key or paid AI service is required. Netlify hosts the static site and runs the included serverless function; the function fetches the public Maharashtra grid feed. Hosting and function usage follow your Netlify account's current plan limits.

## What this version does

- Responsive editorial landing page with original CSS orbital artwork, subtle entrance motion, and reduced-motion support.
- Live Maharashtra state demand reading and timestamped recent demand observations from the public India Electricity Data API.
- A 24-hour seasonal-naive forecast and a dynamic-programming scheduler for three example flexible workloads.
- A local Python standard-library server that proxies the upstream feed; no API keys, database, JavaScript dependencies, or paid hosting are needed to run it locally.

## Important scope note

This is a research prototype, not an operational workload manager. The live input is measured Maharashtra state demand, not a Thane feeder reading. The public feed does not currently provide a live Maharashtra carbon-intensity series, so the optimizer minimizes demand-weighted grid-stress exposure and does **not** claim CO₂ savings. Its forecast is a seasonal-naive time-of-day median from recent observations, not a trained deep-learning forecast. The optimizer is a constrained dynamic-programming search over example jobs; it is not an LLM and does not control real compute. Workload power values are illustrative. The next research phase should validate the public series against official MSLDC/CEA reports and replace example task profiles with measured workload energy. Google Fonts are optional; system font fallbacks are included.

## Study region

- Workload location: Thane, Maharashtra, India.
- Grid boundary: Maharashtra state-level demand; Thane is the workload location, not a distribution-feeder measurement.
- Live source: [India Electricity Data API](https://india-energy-data.vercel.app/) (independent open-source aggregator; underlying source and measured/estimated flag are included in the API response).
- Validation sources: [CEA data APIs](https://cea.nic.in/api-for-central-electricity-authority-data/?lang=en) and [Maharashtra SLDC system-operation/SCADA pages](https://mahasldc.in/system-operations-reports-1).
- Maharashtra live demand is connected. Carbon intensity is not available from the current feed and is intentionally not fabricated.

## Files

- `index.html` — page structure and simulator interface
- `styles.css` — visual design, animation, responsive layout
- `app.js` — simulator interactions
- `server.py` — public grid-data proxy and demand-aware scheduling API
- `netlify.toml` — Netlify publish, function, and API routing settings
- `netlify/functions/api.js` — deployed grid-data proxy and scheduler
- `region.css` — feed-status and responsive schedule-row details
