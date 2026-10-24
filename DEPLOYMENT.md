# Deploying Commonplace on Railway

The login, listings, purchase requests, and messages require the Node server in `server.js`; static-only hosting will not provide the `/api` endpoints.

1. Push this project to a GitHub repository. Do not commit `commonplace.sqlite`; it is ignored by `.gitignore`.
2. In Railway, create a project from that repository. The included `railway.toml` selects Nixpacks, starts the service with `npm start`, and checks `/api/health`.
3. Add a Railway volume mounted at `/data`.
4. Set these service variables:

```text
DATABASE_PATH=/data/commonplace.sqlite
NODE_ENV=production
FIREBASE_PROJECT_ID=common-place-171e0
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

5. Generate a public Railway domain for the service and open that HTTPS URL. The server listens on `0.0.0.0` and Railway's `PORT`.

The server marks API responses as non-cacheable and requires browsers to revalidate static files, so refreshed deployments and marketplace data are not hidden by stale browser or proxy caches. Changes in the source repository still need to be pushed and deployed; production records remain in the SQLite database on the mounted `/data` volume.

In Firebase Console, enable Google under Authentication > Sign-in method, then add your deployed domain under Authentication > Settings > Authorized domains.

```text
https://common-place-171e0.firebaseapp.com/__/auth/handler
```

Google credentials are managed by Firebase Authentication; the web Firebase config in `app.js` is public client configuration. `FIREBASE_SERVICE_ACCOUNT_JSON` is private: create a service account with Firebase Authentication verification access and store its JSON only as a server environment variable. Never put service-account credentials in frontend files or commit them. For local development, add `localhost` to Firebase Authentication's authorized domains and provide the same Admin environment variables before starting the server.

The users table stores salted password hashes. Session records, listings, categories, purchase requests, and messages are stored in SQLite. The persistent volume keeps them through deploys/restarts. Railway usage and volumes may require a paid plan; check the current Railway pricing before enabling billing.

For local development, run `npm start` and open `http://localhost:4173`.