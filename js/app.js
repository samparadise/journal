'use strict'

const STUB_AUTH = window.APP_CONFIG.stubAuth   // skip j2auth, fake user
const STUB_DATA = window.APP_CONFIG.stubData   // localStorage instead of the graph API

// ============================================================
// MARKDOWN  (marked: md→html, turndown: html→md, DOMPurify: sanitize)
// Entries are stored as markdown (entry_md); the editor is a
// contenteditable div working in HTML.
// ============================================================

const turndown = new TurndownService({ emDelimiter: '*', headingStyle: 'atx' })

function mdToHtml(md) {
  return DOMPurify.sanitize(marked.parse(md || ''))
}

function htmlToMd(html) {
  return turndown.turndown(html || '').trim()
}

function mdToText(md) {
  const d = document.createElement('div')
  d.innerHTML = mdToHtml(md)
  return (d.textContent || '').trim()
}

// ============================================================
// STATE
// ============================================================

const state = {
  user:           null,   // E.164 phone string
  profile:        null,
  prompts:        [],     // loaded from prompts.json
  todayPrompt:    null,
  entries:        [],
  uploadingCount: 0,      // photos currently uploading
  selectedMood:   null,
  currentEntryId: null,
  saving:         false,
  canEdit:        false,  // today's prompt, not yet finalized
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

function stubPostEntry(promptId, entryMd, mood, final = false) {
  const entries  = stubLoadEntries()
  const existing = entries.find(e => e.prompt_id === promptId)

  if (existing) {
    if (existing.final) throw new Error('Entry is final and cannot be edited')
    existing.entry_md   = entryMd
    existing.mood       = mood
    existing.final      = final
    existing.updated_at = new Date().toISOString()
    stubSaveEntries(entries)
    return existing
  }

  const entry = {
    id:         Date.now(),
    prompt_id:  promptId,
    entry_md:   entryMd,
    mood,
    final,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    photo_urls: [],
  }
  entries.unshift(entry)
  stubSaveEntries(entries)
  return entry
}

function stubPhotoEntry(promptId) {
  // find-or-create the entry a photo attaches to (stub mode)
  const entries = stubLoadEntries()
  let entry = entries.find(e => e.prompt_id === promptId)
  if (entry?.final) throw new Error('Entry is final and cannot be edited')
  if (!entry) {
    entry = {
      id: Date.now(), prompt_id: promptId, entry_md: '', mood: null,
      final: false, created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), photo_urls: [],
    }
    entries.unshift(entry)
  }
  return { entries, entry }
}

function stubAddPhoto(promptId, dataUrl) {
  const { entries, entry } = stubPhotoEntry(promptId)
  entry.photo_urls.push(dataUrl)
  entry.updated_at = new Date().toISOString()
  stubSaveEntries(entries)
  return entry.photo_urls
}

function stubRemovePhoto(promptId, url) {
  const { entries, entry } = stubPhotoEntry(promptId)
  entry.photo_urls = entry.photo_urls.filter(u => u !== url)
  entry.updated_at = new Date().toISOString()
  stubSaveEntries(entries)
  return entry.photo_urls
}

// ============================================================
// PHOTOS  (resize client-side, upload immediately on add)
// ============================================================

const PHOTO_MAX_DIM  = 1600
const PHOTO_QUALITY  = 0.85

// Downscale to a reasonable JPEG before upload — phone photos
// are 8-12MB and would crawl as base64 JSON otherwise.
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objUrl)
      const scale  = Math.min(1, PHOTO_MAX_DIM / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width  = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY))
    }
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('Could not read that image')) }
    img.src = objUrl
  })
}

async function addPhotoFiles(files) {
  if (!state.canEdit || !state.todayPrompt) return
  const images = Array.from(files).filter(f => f.type.startsWith('image/'))
  if (!images.length) return

  state.uploadingCount += images.length
  renderPhotoStrip()

  for (const file of images) {
    try {
      const dataUrl = await resizeImage(file)
      const urls = STUB_DATA
        ? stubAddPhoto(state.todayPrompt.id, dataUrl)
        : await apiAddPhoto(state.todayPrompt.id, dataUrl)
      applyPhotoUrls(urls)
    } catch (err) {
      console.error('Photo upload failed:', err)
      setSaveStatus('Photo upload failed', 'error')
    } finally {
      state.uploadingCount--
    }
    renderPhotoStrip()
  }
}

