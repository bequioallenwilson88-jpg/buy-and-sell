const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL to the Supabase PostgreSQL connection string.');

const sqlitePath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'commonplace.sqlite');
const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const pool = new Pool({ connectionString: databaseUrl });
const tables = [
  {
    name: 'users',
    columns: ['id', 'username', 'email', 'display_name', 'password_hash', 'password_salt', 'created_at']
  },
  {
    name: 'social_identities',
    columns: ['provider', 'provider_user_id', 'user_id']
  },
  {
    name: 'listings',
    columns: ['id', 'owner_id', 'title', 'price', 'category', 'location', 'image', 'created_at', 'latitude', 'longitude']
  },
  {
    name: 'categories',
    columns: ['name', 'created_by', 'created_at']
  },
  {
    name: 'conversations',
    columns: ['id', 'listing_id', 'buyer_id', 'seller_id', 'fulfillment', 'status', 'created_at']
  },
  {
    name: 'messages',
    columns: ['id', 'conversation_id', 'sender_id', 'body', 'created_at']
  }
];

async function migrate() {
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    const protectedTables = ['users', 'social_identities', 'sessions', 'listings', 'conversations', 'messages'];
    for (const table of protectedTables) {
      const result = await client.query(`SELECT COUNT(*)::integer AS count FROM ${table}`);
      if (result.rows[0].count > 0) {
        throw new Error(`The Supabase ${table} table is not empty. Migration stopped to avoid overwriting production data.`);
      }
    }

    await client.query('BEGIN');
    transactionStarted = true;
    const counts = new Map();
    for (const { name, columns } of tables) {
      const rows = sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${name}`).all();
      counts.set(name, rows.length);
      if (rows.length === 0) continue;

      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const conflictClause = name === 'categories' ? ' ON CONFLICT DO NOTHING' : '';
      const insert = `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders})${conflictClause}`;
      for (const row of rows) {
        await client.query(insert, columns.map((column) => row[column]));
      }
    }

    for (const { name, columns } of tables.filter((table) => table.columns.includes('id'))) {
      const result = await client.query(`SELECT COALESCE(MAX(id), 1) AS max_id, COUNT(*) > 0 AS has_rows FROM ${name}`);
      await client.query(
        "SELECT setval(pg_get_serial_sequence($1, 'id'), $2, $3)",
        [`public.${name}`, result.rows[0].max_id, result.rows[0].has_rows]
      );
    }
    await client.query('COMMIT');
    transactionStarted = false;
    for (const [name, count] of counts) console.log(`${name}: ${count} local records read`);
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    throw error;
  } finally {
    client?.release();
    sqlite.close();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('SQLite data migration failed:', error.message);
  process.exitCode = 1;
});
