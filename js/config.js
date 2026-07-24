// ============================================================
// Summer Pages — Configuration
// ============================================================
// stubAuth: true  → skip j2auth entirely, sign in as a fake user
// stubData: true  → entries stored in localStorage instead of
//                   the Jupiter graph API. Useful for offline
//                   UI work.
//
// j2auth/journal API server URL comes from local.json when
// present (see j2auth.js checkLocalConfig), otherwise the
// production server baked into j2auth.js.
// ============================================================

window.APP_CONFIG = {
  stubAuth:     false,
  stubData:     false,

  j2BizId:      'journal',
  j2AppToken:   'summer-pages',

  // Web Push application server key (VAPID PUBLIC key — not secret).
  // Paste the value from `vapid --applicationServerKey` on the server.
  vapidPublicKey: 'BNhs8uqkRcdaRDvPREFOXhfhwEwKGDGq30e8Y9UUhymA1ONCEY4EUL2RIRdgVgtEbEvOBmIM4x015w_yWPQRUW8'
}