// Sync the active entry's photo_urls into local state
function applyPhotoUrls(urls) {
  if (!state.todayPrompt) return
  let entry = state.entries.find(e => e.prompt_id === state.todayPrompt.id)
  if (!entry) {
    entry = {
      id: Date.now(), prompt_id: state.todayPrompt.id, entry_md: '',
      mood: state.selectedMood, final: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      photo_urls: [],
    }
    state.entries.unshift(entry)
  }
  entry.photo_urls = urls
  renderSidebar()
}

// ============================================================
// AUTH — j2auth wrappers  (real mode only)
// ============================================================

async function sendCode(e164Phone) {
  const code = await requestAuthenticationCode(e164Phone, window.APP_CONFIG.j2BizId)
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
// profile vars stored for this biz. Takes an E.164 number; the server
// normalizes it again, but sending E.164 avoids region-guess ambiguity.
async function checkUser(e164Phone) {
  const res = await fetch(serverURL + '/usercheck/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile: e164Phone, bizid: window.APP_CONFIG.j2BizId })
  })
  if (!res.ok) throw new Error('Could not check that number — try again.')
  return res.json()  // { exists, profile }
}

// Fire a one-time welcome SMS for a brand-new player (situation-aware:
// no prompt today / prompt coming / prompt already out). Best-effort.
async function apiWelcome() {
  if (STUB_AUTH) return
  try {
    await fetch(serverURL + '/journal/welcome/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usertoken: userToken, bizid: window.APP_CONFIG.j2BizId })
    })
  } catch (err) {
    console.error('Welcome send failed:', err)
  }
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
// ENTRIES API  (Jupiter graph: (:User)-[:WROTE]->(:JournalEntry))
// Authenticated by the j2auth device token (userToken global),
// never by raw mobile — so one kid can't read another's entries.
// ============================================================

async function apiLoadEntries() {
  const res = await fetch(serverURL + '/journal/entries/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usertoken: userToken, bizid: window.APP_CONFIG.j2BizId })
  })
  if (!res.ok) throw new Error('Could not load your entries')
  const data = await res.json()
  return data.entries || []
}

async function apiAddPhoto(promptId, dataUrl) {
  const res = await fetch(serverURL + '/journal/photo/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usertoken: userToken,
      bizid:     window.APP_CONFIG.j2BizId,
      prompt_id: promptId,
      image:     dataUrl
    })
  })
  if (res.status === 409) throw new Error('This entry is already done — it can\'t be changed.')
  if (!res.ok) throw new Error('Could not upload the photo')
  return (await res.json()).photo_urls
}

async function apiRemovePhoto(promptId, url) {
  const res = await fetch(serverURL + '/journal/photo/remove/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usertoken: userToken,
      bizid:     window.APP_CONFIG.j2BizId,
      prompt_id: promptId,
      url
    })
  })
  if (!res.ok) throw new Error('Could not remove the photo')
  return (await res.json()).photo_urls
}

async function apiPostEntry(promptId, entryMd, mood, final = false) {
  const res = await fetch(serverURL + '/journal/entry/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usertoken: userToken,
      bizid:     window.APP_CONFIG.j2BizId,
      prompt_id: promptId,
      entry_md:  entryMd,
      mood:      mood || null,
      final
    })
  })
  if (res.status === 409) throw new Error('This entry is already done — it can\'t be changed.')
  if (!res.ok) throw new Error('Could not save your entry')
  const data = await res.json()
  return data.entry
}

// ============================================================
// PROMPTS  (always from prompts.json)
// ============================================================

