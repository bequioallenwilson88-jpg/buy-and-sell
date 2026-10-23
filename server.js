const { createServer } = require('node:http');
const { createReadStream } = require('node:fs');
const { statSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');

const root = __dirname;
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || '0.0.0.0';
const databasePath = process.env.DATABASE_PATH || path.join(root, 'commonplace.sqlite');
const database = new DatabaseSync(databasePath);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
database.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  )
`);
database.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    category TEXT NOT NULL,
    location TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
database.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
database.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fulfillment TEXT NOT NULL CHECK (fulfillment IN ('delivery', 'meetup')),
    status TEXT NOT NULL DEFAULT 'requested',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (listing_id, buyer_id)
  )
`);
database.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
const defaultCategories = ['Furniture', 'Home', 'Tech', 'Fashion', 'Outdoors'];
const insertDefaultCategory = database.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
for (const category of defaultCategories) insertDefaultCategory.run(category);
const listingColumns = new Set(database.prepare('PRAGMA table_info(listings)').all().map((column) => column.name));
if (!listingColumns.has('latitude')) database.exec('ALTER TABLE listings ADD COLUMN latitude REAL');
if (!listingColumns.has('longitude')) database.exec('ALTER TABLE listings ADD COLUMN longitude REAL');
database.exec('PRAGMA foreign_keys = ON');

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_500_000) {
        reject(new Error('Request is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid request body.'));
      }
    });
    request.on('error', reject);
  });
}

