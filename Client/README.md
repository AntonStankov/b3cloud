# b3cloud Client

A Vercel-style frontend for b3cloud: link a GitHub repo, watch your infrastructure
get analyzed and deployed, configure each element on a drag-and-drop canvas, and
subscribe with a 5-day free trial.

Built with Vite + React + TypeScript, React Flow for the builder canvas, and
Zustand for state.

## Getting started

```bash
npm install
cp .env.example .env   # optional; defaults to mock mode
npm run dev
```

Open http://127.0.0.1:5173.

## Modes

The app talks to the b3cloud user API through a single typed layer in
`src/api/`. A `VITE_USE_MOCKS` flag switches between live and mock backends:

- `VITE_USE_MOCKS=true` (default): analyze + deploy + jobs are fully simulated
  in-memory, so the whole flow works without a running backend. Pricing,
  payments, accounts and GitHub are always mocked (no backend exists for them).
- `VITE_USE_MOCKS=false`: `analyze`, `deploy`, and job polling hit the real
  user API. Set `VITE_API_KEY` (or paste the key in-app) and `VITE_API_BASE_URL`
  (or rely on the dev proxy in `vite.config.ts`, which forwards to
  `127.0.0.1:9001`).

## Structure

- `src/api/` - typed client, backend types, and `mocks/` (deploy, github, auth, payments).
- `src/domain/` - infra element model (`fromAnalyze`), pricing, and validation.
- `src/store/` - Zustand builder store (graph, selection, deploy job).
- `src/features/landing` - landing page + GitHub link modal.
- `src/features/builder` - palette, React Flow canvas, properties panel, deploy
  progress, publish bar.
- `src/features/checkout` - plan summary + Stripe-shaped checkout mock.
- `src/features/demo` - product tour stub.

## How it maps to the backend

| UI action | Backend (user API) |
| --- | --- |
| Link repo -> analyze | `POST /apps/analyze` |
| Auto-deploy on builder load | `POST /apps/deploy` |
| Deploy progress | poll `GET /deploy-jobs/{id}` |
| Pricing / payments / accounts | mocked (no backend yet) |

Infra elements are derived from the analyze response: components become
web/api/worker nodes, detected services become database/cache/broker nodes, and
platform-managed env vars (e.g. `DATABASE_URL`) are shown as auto-injected.
