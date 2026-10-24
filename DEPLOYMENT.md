# Free Node.js deployment

This app can run locally with SQLite or use Supabase Postgres in production. Render hosts the Node.js server; Supabase stores accounts, listings, categories, purchase requests, and messages.

## Deploy

1. Create a free project at [Supabase](https://supabase.com/dashboard). Open **Connect**, choose a Supavisor pooler connection string suitable for external clients, and keep `sslmode=require`. Do not commit the connection string or share it publicly.
2. In [Render](https://render.com), choose **New > Blueprint**, connect the GitHub repository, and deploy the `render.yaml` blueprint. Set `DATABASE_URL` to the Supabase connection string when prompted.
3. Wait for the first Render deploy to finish. It creates the database tables and seeds default categories. Before using the live site, migrate the existing local SQLite data from the project directory in PowerShell:

   ```powershell
   $secret = Read-Host 'Supabase DATABASE_URL' -AsSecureString
   $env:DATABASE_URL = [System.Net.NetworkCredential]::new('', $secret).Password
   npm run migrate:sqlite
   Remove-Item Env:DATABASE_URL
   Remove-Variable secret
   ```

   The migration copies existing accounts, listings, categories, conversations, and messages. You will need to log in again on the deployed domain. It refuses to copy if the destination already contains user data. Keep the connection string private.
4. Open the generated `onrender.com` URL and check that `/api/health` returns `{"ok":true}`.
5. If enabling Google sign-in, set `FIREBASE_SERVICE_ACCOUNT_JSON` in the Render service environment using a Firebase Admin service-account JSON. Also add the Render domain under Firebase Authentication > Settings > Authorized domains. Keep the service account secret in Render only.

Render's free web service sleeps after 15 minutes without traffic and may take about a minute to wake up. Supabase's free database has 500 MB of storage and can pause after a week of inactivity. Keep backups of important data and check both providers' current free-plan limits. A free Render service does not have durable local disk, so production must use `DATABASE_URL`; it must not rely on the local SQLite file.

## Local development

Install dependencies with `npm install`, run `npm start`, and open `http://localhost:4173`. Without `DATABASE_URL`, the server uses `commonplace.sqlite` locally.
