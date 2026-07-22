# E2EE Diagnostic Guide

If messages are showing as readable plaintext in MongoDB, follow these steps:

## 1. Check Browser Console for Errors

Open DevTools → Console and look for:
- `[E2EE] New identity key pair generated` (on first login)
- `[E2EE] Public key uploaded to server successfully`

If you see errors like:
- `ReferenceError: crypto is not defined` → your browser doesn't support Web Crypto API
- `Failed to fetch` → API_URL is wrong or the server isn't running
- `401 Unauthorized` → token is invalid or missing

## 2. Verify IndexedDB Has Keys

Open DevTools → **Application** → **IndexedDB** → `e2ee-keys` → `keys`

You should see:
```
identity:privateKey  →  CryptoKey {type: "private", algorithm: {name: "ECDH", ...}}
identity:publicKey   →  CryptoKey {type: "public", algorithm: {name: "ECDH", ...}}
```

**If these are missing**, keys never generated. Check console errors from step 1.

## 3. Run This Diagnostic in Browser Console

```javascript
// Paste this entire block into the Console and press Enter
(async () => {
  console.group('🔍 E2EE Diagnostic');
  
  // 1. Check if IndexedDB has keys
  const db = await indexedDB.open('e2ee-keys');
  const tx = db.transaction('keys', 'readonly');
  const store = tx.objectStore('keys');
  
  const privateKey = await new Promise(r => {
    const req = store.get('identity:privateKey');
    req.onsuccess = () => r(req.result);
  });
  const publicKey = await new Promise(r => {
    const req = store.get('identity:publicKey');
    req.onsuccess = () => r(req.result);
  });
  
  console.log('✓ Private key in IndexedDB:', !!privateKey);
  console.log('✓ Public key in IndexedDB:', !!publicKey);
  
  // 2. Check if server has public key
  const token = localStorage.getItem('chatToken');
  const user = JSON.parse(localStorage.getItem('chatUser'));
  
  if (token && user) {
    const res = await fetch(`http://localhost:5000/api/keys/public-key/${user.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('✓ Server has public key:', res.ok);
    if (!res.ok) console.warn('Server returned:', res.status, await res.text());
  } else {
    console.warn('⚠ No token/user in localStorage — not logged in?');
  }
  
  console.groupEnd();
})();
```

**Expected output:**
```
✓ Private key in IndexedDB: true
✓ Public key in IndexedDB: true
✓ Server has public key: true
```

**If all checks pass but messages are still plaintext:**
1. Log out completely (`localStorage.clear()`)
2. Delete IndexedDB: `indexedDB.deleteDatabase('e2ee-keys')`
3. Log back in (watch console for "[E2EE]" messages)
4. Send a test message
5. Check MongoDB — `msg` should now be base64

## 4. Force Key Regeneration

If keys are corrupt or you need a fresh start:

```javascript
// Clear everything and force re-login
localStorage.clear();
indexedDB.deleteDatabase('e2ee-keys');
location.reload();
```

Then log in again and the keys will regenerate.

## 5. Common Issues

**Problem:** Console shows `[E2EE] ensureIdentityKeyPair failed: TypeError: Cannot read property 'subtle' of undefined`  
**Fix:** Your browser doesn't support Web Crypto API. Use Chrome, Firefox, or Edge (not IE).

**Problem:** Console shows `[E2EE] Public key upload failed with status: 401`  
**Fix:** Token expired or invalid. Log out and back in.

**Problem:** Console shows `[E2EE] Public key upload failed with status: 404`  
**Fix:** Server routes not mounted. Check `server/server.js` has `app.use('/api/keys', keyRoutes)`.

**Problem:** Keys exist in IDB but messages still plaintext  
**Fix:** Old cached plaintext messages were sent before E2EE was working. Send a NEW message after confirming the diagnostic passes.

## 6. Test Encryption Manually

```javascript
// In browser console after login
const { encryptMessage, decryptMessage } = await import('/src/services/encryptionService.js');

const user = JSON.parse(localStorage.getItem('chatUser'));
const token = localStorage.getItem('chatToken');

const ctx = {
  type: 'direct',
  myUserId: user.id,
  theirUserId: 'REPLACE_WITH_FRIEND_USER_ID',  // get from MongoDB
  token
};

const plaintext = 'Test encryption';
const encrypted = await encryptMessage(ctx, plaintext);
console.log('Encrypted:', encrypted);  // Should be long base64 string

const decrypted = await decryptMessage(ctx, encrypted);
console.log('Decrypted:', decrypted);  // Should be "Test encryption"
console.log('Match:', decrypted === plaintext);  // Should be true
```

If this throws an error, **that's the root cause**.
