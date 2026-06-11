'use strict'

const STUB_AUTH = window.APP_CONFIG.stubAuth   // skip j2auth, fake user
const STUB_DATA = window.APP_CONFIG.stubData   // localStorage instead of Supabase

// ============================================================
// SUPABASE CLIENT  (only used when data is not stubbed)
// ============================================================

const supa = !STUB_DATA
  ? window.supabase.createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseKey)
  : null

// ============================================================
// STATE
// ============================================================

const state = {
  user:           null,   // E.164 phone string
  profile:        null,
  prompts:        [],     // loaded from prompts.json
  todayPrompt:    null,
  entries:        [],
  stagedPhotos:   [],     // { file: File, previewUrl: string }
  selectedMood:   null,
  currentEntryId: null,
  saving:         false,
  pendingProfile: null,   // { name, birthday } held for new users until verified
}

// ============================================================
// PROMPT ICON PALETTE
// Cycles through pastel tile backgrounds — each prompt gets a
// consistent color based on its position in prompts.json.
// Black SVG icons read cleanly on all of these.
// ============================================================

const PROMPT_TILE_COLORS = [
  '#FAC775',  // yellow  (warm, logo-adjacent)
  '#A8EDCC',  // mint    (fresh, summery)
  '#A8D8F7',  // sky     (airy)
  '#FFCBA4',  // peach   (cheerful)
  '#D4B8F7',  // lavender(playful)
  '#F7D4A8',  // sand    (beachy)
]

function promptTileColor(prompt) {
  const idx = state.prompts.indexOf(prompt)
  return PROMPT_TILE_COLORS[Math.max(0, idx) % PROMPT_TILE_COLORS.length]
}

// ============================================================
// GREETING
// ============================================================

function getGreeting(name) {
  const h = new Date().getHours()
  let salutation
  if (h < 12)      salutation = 'Good morning'
  else if (h < 17) salutation = 'Hey'
  else if (h < 21) salutation = 'Good evening'
  else             salutation = 'Hi'
  return name ? `${salutation}, ${name}! 👋` : `${salutation}! 👋`
}

// ============================================================
// MOOD META
// ============================================================

const MOOD_EMOJI = {
  happy:      '😊',
  excited:    '🎉',
  calm:       '😌',
  thoughtful: '🤔',
  silly:      '😜',
  proud:      '💪',
}

// ============================================================
// DOM HELPERS
// ============================================================

const $    = id => document.getElementById(id)
const show = el => el.classList.remove('hidden')
const hide = el => el.classList.add('hidden')

// ============================================================
// STUB STORAGE  (localStorage-backed, no backend needed)
// ============================================================

const STUB_USER        = '+15550000000'  // only used when stubAuth is on
const STUB_ENTRIES_KEY = 'sp_stub_entries'

function stubLoadEntries() {
  try {
    return JSON.parse(localStorage.getItem(STUB_ENTRIES_KEY) || '[]')
  } catch (_) { return [] }
}

function stubSaveEntries(entries) {
  try { localStorage.setItem(STUB_ENTRIES_KEY, JSON.stringify(entries)) } catch (_) {}
}

function stubPostEntry(promptDate, body, mood) {
  const entries  = stubLoadEntries()
  const existing = entries.find(e => e.prompt_date === promptDate)

  if (existing) {
    existing.body       = body
    existing.mood       = mood
    existing.updated_at = new Date().toISOString()
    stubSaveEntries(entries)
    return existing
  }

  const entry = {
    id:           Date.now(),
    user_id:      state.user,
    prompt_date:  promptDate,
    body,
    mood,
    created_at:   new Date().toISOString(),
    updated_at:   new Date().toISOString(),
    entry_photos: [],
  }
  entries.unshift(entry)
  stubSaveEntries(entries)
  return entry
}

// ============================================================
// AUTH — j2auth wrappers  (real mode only)
// ============================================================

