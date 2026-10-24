const { createServer } = require('node:http');
const { createReadStream } = require('node:fs');
const { statSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { applicationDefault, cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const root = __dirname;
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || '0.0.0.0';
const databasePath = process.env.DATABASE_PATH || path.join(root, 'commonplace.sqlite');
const database = new DatabaseSync(databasePath);
let firebaseAdminApp;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

async function initializeDatabase() {
  database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS social_identities (
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (provider, provider_user_id),
        UNIQUE (provider, user_id)
      );
      CREATE TABLE IF NOT EXISTS listings (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        price INTEGER NOT NULL CHECK (price > 0),
        category TEXT NOT NULL,
        location TEXT NOT NULL,
        image TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fulfillment TEXT NOT NULL CHECK (fulfillment IN ('delivery', 'meetup')),
        status TEXT NOT NULL DEFAULT 'requested',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (listing_id, buyer_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
  `);
  const listingColumns = new Set(database.prepare('PRAGMA table_info(listings)').all().map((column) => column.name));
  if (!listingColumns.has('latitude')) database.exec('ALTER TABLE listings ADD COLUMN latitude REAL');
  if (!listingColumns.has('longitude')) database.exec('ALTER TABLE listings ADD COLUMN longitude REAL');
  database.exec('PRAGMA foreign_keys = ON');
  const defaultCategories = ['Furniture', 'Home', 'Tech', 'Fashion', 'Outdoors'];
  const insertDefaultCategory = database.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  for (const category of defaultCategories) await insertDefaultCategory.run(category);
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
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

async function createSession(user, response) {
  const sessionId = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 24 * 7 * 1000;
  await database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(createHash('sha256').update(sessionId).digest('hex'), user.id, expiresAt);
  response.setHeader('Set-Cookie', sessionCookie(sessionId, 60 * 60 * 24 * 7));
  return sessionId;
}

function getSessionId(request) {
  return (request.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('commonplace_session='))?.split('=')[1];
}

async function getAuthenticatedUser(request) {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  const tokenHash = createHash('sha256').update(sessionId).digest('hex');
  const session = await database.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now());
  if (!session) return null;
  return await database.prepare('SELECT id, username, email, display_name FROM users WHERE id = ?').get(session.user_id) || null;
}

function getFirebaseAdminAuth() {
  if (!firebaseAdminApp) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const options = {
      projectId: process.env.FIREBASE_PROJECT_ID || 'common-place-171e0',
      credential: serviceAccountJson ? cert(JSON.parse(serviceAccountJson)) : applicationDefault()
    };
    firebaseAdminApp = getApps()[0] || initializeApp(options);
  }
  return getAuth(firebaseAdminApp);
}

function getCookie(request, name) {
  return (request.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function oauthStateCookie(value, maxAge, secure) {
  return `commonplace_oauth_state=${value}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function oauthRedirectUri(request, provider) {
  const baseUrl = process.env.OAUTH_BASE_URL
    || `${process.env.NODE_ENV === 'production' ? 'https' : (request.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${request.headers['x-forwarded-host'] || request.headers.host || 'localhost:4173'}`;
  const parsedBaseUrl = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new Error('Invalid OAuth base URL.');
  }
  return new URL(`/auth/${provider}/callback`, parsedBaseUrl).toString();
}

async function socialUsername(email) {
  const base = (email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 15) || 'member').padEnd(3, 'x');
  let username;
  do {
    username = `${base}-${randomBytes(3).toString('hex')}`.slice(0, 24);
  } while (await database.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username));
  return username;
}

async function getOrCreateSocialUser(provider, providerUserId, email, displayName) {
  const linkedUser = await database.prepare(`
    SELECT users.id, users.username, users.email, users.display_name
    FROM social_identities JOIN users ON users.id = social_identities.user_id
    WHERE social_identities.provider = ? AND social_identities.provider_user_id = ?
  `).get(provider, providerUserId);
  if (linkedUser) return linkedUser;

  const existingEmail = await database.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (existingEmail) {
    throw new Error('An account already uses this email. Log in with that account first; social account linking is not available yet.');
  }

  const username = await socialUsername(email);
  const salt = randomBytes(16);
  const passwordHash = scryptSync(randomBytes(32), salt, 64).toString('hex');
  const result = await database.prepare('INSERT INTO users (username, email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)')
    .run(username, email, displayName, passwordHash, salt.toString('hex'));
  const userId = Number(result.lastInsertRowid);
  await database.prepare('INSERT INTO social_identities (provider, provider_user_id, user_id) VALUES (?, ?, ?)')
    .run(provider, providerUserId, userId);
  return { id: userId, username, email, display_name: displayName };
}

function oauthErrorRedirect(response, message, stateCookie) {
  response.writeHead(302, {
    Location: `/?authError=${encodeURIComponent(message)}`,
    ...(stateCookie ? { 'Set-Cookie': stateCookie } : {})
  });
  response.end();
}

async function handleOAuth(request, response, url) {
  const match = url.pathname.match(/^\/auth\/(google|facebook)(\/callback)?$/);
  if (!match || request.method !== 'GET') return false;

  const provider = match[1];
  const isCallback = Boolean(match[2]);
  const isProduction = process.env.NODE_ENV === 'production';
  const stateCookie = oauthStateCookie('', 0, isProduction);
  const clientId = provider === 'google' ? process.env.GOOGLE_CLIENT_ID : process.env.FACEBOOK_APP_ID;
  const clientSecret = provider === 'google' ? process.env.GOOGLE_CLIENT_SECRET : process.env.FACEBOOK_APP_SECRET;
  if (!clientId || !clientSecret) {
    oauthErrorRedirect(response, `${provider === 'google' ? 'Google' : 'Facebook'} sign-in is not configured on this server yet.`);
    return true;
  }

  const redirectUri = oauthRedirectUri(request, provider);
  if (!isCallback) {
    const state = randomBytes(32).toString('hex');
    const authorizationUrl = provider === 'google'
      ? new URL('https://accounts.google.com/o/oauth2/v2/auth')
      : new URL(`https://www.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || 'v22.0'}/dialog/oauth`);
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: provider === 'google' ? 'openid email profile' : 'email,public_profile',
      state
    }).toString();
    response.writeHead(302, {
      Location: authorizationUrl.toString(),
      'Set-Cookie': oauthStateCookie(state, 600, isProduction)
    });
    response.end();
    return true;
  }

  const savedState = getCookie(request, 'commonplace_oauth_state') || '';
  const returnedState = url.searchParams.get('state') || '';
  const stateMatches = savedState.length === returnedState.length
    && savedState.length > 0
    && timingSafeEqual(Buffer.from(savedState), Buffer.from(returnedState));
  if (!stateMatches) {
    oauthErrorRedirect(response, 'Sign-in could not be verified. Please try again.', stateCookie);
    return true;
  }
  if (url.searchParams.has('error') || !url.searchParams.get('code')) {
    oauthErrorRedirect(response, 'Sign-in was cancelled or denied.', stateCookie);
    return true;
  }

  try {
    const tokenParameters = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code: url.searchParams.get('code')
    });
    let tokenResponse;
    if (provider === 'google') {
      tokenParameters.set('grant_type', 'authorization_code');
      tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParameters,
        signal: AbortSignal.timeout(10000)
      });
    } else {
      const tokenUrl = new URL(`https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || 'v22.0'}/oauth/access_token`);
      tokenUrl.search = tokenParameters.toString();
      tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(10000) });
    }
    if (!tokenResponse.ok) throw new Error('Could not complete sign-in with the provider.');
    const tokenData = await tokenResponse.json();
    let providerUser;
    if (provider === 'google') {
      const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!profileResponse.ok) throw new Error('Could not read your Google account details.');
      providerUser = await profileResponse.json();
      if (providerUser.email_verified !== true) throw new Error('Please use a Google account with a verified email address.');
      providerUser.id = providerUser.sub;
    } else {
      const profileUrl = new URL(`https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || 'v22.0'}/me`);
      profileUrl.search = new URLSearchParams({ fields: 'id,name,email', access_token: tokenData.access_token }).toString();
      const profileResponse = await fetch(profileUrl, { signal: AbortSignal.timeout(10000) });
      if (!profileResponse.ok) throw new Error('Could not read your Facebook account details.');
      providerUser = await profileResponse.json();
    }

    const email = String(providerUser.email || '').trim().toLowerCase();
    const displayName = String(providerUser.name || providerUser.given_name || '').trim().slice(0, 80);
    if (!providerUser.id || !/^\S+@\S+\.\S+$/.test(email) || !displayName) {
      throw new Error('The provider did not return a name and email address. Check its email permission and try again.');
    }
    const record = await getOrCreateSocialUser(provider, String(providerUser.id), email, displayName);
    const user = { id: record.id, username: record.username, email: record.email, displayName: record.display_name };
    const sessionId = await createSession(user, response);
    response.setHeader('Set-Cookie', [sessionCookie(sessionId, 60 * 60 * 24 * 7), stateCookie]);
    response.writeHead(302, { Location: '/' });
    response.end();
  } catch (error) {
    oauthErrorRedirect(response, error.message || 'Could not complete social sign-in. Please try again.', stateCookie);
  }
  return true;
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/firebase') {
    const authorization = request.headers.authorization || '';
    const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!idToken) {
      sendJson(response, 401, { error: 'Firebase sign-in token is missing. Please try again.' });
      return;
    }

    let decodedToken;
    try {
      decodedToken = await getFirebaseAdminAuth().verifyIdToken(idToken);
    } catch (error) {
      console.error('Firebase token verification failed:', error.message);
      sendJson(response, 401, { error: 'Firebase could not verify this sign-in. Check the server credentials and try again.' });
      return;
    }

    const email = String(decodedToken.email || '').trim().toLowerCase();
    const displayName = String(decodedToken.name || email.split('@')[0] || 'Marketplace member').trim().slice(0, 80);
    if (!decodedToken.uid || !/^\S+@\S+\.\S+$/.test(email)) {
      sendJson(response, 400, { error: 'Your Firebase account must provide a valid email address.' });
      return;
    }

    let userRecord;
    try {
      userRecord = await getOrCreateSocialUser('firebase', decodedToken.uid, email, displayName);
    } catch (error) {
      const isExistingEmail = String(error.message).includes('An account already uses this email');
      sendJson(response, isExistingEmail ? 409 : 500, {
        error: isExistingEmail
          ? 'An account already uses this email. Log in with that account before linking a social provider.'
          : 'Could not create your marketplace account. Please try again.'
      });
      return;
    }

    const user = {
      id: userRecord.id,
      username: userRecord.username,
      email: userRecord.email,
      displayName: userRecord.display_name
    };
    await createSession(user, response);
    sendJson(response, 200, { user });
    return;
  }

  const conversationMessagesMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/messages$/);
  if (url.pathname === '/api/conversations' || conversationMessagesMatch) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Please log in to use buyer and seller messages.' });
      return;
    }

    if (url.pathname === '/api/conversations' && request.method === 'GET') {
      const rows = await database.prepare(`
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
      const listing = await database.prepare('SELECT id, owner_id FROM listings WHERE id = ?').get(Number(listingIdMatch[1]));
      if (!listing) {
        sendJson(response, 404, { error: 'This listing is no longer available.' });
        return;
      }
      if (listing.owner_id === user.id) {
        sendJson(response, 400, { error: 'You cannot send a purchase request for your own listing.' });
        return;
      }
      let conversation = await database.prepare('SELECT id FROM conversations WHERE listing_id = ? AND buyer_id = ?').get(listing.id, user.id);
      if (conversation) {
        await database.prepare('UPDATE conversations SET fulfillment = ?, status = ? WHERE id = ?')
          .run(fulfillment, 'requested', conversation.id);
      } else {
        const result = await database.prepare('INSERT INTO conversations (listing_id, buyer_id, seller_id, fulfillment) VALUES (?, ?, ?, ?)')
          .run(listing.id, user.id, listing.owner_id, fulfillment);
        conversation = { id: Number(result.lastInsertRowid) };
      }
      await database.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)')
        .run(conversation.id, user.id, body);
      sendJson(response, 201, { conversationId: conversation.id });
      return;
    }

    if (conversationMessagesMatch) {
      const conversationId = Number(conversationMessagesMatch[1]);
      const conversation = await database.prepare('SELECT id, buyer_id, seller_id FROM conversations WHERE id = ? AND (buyer_id = ? OR seller_id = ?)')
        .get(conversationId, user.id, user.id);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      if (request.method === 'GET') {
        const messages = await database.prepare(`
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
        const result = await database.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)')
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
      const categories = (await database.prepare('SELECT name FROM categories ORDER BY name COLLATE NOCASE').all()).map((row) => row.name);
      sendJson(response, 200, { categories });
      return;
    }
    if (request.method === 'POST') {
      const user = await getAuthenticatedUser(request);
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
        await database.prepare('INSERT INTO categories (name, created_by) VALUES (?, ?)').run(name, user.id);
      } catch (error) {
        if (error.code === '23505' || String(error.message).includes('UNIQUE constraint failed')) {
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
    const userRecord = await getAuthenticatedUser(request);
    if (!userRecord) {
      if (tokenHash) await database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      sendJson(response, 200, { user: null });
      return;
    }
    sendJson(response, 200, { user: { id: userRecord.id, username: userRecord.username, email: userRecord.email, displayName: userRecord.display_name } });
    return;
  }

  if (url.pathname === '/api/listings') {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Please log in to view listings.' });
      return;
    }

    if (request.method === 'GET') {
      const rows = await database.prepare(`
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
      const categoryExists = await database.prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE').get(category);
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

      const result = await database.prepare('INSERT INTO listings (owner_id, title, price, category, location, latitude, longitude, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
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
      const result = await database.prepare('INSERT INTO users (username, email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)')
        .run(username, email, displayName, passwordHash, salt.toString('hex'));
      const user = { id: Number(result.lastInsertRowid), username, email, displayName };
      sendJson(response, 201, { user });
    } catch (error) {
      if (error.code === '23505' || String(error.message).includes('UNIQUE constraint failed')) {
        const field = String(error.message).toLowerCase().includes('username') ? 'username' : 'email';
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
    const userRecord = await database.prepare('SELECT id, username, email, display_name, password_hash, password_salt FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1')
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
    await createSession(user, response);
    sendJson(response, 200, { user });
    return;
  }

  if (url.pathname === '/api/logout') {
    const sessionId = getSessionId(request);
    if (sessionId) {
      await database.prepare('DELETE FROM sessions WHERE token_hash = ?')
        .run(createHash('sha256').update(sessionId).digest('hex'));
    }
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/auth/')) {
    try {
      if (await handleOAuth(request, response, url)) return;
    } catch (error) {
      console.error(error);
      oauthErrorRedirect(response, 'Social sign-in is temporarily unavailable. Please try again.');
      return;
    }
  }
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
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, must-revalidate'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

initializeDatabase().then(() => {
  server.listen(port, host, () => {
    console.log(`Commonplace running on ${host}:${port}`);
    console.log(`SQLite database: ${databasePath}`);
    if (process.env.NODE_ENV === 'production') {
      console.warn('Production SQLite storage is temporary; accounts and marketplace data can be lost when the host restarts or redeploys.');
    }
  });
}).catch((error) => {
  console.error('Could not initialize the database:', error);
  process.exitCode = 1;
});
