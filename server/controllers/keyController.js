/**
 * E2EE — Key Management Controller
 *
 * All endpoints here deal only with opaque base64 blobs — the server never
 * interprets or decrypts any key material.  Private keys never arrive here;
 * they live exclusively in each client's IndexedDB.
 *
 * Routes (mounted at /api/keys by keyRoutes.js):
 *
 *   POST   /api/keys/public-key           — upload / rotate own public key
 *   GET    /api/keys/public-key/:userId   — fetch a user's public key
 *   POST   /api/keys/groups/:groupId/wrapped-keys  — bulk-upload wrapped group keys
 *   GET    /api/keys/groups/:groupId/wrapped-key   — fetch my own wrapped group key
 */

const PublicKey       = require('../models/PublicKey');
const WrappedGroupKey = require('../models/WrappedGroupKey');
const Group           = require('../models/Group');

// ---------------------------------------------------------------------------
// POST /api/keys/public-key
// Body: { publicKey: "<base64 SPKI>" }
// ---------------------------------------------------------------------------
const uploadPublicKey = async (req, res) => {
  const { publicKey } = req.body;
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    return res.status(400).json({ message: 'publicKey (base64) is required' });
  }
  try {
    // Upsert — replace previous key on the same device / re-registration.
    await PublicKey.findOneAndUpdate(
      { userId: req.user.userId },
      { userId: req.user.userId, publicKey: publicKey.trim() },
      { upsert: true, returnDocument: 'after' },
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[E2EE] uploadPublicKey error:', err.message);
    return res.status(500).json({ message: 'Could not store public key' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/keys/public-key/:userId
// Returns { userId, publicKey }  or 404 if the user hasn't uploaded one yet.
// ---------------------------------------------------------------------------
const getPublicKey = async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ message: 'userId param is required' });
  try {
    const record = await PublicKey.findOne({ userId }).lean();
    if (!record) {
      return res.status(404).json({ message: 'No public key on file for this user' });
    }
    return res.json({ userId: record.userId, publicKey: record.publicKey });
  } catch (err) {
    console.error('[E2EE] getPublicKey error:', err.message);
    return res.status(500).json({ message: 'Could not fetch public key' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/keys/groups/:groupId/wrapped-keys
// Body: { keys: [{ userId, wrappedKey }] }
//
// Called by the group creator (or whoever adds a new member) after they have
// wrapped the group AES key individually for each member using that member's
// public key.  The server stores the blobs — it cannot unwrap them.
// ---------------------------------------------------------------------------
const uploadWrappedGroupKeys = async (req, res) => {
  const { groupId } = req.params;
  const { keys }    = req.body; // [{ userId, wrappedKey }]

  if (!Array.isArray(keys) || !keys.length) {
    return res.status(400).json({ message: 'keys array is required' });
  }

  try {
    // Verify the requester is a member of this group.
    const group = await Group.findOne({
      _id: groupId,
      'members.userId': req.user.userId,
    }).select('_id').lean();
    if (!group) {
      return res.status(403).json({ message: 'Not a member of this group' });
    }

    // Upsert each wrapped key blob.
    const ops = keys
      .filter((k) => k.userId && typeof k.wrappedKey === 'string')
      .map((k) => ({
        updateOne: {
          filter: { groupId, userId: k.userId },
          update: {
            $set: {
              groupId,
              userId:     k.userId,
              wrappedKey: k.wrappedKey,
              wrappedBy:  req.user.userId,
            },
          },
          upsert: true,
        },
      }));

    if (!ops.length) {
      return res.status(400).json({ message: 'No valid key entries provided' });
    }

    await WrappedGroupKey.bulkWrite(ops);
    return res.status(200).json({ ok: true, stored: ops.length });
  } catch (err) {
    console.error('[E2EE] uploadWrappedGroupKeys error:', err.message);
    return res.status(500).json({ message: 'Could not store wrapped group keys' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/keys/groups/:groupId/wrapped-key
// Returns the wrapped group key blob for the calling user.
// ---------------------------------------------------------------------------
const getWrappedGroupKey = async (req, res) => {
  const { groupId } = req.params;
  try {
    // Verify membership.
    const group = await Group.findOne({
      _id: groupId,
      'members.userId': req.user.userId,
    }).select('_id').lean();
    if (!group) {
      return res.status(403).json({ message: 'Not a member of this group' });
    }

    const record = await WrappedGroupKey.findOne({
      groupId,
      userId: req.user.userId,
    }).lean();

    if (!record) {
      return res
        .status(404)
        .json({ message: 'No wrapped group key found for this member' });
    }

    return res.json({
      groupId:    record.groupId,
      wrappedKey: record.wrappedKey,
      wrappedBy:  record.wrappedBy,
    });
  } catch (err) {
    console.error('[E2EE] getWrappedGroupKey error:', err.message);
    return res.status(500).json({ message: 'Could not fetch wrapped group key' });
  }
};

module.exports = {
  uploadPublicKey,
  getPublicKey,
  uploadWrappedGroupKeys,
  getWrappedGroupKey,
};
