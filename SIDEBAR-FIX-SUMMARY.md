# Sidebar Encrypted Preview Fix — Applied

## Problem

Messages were being encrypted correctly and stored as base64 blobs in MongoDB, BUT the **sidebar/chat list** was showing the encrypted base64 string instead of the decrypted preview text.

Example of what users were seeing:
```
Shruti patil
eyJjaXBoZXJ0ZXh0IjoiQWRHVmMyUU1D...   ← This should say "hello"
```

## Root Cause

The `/api/conversations` and `/api/groups` REST endpoints return `lastMessage` computed by the server-side `previewFor()` function. This function reads `message.msg` directly — which is now encrypted ciphertext.

**By design**, the server CANNOT decrypt (it's E2EE — server has no keys). Therefore the client must decrypt the `lastMessage` preview after loading conversations.

## Fix Applied

### 1. Added sidebar decryption in `ChatApp.jsx` loadData()

```javascript
// E2EE integration point — decrypt lastMessage previews for conversations
const decryptedConvs = await Promise.all(
  convRes.data.map(async (conv) => {
    if (conv.lastMessage) {
      try {
        const decrypted = await decryptMessage(
          { type: 'direct', myUserId: user.id, theirUserId: conv.id, token },
          conv.lastMessage,
        );
        return { ...conv, lastMessage: decrypted };
      } catch { return conv; }
    }
    return conv;
  }),
);
setConversations(decryptedConvs);
```

Same logic applied to groups.

### 2. Exported `isEncryptedPayload` from `encryptionService.js`

Changed from `function isEncryptedPayload` to `export function isEncryptedPayload` so other modules can use the same authoritative E2EE blob detection.

### 3. Socket handlers already correct

The socket `msg` and `group-msg` handlers already decrypt messages before passing to `previewFor()`, so real-time message previews work correctly. The issue was only with the initial load from REST.

## Files Modified

1. `client/src/pages/ChatApp.jsx` — added sidebar decryption in loadData, imported isEncryptedPayload
2. `client/src/services/encryptionService.js` — exported isEncryptedPayload function

## How to Verify the Fix

1. **Refresh the app** (Ctrl+Shift+R or Cmd+Shift+R to clear cache)
2. Open the chat list sidebar
3. The most recent message preview should now show **decrypted plaintext** instead of base64

**Before:**
```
Shruti patil
eyJjaXBoZXJ0ZXh0IjoiQWRHVmMyUU1D...
```

**After:**
```
Shruti patil
hello
```

## MongoDB Verification (Still Shows Encrypted)

The **database** should STILL show encrypted blobs (this is correct):

```javascript
db.chats.findOne({ type: "text" })
// msg: "eyJjaXBoZXJ0ZXh0IjoiQWRHVmMyUU..."  ← encrypted (good!)
```

Only the **client UI** decrypts and shows plaintext. The server and database never see plaintext.

## What If Sidebar Still Shows Encrypted Text?

Run this in the browser console:

```javascript
// Check if keys exist
const db = await indexedDB.open('e2ee-keys');
const tx = db.transaction('keys', 'readonly');
const store = tx.objectStore('keys');
const privateKey = await new Promise(r => {
  const req = store.get('identity:privateKey');
  req.onsuccess = () => r(req.result);
});
console.log('Private key exists:', !!privateKey);

// If false, regenerate keys:
localStorage.clear();
indexedDB.deleteDatabase('e2ee-keys');
location.reload();
// Then log in again
```

## Summary

✅ **Encryption working** — MongoDB stores ciphertext only  
✅ **Decryption working** — Chat window shows plaintext  
✅ **Sidebar decryption added** — Chat list previews now show plaintext  
✅ **Server remains blind** — Server never decrypts, maintains E2EE security model
