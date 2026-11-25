# Looma Admin — Standalone Operations Console

Dedicated platform administration application separated from the main Looma Advertising advertiser & publisher portal.

## Running Independently

```bash
cd admin
npm install
npm run dev
```

By default, the development server runs on `http://localhost:3001` and proxies `/api` requests to the Looma Advertising backend at `http://localhost:3000` (override with `VITE_API_TARGET` in dev or `VITE_API_BASE_URL` for cross-origin production deployments).

## Build & Type Check

```bash
npm run lint
npm run build
```
