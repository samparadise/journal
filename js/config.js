// ============================================================
// Summer Pages — Configuration
// ============================================================
// stubAuth: true  → skip j2auth entirely, sign in as a fake user
// stubData: true  → entries/profile stored in localStorage
//                   (no Supabase). Flip to false + fill in keys
//                   when the backend is ready.
//
// j2auth API server URL comes from local.json when present
// (see j2auth.js checkLocalConfig), otherwise the production
// server baked into j2auth.js.
// ============================================================

window.APP_CONFIG = {
  stubAuth:     false,
  stubData:     true,

  j2BizId:      'journal',
  j2AppToken:   'summer-pages',

  supabaseUrl:  'https://YOUR_PROJECT_ID.supabase.co',
  supabaseKey:  'YOUR_ANON_PUBLIC_KEY'
}