function sessionCookie(sessionId, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `commonplace_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function createSession(user, response) {
  const sessionId = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 24 * 7 * 1000;
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(createHash('sha256').update(sessionId).digest('hex'), user.id, expiresAt);
  response.setHeader('Set-Cookie', sessionCookie(sessionId, 60 * 60 * 24 * 7));
}

function getSessionId(request) {
  return (request.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('commonplace_session='))?.split('=')[1];
}

function getAuthenticatedUser(request) {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  const tokenHash = createHash('sha256').update(sessionId).digest('hex');
  const session = database.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now());
  if (!session) return null;
  return database.prepare('SELECT id, username, email, display_name FROM users WHERE id = ?').get(session.user_id) || null;
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  const conversationMessagesMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/messages$/);
  if (url.pathname === '/api/conversations' || conversationMessagesMatch) {
    const user = getAuthenticatedUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Please log in to use buyer and seller messages.' });
      return;
    }

    if (url.pathname === '/api/conversations' && request.method === 'GET') {
      const rows = database.prepare(`
        SELECT c.id, c.listing_id, c.buyer_id, c.seller_id, c.fulfillment, c.status,
          l.title, l.price, l.image, buyer.username AS buyer_username,
          buyer.display_name AS buyer_name, seller.username AS seller_username,
          seller.display_name AS seller_name,
          (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
          (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message_at
        FROM conversations c
        JOIN listings l ON l.id = c.listing_id
        JOIN users buyer ON buyer.id = c.buyer_id
        JOIN users seller ON seller.id = c.seller_id
        WHERE c.buyer_id = ? OR c.seller_id = ?
        ORDER BY c.id DESC
      `).all(user.id, user.id);
      sendJson(response, 200, { conversations: rows.map((row) => ({
        id: row.id,
        listingId: `user-${row.listing_id}`,
        listingTitle: row.title,
        price: row.price,
        image: row.image,
        fulfillment: row.fulfillment,
        status: row.status,
        otherUser: row.buyer_id === user.id
          ? { username: row.seller_username, displayName: row.seller_name }
          : { username: row.buyer_username, displayName: row.buyer_name },
        lastMessage: row.last_message || '',
        updatedAt: row.last_message_at
      })) });
      return;
    }

    if (url.pathname === '/api/conversations' && request.method === 'POST') {
      let data;
      try {
        data = await readJson(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const listingIdMatch = String(data.listingId || '').match(/^user-(\d+)$/);
      const fulfillment = String(data.fulfillment || '');
      const body = String(data.message || '').trim();
      if (!listingIdMatch || !['delivery', 'meetup'].includes(fulfillment) || !body || body.length > 2000) {
        sendJson(response, 400, { error: 'Choose delivery or meet up and include a message (up to 2,000 characters).' });
        return;
      }
      const listing = database.prepare('SELECT id, owner_id FROM listings WHERE id = ?').get(Number(listingIdMatch[1]));
      if (!listing) {
        sendJson(response, 404, { error: 'This listing is no longer available.' });
        return;
      }
      if (listing.owner_id === user.id) {
        sendJson(response, 400, { error: 'You cannot send a purchase request for your own listing.' });
        return;
      }
      let conversation = database.prepare('SELECT id FROM conversations WHERE listing_id = ? AND buyer_id = ?').get(listing.id, user.id);
      if (conversation) {
        database.prepare('UPDATE conversations SET fulfillment = ?, status = ? WHERE id = ?')
          .run(fulfillment, 'requested', conversation.id);
      } else {
        const result = database.prepare('INSERT INTO conversations (listing_id, buyer_id, seller_id, fulfillment) VALUES (?, ?, ?, ?)')
          .run(listing.id, user.id, listing.owner_id, fulfillment);
        conversation = { id: Number(result.lastInsertRowid) };
      }
      database.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)')
        .run(conversation.id, user.id, body);
      sendJson(response, 201, { conversationId: conversation.id });
      return;
    }

    if (conversationMessagesMatch) {
      const conversationId = Number(conversationMessagesMatch[1]);
      const conversation = database.prepare('SELECT id, buyer_id, seller_id FROM conversations WHERE id = ? AND (buyer_id = ? OR seller_id = ?)')
        .get(conversationId, user.id, user.id);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      if (request.method === 'GET') {
        const messages = database.prepare(`
          SELECT messages.id, messages.sender_id, messages.body, messages.created_at,
            users.display_name, users.username
          FROM messages JOIN users ON users.id = messages.sender_id
          WHERE messages.conversation_id = ? ORDER BY messages.id
        `).all(conversationId);
        sendJson(response, 200, { messages: messages.map((message) => ({
          id: message.id,
          senderId: message.sender_id,
          body: message.body,
          createdAt: message.created_at,
          sender: { username: message.username, displayName: message.display_name }
        })) });
        return;
      }
      if (request.method === 'POST') {
        let data;
        try {
          data = await readJson(request);
        } catch (error) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        const body = String(data.message || '').trim();
        if (!body || body.length > 2000) {
          sendJson(response, 400, { error: 'Message cannot be empty or exceed 2,000 characters.' });
          return;
        }
        const result = database.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)')
          .run(conversationId, user.id, body);
        sendJson(response, 201, { message: { id: Number(result.lastInsertRowid), senderId: user.id, body, sender: { username: user.username, displayName: user.display_name } } });
        return;
      }
      sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    return;
  }

  if (url.pathname === '/api/categories') {
    if (request.method === 'GET') {
      const categories = database.prepare('SELECT name FROM categories ORDER BY name COLLATE NOCASE').all().map((row) => row.name);
      sendJson(response, 200, { categories });
      return;
    }
    if (request.method === 'POST') {
      const user = getAuthenticatedUser(request);
      if (!user) {
        sendJson(response, 401, { error: 'Please log in before adding a category.' });
        return;
      }
      let data;
      try {
        data = await readJson(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const name = String(data.name || '').trim().replace(/\s+/g, ' ');
      if (!/^[\p{L}\p{N}][\p{L}\p{N} &'_-]{1,31}$/u.test(name)) {
        sendJson(response, 400, { error: 'Category must be 2 to 32 characters and use letters, numbers, spaces, apostrophes, ampersands, dashes, or underscores.' });
        return;
      }
      try {
        database.prepare('INSERT INTO categories (name, created_by) VALUES (?, ?)').run(name, user.id);
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
          sendJson(response, 409, { error: 'That category already exists.' });
          return;
        }
        throw error;
      }
      sendJson(response, 201, { category: name });
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/me') {
    const sessionId = getSessionId(request);
    const tokenHash = sessionId ? createHash('sha256').update(sessionId).digest('hex') : '';
    const userRecord = getAuthenticatedUser(request);
    if (!userRecord) {
      if (tokenHash) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      sendJson(response, 200, { user: null });
      return;
    }
    sendJson(response, 200, { user: { id: userRecord.id, username: userRecord.username, email: userRecord.email, displayName: userRecord.display_name } });
    return;
  }

  if (url.pathname === '/api/listings') {
    const user = getAuthenticatedUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Please log in to view listings.' });
      return;
    }

    if (request.method === 'GET') {
      const rows = database.prepare(`
        SELECT listings.id, listings.owner_id, listings.title, listings.price,
          listings.category, listings.location, listings.latitude, listings.longitude,
          listings.image, listings.created_at,
          users.username, users.display_name
        FROM listings JOIN users ON users.id = listings.owner_id
        ORDER BY listings.id DESC
      `).all();
      sendJson(response, 200, {
        listings: rows.map((listing) => ({
          id: `user-${listing.id}`,
          ownerId: listing.owner_id,
          title: listing.title,
          price: listing.price,
          category: listing.category,
          location: listing.location,
          latitude: listing.latitude,
          longitude: listing.longitude,
          image: listing.image,
          time: 'just now',
          seller: { username: listing.username, displayName: listing.display_name }
        }))
      });
      return;
    }

    if (request.method === 'POST') {
      let data;
      try {
        data = await readJson(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      const title = String(data.title || '').trim();
      const category = String(data.category || '').trim();
      const location = String(data.location || '').trim();
      const price = Number(data.price);
      const image = String(data.image || '');
      const latitude = data.latitude === null || data.latitude === '' || data.latitude === undefined ? null : Number(data.latitude);
      const longitude = data.longitude === null || data.longitude === '' || data.longitude === undefined ? null : Number(data.longitude);
      const categoryExists = database.prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE').get(category);
      if (!title || title.length > 120 || !Number.isSafeInteger(price) || price < 1 || !categoryExists || !location || location.length > 120) {
        sendJson(response, 400, { error: 'Enter a title, valid price, category, and location for the listing.' });
        return;
      }
      if ((latitude === null) !== (longitude === null)
        || (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
          || !Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
        sendJson(response, 400, { error: 'Location pin is invalid. Choose your location again.' });
        return;
      }
      if (image && !image.startsWith('data:image/') && !/^https:\/\//i.test(image)) {
        sendJson(response, 400, { error: 'Photo must be an image upload or an HTTPS image URL.' });
        return;
      }
      if (image.length > 8_000_000) {
        sendJson(response, 413, { error: 'Photo is too large. Choose a smaller image.' });
        return;
      }

      const result = database.prepare('INSERT INTO listings (owner_id, title, price, category, location, latitude, longitude, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(user.id, title, price, category, location, latitude, longitude, image);
      sendJson(response, 201, {
        listing: {
          id: `user-${result.lastInsertRowid}`,
          ownerId: user.id,
          title,
          price,
          category,
          location,
          latitude,
          longitude,
          image,
          time: 'just now',
          seller: { username: user.username, displayName: user.display_name }
        }
      });
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
    return;
  }

  let data;
  try {
    data = await readJson(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  if (url.pathname === '/api/register') {
    const username = String(data.username || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    const displayName = String(data.name || '').trim();
    const password = String(data.password || '');

    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
      sendJson(response, 400, { error: 'Username must be 3 to 24 characters using letters, numbers, dots, dashes, or underscores.' });
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email) || !displayName || password.length < 8 || password.length > 256) {
      sendJson(response, 400, { error: 'Enter a valid name and email, and use a password with at least 8 characters.' });
      return;
    }

    const salt = randomBytes(16);
    const passwordHash = scryptSync(password, salt, 64).toString('hex');
    try {
      const result = database.prepare('INSERT INTO users (username, email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)')
        .run(username, email, displayName, passwordHash, salt.toString('hex'));
      const user = { id: Number(result.lastInsertRowid), username, email, displayName };
      sendJson(response, 201, { user });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        const field = String(error.message).includes('users.username') ? 'username' : 'email';
        sendJson(response, 409, { error: `That ${field} is already registered. Please log in instead.` });
        return;
      }
      throw error;
    }
    return;
  }

  if (url.pathname === '/api/login') {
    const identity = String(data.identity || '').trim();
    const password = String(data.password || '');
    const userRecord = database.prepare('SELECT id, username, email, display_name, password_hash, password_salt FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1')
      .get(identity, identity);

    if (!userRecord) {
      sendJson(response, 404, { code: 'ACCOUNT_NOT_FOUND', error: 'No account found for that username. Please register first.' });
      return;
    }

    const expected = Buffer.from(userRecord.password_hash, 'hex');
    const actual = scryptSync(password, Buffer.from(userRecord.password_salt, 'hex'), 64);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      sendJson(response, 401, { code: 'WRONG_PASSWORD', error: 'Password is incorrect. Please try again.' });
      return;
    }

    const user = { id: userRecord.id, username: userRecord.username, email: userRecord.email, displayName: userRecord.display_name };
    createSession(user, response);
    sendJson(response, 200, { user });
    return;
  }

  if (url.pathname === '/api/logout') {
    const sessionId = getSessionId(request);
    if (sessionId) {
      database.prepare('DELETE FROM sessions WHERE token_hash = ?')
        .run(createHash('sha256').update(sessionId).digest('hex'));
    }
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { error: 'Server error. Please try again.' });
      else response.destroy();
    }
    return;
  }

  if (url.pathname.endsWith('.sqlite') || url.pathname.endsWith('.sqlite-wal') || url.pathname.endsWith('.sqlite-shm')) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const requestedPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(root, requestedPath);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, 'index.html')) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    if (!statSync(filePath).isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`Commonplace running on ${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
});
