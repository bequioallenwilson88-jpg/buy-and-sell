# Deploying Commonplace on Railway

The login, listings, purchase requests, and messages require the Node server in `server.js`; static-only hosting will not provide the `/api` endpoints.

1. Push this project to a GitHub repository. Do not commit `commonplace.sqlite`; it is ignored by `.gitignore`.
2. In Railway, create a project from that repository. The included `railway.toml` selects Nixpacks, starts the service with `npm start`, and checks `/api/health`.
3. Add a Railway volume mounted at `/data`.
4. Set these service variables:

```text
DATABASE_PATH=/data/commonplace.sqlite
NODE_ENV=production
```

5. Generate a public Railway domain for the service and open that HTTPS URL. The server listens on `0.0.0.0` and Railway's `PORT`.

The users table stores salted password hashes. Session records, listings, categories, purchase requests, and messages are stored in SQLite. The persistent volume keeps them through deploys/restarts. Railway usage and volumes may require a paid plan; check the current Railway pricing before enabling billing.

For local development, run `npm start` and open `http://localhost:4173`.