async function sendCode(rawPhone) {
  const digits = rawPhone.replace(/\D/g, '')
  const phone  = digits.startsWith('1') ? `+${digits}` : `+1${digits}`
  const code   = await requestAuthenticationCode(phone, window.APP_CONFIG.j2BizId)
  if (!code) throw new Error('Could not send code — check the number and try again.')
}

async function verifyCode(userCode) {
  const ok = await verifyAuthenticationCode(userCode)
  if (!ok) throw new Error('Wrong code — try again.')
  // Associate this user with the journal Business in the graph.
  // Server auto-creates a User object for new mobiles.
  registerBusinessUser()
  return userMobile
}

// Check whether a mobile already belongs to a known user, and get any
// profile vars stored for this biz. Uses serverURL from j2auth.js
// (already localized via local.json by the time forms are usable).
async function checkUser(rawPhone) {
  const res = await fetch(serverURL + '/usercheck/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile: rawPhone, bizid: window.APP_CONFIG.j2BizId })
  })
  if (!res.ok) throw new Error('Could not check that number — try again.')
  return res.json()  // { exists, profile }
}

// Store profile vars (name, birthday) on the User for this biz.
// Must run after auth — the User object is created by /auth/.
async function pushProfile(mobile, vars) {
  const res = await fetch(serverURL + '/update-profile/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile, bizid: window.APP_CONFIG.j2BizId, vars })
  })
  if (!res.ok) throw new Error('Could not save profile')
  return res.json()  // { profile }
}

function signOut() {
  if (!STUB_AUTH) {
    document.cookie = `jupiterDeviceID=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`
    isAuthenticated = false
  }
  state.user    = null
  state.profile = null
  state.entries = []
  showAuthScreen()
}

// ============================================================
// DATABASE  (real mode; stub mode uses localStorage above)
// ============================================================

async function loadProfile(userId) {
  const { data } = await supa
    .from('profiles').select('*').eq('id', userId).maybeSingle()
  return data
}

async function createProfile(userId) {
  const { data, error } = await supa
    .from('profiles').insert({ id: userId, name: 'Journaler' }).select().single()
  if (error) throw error
  return data
}

async function saveProfileName(userId, name) {
  const { data, error } = await supa
    .from('profiles').update({ name }).eq('id', userId).select().single()
  if (error) throw error
  return data
}

