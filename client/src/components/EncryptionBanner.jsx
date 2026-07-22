/**
 * E2EE — Encryption Notice Banner
 *
 * WhatsApp-style in-chat notice shown at the top of every conversation.
 * Purely presentational — no logic, no state.
 *
 * Exact copy (per spec):
 *   "🔒 Messages and calls are end-to-end encrypted. Only people in this
 *    chat can read, listen to, or share them."
 */

import React from 'react';

const bannerStyle = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'center',
  gap:            '6px',
  margin:         '10px auto 4px',
  padding:        '6px 14px',
  maxWidth:       '480px',
  background:     'rgba(17, 27, 33, 0.82)',  // dark translucent pill
  borderRadius:   '999px',
  fontSize:       '11.5px',
  lineHeight:     '1.4',
  color:          '#e9dcc3',                 // warm off-white / light wheat
  textAlign:      'center',
  letterSpacing:  '0.01em',
  pointerEvents:  'none',                    // not interactive
  userSelect:     'none',
};

const EncryptionBanner = () => (
  <div style={bannerStyle} role="note" aria-label="End-to-end encryption notice">
    <span aria-hidden="true">🔒</span>
    <span>
      Messages and calls are end-to-end encrypted. Only people in this chat can
      read, listen to, or share them.
    </span>
  </div>
);

export default EncryptionBanner;