async function loadPrompts() {
  const res = await fetch('prompts.json')
  if (!res.ok) throw new Error(`Could not fetch prompts.json (HTTP ${res.status})`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (e) {
    // A malformed prompts.json (missing comma, stray quote) lands here.
    // Surface it loudly instead of bubbling up an opaque parser error.
    throw new Error(`prompts.json is not valid JSON — ${e.message}`)
  }
}

function getActivePrompt(prompts) {
  const today = localDate()
  const past  = prompts.filter(p => p.date <= today)
  if (!past.length) return null
  return past.reduce((a, b) => (a.date > b.date ? a : b))
}

// ============================================================
// COMPUTED HELPERS
// ============================================================

// Local-time YYYY-MM-DD. Using toISOString() here would give UTC,
// which rolls over to "tomorrow" in the evening for US timezones.
function localDate(d = new Date()) {
  const y  = d.getFullYear()
  const m  = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// Parse a server ISO timestamp tolerantly. The graph stores created_at as
// e.g. "2026-06-16T09:00:06+0000" (no colon in the offset). Chrome parses
// that, but Safari's `new Date()` THROWS "string did not match expected
// pattern" on it — so normalize the offset (and a trailing Z) first.
function parseTs(s) {
  if (!s) return new Date(NaN)
  let str = String(s)
  if (str.endsWith('Z')) str = str.slice(0, -1) + '+00:00'
  const m = str.match(/([+-]\d{2})(\d{2})$/)
  if (m) str = str.slice(0, m.index) + m[1] + ':' + m[2]
  return new Date(str)
}

// Streak = consecutive completed PROMPTS in the schedule, not calendar days.
// Prompts aren't daily, so a non-prompt day (or a multi-day gap between
// prompts) must NOT break the streak — only missing an actual past prompt does.
function computeStreak(entries) {
  const today   = localDate()
  const doneIds = new Set(entries.filter(e => e.final).map(e => e.prompt_id))
  const past    = state.prompts
    .filter(p => p.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  if (!past.length) return 0

  let i = past.length - 1
  // Today's prompt not done yet shouldn't break the streak mid-day — skip it.
  if (past[i].date === today && !doneIds.has(past[i].id)) i--

  let streak = 0
  while (i >= 0 && doneIds.has(past[i].id)) { streak++; i-- }
  return streak
}

function getWeekDays(entries) {
  const now    = new Date()
  const dow    = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1))
  monday.setHours(0, 0, 0, 0)
  const todayStr    = localDate(now)
  const entryDates  = new Set(entries.map(e => localDate(parseTs(e.created_at))))
  const promptDates = new Set(state.prompts.map(p => p.date))
  const dayLabels   = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
  const dayNames    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return Array.from({ length: 7 }, (_, i) => {
    const d   = new Date(monday); d.setDate(monday.getDate() + i)
    const iso = localDate(d)
    return {
      label: dayLabels[i], name: dayNames[i], date: iso,
      done:      entryDates.has(iso),
      hasPrompt: promptDates.has(iso),
      isToday:   iso === todayStr,
      isPast:    iso < todayStr,
    }
  })
}

function wordCount(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

function formatDate(iso) {
  return parseTs(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

function formatDateShort(isoDate) {
  // isoDate is "YYYY-MM-DD" — parse as local date to avoid UTC shift
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ============================================================
// EDITOR  (contenteditable canvas ↔ markdown)
// ============================================================

function getCanvasMd()   { return htmlToMd($('canvas').innerHTML) }
function setCanvasMd(md) { $('canvas').innerHTML = mdToHtml(md) }
function getCanvasText() { return ($('canvas').textContent || '').trim() }

// ============================================================
// AUTOSAVE  (Sheets-style: debounced server save while typing)
// The entry exists server-side in non-final form, so the writer
// can leave and pick up later — from any device.
// ============================================================

const AUTOSAVE_DELAY = 1200  // ms after last keystroke

let autosaveTimer    = null
let autosaveInFlight = false
let autosaveQueued   = false

function setSaveStatus(text, cls = '') {
  const el = $('save-status')
  el.textContent = text
  el.className   = `save-status ${cls}`
}

function scheduleAutosave() {
  if (!state.canEdit) return
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(doAutosave, AUTOSAVE_DELAY)
}

// Replace-or-insert an entry in local state without re-rendering
// the canvas (which would fight the cursor while typing)
function upsertLocalEntry(entry) {
  const i = state.entries.findIndex(e => e.prompt_id === entry.prompt_id)
  if (i >= 0) state.entries[i] = entry
  else state.entries.unshift(entry)
}

async function doAutosave() {
  if (!state.canEdit || !state.todayPrompt) return
  if (!getCanvasText()) return  // nothing written yet

  if (autosaveInFlight) { autosaveQueued = true; return }
  autosaveInFlight = true
  setSaveStatus('Saving…')

  try {
    const md    = getCanvasMd()
    const entry = STUB_DATA
      ? stubPostEntry(state.todayPrompt.id, md, state.selectedMood, false)
      : await apiPostEntry(state.todayPrompt.id, md, state.selectedMood, false)
    state.currentEntryId = entry.id
    upsertLocalEntry(entry)
    renderSidebar()
    renderWeekProgress()
    renderStreakHeader()
    setSaveStatus('Saved ✓', 'saved')
  } catch (err) {
    console.error('Autosave failed:', err)
    setSaveStatus('Not saved — retrying…', 'error')
    clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(doAutosave, 5000)
  } finally {
    autosaveInFlight = false
    if (autosaveQueued) { autosaveQueued = false; doAutosave() }
  }
}

// ============================================================
// RENDER — app screen
// ============================================================

function renderStreakHeader() {
  const streak = computeStreak(state.entries)
  if (streak >= 2) {   // a single day isn't a streak
    $('header-streak-count').textContent = `${streak}-day streak`
    show($('header-streak'))
  } else {
    hide($('header-streak'))
  }
}

function renderApp() {
  const { profile, todayPrompt, entries } = state

  $('user-name').textContent    = profile?.name || ''
  $('user-initial').textContent = (profile?.name || '?')[0].toUpperCase()

  renderStreakHeader()

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

  // Pre-fill canvas if entry exists for the active prompt
  const existingEntry = todayPrompt
    ? entries.find(e => e.prompt_id === todayPrompt.id)
    : null

  setCanvasMd(existingEntry?.entry_md || '')
  state.selectedMood   = existingEntry?.mood || null
  state.currentEntryId = existingEntry?.id || null

  // Editability: only today's prompt, and only until it's finalized.
  // No going back or forward in time — that's the whole point.
  const todayStr      = localDate()
  const isPromptToday = todayPrompt?.date === todayStr
  const entryFinal    = !!existingEntry?.final
  state.canEdit       = !!todayPrompt && isPromptToday && !entryFinal

  // Locked note
  const note = $('locked-note')
  if (todayPrompt && entryFinal) {
    note.className = 'locked-note done-note'
    note.innerHTML = '🎉 You finished this one — nice work! Come back for the next prompt.'
    show(note)
  } else if (todayPrompt && !isPromptToday) {
    const next = state.prompts
      .filter(p => p.date > todayStr)
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0]
    note.className = 'locked-note'
    note.innerHTML = next
      ? `🌞 No prompt today — your next one arrives ${formatDateShort(next.date)}. Enjoy the day!`
      : `🌞 That's all the prompts for now — more coming soon!`
    show(note)
  } else {
    hide(note)
  }

  // Lock/unlock the editor chrome
  const canvas = $('canvas')
  canvas.contentEditable = state.canEdit ? 'true' : 'false'
  canvas.classList.toggle('locked', !state.canEdit)
  document.querySelector('.editor-toolbar').style.display = state.canEdit ? '' : 'none'
  document.querySelectorAll('.mood-btn').forEach(b => b.disabled = !state.canEdit)
  $('photo-add-btn').disabled = !state.canEdit
  $('done-btn').style.display       = state.canEdit ? '' : 'none'
  $('post-explainer').style.display = state.canEdit ? '' : 'none'
  setSaveStatus('')

  updateWordCount()
  renderMoodButtons()
  renderPhotoStrip()
  renderSidebar()
  renderWeekProgress()
}

function renderMoodButtons() {
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mood === state.selectedMood)
  })
}

function renderPhotoStrip() {
  document.querySelectorAll('.photo-thumb').forEach(el => el.remove())
  const strip  = $('photo-strip'), addBtn = $('photo-add-btn')
  const entry  = state.todayPrompt
    ? state.entries.find(e => e.prompt_id === state.todayPrompt.id)
    : null

  ;(entry?.photo_urls || []).forEach(url => {
    const div = document.createElement('div')
    div.className = 'photo-thumb'
    div.dataset.url = url
    div.innerHTML = `
      <img src="${url}" alt="Entry photo">
      ${state.canEdit ? '<button class="photo-remove-btn" aria-label="Remove photo">✕</button>' : ''}`
    strip.insertBefore(div, addBtn)
  })

  // Spinner placeholders for in-flight uploads
  for (let i = 0; i < state.uploadingCount; i++) {
    const div = document.createElement('div')
    div.className = 'photo-thumb uploading'
    strip.insertBefore(div, addBtn)
  }
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
    const prompt     = state.prompts.find(p => p.id === entry.prompt_id)
    const promptText = prompt?.body || ''
    const plainText  = mdToText(entry.entry_md)
    const preview    = plainText.slice(0, 110)
    const photoCount = entry.photo_urls?.length || 0
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
        <div class="entry-card-preview">"${preview}${plainText.length > 110 ? '…' : ''}"</div>
        <div class="entry-card-footer">
          <span class="entry-card-date">${formatDate(entry.created_at)}</span>
          ${photoHtml}
        </div>
      </div>`
  }).join('')
}

function renderWeekProgress() {
  const days      = getWeekDays(state.entries)
  const promptDays = days.filter(d => d.hasPrompt).length
  const doneCount  = days.filter(d => d.done).length

  // Goal is the number of prompts actually scheduled this week, not a fixed 3.
  if (promptDays > 0) {
    $('week-goal').textContent     = `${doneCount} of ${promptDays}`
    $('progress-fill').style.width = `${Math.min(100, (doneCount / promptDays) * 100)}%`
  } else {
    $('week-goal').textContent     = 'no prompts'
    $('progress-fill').style.width = '0%'
  }

  $('week-dots').innerHTML = days.map(day => {
    // Classify each dot: done, today's open prompt, an upcoming prompt,
    // a past missed prompt (plain), or simply no prompt scheduled (struck).
    let cls = ''
    if (!day.hasPrompt)               cls = 'no-prompt'
    else if (day.done)                cls = 'done'
    else if (day.isToday)             cls = 'today'
    else if (!day.isPast)             cls = 'upcoming'   // a prompt is coming this day
    // else: past prompt, not done → plain (reads as a genuine miss)

    const inner = day.done
      ? '<i class="fa-solid fa-check" aria-hidden="true" style="font-size:11px;"></i>'
      : day.label
    return `
      <div class="week-dot-col">
        <div class="week-dot ${cls}">${inner}</div>
        <span class="week-dot-name">${day.name}</span>
      </div>`
  }).join('')

  // Heads-up about the next prompt (today's, or the next upcoming one).
  const todayStr = localDate()
  const next = state.prompts
    .filter(p => p.date >= todayStr)
    .sort((a, b) => (a.date < b.date ? -1 : 1))[0]
  const noteEl = $('next-prompt-note')
  if (!next) {
    noteEl.textContent = "That's a wrap on summer prompts! 🌅"
  } else if (next.date === todayStr) {
    noteEl.textContent = "📨 Today's prompt is here!"
  } else {
    noteEl.textContent = `📨 Next prompt: ${formatDateShort(next.date)}`
  }
}

function updateWordCount() {
  const n = wordCount(getCanvasText())
  $('word-count').textContent = `${n} word${n !== 1 ? 's' : ''}`
}

// ============================================================
// RENDER — mobile screen
// ============================================================

function tileColorForPrompt(p) {
  return PROMPT_TILE_COLORS[
    Math.max(0, state.prompts.indexOf(p)) % PROMPT_TILE_COLORS.length
  ]
}

function renderMobile() {
  const entries = STUB_DATA ? stubLoadEntries() : state.entries
  const today   = localDate()

  // Personalized greeting — profile is loaded by the time this renders
  const name = state.profile?.name || localStorage.getItem('sp_user_name') || ''
  $('mobile-greeting').textContent = getGreeting(name)

  // Completed (finalized) entries are the ones that "count"
  const doneEntries = entries.filter(e => e.final)

  // --- Stats row ---
  const totalWords = doneEntries.reduce(
    (sum, e) => sum + wordCount(mdToText(e.entry_md)), 0
  )
  $('stat-entries').textContent = doneEntries.length
  const mStreak = computeStreak(entries)
  $('stat-streak').textContent  = mStreak >= 2 ? mStreak : 0   // a single day isn't a streak
  $('stat-words').textContent   = totalWords >= 1000
    ? (totalWords / 1000).toFixed(1) + 'k'
    : totalWords

  // --- Trophy collection: one tile per completed prompt, oldest first ---
  // Position of each prompt in the full schedule, so we can detect gaps.
  const order   = [...state.prompts].sort((a, b) => (a.date < b.date ? -1 : 1))
  const idxById = {}
  order.forEach((p, i) => { idxById[p.id] = i })

  const done = doneEntries
    .map(e => ({ entry: e, prompt: state.prompts.find(p => p.id === e.prompt_id) }))
    .filter(x => x.prompt)
    .sort((a, b) => (a.prompt.date < b.prompt.date ? -1 : 1))

  // Build the cell list: completed tiles in order, with a single gap tile
  // wherever there's a jump in the schedule (any number of missed prompts
  // between two completed ones collapses to one gap marker).
  const cells = []
  done.forEach((item, i) => {
    if (i > 0 && idxById[item.prompt.id] - idxById[done[i - 1].prompt.id] > 1) {
      cells.push({ gap: true })
    }
    cells.push(item)
  })

  const grid = $('mobile-trophy-grid')

  if (!done.length) {
    grid.style.display = 'none'
    grid.innerHTML = ''
    $('mobile-empty').style.display = ''
  } else {
    grid.style.display = ''
    $('mobile-empty').style.display = 'none'
    grid.innerHTML = cells.map(cell => {
      if (cell.gap) {
        return `<div class="mobile-trophy gap" aria-hidden="true"><span class="gap-dots">···</span></div>`
      }
      const p = cell.prompt
      const color = tileColorForPrompt(p)
      const inner = p.icon
        ? `<img src="icons/${p.icon}.svg" alt="" aria-hidden="true">`
        : `<span style="font-size:26px">✏️</span>`
      return `
        <div class="mobile-trophy" style="background:${color}"
             data-id="${cell.entry.id}" role="button" tabindex="0"
             aria-label="Open entry from ${formatDateShort(p.date)}">
          ${inner}
          <span class="mobile-trophy-label">${formatDateShort(p.date)}</span>
        </div>`
    }).join('')
  }

  // --- "go write" CTA when today's prompt is live and unfinished ---
  const todayPrompt = state.prompts.find(p => p.date === today)
  const todayDone   = todayPrompt && doneEntries.some(e => e.prompt_id === todayPrompt.id)
  if (todayPrompt && !todayDone) {
    show($('mobile-cta'))
  } else {
    hide($('mobile-cta'))
  }
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

// Supported countries for phone auth. Each knows how to display-format the
// national number as the user types, validate it, and build the E.164 string.
const PHONE_COUNTRIES = {
  US: {
    dial: '1',
    maxDigits: 10,
    placeholder: '(555) 000-0000',
    format(d) {
      d = d.slice(0, 10)
      if (!d.length)     return ''
      if (d.length <= 3) return `(${d}`
      if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
      return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
    },
    valid: d => d.length === 10,
    e164:  d => '+1' + d,
  },
  GB: {
    dial: '44',
    maxDigits: 11,
    placeholder: '07700 900123',
    // UK mobile: 07xxx xxxxxx with the leading 0, or 7xxx xxxxxx without it.
    // Break after 5 digits when the 0 is present, after 4 when it's omitted,
    // so the trailing 6-digit group lines up either way.
    format(d) {
      d = d.slice(0, 11)
      const split = d[0] === '0' ? 5 : 4
      return d.length <= split ? d : `${d.slice(0, split)} ${d.slice(split)}`
    },
    // accept with or without the leading 0; must be a 07/7 mobile
    valid(d) { const n = d.replace(/^0/, ''); return n.length === 10 && n[0] === '7' },
    e164(d)  { return '+44' + d.replace(/^0/, '') },
  },
}

function selectedCountry() {
  return PHONE_COUNTRIES[$('country-select').value] || PHONE_COUNTRIES.US
}

function reformatPhone() {
  const c = selectedCountry()
  const digits = $('phone-input').value.replace(/\D/g, '').slice(0, c.maxDigits)
  $('phone-input').value = c.format(digits)
}

$('country-select').addEventListener('change', () => {
  const c = selectedCountry()
  $('dial-prefix').textContent = '+' + c.dial
  $('phone-input').placeholder = c.placeholder
  reformatPhone()
  $('phone-input').focus()
})

$('phone-input').addEventListener('input', () => {
  reformatPhone()
  // Number changed — any new-user expansion no longer applies
  hide($('newuser-fields'))
  state.pendingProfile = null
  $('send-otp-btn').textContent = 'Send code'
})

$('phone-form').addEventListener('submit', async e => {
  e.preventDefault()
  const c      = selectedCountry()
  const digits = $('phone-input').value.replace(/\D/g, '')
  if (!c.valid(digits)) {
    $('phone-error').textContent = 'Please enter a full phone number.'
    return
  }
  const phone = c.e164(digits)   // E.164 — used for both /usercheck and send

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
    // exists (created server-side during /auth/), then send a one-time
    // situation-aware welcome text.
    if (state.pendingProfile) {
      try {
        await pushProfile(state.user, state.pendingProfile)
        localStorage.setItem('sp_user_name', state.pendingProfile.name)
      } catch (err) {
        // Non-fatal — they're authenticated; profile can be set later
        console.error('Profile save failed:', err)
      }
      state.pendingProfile = null
      apiWelcome()   // fire-and-forget; needs the profile name saved first
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
    if (!STUB_AUTH) {
      await pushProfile(state.user, { name })
    }
    state.profile = { ...(state.profile || {}), id: state.user, name }
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
  scheduleAutosave()
})

document.querySelectorAll('.mood-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!state.canEdit) return
    state.selectedMood = state.selectedMood === btn.dataset.mood ? null : btn.dataset.mood
    renderMoodButtons()
    scheduleAutosave()
  })
})

// --- Formatting toolbar ---

function applyFormat(cmd) {
  $('canvas').focus()
  document.execCommand(cmd, false, null)
  updateToolbarState()
}

function applyLink() {
  $('canvas').focus()
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return  // need a selection to linkify
  let url = window.prompt('Link to where? (paste a URL)')
  if (!url) return
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  document.execCommand('createLink', false, url)
}

$('fmt-bold').addEventListener('click', () => applyFormat('bold'))
$('fmt-italic').addEventListener('click', () => applyFormat('italic'))
$('fmt-link').addEventListener('click', applyLink)

// Reflect bold/italic state of the cursor position in the toolbar
function updateToolbarState() {
  $('fmt-bold').classList.toggle('active', document.queryCommandState('bold'))
  $('fmt-italic').classList.toggle('active', document.queryCommandState('italic'))
}
document.addEventListener('selectionchange', () => {
  if (document.activeElement === $('canvas')) updateToolbarState()
})

// ⌘B / ⌘I are native in contenteditable; add ⌘K for links
$('canvas').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    applyLink()
  }
})

$('photo-add-btn').addEventListener('click', () => $('photo-file-input').click())

$('photo-file-input').addEventListener('change', e => {
  addPhotoFiles(e.target.files)
  e.target.value = ''
})

// Photo strip: ✕ removes (while editable), clicking a thumb previews
$('photo-strip').addEventListener('click', async e => {
  const thumb = e.target.closest('.photo-thumb')
  if (!thumb || thumb.classList.contains('uploading')) return

  const url = thumb.dataset.url
  if (e.target.closest('.photo-remove-btn')) {
    if (!state.canEdit || !state.todayPrompt) return
    try {
      const urls = STUB_DATA
        ? stubRemovePhoto(state.todayPrompt.id, url)
        : await apiRemovePhoto(state.todayPrompt.id, url)
      applyPhotoUrls(urls)
      renderPhotoStrip()
    } catch (err) {
      console.error('Photo remove failed:', err)
      setSaveStatus('Could not remove photo', 'error')
    }
    return
  }

  // Lightbox preview
  $('lightbox-img').src = url
  show($('photo-lightbox'))
})

$('photo-lightbox').addEventListener('click', () => {
  hide($('photo-lightbox'))
  $('lightbox-img').src = ''
})

// Drag & drop photos onto the writing area
const mainArea = document.querySelector('.main-area')
;['dragover', 'dragenter'].forEach(ev =>
  mainArea.addEventListener(ev, e => { e.preventDefault() }))
mainArea.addEventListener('drop', e => {
  e.preventDefault()
  if (e.dataTransfer?.files?.length) addPhotoFiles(e.dataTransfer.files)
})

// Paste an image (e.g. a screenshot) straight into the canvas
$('canvas').addEventListener('paste', e => {
  const files = Array.from(e.clipboardData?.items || [])
    .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
    .map(it => it.getAsFile())
  if (files.length) {
    e.preventDefault()
    addPhotoFiles(files)
  }
})

// --- Done! flow: confirm modal → finalize → lock ---

$('done-btn').addEventListener('click', () => {
  if (!state.canEdit || state.saving) return
  if (!getCanvasText()) { $('canvas').focus(); return }
  show($('confirm-modal'))
  $('confirm-cancel').focus()
})

$('confirm-cancel').addEventListener('click', () => hide($('confirm-modal')))

$('confirm-modal').addEventListener('click', e => {
  if (e.target === $('confirm-modal')) hide($('confirm-modal'))
})

$('confirm-done').addEventListener('click', async () => {
  hide($('confirm-modal'))
  if (!state.canEdit || !state.todayPrompt || state.saving) return

  // Cancel any pending autosave — the final write supersedes it
  clearTimeout(autosaveTimer)

  state.saving = true
  const btn    = $('done-btn')
  btn.disabled = true; btn.textContent = 'Posting…'
  setSaveStatus('Saving…')

  try {
    const entryMd = getCanvasMd()
    if (STUB_DATA) {
      stubPostEntry(state.todayPrompt.id, entryMd, state.selectedMood, true)
    } else {
      await apiPostEntry(state.todayPrompt.id, entryMd, state.selectedMood, true)
    }
    state.entries = STUB_DATA ? stubLoadEntries() : await apiLoadEntries()
    renderApp()  // locks the editor, shows the done note
  } catch (err) {
    console.error('Finalize error:', err)
    setSaveStatus('Could not finish — try again', 'error')
  } finally {
    state.saving = false
    btn.disabled = false
    btn.innerHTML = '<i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Post entry'
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

// Mobile trophy tiles → open the entry modal (gap tiles have no data-id)
function openTileEntry(target) {
  const tile = target.closest('.mobile-trophy[data-id]')
  if (!tile) return
  const entry = state.entries.find(en => en.id === parseInt(tile.dataset.id, 10))
  if (entry) openModal(entry)
}
$('mobile-trophy-grid').addEventListener('click', e => openTileEntry(e.target))
$('mobile-trophy-grid').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTileEntry(e.target) }
})

function openModal(entry) {
  const prompt = state.prompts.find(p => p.id === entry.prompt_id)
  $('modal-prompt').textContent = prompt?.body || ''
  $('modal-date').textContent   = formatDate(entry.created_at)
  $('modal-body').innerHTML     = mdToHtml(entry.entry_md)

  const emoji = MOOD_EMOJI[entry.mood] || ''
  if (entry.mood) {
    $('modal-mood').textContent   = `${emoji} ${entry.mood}`
    $('modal-mood').style.display = ''
  } else {
    $('modal-mood').style.display = 'none'
  }

  const photos = entry.photo_urls || []
  const grid   = $('modal-photos')
  grid.innerHTML = ''
  grid.style.display = photos.length ? 'grid' : 'none'
  photos.forEach(url => {
    const img = document.createElement('img')
    img.src = url; img.alt = 'Journal photo'
    grid.appendChild(img)
  })

  show($('entry-modal'))
  $('modal-close').focus()
}

$('modal-close').addEventListener('click', () => hide($('entry-modal')))
$('entry-modal').addEventListener('click', e => { if (e.target === $('entry-modal')) hide($('entry-modal')) })
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hide($('entry-modal'))
    hide($('photo-lightbox'))
    hide($('confirm-modal'))
  }
})

// Photos inside the past-entry modal open the lightbox too
$('modal-photos').addEventListener('click', e => {
  const img = e.target.closest('img')
  if (!img) return
  $('lightbox-img').src = img.src
  show($('photo-lightbox'))
})

// ============================================================
// INIT
// ============================================================

async function loadAndRenderApp() {
  state.prompts     = await loadPrompts()
  state.todayPrompt = getActivePrompt(state.prompts)
  state.entries     = STUB_DATA ? stubLoadEntries() : await apiLoadEntries()
  renderApp()
}

async function handleAuthenticated() {
  hide($('auth-screen'))
  try {
    // Profile lives on the REGISTERED_FOR relationship in the graph
    // (biz_profile in the /userprofile/ response), localStorage fallback
    const vars = (!STUB_AUTH && typeof userProfile !== 'undefined' && userProfile?.biz_profile) || {}
    state.profile = {
      id:       state.user,
      name:     vars.name || localStorage.getItem('sp_user_name') || '',
      birthday: vars.birthday || null,
    }

    if (!state.profile.name || state.profile.name === 'Journaler') {
      show($('profile-setup-screen'))
      $('name-input').focus()
      return
    }

    await loadAndRenderApp()
    showMainScreen()
  } catch (err) {
    // A render/data error here is NOT an auth failure — don't bounce to the
    // sign-in screen (that's misleading). Surface the real reason instead.
    console.error('Could not load the app after sign-in:', err)
    alert('Something went wrong loading Summer Pages:\n\n' + (err && err.message) +
          '\n\n(If you just edited prompts.json, check it for a JSON typo.)')
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
  // device cookie, and fetches the user profile if it's valid.
  // Never let an API failure leave the page blank — fall through
  // to the auth screen on any error.
  try {
    await j2AuthInit(window.APP_CONFIG.j2BizId, window.APP_CONFIG.j2AppToken)
  } catch (err) {
    console.error('j2AuthInit failed:', err)
  }

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

init().catch(err => {
  console.error('Init failed:', err)
  showAuthScreen()
})