async function loadEntries(userId) {
  const { data, error } = await supa
    .from('entries')
    .select('id, body, mood, created_at, updated_at, prompt_date, entry_photos ( id, storage_path )')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

async function postEntry(userId, promptDate, body, mood) {
  const existing = state.entries.find(e => e.prompt_date === promptDate)
  if (existing) {
    const { data, error } = await supa
      .from('entries')
      .update({ body, mood, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select().single()
    if (error) throw error
    return data
  }
  const { data, error } = await supa
    .from('entries')
    .insert({ user_id: userId, prompt_date: promptDate, body, mood })
    .select().single()
  if (error) throw error
  return data
}

async function uploadPhotos(userId, entryId, staged) {
  for (const { file } of staged) {
    const ext  = file.name.split('.').pop().toLowerCase()
    const path = `${userId}/${entryId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error: uploadErr } = await supa.storage
      .from('photos').upload(path, file, { contentType: file.type })
    if (uploadErr) throw uploadErr
    const { error: dbErr } = await supa
      .from('entry_photos').insert({ entry_id: entryId, storage_path: path })
    if (dbErr) throw dbErr
  }
}

function photoUrl(path) {
  const { data } = supa.storage.from('photos').getPublicUrl(path)
  return data.publicUrl
}

// ============================================================
// PROMPTS  (always from prompts.json)
// ============================================================

async function loadPrompts() {
  const res = await fetch('prompts.json')
  if (!res.ok) throw new Error('Could not load prompts.json')
  return res.json()
}

function getActivePrompt(prompts) {
  const today = new Date().toISOString().split('T')[0]
  const past  = prompts.filter(p => p.date <= today)
  if (!past.length) return null
  return past.reduce((a, b) => (a.date > b.date ? a : b))
}

// ============================================================
// COMPUTED HELPERS
// ============================================================

function computeStreak(entries) {
  if (!entries.length) return 0
  const dates = [...new Set(entries.map(e => e.created_at.split('T')[0]))].sort().reverse()
  const todayStr = new Date().toISOString().split('T')[0]
  const yest     = new Date(); yest.setDate(yest.getDate() - 1)
  const yesterdayStr = yest.toISOString().split('T')[0]
  if (dates[0] !== todayStr && dates[0] !== yesterdayStr) return 0
  let streak = 0, cursor = dates[0]
  for (const date of dates) {
    if (date === cursor) {
      streak++
      const d = new Date(cursor); d.setDate(d.getDate() - 1)
      cursor = d.toISOString().split('T')[0]
    } else { break }
  }
  return streak
}

function getWeekDays(entries) {
  const now    = new Date()
  const dow    = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1))
  monday.setHours(0, 0, 0, 0)
  const todayStr   = now.toISOString().split('T')[0]
  const entryDates = new Set(entries.map(e => e.created_at.split('T')[0]))
  const dayLabels  = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
  const dayNames   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return Array.from({ length: 7 }, (_, i) => {
    const d   = new Date(monday); d.setDate(monday.getDate() + i)
    const iso = d.toISOString().split('T')[0]
    return { label: dayLabels[i], name: dayNames[i], date: iso,
             done: entryDates.has(iso), isToday: iso === todayStr }
  })
}

function wordCount(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

function formatDateShort(isoDate) {
  // isoDate is "YYYY-MM-DD" — parse as local date to avoid UTC shift
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ============================================================
// DRAFT  (localStorage)
// ============================================================

function saveDraft(promptDate, body, mood) {
  if (!promptDate) return
  try { localStorage.setItem(`sp_draft_${promptDate}`, JSON.stringify({ body, mood })) } catch (_) {}
}
function loadDraft(promptDate) {
  if (!promptDate) return null
  try { return JSON.parse(localStorage.getItem(`sp_draft_${promptDate}`)) } catch (_) { return null }
}
function clearDraft(promptDate) {
  try { localStorage.removeItem(`sp_draft_${promptDate}`) } catch (_) {}
}

// ============================================================
// RENDER — app screen
// ============================================================

function renderApp() {
  const { profile, todayPrompt, entries } = state

  $('user-name').textContent    = profile?.name || ''
  $('user-initial').textContent = (profile?.name || '?')[0].toUpperCase()

  // Streak
  const streak = computeStreak(entries)
  if (streak > 0) {
    $('header-streak-count').textContent = `${streak}-day streak`
    show($('header-streak'))
  } else {
    hide($('header-streak'))
  }

  // Prompt banner — day number = total entries written + 1
  $('prompt-day').textContent     = `Day ${entries.length + 1}`
  $('prompt-text').textContent    = todayPrompt?.body    || 'No prompt yet — check back soon!'
  $('prompt-subtext').textContent = todayPrompt?.subtext || ''
  $('prompt-subtext').style.display = todayPrompt?.subtext ? '' : 'none'

  // Prompt icon tile
  const tile = $('prompt-icon-tile')
  if (todayPrompt?.icon) {
    $('prompt-icon-img').src = `icons/${todayPrompt.icon}.svg`
    tile.style.setProperty('--prompt-tile-color', promptTileColor(todayPrompt))
    show(tile)
  } else {
    hide(tile)
  }

  // Entry date
  $('entry-date').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  })

  // Pre-fill canvas if entry exists for today's prompt
  const existingEntry = todayPrompt
    ? entries.find(e => e.prompt_date === todayPrompt.date)
    : null

  if (existingEntry) {
    $('canvas').value         = existingEntry.body
    state.selectedMood        = existingEntry.mood
    state.currentEntryId      = existingEntry.id
    $('post-btn').innerHTML   = '<i class="fa-solid fa-rotate" aria-hidden="true"></i> Update entry'
    renderExistingPhotos(existingEntry.entry_photos || [])
  } else {
    const draft = todayPrompt ? loadDraft(todayPrompt.date) : null
    $('canvas').value    = draft?.body || ''
    state.selectedMood   = draft?.mood || null
    state.currentEntryId = null
    $('post-btn').innerHTML = '<i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Post entry'
    renderExistingPhotos([])
  }

  updateWordCount()
  renderMoodButtons()
  renderStagedPhotos()
  renderSidebar()
  renderWeekProgress()
}

function renderMoodButtons() {
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mood === state.selectedMood)
  })
}

function renderExistingPhotos(photos) {
  document.querySelectorAll('.photo-existing').forEach(el => el.remove())
  if (STUB_DATA) return  // no photo URLs in stub mode
  const strip = $('photo-strip'), addBtn = $('photo-add-btn')
  photos.forEach(p => {
    const div = document.createElement('div')
    div.className = 'photo-thumb photo-existing'
    div.innerHTML = `<img src="${photoUrl(p.storage_path)}" alt="Entry photo">`
    strip.insertBefore(div, addBtn)
  })
}

function renderStagedPhotos() {
  document.querySelectorAll('.photo-staged').forEach(el => el.remove())
  const strip = $('photo-strip'), addBtn = $('photo-add-btn')
  state.stagedPhotos.forEach((p, i) => {
    const div = document.createElement('div')
    div.className = 'photo-thumb photo-staged'
    div.innerHTML = `
      <img src="${p.previewUrl}" alt="Photo to upload">
      <button class="photo-remove-btn" data-index="${i}" aria-label="Remove photo">✕</button>`
    strip.insertBefore(div, addBtn)
  })
}

function renderSidebar() {
  const list    = $('entries-list')
  const entries = state.entries
  $('entry-count').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`

  if (!entries.length) {
    list.innerHTML = `<div class="entry-empty">✨ Your entries will appear here as you write them.</div>`
    return
  }

  list.innerHTML = entries.map(entry => {
    const mood       = entry.mood || ''
    const prompt     = state.prompts.find(p => p.date === entry.prompt_date)
    const promptText = prompt?.body || ''
    const preview    = entry.body.slice(0, 110)
    const photoCount = entry.entry_photos?.length || 0
    const emoji      = MOOD_EMOJI[mood] || ''

    const moodHtml = mood ? `
      <div class="entry-card-mood">
        <span class="entry-card-mood-emoji">${emoji}</span>
        <span class="entry-card-mood-label mood-label-${mood}">${mood}</span>
      </div>` : ''

    const photoHtml = photoCount > 0 ? `
      <span class="entry-card-photo">
        <i class="fa-solid fa-image" aria-hidden="true" style="font-size:11px;"></i> ${photoCount}
      </span>` : ''

    return `
      <div class="entry-card" data-id="${entry.id}" data-mood="${mood}"
           role="button" tabindex="0"
           aria-label="Open entry from ${formatDate(entry.created_at)}">
        ${moodHtml}
        <div class="entry-card-prompt">${promptText.slice(0, 72)}${promptText.length > 72 ? '…' : ''}</div>
        <div class="entry-card-preview">"${preview}${entry.body.length > 110 ? '…' : ''}"</div>
        <div class="entry-card-footer">
          <span class="entry-card-date">${formatDate(entry.created_at)}</span>
          ${photoHtml}
        </div>
      </div>`
  }).join('')
}

function renderWeekProgress() {
  const days      = getWeekDays(state.entries)
  const doneCount = days.filter(d => d.done).length
  const goal      = 3
  $('week-goal').textContent     = `${Math.min(doneCount, goal)} of ${goal}`
  $('progress-fill').style.width = `${Math.min(100, (doneCount / goal) * 100)}%`
  $('week-dots').innerHTML = days.map(day => `
    <div class="week-dot-col">
      <div class="week-dot ${day.done ? 'done' : ''} ${day.isToday && !day.done ? 'today' : ''}">
        ${day.done ? '<i class="fa-solid fa-check" aria-hidden="true" style="font-size:11px;"></i>' : day.label}
      </div>
      <span class="week-dot-name">${day.name}</span>
    </div>`).join('')
}

function updateWordCount() {
  const n = wordCount($('canvas').value)
  $('word-count').textContent = `${n} word${n !== 1 ? 's' : ''}`
}

// ============================================================
// RENDER — mobile screen
// ============================================================

function renderMobile() {
  const entries    = STUB_DATA ? stubLoadEntries() : state.entries
  const entryDates = new Set(entries.map(e => e.prompt_date))
  const today      = new Date().toISOString().split('T')[0]

  // Personalized greeting — profile is loaded by the time this renders
  const name = state.profile?.name || localStorage.getItem('sp_user_name') || ''
  $('mobile-greeting').textContent = getGreeting(name)

  // Streak on mobile
  const streak = computeStreak(entries)
  if (streak > 0) {
    $('mobile-streak-text').textContent = `${streak}-day streak`
    show($('mobile-streak-wrap'))
  }

  // Show recent + upcoming prompts (past 3 + next 3)
  const past     = state.prompts.filter(p => p.date <= today).slice(-4).reverse()
  const upcoming = state.prompts.filter(p => p.date > today).slice(0, 3)
  const visible  = [...past, ...upcoming]

  if (!visible.length) {
    $('mobile-prompt-list').innerHTML =
      `<div style="color:var(--purple-300);font-size:13px;text-align:center;padding:20px 0;">No prompts yet — check back soon!</div>`
    return
  }

  $('mobile-prompt-list').innerHTML = visible.map(p => {
    const done    = entryDates.has(p.date)
    const isToday = p.date === today
    const color   = PROMPT_TILE_COLORS[
      Math.max(0, state.prompts.indexOf(p)) % PROMPT_TILE_COLORS.length
    ]
    const iconHtml = p.icon
      ? `<div class="mobile-prompt-icon" style="background:${color}">
           <img src="icons/${p.icon}.svg" alt="" aria-hidden="true">
         </div>`
      : `<div class="mobile-prompt-check">
           ${done ? '<i class="fa-solid fa-check" style="font-size:11px;"></i>' : ''}
         </div>`

    return `
      <div class="mobile-prompt-item ${done ? 'done' : ''}">
        ${iconHtml}
        <div class="mobile-prompt-item-body">
          <div class="mobile-prompt-date">${isToday ? 'Today' : formatDateShort(p.date)}</div>
          <div class="mobile-prompt-text">${p.body}</div>
        </div>
        ${done ? '<i class="fa-solid fa-check mobile-done-check" aria-hidden="true"></i>' : ''}
      </div>`
  }).join('')
}

// ============================================================
// SCREEN TRANSITIONS
// ============================================================

function showAuthScreen() {
  hide($('app-screen'))
  hide($('mobile-screen'))
  hide($('profile-setup-screen'))
  show($('auth-screen'))
  show($('phone-step'))
  hide($('otp-step'))
}

// Show the signed-in experience. Both screens are un-hidden;
// CSS media queries decide which one renders (full app on
// desktop, to-do list on mobile).
function showMainScreen() {
  renderMobile()
  show($('app-screen'))
  show($('mobile-screen'))
}

// ============================================================
// EVENT HANDLERS — Auth
// ============================================================

// Auto-format phone number as (###) ###-#### while typing
function formatPhone(digits) {
  if (!digits.length) return ''
  if (digits.length <= 3) return `(${digits}`
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`
}

$('phone-input').addEventListener('input', e => {
  const digits = e.target.value.replace(/\D/g, '').slice(0, 10)
  e.target.value = formatPhone(digits)
  // Number changed — any new-user expansion no longer applies
  hide($('newuser-fields'))
  state.pendingProfile = null
  $('send-otp-btn').textContent = 'Send code'
})

$('phone-form').addEventListener('submit', async e => {
  e.preventDefault()
  const phone  = $('phone-input').value.trim()
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 10) {
    $('phone-error').textContent = 'Please enter a full 10-digit phone number.'
    return
  }

  const btn = $('send-otp-btn')
  $('phone-error').textContent = ''

  // Phase 2: new-user fields are open — validate, stash, send code
  if (!$('newuser-fields').classList.contains('hidden')) {
    const name     = $('newuser-name').value.trim()
    const birthday = $('newuser-birthday').value  // YYYY-MM-DD or ''
    if (!name) {
      $('phone-error').textContent = 'Tell us your name so we know what to call you!'
      $('newuser-name').focus()
      return
    }
    state.pendingProfile = { name, ...(birthday ? { birthday } : {}) }

    btn.disabled = true; btn.textContent = 'Sending…'
    try {
      await sendCode(phone)
      hide($('phone-step')); show($('otp-step'))
      $('otp-input').focus()
    } catch (err) {
      $('phone-error').textContent = err.message
      btn.disabled = false; btn.textContent = 'Send my code'
    }
    return
  }

  // Phase 1: check whether this mobile is already a known user
  btn.disabled = true; btn.textContent = 'Checking…'
  try {
    const { exists, profile } = await checkUser(phone)

    if (exists && profile?.name) {
      // Known user — straight to the code
      btn.textContent = 'Sending…'
      await sendCode(phone)
      hide($('phone-step')); show($('otp-step'))
      $('otp-input').focus()
    } else {
      // New user (or no profile yet) — expand the intro form
      show($('newuser-fields'))
      btn.disabled = false; btn.textContent = 'Send my code'
      $('newuser-name').focus()
    }
  } catch (err) {
    $('phone-error').textContent = err.message
    btn.disabled = false; btn.textContent = 'Send code'
  }
})

$('otp-form').addEventListener('submit', async e => {
  e.preventDefault()
  const token = $('otp-input').value.trim()
  if (!token) return
  const btn = $('verify-btn')
  btn.disabled = true; btn.textContent = 'Verifying…'
  $('otp-error').textContent = ''
  try {
    state.user = await verifyCode(token)

    // New user: store their profile info now that the User object
    // exists (created server-side during /auth/)
    if (state.pendingProfile) {
      try {
        await pushProfile(state.user, state.pendingProfile)
        localStorage.setItem('sp_user_name', state.pendingProfile.name)
      } catch (err) {
        // Non-fatal — they're authenticated; profile can be set later
        console.error('Profile save failed:', err)
      }
      state.pendingProfile = null
    }

    await handleAuthenticated()
  } catch (err) {
    $('otp-error').textContent = err.message
    btn.disabled = false; btn.textContent = 'Verify'
  }
})

$('back-to-phone').addEventListener('click', () => {
  hide($('otp-step')); show($('phone-step'))
  $('otp-input').value = ''; $('otp-error').textContent = ''
})

// ============================================================
// EVENT HANDLERS — Profile setup
// ============================================================

$('profile-form').addEventListener('submit', async e => {
  e.preventDefault()
  const name = $('name-input').value.trim()
  if (!name) return
  const btn = $('save-name-btn')
  btn.disabled = true; btn.textContent = 'Saving…'
  try {
    if (STUB_DATA) {
      state.profile = { id: state.user, name }
    } else {
      state.profile = await saveProfileName(state.user, name)
    }
    localStorage.setItem('sp_user_name', name)
    hide($('profile-setup-screen'))
    await loadAndRenderApp()
    showMainScreen()
  } catch (err) {
    console.error(err)
    btn.disabled = false; btn.textContent = 'Start writing ✨'
  }
})

// ============================================================
// EVENT HANDLERS — Writing canvas
// ============================================================

$('canvas').addEventListener('input', () => {
  updateWordCount()
  if (state.todayPrompt) saveDraft(state.todayPrompt.date, $('canvas').value, state.selectedMood)
})

document.querySelectorAll('.mood-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.selectedMood = state.selectedMood === btn.dataset.mood ? null : btn.dataset.mood
    renderMoodButtons()
    if (state.todayPrompt) saveDraft(state.todayPrompt.date, $('canvas').value, state.selectedMood)
  })
})

$('photo-add-btn').addEventListener('click', () => $('photo-file-input').click())

$('photo-file-input').addEventListener('change', e => {
  Array.from(e.target.files).forEach(file => {
    if (!file.type.startsWith('image/')) return
    state.stagedPhotos.push({ file, previewUrl: URL.createObjectURL(file) })
  })
  renderStagedPhotos()
  e.target.value = ''
})

$('photo-strip').addEventListener('click', e => {
  const btn = e.target.closest('.photo-remove-btn')
  if (!btn) return
  const i = parseInt(btn.dataset.index, 10)
  URL.revokeObjectURL(state.stagedPhotos[i].previewUrl)
  state.stagedPhotos.splice(i, 1)
  renderStagedPhotos()
})

$('post-btn').addEventListener('click', async () => {
  const body = $('canvas').value.trim()
  if (!body) { $('canvas').focus(); return }
  if (!state.todayPrompt || state.saving) return

  state.saving = true
  const btn    = $('post-btn')
  btn.disabled = true; btn.textContent = 'Posting…'

  try {
    let entry
    if (STUB_DATA) {
      entry = stubPostEntry(state.todayPrompt.date, body, state.selectedMood)
    } else {
      entry = await postEntry(state.user, state.todayPrompt.date, body, state.selectedMood)
      if (state.stagedPhotos.length > 0) {
        await uploadPhotos(state.user, entry.id, state.stagedPhotos)
        state.stagedPhotos.forEach(p => URL.revokeObjectURL(p.previewUrl))
        state.stagedPhotos = []
      }
    }
    clearDraft(state.todayPrompt.date)
    state.entries = STUB_DATA ? stubLoadEntries() : await loadEntries(state.user)
    renderApp()
    btn.innerHTML = '✓ Posted!'
    setTimeout(() => {
      btn.innerHTML = '<i class="fa-solid fa-rotate" aria-hidden="true"></i> Update entry'
      btn.disabled  = false
    }, 1600)
  } catch (err) {
    console.error('Post error:', err)
    btn.textContent = 'Error — try again'
    setTimeout(() => {
      btn.innerHTML = state.currentEntryId
        ? '<i class="fa-solid fa-rotate" aria-hidden="true"></i> Update entry'
        : '<i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Post entry'
      btn.disabled = false
    }, 2200)
  } finally {
    state.saving = false
  }
})

// User dropdown
const userMenuTrigger = $('user-menu-trigger')
const userDropdown    = $('user-dropdown')

function toggleUserMenu(e) {
  e.stopPropagation()
  const opening = userDropdown.classList.contains('hidden')
  userDropdown.classList.toggle('hidden', !opening)
  userMenuTrigger.setAttribute('aria-expanded', opening ? 'true' : 'false')
}

userMenuTrigger.addEventListener('click', toggleUserMenu)
userMenuTrigger.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') toggleUserMenu(e)
})

document.addEventListener('click', () => {
  userDropdown.classList.add('hidden')
  userMenuTrigger.setAttribute('aria-expanded', 'false')
})

$('sign-out-btn').addEventListener('click', signOut)

// ============================================================
// EVENT HANDLERS — Sidebar / Modal
// ============================================================

$('entries-list').addEventListener('click', e => {
  const card = e.target.closest('.entry-card')
  if (!card) return
  const entry = state.entries.find(en => en.id === parseInt(card.dataset.id, 10))
  if (entry) openModal(entry)
})

$('entries-list').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    const card = e.target.closest('.entry-card')
    if (!card) return
    const entry = state.entries.find(en => en.id === parseInt(card.dataset.id, 10))
    if (entry) openModal(entry)
  }
})

function openModal(entry) {
  const prompt = state.prompts.find(p => p.date === entry.prompt_date)
  $('modal-prompt').textContent = prompt?.body || ''
  $('modal-date').textContent   = formatDate(entry.created_at)
  $('modal-body').textContent   = entry.body

  const emoji = MOOD_EMOJI[entry.mood] || ''
  if (entry.mood) {
    $('modal-mood').textContent   = `${emoji} ${entry.mood}`
    $('modal-mood').style.display = ''
  } else {
    $('modal-mood').style.display = 'none'
  }

  const photos = entry.entry_photos || []
  const grid   = $('modal-photos')
  grid.innerHTML = ''
  grid.style.display = photos.length ? 'grid' : 'none'
  if (!STUB_DATA) {
    photos.forEach(p => {
      const img = document.createElement('img')
      img.src = photoUrl(p.storage_path); img.alt = 'Journal photo'
      grid.appendChild(img)
    })
  }

  show($('entry-modal'))
  $('modal-close').focus()
}

$('modal-close').addEventListener('click', () => hide($('entry-modal')))
$('entry-modal').addEventListener('click', e => { if (e.target === $('entry-modal')) hide($('entry-modal')) })
document.addEventListener('keydown', e => { if (e.key === 'Escape') hide($('entry-modal')) })

// ============================================================
// INIT
// ============================================================

async function loadAndRenderApp() {
  state.prompts     = await loadPrompts()
  state.todayPrompt = getActivePrompt(state.prompts)
  state.entries     = STUB_DATA ? stubLoadEntries() : await loadEntries(state.user)
  renderApp()
}

async function handleAuthenticated() {
  hide($('auth-screen'))
  try {
    if (STUB_DATA) {
      // Profile lives on the REGISTERED_FOR relationship in the graph
      // (biz_profile in the /userprofile/ response), localStorage fallback
      const vars = (!STUB_AUTH && typeof userProfile !== 'undefined' && userProfile?.biz_profile) || {}
      state.profile = {
        id:       state.user,
        name:     vars.name || localStorage.getItem('sp_user_name') || '',
        birthday: vars.birthday || null,
      }
    } else {
      state.profile = await loadProfile(state.user)
      if (!state.profile) state.profile = await createProfile(state.user)
    }

    if (!state.profile.name || state.profile.name === 'Journaler') {
      show($('profile-setup-screen'))
      $('name-input').focus()
      return
    }

    await loadAndRenderApp()
    showMainScreen()
  } catch (err) {
    console.error('App init error:', err)
    showAuthScreen()
  }
}

async function init() {
  if (STUB_AUTH) {
    // Skip auth entirely — go straight to the app
    state.user = STUB_USER
    await handleAuthenticated()
    return
  }

  // j2AuthInit reads local.json (API server override), checks the
  // device cookie, and fetches the user profile if it's valid
  await j2AuthInit(window.APP_CONFIG.j2BizId, window.APP_CONFIG.j2AppToken)
  if (isAuthenticated) {
    // On cookie-restored sessions j2auth doesn't set the userMobile
    // global — recover it from the profile (shape: { user: { mobile, uuid }, ... })
    state.user = userMobile || userProfile?.user?.mobile || null
    if (state.user) {
      await handleAuthenticated()
      return
    }
    console.error('Authenticated but no mobile in profile:', userProfile)
  }
  showAuthScreen()
}

init()
