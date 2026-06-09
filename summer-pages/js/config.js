// ============================================================
// Summer Pages — Configuration
// ============================================================
// Set stubMode: true to run entirely in the browser with no
// backend. Auth is bypassed, entries are stored in localStorage.
// Flip to false and fill in the values below when you're ready
// to wire up the real backend.
//
// Supabase:  Dashboard → Project Settings → API
// j2auth:    your Business ID and app token from the Jupiter 2 graph
// ============================================================

window.APP_CONFIG = {
  stubMode:     true,

  supabaseUrl:  'https://YOUR_PROJECT_ID.supabase.co',
  supabaseKey:  'YOUR_ANON_PUBLIC_KEY',
  j2BizId:      'YOUR_BIZ_ID',
  j2AppToken:   'YOUR_APP_TOKEN'
}
