/**
 * E2EE — Key Management Routes
 * Mounted in server.js at /api/keys (one-line addition).
 * All routes require a valid JWT (auth middleware).
 */

const express = require('express');
const { auth } = require('../middleware/auth');
const {
  uploadPublicKey,
  getPublicKey,
  uploadWrappedGroupKeys,
  getWrappedGroupKey,
} = require('../controllers/keyController');

const router = express.Router();

// Identity public-key directory
router.post('/public-key',          auth, uploadPublicKey);
router.get('/public-key/:userId',   auth, getPublicKey);

// Per-group wrapped key store
router.post('/groups/:groupId/wrapped-keys', auth, uploadWrappedGroupKeys);
router.get('/groups/:groupId/wrapped-key',   auth, getWrappedGroupKey);

module.exports = router;
