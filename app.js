import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';

const firebaseApp = initializeApp({
  apiKey: 'AIzaSyD2_IAuYtFwGJMO8P2Hss2JNvEW4AmD53s',
  authDomain: 'common-place-171e0.firebaseapp.com',
  projectId: 'common-place-171e0',
  storageBucket: 'common-place-171e0.firebasestorage.app',
  messagingSenderId: '990540794624',
  appId: '1:990540794624:web:f9191219e66afd40c881e5',
  measurementId: 'G-MY3VFBX17E'
});
const firebaseAuth = getAuth(firebaseApp);

const seedListings = [
  { id: 1, title: 'Togo-style lounge chair', price: 380, category: 'Furniture', location: 'Fort Greene', time: '2h ago', color: 'rust', image: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=85' },
  { id: 2, title: 'Hand-thrown stoneware set', price: 64, category: 'Home', location: 'Prospect Heights', time: '4h ago', color: 'cream', image: 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?auto=format&fit=crop&w=800&q=85' },
  { id: 3, title: 'Olympus OM-1 film camera', price: 210, category: 'Tech', location: 'Cobble Hill', time: '6h ago', color: 'yellow', image: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=800&q=85' },
  { id: 4, title: 'Wool fisherman knit', price: 72, category: 'Fashion', location: 'Williamsburg', time: '1d ago', color: 'blue', image: 'https://images.unsplash.com/photo-1610652492500-ded49ceeb378?auto=format&fit=crop&w=800&q=85' },
  { id: 5, title: '1970s oak side table', price: 145, category: 'Furniture', location: 'Clinton Hill', time: '1d ago', color: 'wood', image: 'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?auto=format&fit=crop&w=800&q=85' },
  { id: 6, title: 'Canvas weekend bag', price: 58, category: 'Outdoors', location: 'Park Slope', time: '2d ago', color: 'green', image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=85' },
  { id: 7, title: 'Brass reading lamp', price: 90, category: 'Home', location: 'Bedford-Stuyvesant', time: '2d ago', color: 'brass', image: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=800&q=85' },
  { id: 8, title: 'Sierra camping stove', price: 45, category: 'Outdoors', location: 'Greenpoint', time: '3d ago', color: 'orange', image: 'https://images.unsplash.com/photo-1523987355523-c7b5b0dd90a7?auto=format&fit=crop&w=800&q=85' }
];

const savedStorageKey = 'commonplace-saved-listings';

function readStoredValue(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function getSeedListings() {
  return seedListings.map((listing) => ({
    ...listing,
    seller: { username: 'neighbor', displayName: 'Commonplace neighbor' },
    ownerId: null
  }));
}

let listings = getSeedListings();
let saved = new Set();
let currentCategory = 'All';
let currentView = 'browse';
let currentUser = null;
let selectedConversationId = null;
let categories = ['Furniture', 'Home', 'Tech', 'Fashion', 'Outdoors'];
const grid = document.querySelector('#listingGrid');
const emptyState = document.querySelector('#emptyState');
const searchInput = document.querySelector('#searchInput');
const locationInput = document.querySelector('#locationInput');
const locationMapLink = document.querySelector('#openLocationMap');
const savedCount = document.querySelector('#savedCount');
const categoryRow = document.querySelector('#categoryRow');
const listingCategorySelect = document.querySelector('#listingCategory');
const inboxSection = document.querySelector('#inboxSection');
const conversationList = document.querySelector('#conversationList');
const conversationPanel = document.querySelector('#conversationPanel');
const purchaseModal = document.querySelector('#purchaseModal');
const purchaseForm = document.querySelector('#purchaseForm');
const purchaseStatus = document.querySelector('#purchaseStatus');
let pendingPurchaseListing = null;

function money(value) { return `$${Number(value).toLocaleString()}`; }

function persistSaved() {
  try {
    if (currentUser) localStorage.setItem(`${savedStorageKey}-${currentUser.id}`, JSON.stringify([...saved]));
  } catch {
    // Saved items remain available until the page is closed.
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function renderCategories() {
  categoryRow.innerHTML = [
    '<button class="category active" data-category="All" role="tab" aria-selected="true">All finds</button>',
    ...categories.map((category) => `<button class="category" data-category="${escapeHtml(category)}" role="tab" aria-selected="false">${escapeHtml(category)}</button>`)
  ].join('');
  listingCategorySelect.innerHTML = categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  if (categories.includes(currentCategory)) {
    const activeButton = [...categoryRow.querySelectorAll('.category')].find((button) => button.dataset.category === currentCategory);
    if (activeButton) {
      categoryRow.querySelectorAll('.category').forEach((button) => {
        button.classList.toggle('active', button === activeButton);
        button.setAttribute('aria-selected', String(button === activeButton));
      });
    }
  } else {
    currentCategory = 'All';
  }
}

async function loadCategories() {
  const response = await fetch('/api/categories');
  if (!response.ok) throw new Error('Could not load categories.');
  const result = await response.json();
  categories = result.categories;
  renderCategories();
  renderListings();
}

function renderListings() {
  const query = searchInput.value.trim().toLowerCase();
  const place = locationInput.value.trim().toLowerCase();
  const visible = listings.filter((listing) => {
    const matchesCategory = currentCategory === 'All' || listing.category === currentCategory;
    const matchesSearch = !query || `${listing.title} ${listing.category} ${listing.location}`.toLowerCase().includes(query);
    const matchesPlace = !place || listing.location.toLowerCase().includes(place);
    const matchesView = currentView === 'saved'
      ? saved.has(String(listing.id))
      : currentView !== 'selling' || listing.ownerId === currentUser?.id;
    return matchesCategory && matchesSearch && matchesPlace && matchesView;
  });

  grid.innerHTML = visible.map((listing) => {
    const sellerName = listing.seller?.displayName || 'Commonplace neighbor';
    const sellerInitials = sellerName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
    const photo = listing.image
      ? `<img src="${escapeHtml(listing.image)}" alt="${escapeHtml(listing.title)}" loading="lazy" onerror="this.style.display='none'" />`
      : '';
    return `
    <article class="listing-card">
      <div class="listing-image ${listing.image ? '' : 'listing-image-empty'}" style="${listing.image ? `background:${escapeHtml(listing.color || 'cream')}` : ''}">
        ${photo}
        <button class="save-button ${saved.has(String(listing.id)) ? 'saved' : ''}" data-save="${escapeHtml(listing.id)}" aria-label="${saved.has(String(listing.id)) ? 'Remove from saved' : 'Save'} ${escapeHtml(listing.title)}">${saved.has(String(listing.id)) ? '♥' : '♡'}</button>
      </div>
      <div class="listing-info">
        <div class="listing-topline"><h3 class="listing-title">${escapeHtml(listing.title)}</h3><span class="listing-price">${money(listing.price)}</span></div>
        <div class="listing-meta"><span class="listing-category">${escapeHtml(listing.category)}</span><span>${escapeHtml(listing.time)}</span></div>
        <a class="listing-map-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(listing.latitude !== null && listing.latitude !== undefined ? `${listing.latitude},${listing.longitude}` : listing.location)}" target="_blank" rel="noopener noreferrer">${escapeHtml(listing.location)} · View map ↗</a>
        <div class="listing-seller"><span class="seller-avatar" aria-hidden="true">${escapeHtml(sellerInitials)}</span><span>${escapeHtml(sellerName)}</span></div>
        ${listing.ownerId && listing.ownerId !== currentUser?.id ? `<button class="buy-listing-button" type="button" data-buy="${escapeHtml(listing.id)}">Buy / message seller</button>` : ''}
      </div>
    </article>`;
  }).join('');

  emptyState.classList.toggle('hidden', visible.length > 0);
  grid.classList.toggle('hidden', visible.length === 0);
  savedCount.textContent = saved.size;
}

categoryRow.addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  currentCategory = button.dataset.category;
  categoryRow.querySelectorAll('.category').forEach((item) => {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-selected', String(item === button));
  });
  renderListings();
});

grid.addEventListener('click', (event) => {
  const buyButton = event.target.closest('[data-buy]');
  if (buyButton) {
    const listing = listings.find((item) => String(item.id) === buyButton.dataset.buy);
    if (listing) openPurchaseRequest(listing);
    return;
  }
  const button = event.target.closest('[data-save]');
  if (!button) return;
  const id = button.dataset.save;
  saved.has(id) ? saved.delete(id) : saved.add(id);
  persistSaved();
  renderListings();
});

searchInput.addEventListener('input', renderListings);
locationInput.addEventListener('input', () => {
  const place = locationInput.value.trim();
  locationMapLink.href = place
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`
    : 'https://www.google.com/maps/';
  renderListings();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.focus(); }
  if (event.key === 'Escape') { closeModal(); closeAuthModal(); }
});

document.querySelectorAll('.nav-link').forEach((button) => button.addEventListener('click', () => {
  currentView = button.dataset.view;
  document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelector('#nearbyHeading').textContent = currentView === 'saved' ? 'Your saved finds' : currentView === 'selling' ? 'Your listings' : 'Worth a closer look';
  document.querySelector('.hero').classList.toggle('hidden', currentView === 'inbox');
  document.querySelector('.content-section').classList.toggle('hidden', currentView === 'inbox');
  inboxSection.classList.toggle('hidden', currentView !== 'inbox');
  renderListings();
  if (currentView === 'inbox') loadConversations();
  else document.querySelector('#browse').scrollIntoView({ behavior: 'smooth' });
}));

const modal = document.querySelector('#sellModal');
const authModal = document.querySelector('#authModal');
const authStatus = document.querySelector('#authStatus');
const loginForm = document.querySelector('#loginForm');
const registerForm = document.querySelector('#registerForm');
const loginTab = document.querySelector('#loginTab');
const registerTab = document.querySelector('#registerTab');
const logoutButton = document.querySelector('#logoutButton');
let authModalHistoryEntry = false;
const photoFile = document.querySelector('#photoFile');
const photoUrl = document.querySelector('#sellForm [name="image"]');
const photoPreviewImage = document.querySelector('#photoPreviewImage');
const photoPreviewEmpty = document.querySelector('#photoPreviewEmpty');
const photoStatus = document.querySelector('#photoStatus');
const imageSearchLink = document.querySelector('#searchImages');
const listingTitleInput = document.querySelector('#sellForm [name="title"]');
const listingCategoryInput = document.querySelector('#sellForm [name="category"]');
const listingLocationInput = document.querySelector('#listingLocation');
const listingLatitudeInput = document.querySelector('#listingLatitude');
const listingLongitudeInput = document.querySelector('#listingLongitude');
const listingLocationStatus = document.querySelector('#listingLocationStatus');
const checkLocationMap = document.querySelector('#checkLocationMap');
let selectedLocalImage = '';
let locationRequestId = 0;

function showPhotoPreview(source) {
  photoPreviewImage.src = source;
  photoPreviewImage.classList.toggle('hidden', !source);
  photoPreviewEmpty.classList.toggle('hidden', Boolean(source));
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const imageUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(imageUrl);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    image.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error('This image could not be opened. Try another file.'));
    };
    image.src = imageUrl;
  });
}

function updateImageSearchLink() {
  const query = [listingTitleInput.value.trim(), listingCategoryInput.value, 'for sale'].filter(Boolean).join(' ');
  imageSearchLink.href = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
}

listingTitleInput.addEventListener('input', updateImageSearchLink);
listingCategoryInput.addEventListener('change', updateImageSearchLink);
imageSearchLink.addEventListener('click', () => {
  photoStatus.textContent = 'Choose an image online, then paste its image address above.';
});
updateImageSearchLink();

function closeModal() { modal.classList.add('hidden'); }
function openPurchaseRequest(listing) {
  pendingPurchaseListing = listing;
  document.querySelector('#purchaseTitle').textContent = 'Ask about this item';
  document.querySelector('#purchaseListingSummary').textContent = `${listing.title} · ${money(listing.price)} · ${listing.seller?.displayName || 'Seller'}`;
  purchaseStatus.textContent = '';
  purchaseForm.reset();
  purchaseModal.classList.remove('hidden');
}

document.querySelector('#closePurchase').addEventListener('click', () => purchaseModal.classList.add('hidden'));
purchaseModal.addEventListener('click', (event) => {
  if (event.target === purchaseModal) purchaseModal.classList.add('hidden');
});

purchaseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingPurchaseListing) return;
  const submitButton = purchaseForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  purchaseStatus.textContent = 'Sending request...';
  try {
    const response = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listingId: pendingPurchaseListing.id,
        fulfillment: purchaseForm.elements.fulfillment.value,
        message: purchaseForm.elements.message.value
      })
    });
    const result = await response.json();
    if (!response.ok) {
      purchaseStatus.textContent = result.error || 'Could not send your purchase request.';
      return;
    }
    purchaseModal.classList.add('hidden');
    pendingPurchaseListing = null;
    currentView = 'inbox';
    document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item.dataset.view === 'inbox'));
    document.querySelector('.hero').classList.add('hidden');
    document.querySelector('.content-section').classList.add('hidden');
    inboxSection.classList.remove('hidden');
    await loadConversations(result.conversationId);
  } catch {
    purchaseStatus.textContent = 'Could not reach the messaging service. Try again.';
  } finally {
    submitButton.disabled = false;
  }
});

async function loadConversations(preferredId = null) {
  conversationList.innerHTML = '<p class="conversation-placeholder">Loading messages...</p>';
  try {
    const response = await fetch('/api/conversations');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load messages.');
    if (!result.conversations.length) {
      selectedConversationId = null;
      conversationList.innerHTML = '<p class="conversation-placeholder">No conversations yet. Use “Buy / message seller” on a listing to start one.</p>';
      conversationPanel.innerHTML = '<div class="conversation-placeholder">Your buyer and seller messages will appear here.</div>';
      return;
    }
    conversationList.innerHTML = result.conversations.map((conversation) => `
      <button class="conversation-item ${String(conversation.id) === String(selectedConversationId) ? 'active' : ''}" type="button" data-conversation="${conversation.id}">
        <span class="conversation-item-title">${escapeHtml(conversation.listingTitle)}</span>
        <span class="conversation-item-user">${escapeHtml(conversation.otherUser.displayName)} · ${conversation.fulfillment === 'delivery' ? 'Delivery' : 'Meet up'}</span>
        <span class="conversation-item-preview">${escapeHtml(conversation.lastMessage || 'Purchase request')}</span>
      </button>`).join('');
    const selected = result.conversations.find((conversation) => String(conversation.id) === String(preferredId || selectedConversationId)) || result.conversations[0];
    await openConversation(selected.id, selected);
  } catch (error) {
    conversationList.innerHTML = `<p class="conversation-placeholder">${escapeHtml(error.message)}</p>`;
    conversationPanel.innerHTML = '<div class="conversation-placeholder">Messages are unavailable right now.</div>';
  }
}

async function openConversation(conversationId, conversationSummary = null) {
  selectedConversationId = conversationId;
  conversationList.querySelectorAll('[data-conversation]').forEach((button) => {
    button.classList.toggle('active', String(button.dataset.conversation) === String(conversationId));
  });
  conversationPanel.innerHTML = '<div class="conversation-placeholder">Loading conversation...</div>';
  try {
    const [messageResponse, listResponse] = await Promise.all([
      fetch(`/api/conversations/${conversationId}/messages`),
      conversationSummary ? Promise.resolve(null) : fetch('/api/conversations')
    ]);
    const messageResult = await messageResponse.json();
    if (!messageResponse.ok) throw new Error(messageResult.error || 'Could not load conversation.');
    let summary = conversationSummary;
    if (!summary) {
      const listResult = await listResponse.json();
      summary = listResult.conversations.find((conversation) => String(conversation.id) === String(conversationId));
    }
    if (!summary) throw new Error('Conversation not found.');
    const messages = messageResult.messages.map((message) => `
      <article class="chat-message ${message.senderId === currentUser.id ? 'mine' : ''}">
        <div class="chat-message-byline">${escapeHtml(message.sender.displayName)}</div>
        <p>${escapeHtml(message.body)}</p>
      </article>`).join('');
    conversationPanel.innerHTML = `
      <header class="conversation-header">
        <div><h3>${escapeHtml(summary.listingTitle)}</h3><p>${escapeHtml(summary.otherUser.displayName)} · ${summary.fulfillment === 'delivery' ? 'Delivery requested' : 'Meet up requested'}</p></div>
        <strong>${money(summary.price)}</strong>
      </header>
      <div class="chat-messages" id="chatMessages">${messages}</div>
      <form class="chat-compose" id="chatCompose">
        <label class="visually-hidden" for="chatMessage">Your message</label>
        <textarea id="chatMessage" name="message" rows="2" maxlength="2000" required placeholder="Write a message..."></textarea>
        <button class="submit-button" type="submit">Send <span>↗</span></button>
      </form>`;
    const chatMessages = document.querySelector('#chatMessages');
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (error) {
    conversationPanel.innerHTML = `<div class="conversation-placeholder">${escapeHtml(error.message)}</div>`;
  }
}

conversationList.addEventListener('click', (event) => {
  const item = event.target.closest('[data-conversation]');
  if (item) openConversation(item.dataset.conversation);
});

conversationPanel.addEventListener('submit', async (event) => {
  if (event.target.id !== 'chatCompose') return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetch(`/api/conversations/${selectedConversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: form.elements.message.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not send message.');
    await loadConversations(selectedConversationId);
  } catch (error) {
    const status = document.createElement('p');
    status.className = 'chat-error';
    status.textContent = error.message;
    form.before(status);
  } finally {
    button.disabled = false;
  }
});

function closeAuthModal() {
  authModal.classList.add('hidden');
  if (authModalHistoryEntry && history.state?.commonplaceAuthModal) {
    authModalHistoryEntry = false;
    history.back();
  }
}
async function loadCommunityListings() {
  const response = await fetch('/api/listings');
  if (!response.ok) throw new Error('Could not load marketplace listings.');
  const result = await response.json();
  listings = [...getSeedListings(), ...result.listings];
  renderListings();
}

function finishAuthentication(user) {
  currentUser = user;
  saved = new Set(readStoredValue(`${savedStorageKey}-${user.id}`, []).map(String));
  document.querySelector('#profileButton').textContent = user.displayName
    .split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  document.querySelector('#profileButton').title = `Signed in as ${user.username}`;
  logoutButton.classList.remove('hidden');
  document.body.classList.remove('auth-required');
  authModal.classList.add('hidden');
  authStatus.textContent = '';
  authStatus.classList.remove('auth-error', 'auth-success');
  renderListings();
  loadCommunityListings().catch(() => {
    currentView = 'browse';
    document.querySelector('#nearbyHeading').textContent = 'Worth a closer look';
    authStatus.textContent = 'Could not load marketplace listings. Refresh and try again.';
    authStatus.classList.add('auth-error');
  });
}
function setAuthMode(mode) {
  const isLogin = mode === 'login';
  loginForm.classList.toggle('hidden', !isLogin);
  registerForm.classList.toggle('hidden', isLogin);
  loginTab.classList.toggle('active', isLogin);
  registerTab.classList.toggle('active', !isLogin);
  loginTab.setAttribute('aria-selected', String(isLogin));
  registerTab.setAttribute('aria-selected', String(!isLogin));
  document.querySelector('#authTitle').textContent = isLogin ? 'Welcome back.' : 'Join the neighborhood.';
  document.querySelector('#authIntro').textContent = isLogin
    ? 'Sign in to keep your finds and listings together.'
    : 'Create an account to save finds and share good things.';
  authStatus.textContent = '';
  authStatus.classList.remove('auth-error', 'auth-success');
}

function showOAuthError() {
  const params = new URLSearchParams(location.search);
  const error = params.get('authError');
  if (!error) return;
  params.delete('authError');
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  authStatus.textContent = error;
  authStatus.classList.add('auth-error');
}

document.querySelector('#profileButton').addEventListener('click', () => {
  if (authModal.classList.contains('hidden')) {
    history.pushState({ ...history.state, commonplaceAuthModal: true }, '', location.href);
    authModalHistoryEntry = true;
  }
  authModal.classList.remove('hidden');
  setAuthMode('login');
});
logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Could not sign out. Please try again.');
    currentUser = null;
    document.body.classList.add('auth-required');
    authModal.classList.remove('hidden');
    setAuthMode('login');
    document.querySelector('#profileButton').textContent = 'AM';
    document.querySelector('#profileButton').title = 'Profile';
    logoutButton.classList.add('hidden');
    saved.clear();
    renderListings();
  } catch (error) {
    authStatus.textContent = error.message;
    authStatus.classList.add('auth-error');
  } finally {
    logoutButton.disabled = false;
  }
});
window.addEventListener('popstate', (event) => {
  if (authModalHistoryEntry) {
    authModalHistoryEntry = false;
    authModal.classList.add('hidden');
  } else if (event.state?.commonplaceAuthModal) {
    authModalHistoryEntry = true;
    authModal.classList.remove('hidden');
  }
});
document.querySelector('#closeAuth').addEventListener('click', closeAuthModal);
authModal.addEventListener('click', (event) => { if (event.target === authModal) closeAuthModal(); });
loginTab.addEventListener('click', () => setAuthMode('login'));
registerTab.addEventListener('click', () => setAuthMode('register'));
document.querySelectorAll('[data-firebase-provider]').forEach((button) => {
  button.addEventListener('click', async () => {
    const provider = new GoogleAuthProvider();
    const providerLabel = 'Google';
    button.disabled = true;
    authStatus.classList.remove('auth-error', 'auth-success');
    authStatus.textContent = `Connecting to ${providerLabel}...`;
    try {
      const credential = await signInWithPopup(firebaseAuth, provider);
      const idToken = await credential.user.getIdToken();
      const response = await fetch('/api/auth/firebase', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` }
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not finish signing in.');
      finishAuthentication(result.user);
    } catch (error) {
      if (error.code === 'auth/configuration-not-found') {
        authStatus.textContent = `Firebase Authentication is not configured for ${providerLabel}. In Firebase Console, open project common-place-171e0, enable Authentication, then enable ${providerLabel} under Sign-in method.`;
      } else if (error.code === 'auth/operation-not-allowed') {
        authStatus.textContent = `${providerLabel} sign-in is disabled. Enable it in Firebase Console under Authentication > Sign-in method.`;
      } else {
        authStatus.textContent = error.message || `Could not sign in with ${providerLabel}.`;
      }
      authStatus.classList.add('auth-error');
    } finally {
      button.disabled = false;
    }
  });
});
document.querySelectorAll('[data-password-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.getAttribute('aria-controls'));
    const isVisible = input.type === 'text';
    input.type = isVisible ? 'password' : 'text';
    button.textContent = isVisible ? 'Show' : 'Hide';
    button.setAttribute('aria-label', `${isVisible ? 'Show' : 'Hide'} ${input.name === 'confirmPassword' ? 'confirm password' : 'password'}`);
    button.setAttribute('aria-pressed', String(!isVisible));
  });
});
async function submitAuthForm(form, endpoint, payload) {
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  authStatus.classList.remove('auth-error', 'auth-success');
  authStatus.textContent = 'Please wait...';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      authStatus.textContent = result.error || 'Could not complete that request.';
      authStatus.classList.add('auth-error');
      return;
    }
    if (endpoint === '/api/register') {
      registerForm.reset();
      loginForm.elements.identity.value = result.user.username;
      loginForm.elements.password.value = '';
      setAuthMode('login');
      authStatus.textContent = 'Account created. Log in with your username and password to enter the marketplace.';
      authStatus.classList.add('auth-success');
    } else {
      finishAuthentication(result.user);
    }
  } catch {
    authStatus.textContent = `Could not reach the account API at ${location.origin}/api. For local use, run "npm start" and open http://localhost:4173. Static-only hosting is not supported; deploy this site with its Node.js server and database.`;
    authStatus.classList.add('auth-error');
  } finally {
    submitButton.disabled = false;
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  await submitAuthForm(loginForm, '/api/login', {
    identity: form.get('identity'),
    password: form.get('password')
  });
});
registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = registerForm.elements.password.value;
  const confirmation = registerForm.elements.confirmPassword.value;
  if (password !== confirmation) {
    registerForm.elements.confirmPassword.setCustomValidity('Passwords do not match.');
    registerForm.reportValidity();
    registerForm.elements.confirmPassword.setCustomValidity('');
    return;
  }
  const form = new FormData(registerForm);
  await submitAuthForm(registerForm, '/api/register', {
    name: form.get('name'),
    username: form.get('username'),
    email: form.get('email'),
    password
  });
});
fetch('/api/me')
  .then(async (response) => {
    if (!response.ok) throw new Error('Could not check account session.');
    return response.json();
  })
  .then(({ user }) => {
    if (user) finishAuthentication(user);
    else {
      document.body.classList.add('auth-required');
      authModal.classList.remove('hidden');
      setAuthMode('login');
      showOAuthError();
    }
  })
  .catch(() => {
    document.body.classList.add('auth-required');
    authModal.classList.remove('hidden');
    setAuthMode('login');
    showOAuthError();
  });
document.querySelector('#openSell').addEventListener('click', () => {
  modal.classList.remove('hidden');
  if (!listingLocationInput.value.trim()) locateCurrentDevice();
});
document.querySelector('#closeSell').addEventListener('click', closeModal);
modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
const newCategoryForm = document.querySelector('#newCategoryForm');
const newCategoryName = document.querySelector('#newCategoryName');
const categoryStatus = document.querySelector('#categoryStatus');
document.querySelector('#showAddCategory').addEventListener('click', () => {
  newCategoryForm.classList.toggle('hidden');
  categoryStatus.textContent = '';
  if (!newCategoryForm.classList.contains('hidden')) newCategoryName.focus();
});

async function addCategory() {
  const name = newCategoryName.value.trim().replace(/\s+/g, ' ');
  if (!name) {
    newCategoryName.focus();
    return;
  }
  const button = document.querySelector('#addCategoryConfirm');
  button.disabled = true;
  categoryStatus.textContent = 'Adding category...';
  try {
    const response = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const result = await response.json();
    if (!response.ok) {
      categoryStatus.textContent = result.error || 'Could not add category.';
      return;
    }
    const savedCategory = result.category;
    if (!categories.some((category) => category.toLowerCase() === savedCategory.toLowerCase())) {
      categories.push(savedCategory);
      categories.sort((first, second) => first.localeCompare(second));
    }
    currentCategory = savedCategory;
    renderCategories();
    listingCategorySelect.value = savedCategory;
    newCategoryName.value = '';
    categoryStatus.textContent = `Added "${savedCategory}". It is now available to everyone.`;
    renderListings();
  } catch {
    categoryStatus.textContent = 'Could not reach the marketplace server.';
  } finally {
    button.disabled = false;
  }
}

document.querySelector('#addCategoryConfirm').addEventListener('click', addCategory);
newCategoryName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addCategory();
  }
});
async function reverseGeocode(latitude, longitude) {
  const query = new URLSearchParams({ format: 'jsonv2', lat: latitude, lon: longitude, zoom: '18', addressdetails: '1' });
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${query}`, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error('Could not look up a readable address.');
  const result = await response.json();
  const address = result.address || {};
  const street = [address.house_number, address.road].filter(Boolean).join(' ');
  const readable = [
    street,
    address.neighbourhood || address.quarter,
    address.suburb || address.city_district,
    address.city || address.town || address.village || address.municipality,
    address.state,
    address.country
  ].filter(Boolean).filter((part, index, parts) => parts.indexOf(part) === index);
  return readable.join(', ') || result.display_name || '';
}

function locateCurrentDevice() {
  if (!navigator.geolocation) {
    listingLocationStatus.textContent = 'Location detection is not supported here. Type the item location instead.';
    return;
  }
  const requestId = ++locationRequestId;
  listingLocationStatus.textContent = 'Requesting permission and finding your readable address...';
  navigator.geolocation.getCurrentPosition(async (position) => {
    if (requestId !== locationRequestId) return;
    const { latitude, longitude } = position.coords;
    listingLatitudeInput.value = latitude.toFixed(6);
    listingLongitudeInput.value = longitude.toFixed(6);
    checkLocationMap.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
    checkLocationMap.classList.remove('hidden');
    listingLocationStatus.textContent = 'Location found. Looking up a readable address...';
    try {
      const readableLocation = await reverseGeocode(latitude, longitude);
      if (requestId !== locationRequestId) return;
      if (!readableLocation) throw new Error('No readable address was returned.');
      listingLocationInput.value = readableLocation;
      listingLocationStatus.textContent = `Current location: ${readableLocation}. Exact pin will be visible to buyers.`;
    } catch {
      if (requestId !== locationRequestId) return;
      listingLocationInput.value = '';
      listingLatitudeInput.value = '';
      listingLongitudeInput.value = '';
      checkLocationMap.classList.add('hidden');
      listingLocationStatus.textContent = 'Your exact pin is ready, but address lookup failed. Type a readable street, neighborhood, or city before publishing.';
      listingLocationInput.focus();
    }
  }, (error) => {
    if (requestId !== locationRequestId) return;
    const message = error.code === error.PERMISSION_DENIED
      ? 'Location permission was denied. Type the item location or allow location access in your browser.'
      : 'Could not detect your location. Type the item location or try again.';
    listingLocationStatus.textContent = message;
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

document.querySelector('#useCurrentLocation').addEventListener('click', locateCurrentDevice);
listingLocationInput.addEventListener('input', () => {
  locationRequestId += 1;
  listingLatitudeInput.value = '';
  listingLongitudeInput.value = '';
  checkLocationMap.classList.add('hidden');
  listingLocationStatus.textContent = 'Typed location selected. Add an exact device pin if you want buyers to see a precise map point.';
});
photoFile.addEventListener('change', async () => {
  const file = photoFile.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    photoStatus.textContent = 'Choose an image file.';
    photoFile.value = '';
    return;
  }
  photoStatus.textContent = 'Preparing photo...';
  try {
    selectedLocalImage = await compressImage(file);
    photoUrl.value = '';
    showPhotoPreview(selectedLocalImage);
    photoStatus.textContent = 'Device photo ready.';
  } catch (error) {
    selectedLocalImage = '';
    photoStatus.textContent = error.message;
  }
});

photoUrl.addEventListener('input', () => {
  selectedLocalImage = '';
  showPhotoPreview(photoUrl.value.trim());
  photoStatus.textContent = photoUrl.value ? 'Previewing image URL.' : 'Online search opens in a new tab.';
});

document.querySelector('#searchImages').addEventListener('click', () => {
  const title = document.querySelector('#sellForm [name="title"]').value.trim();
  const category = document.querySelector('#sellForm [name="category"]').value;
  const query = [title, category, 'for sale'].filter(Boolean).join(' ');
  window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
  photoStatus.textContent = 'Choose an image online, then paste its image address above.';
});

document.querySelector('#sellForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const submitButton = event.target.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await fetch('/api/listings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.get('title'),
        price: form.get('price'),
        category: form.get('category'),
        location: form.get('location'),
        latitude: form.get('latitude') || null,
        longitude: form.get('longitude') || null,
        image: selectedLocalImage || form.get('image') || ''
      })
    });
    const result = await response.json();
    if (!response.ok) {
      photoStatus.textContent = result.error || 'Could not publish this listing.';
      return;
    }
    listings.unshift(result.listing);
  } catch {
    photoStatus.textContent = 'Could not reach the marketplace server. Your listing was not published.';
    return;
  } finally {
    submitButton.disabled = false;
  }
  event.target.reset();
  selectedLocalImage = '';
  locationRequestId += 1;
  checkLocationMap.classList.add('hidden');
  listingLocationStatus.textContent = 'Your location is being detected when this form opens. You can also type an address.';
  showPhotoPreview('');
  photoStatus.textContent = 'Online search opens in a new tab.';
  updateImageSearchLink();
  closeModal();
  currentView = 'selling';
  document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item.dataset.view === 'selling'));
  document.querySelector('#nearbyHeading').textContent = 'Your listings';
  renderListings();
});

renderCategories();
loadCategories().catch(() => {});
renderListings();
