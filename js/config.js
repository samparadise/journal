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
  j2AppToken:   'summer-pages'
}
