# Free Node.js deployment

The app runs on Render's free Node.js service and stores its data in SQLite at `/tmp/commonplace.sqlite`. No Supabase account, database URL, or persistent volume is needed.

1. Open [Render](https://render.com) and choose **New > Blueprint**.
2. Connect the GitHub repository `bequioallenwilson88-jpg/buy-and-sell`.
3. Deploy the included `render.yaml`.
4. When deployment finishes, open the generated `onrender.com` URL. Check that `/api/health` returns `{"ok":true}`.

This is a free demo setup: Render sleeps after 15 minutes without traffic, and `/tmp` data is temporary. Accounts, listings, messages, and categories may be lost after a restart or deployment. This app has local sample listings, so it remains browseable if the temporary database is reset.

For local development, run `npm start` and open `http://localhost:4173`.
