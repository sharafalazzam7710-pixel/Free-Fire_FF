const KEYS = {
  teams: 'clashSquadTeamsV3',
  matches: 'clashSquadMatchesV3',
  settings: 'clashSquadSettingsV1',
  winners: 'clashSquadWinnersV1',
  session: 'clashSquadAdminSessionV1',
  registeredTeam: 'clashSquadRegisteredTeamV1',
};

const DEFAULT_SETTINGS = {
  title: 'بطولة فري فاير كلاش سكواد',
  description: 'سجّل فريقك ونافس أفضل لاعبي Free Fire في بطولة عربية منظمة وسريعة.',
  rules: 'الفريق يتكون من لاعبين أساسيين ولاعب احتياط اختياري.\nيجب التأكد من صحة IDs قبل إرسال طلب التسجيل.\nالالتزام بموعد المواجهة شرط أساسي للاستمرار في البطولة.',
  registration: 'open',
  started: false,
  finished: false,
  maintenance: false,
  startDate: '',
  startTime: '',
};

// لا يتم حفظ كلمة المرور نفسها؛ تتم مقارنة بصمتها فقط.
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD_HASH = 'ad861d70';
const SESSION_DURATION = 8 * 60 * 60 * 1000;

const legacyTeams = read('clashSquadTeamsV2', []);
const legacyMatches = read('clashSquadMatchesV2', []);
const storedTeams = read(KEYS.teams, null);
const storedMatches = read(KEYS.matches, null);
let teams = (Array.isArray(storedTeams)
  ? storedTeams
  : legacyTeams).map(normalizeTeam);
let matches = (Array.isArray(storedMatches)
  ? storedMatches
  : legacyMatches).map((match) => ({
    ...match,
    status: match.status || 'scheduled',
    scoreOne: match.scoreOne ?? '',
    scoreTwo: match.scoreTwo ?? '',
  }));
let winners = read(KEYS.winners, []);
let settings = { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) };
let loggedIn = hasValidSession();
let serverAuthenticated = false;
// GitHub Pages لا يشغّل server.js؛ استخدم الدخول المحلي هناك، بينما
// يبقى التحقق من الخادم فعالًا عند تشغيل npm start.
let serverMode = window.location.protocol !== 'file:' && !/\.github\.io$/i.test(window.location.hostname);
let registeredTeam = read(KEYS.registeredTeam, null);
let editingMatchId = null;
let editingTeamId = null;
let pendingMatchAction = null;
let passwordOnlyMode = false;

const $ = (id) => document.getElementById(id);
const toast = $('toast');
const modal = $('adminModal');
const loginView = $('loginView');
const dashboardView = $('dashboardView');

function read(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function save() {
  localStorage.setItem(KEYS.teams, JSON.stringify(teams));
  localStorage.setItem(KEYS.matches, JSON.stringify(matches));
  localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  localStorage.setItem(KEYS.winners, JSON.stringify(winners));
  if (serverMode && serverAuthenticated) {
    fetch('/api/state', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teams, matches, winners, settings }),
    }).catch(() => showToast('تعذر حفظ التغيير على الخادم'));
  }
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = {};
  try { data = await response.json(); } catch {}
  return { response, data };
}

function applyServerState(data) {
  if (Array.isArray(data.teams)) teams = data.teams.map(normalizeTeam);
  if (Array.isArray(data.matches)) {
    matches = data.matches.map((match) => ({
      ...match,
      status: match.status || 'scheduled',
      scoreOne: match.scoreOne ?? '',
      scoreTwo: match.scoreTwo ?? '',
    }));
  }
  if (Array.isArray(data.winners)) winners = data.winners;
  settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  serverAuthenticated = Boolean(data.authenticated);
  loggedIn = serverAuthenticated || loggedIn;
  localStorage.setItem(KEYS.teams, JSON.stringify(teams));
  localStorage.setItem(KEYS.matches, JSON.stringify(matches));
  localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  localStorage.setItem(KEYS.winners, JSON.stringify(winners));
}

function setMaintenanceVisibility(isVisible) {
  $('maintenanceOverlay').classList.toggle('hidden', !isVisible);
  document.querySelector('.site-header').classList.toggle('hidden', isVisible);
  document.querySelector('main').classList.toggle('hidden', isVisible);
  document.querySelector('footer').classList.toggle('hidden', isVisible);
}

function showRegistrationPage() {
  document.querySelectorAll('main > section').forEach((section) => {
    section.classList.toggle('hidden', section.id !== 'register');
  });
  $('register').scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => $('registrationTeamName').focus(), 450);
}

function showHomepage() {
  document.querySelectorAll('main > section').forEach((section) => {
    section.classList.remove('hidden');
  });
  $('register').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function syncFromServer() {
  if (!serverMode) return;
  try {
    const { response, data } = await apiRequest('/api/state', { method: 'GET' });
    if (response.status === 503 && data.maintenance) {
      setMaintenanceVisibility(true);
      return;
    }
    if (!response.ok) return;
    applyServerState(data);
    setMaintenanceVisibility(false);
    renderAll();
  } catch {
    showToast('تعذر الاتصال بالخادم، تم عرض آخر نسخة محفوظة');
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char]));
}

function parseLegacyPlayer(value) {
  const text = String(value || '').trim();
  const parts = text.split(/\s+[—-]\s+/);
  return { name: (parts[0] || text || 'لاعب').trim(), id: (parts[1] || '').trim() };
}

function normalizeTeam(team) {
  const oldPlayers = [
    team.players?.[0],
    team.players?.[1],
    team.substitute && (typeof team.substitute === 'object' ? team.substitute : parseLegacyPlayer(team.substitute)),
  ].filter(Boolean);
  const players = oldPlayers.length
    ? oldPlayers.map((player) => typeof player === 'object' ? { name: String(player.name || ''), id: String(player.id || '') } : parseLegacyPlayer(player))
    : [parseLegacyPlayer(team.captain), parseLegacyPlayer(team.playerTwo)];
  return {
    id: team.id || makeId(),
    name: team.name || 'فريق بدون اسم',
    owner: team.owner || team.captain || '',
    ...(team.registrationToken ? { registrationToken: team.registrationToken } : {}),
    players: players.filter((player) => player.name || player.id),
    status: team.status || 'approved',
    wins: Number(team.wins || 0),
    losses: Number(team.losses || 0),
    draws: Number(team.draws || 0),
    points: Number(team.points || 0),
  };
}

function makeId() {
  return window.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function credentialHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function hasValidSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(KEYS.session) || 'null');
    return Boolean(session?.expiresAt && session.expiresAt > Date.now());
  } catch {
    return false;
  }
}

function startSession() {
  sessionStorage.setItem(KEYS.session, JSON.stringify({
    authenticated: true,
    expiresAt: Date.now() + SESSION_DURATION,
  }));
}

function endSession() {
  sessionStorage.removeItem(KEYS.session);
}

function getTeam(id) {
  return teams.find((team) => team.id === id);
}

function formatDate(value) {
  if (!value) return 'بدون تاريخ';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? 'بدون تاريخ'
    : new Intl.DateTimeFormat('ar-JO', { day: 'numeric', month: 'long' }).format(date);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(`2026-01-01T${value}`);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('ar-JO', { hour: 'numeric', minute: '2-digit' }).format(date);
}

function statusLabel(status) {
  return {
    scheduled: 'مجدولة',
    live: 'مباشرة',
    completed: 'منتهية',
    cancelled: 'ملغاة',
    withdrawn: 'انسحاب',
  }[status] || 'مجدولة';
}

function matchSort(a, b) {
  return `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`);
}

function renderAll() {
  $('championshipTitle').innerHTML = escapeHtml(settings.title).replace(/\n/g, '<br />');
  $('championshipDescription').textContent = settings.description;
  $('teamCount').textContent = teams.length;
  $('playerCount').textContent = teams.length * 2;
  $('matchCount').textContent = matches.length;
  $('winnerCount').textContent = winners.length;
  syncRegistrationState();
  renderPublicSchedule();
  renderNextMatch();
  renderStandings();
  renderAdminLists();
  renderRegistrations();
  renderWinners();
  renderDashboardStats();
  renderRules();
  populateTeamSelects();
  populateWinnerSelect();
  fillSettingsForm();
  const maintenance = Boolean(settings.maintenance);
  $('maintenanceStatusText').textContent = maintenance
    ? 'الصيانة مفعلة. الأعضاء يرون صفحة الصيانة فقط، والمشرف يستطيع إلغاءها من هنا.'
    : 'الصيانة غير مفعلة. عند تفعيلها لن يرى الأعضاء إلا رسالة الموقع تحت الصيانة، بينما يبقى المشرف قادرًا على الدخول.';
  $('toggleMaintenance').textContent = maintenance ? 'إلغاء الصيانة' : 'تفعيل الصيانة';
}

function renderRules() {
  const container = $('publicRules');
  if (!container) return;
  const rules = String(settings.rules || DEFAULT_SETTINGS.rules).split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean);
  container.innerHTML = rules.length
    ? rules.map((rule, index) => `<div><span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(rule)}</p></div>`).join('')
    : '<div class="empty-state">لم تتم إضافة قوانين بعد.</div>';
}

function syncRegistrationState() {
  const isStarted = Boolean(settings.started);
  const isFinished = Boolean(settings.finished);
  const isOpen = settings.registration === 'open';
  const ownTeam = registeredTeam && teams.find((team) => team.id === registeredTeam.id);
  if (registeredTeam && !ownTeam) {
    registeredTeam = null;
    localStorage.removeItem(KEYS.registeredTeam);
  }
  $('registrationAlready').classList.toggle('hidden', !ownTeam || isStarted || isFinished);
  $('registrationPanel').classList.toggle('hidden', Boolean(ownTeam) || isStarted || isFinished || !isOpen);
  $('registrationClosed').classList.toggle('hidden', Boolean(ownTeam) || isStarted || isFinished || isOpen);
  $('tournamentStarted').classList.toggle('hidden', Boolean(ownTeam) || (!isStarted && !isFinished));
  if (isFinished) {
    $('tournamentStarted').querySelector('h3').textContent = 'انتهت البطولة';
    $('tournamentStarted').querySelector('p').textContent = 'تم إغلاق التسجيل. تظهر النتائج النهائية في قسم نتائج البطولة.';
  } else {
    $('tournamentStarted').querySelector('h3').textContent = 'بدأت البطولة';
    $('tournamentStarted').querySelector('p').textContent = 'انتهت فترة التسجيل وبدأت جولات البطولة. تابع المباريات بالأسفل.';
  }
  if (ownTeam) $('registrationAlreadyDetails').textContent = `الفريق: ${ownTeam.name} • الحالة: ${ownTeam.status === 'approved' ? 'مقبول' : 'قيد المراجعة'}`;
}

function renderPublicSchedule() {
  const list = $('publicSchedule');
  if (!matches.length) {
    list.innerHTML = '<div class="empty-state">لا توجد مباريات مضافة حاليًا.</div>';
    return;
  }

  list.innerHTML = matches.slice().sort((a, b) => Number(a.number || 0) - Number(b.number || 0)).map((match, index) => {
    const first = getTeam(match.teamOneId);
    const second = getTeam(match.teamTwoId);
    const score = match.scoreOne !== '' && match.scoreTwo !== '' && match.scoreOne != null && match.scoreTwo != null
      ? `${escapeHtml(match.scoreOne)} : ${escapeHtml(match.scoreTwo)}`
      : '—';
    return `<div class="schedule-row">
      <span class="round">${String(match.number || index + 1).padStart(2, '0')}</span>
      <div><b>${escapeHtml(first?.name || match.teamOneName || 'بانتظار التحديد')} <em>ضد</em> ${escapeHtml(second?.name || match.teamTwoName || 'بانتظار التحديد')}</b>
      <small>${escapeHtml(match.round)} • ${escapeHtml(match.phase || 'الدوري')} • خريطة ${escapeHtml(match.map || '—')}</small></div>
      <span class="match-status ${escapeHtml(match.status || 'scheduled')}">${statusLabel(match.status)}</span>
      <div class="schedule-score">${score}<br /><small>${escapeHtml(formatDate(match.date))} • ${escapeHtml(formatTime(match.time))}</small></div>
    </div>`;
  }).join('');
}

function renderNextMatch() {
  const next = matches
    .filter((match) => match.status !== 'completed' && match.status !== 'cancelled')
    .slice()
    .sort(matchSort)[0];
  if (!next) {
    $('nextRound').textContent = 'لم تُضف بعد';
    $('nextDate').textContent = 'التاريخ والوقت يظهران هنا';
    $('nextTime').textContent = '—';
    $('nextMatch').innerHTML = '<div class="empty-next"><span>⚔️</span><b>لم تتم إضافة مواجهات</b><small>تظهر هنا أقرب مواجهة</small></div>';
    return;
  }
  const first = getTeam(next.teamOneId);
  const second = getTeam(next.teamTwoId);
  $('nextRound').textContent = next.round || 'المواجهة القادمة';
  $('nextDate').textContent = formatDate(next.date);
  $('nextTime').textContent = formatTime(next.time);
  $('nextMatch').innerHTML = `<div class="team"><div class="team-logo red">🔥</div><b>${escapeHtml(first?.name || '—')}</b><small>الفريق الأول</small></div>
    <div class="vs">VS</div>
    <div class="team"><div class="team-logo blue">⚡</div><b>${escapeHtml(second?.name || '—')}</b><small>الفريق الثاني</small></div>`;
}

function calculateStandings() {
  const table = new Map(teams.map((team) => [team.id, {
    team,
    played: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    points: 0,
  }]));
  matches.filter((match) => ['completed', 'withdrawn'].includes(match.status)).forEach((match) => {
    const first = table.get(match.teamOneId);
    const second = table.get(match.teamTwoId);
    if (!first || !second || !match.winnerId) return;
    first.played += 1;
    second.played += 1;
    const winner = table.get(match.winnerId);
    const loser = match.winnerId === match.teamOneId ? second : first;
    if (!winner || !loser) return;
    winner.wins += 1;
    winner.points += 3;
    loser.losses += 1;
  });
  return [...table.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses || a.team.name.localeCompare(b.team.name));
}

function renderStandings() {
  const rows = calculateStandings();
  $('publicPhase').textContent = getCurrentPhaseLabel();
  $('publicStandings').innerHTML = rows.length ? rows.map((row, index) => `<tr>
    <td>${index + 1}</td><td><b>${escapeHtml(row.team.name)}</b></td><td>${row.played}</td><td>${row.wins}</td><td>${row.losses}</td><td><b>${row.points}</b></td>
  </tr>`).join('') : '<tr><td colspan="6" class="empty-table">لا توجد فرق مسجلة بعد.</td></tr>';
}

function getCurrentPhaseLabel() {
  const active = matches.find((match) => !['completed', 'withdrawn', 'cancelled'].includes(match.status));
  if (active) return active.phaseLabel || active.phase || 'الدوري';
  const last = matches[matches.length - 1];
  return last?.phaseLabel || last?.phase || 'لم تبدأ المباريات';
}

function populateWinnerSelect() {
  const select = $('winnerTeamId');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">اختر الفريق</option>' + teams.map((team) => `<option value="${team.id}">${escapeHtml(team.name)}</option>`).join('');
  select.value = teams.some((team) => team.id === current) ? current : '';
}

function populateTeamSelects() {
  ['teamOne', 'teamTwo'].forEach((id) => {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = teams.length
      ? '<option value="">اختر الفريق</option>' + teams.map((team) => `<option value="${team.id}">${escapeHtml(team.name)}</option>`).join('')
      : '<option value="">أضف الفرق أولًا</option>';
    select.value = teams.some((team) => team.id === current) ? current : '';
  });
}

function renderAdminLists() {
  $('adminTeamTotal').textContent = teams.length;
  $('adminMatchTotal').textContent = matches.length;
  $('adminTeamsList').innerHTML = teams.length ? teams.map((team) => `<div class="admin-item">
    <div><b>${escapeHtml(team.name)}</b><small>صاحب التسجيل: ${escapeHtml(team.owner)} • ${team.players.length} لاعبين</small><small>${team.players.map((player) => `${escapeHtml(player.name)} — ${escapeHtml(player.id)}`).join(' • ')}</small></div>
    <div class="admin-item-actions"><button class="approve-button" data-edit-team="${team.id}" type="button">تعديل</button><button class="delete-button" data-delete-team="${team.id}" type="button">حذف</button></div>
  </div>`).join('') : '<div class="empty-state">لا توجد فرق</div>';
  $('adminMatchesList').innerHTML = matches.length ? matches.slice().sort((a, b) => Number(a.number || 0) - Number(b.number || 0)).map((match) => `<div class="admin-item">
    <div><b>م${String(match.number || '').padStart(2, '0')} • ${escapeHtml(getTeam(match.teamOneId)?.name || match.teamOneName || 'بانتظار التحديد')} ضد ${escapeHtml(getTeam(match.teamTwoId)?.name || match.teamTwoName || 'بانتظار التحديد')}</b>
    <small>${escapeHtml(match.round)} • ${escapeHtml(match.phaseLabel || match.phase || 'الدوري')} • ${escapeHtml(formatDate(match.date))} ${escapeHtml(formatTime(match.time))} • ${escapeHtml(statusLabel(match.status))}${match.winnerId ? ` • الفائز: ${escapeHtml(getTeam(match.winnerId)?.name || '—')}` : ''}</small></div>
    <div class="admin-item-actions">${!['completed', 'withdrawn', 'cancelled'].includes(match.status) ? `<button class="approve-button" data-win-match="${match.id}" type="button">فوز</button><button class="delete-button" data-withdraw-match="${match.id}" type="button">انسحاب</button>` : ''}<button class="approve-button" data-edit-match="${match.id}" type="button">تعديل</button><button class="delete-button" data-delete-match="${match.id}" type="button">حذف</button></div>
  </div>`).join('') : '<div class="empty-state">لا توجد مواجهات</div>';
}

function renderRegistrations() {
  $('registrationTotal').textContent = teams.length;
  $('registrationList').innerHTML = teams.length ? teams.map((team) => `<div class="admin-item">
    <div><b>${escapeHtml(team.name)}</b><small>صاحب التسجيل: ${escapeHtml(team.owner)} • ${team.players.length} لاعبين${team.status === 'approved' ? ' • مقبول' : ' • قيد المراجعة'}</small></div>
    <div class="admin-item-actions">${team.status !== 'approved' ? `<button class="approve-button" data-approve-team="${team.id}" type="button">قبول</button>` : '<small>تم القبول</small>'}<button class="delete-button" data-delete-team="${team.id}" type="button">حذف</button></div>
  </div>`).join('') : '<div class="empty-state">لا توجد طلبات تسجيل</div>';
}

function renderWinners() {
  $('adminWinnerTotal').textContent = winners.length;
  $('winnersList').innerHTML = winners.length ? winners.map((winner) => `<div class="admin-item">
    <div><b>${winner.place === 1 ? '🏆' : winner.place === 2 ? '🥈' : '🥉'} ${escapeHtml(winner.teamName || getTeam(winner.teamId)?.name || '—')}</b><small>المركز ${escapeHtml(winner.place)}</small></div>
    <button class="delete-button" data-delete-winner="${winner.id}" type="button">حذف</button>
  </div>`).join('') : '<div class="empty-state">لم تتم إضافة فائزين بعد</div>';
  $('publicWinners').innerHTML = winners.length ? winners.slice().sort((a, b) => Number(a.place) - Number(b.place)).map((winner) => `<div class="winner-public-card">
    <strong>${winner.place === 1 ? '🏆' : winner.place === 2 ? '🥈' : '🥉'}</strong>
    <b>${escapeHtml(winner.teamName || getTeam(winner.teamId)?.name || '—')}</b><small>المركز ${escapeHtml(winner.place)}</small>
  </div>`).join('') : '<div class="empty-state">تظهر المراكز النهائية بعد انتهاء البطولة.</div>';
}

function renderDashboardStats() {
  const completed = matches.filter((match) => match.status === 'completed').length;
  const live = matches.filter((match) => match.status === 'live').length;
  $('dashboardStats').innerHTML = [
    ['الفرق المسجلة', teams.length],
    ['إجمالي المواجهات', matches.length],
    ['المواجهات المنتهية', completed],
    ['المواجهات المباشرة', live],
    ['طلبات قيد المراجعة', teams.filter((team) => team.status !== 'approved').length],
    ['الفائزون', winners.length],
  ].map(([label, value]) => `<div class="dashboard-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
}

function fillSettingsForm() {
  if (!$('settingsTitle')) return;
  $('settingsTitle').value = settings.title;
  $('settingsDescription').value = settings.description;
  $('settingsRules').value = settings.rules || DEFAULT_SETTINGS.rules;
  $('settingsRegistration').value = settings.registration;
  $('settingsStarted').checked = Boolean(settings.started);
  $('settingsFinished').checked = Boolean(settings.finished);
  $('settingsStartDate').value = settings.startDate || '';
  $('settingsStartTime').value = settings.startTime || '';
}

function renderTeamPlayerRows(players = []) {
  const editor = $('teamPlayersEditor');
  const rows = players.length ? players : [{ name: '', id: '' }, { name: '', id: '' }];
  editor.innerHTML = rows.map((player, index) => `<div class="player-row" data-player-row>
    <div class="field"><label>اسم اللاعب ${index + 1}</label><input data-player-name value="${escapeHtml(player.name)}" required /></div>
    <div class="field"><label>ID اللاعب</label><input data-player-id value="${escapeHtml(player.id)}" required inputmode="numeric" /></div>
    <button class="remove-player" data-remove-player type="button">حذف اللاعب</button>
  </div>`).join('');
}

function renderRegistrationPlayers(players = []) {
  const editor = $('registrationPlayers');
  const rows = players.length >= 2 ? players : [{ name: '', id: '' }, { name: '', id: '' }];
  editor.innerHTML = rows.slice(0, 4).map((player, index) => {
    const label = index === 0 ? 'اللاعب الأول / الكابتن' : `اللاعب ${index + 1}`;
    const type = index < 2 ? 'أساسي' : 'إضافي';
    return `<div class="player-block registration-player" data-registration-player>
      <div class="player-heading"><b>${label}</b><span>${type}</span></div>
      <div class="two-fields"><div class="field"><label>اسم اللاعب</label><input data-registration-player-name value="${escapeHtml(player.name)}" required /></div>
      <div class="field"><label>ID اللاعب</label><input data-registration-player-id value="${escapeHtml(player.id)}" required inputmode="numeric" /></div></div>
      ${index > 1 ? '<button class="remove-registration-player" data-remove-registration-player type="button">حذف اللاعب</button>' : ''}
    </div>`;
  }).join('');
  $('addRegistrationPlayer').disabled = rows.length >= 4;
  $('addRegistrationPlayer').classList.toggle('hidden', rows.length >= 4);
}

function getRegistrationPlayers() {
  return [...document.querySelectorAll('[data-registration-player]')].map((row) => ({
    name: row.querySelector('[data-registration-player-name]').value.trim(),
    id: String(row.querySelector('[data-registration-player-id]').value).trim(),
  }));
}

function addRegistrationPlayer() {
  const players = getRegistrationPlayers();
  if (players.length >= 4) return;
  renderRegistrationPlayers([...players, { name: '', id: '' }]);
  const rows = document.querySelectorAll('[data-registration-player]');
  rows[rows.length - 1]?.querySelector('[data-registration-player-name]')?.focus();
}

function resetTeamEditor() {
  editingTeamId = null;
  $('adminTeamForm').reset();
  renderTeamPlayerRows();
  $('saveTeamButton').textContent = 'إضافة الفريق';
  $('cancelTeamEdit').classList.add('hidden');
}

function editTeam(teamId) {
  const team = getTeam(teamId);
  if (!team) return;
  editingTeamId = team.id;
  showAdminSection('teamsSection');
  $('adminTeamName').value = team.name;
  $('adminOwner').value = team.owner;
  renderTeamPlayerRows(team.players);
  $('saveTeamButton').textContent = 'تحديث الفريق';
  $('cancelTeamEdit').classList.remove('hidden');
}

function addPlayerRow() {
  const rows = [...document.querySelectorAll('[data-player-row]')].map((row) => ({
    name: row.querySelector('[data-player-name]').value,
    id: row.querySelector('[data-player-id]').value,
  }));
  rows.push({ name: '', id: '' });
  renderTeamPlayerRows(rows);
}

function openAdmin(passwordOnly = false) {
  passwordOnlyMode = passwordOnly;
  if (passwordOnly && settings.maintenance) setMaintenanceVisibility(false);
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  if (loggedIn && hasValidSession()) {
    loginView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    showDashboardHome();
  } else {
    loggedIn = false;
    loginView.classList.remove('hidden');
    dashboardView.classList.add('hidden');
    $('loginMessage').textContent = '';
    $('adminPassword').value = '';
    $('adminUserField').classList.toggle('hidden', passwordOnly);
    $('adminUser').value = passwordOnly ? ADMIN_USERNAME : '';
    setTimeout(() => $('adminUser').focus(), 0);
    if (passwordOnly) setTimeout(() => $('adminPassword').focus(), 0);
  }
}

function closeAdmin() {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  passwordOnlyMode = false;
  $('adminUserField').classList.remove('hidden');
  if (settings.maintenance && !loggedIn) setMaintenanceVisibility(true);
}

function showDashboardHome() {
  $('dashboardHome').classList.remove('hidden');
  document.querySelectorAll('.admin-section').forEach((section) => section.classList.add('hidden'));
}

function showAdminSection(sectionId) {
  $('dashboardHome').classList.add('hidden');
  document.querySelectorAll('.admin-section').forEach((section) => section.classList.add('hidden'));
  $(sectionId).classList.remove('hidden');
}

function resetMatchEditor() {
  editingMatchId = null;
  $('adminMatchForm').reset();
  $('adminMatchForm').querySelector('button[type="submit"]').textContent = 'حفظ المواجهة';
  $('matchEditorTitle').textContent = 'إضافة مواجهة يدوية';
}

const PHASE_LABELS = {
  league: 'الدوري',
  playoffs: 'التصفيات',
  semi_final: 'نصف النهائي',
  final: 'النهائي',
  third_place: 'مباراة المركز الثالث',
};

function isResolved(match) {
  return ['completed', 'withdrawn'].includes(match.status);
}

function localDateTime(date, time, minutesToAdd) {
  const value = new Date(`${date}T${time}:00`);
  value.setMinutes(value.getMinutes() + minutesToAdd);
  const pad = (number) => String(number).padStart(2, '0');
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  };
}

function nextScheduleStart() {
  const last = matches.slice().sort(matchSort).pop();
  return last ? localDateTime(last.date, last.time, 15) : null;
}

function createStageMatches(pairs, phase, round, startDate, startTime, forcedNumber) {
  const start = startDate && startTime ? { date: startDate, time: startTime } : nextScheduleStart();
  if (!start) return [];
  const nextNumber = forcedNumber || matches.reduce((max, match) => Math.max(max, Number(match.number || 0)), 0) + 1;
  return pairs.map((pair, index) => {
    const slot = localDateTime(start.date, start.time, index * 15);
    return {
      id: makeId(),
      number: nextNumber + index,
      round,
      phase,
      phaseLabel: PHASE_LABELS[phase],
      teamOneId: pair[0],
      teamTwoId: pair[1],
      date: slot.date,
      time: slot.time,
      map: 'برمودا',
      status: 'scheduled',
      scoreOne: '',
      scoreTwo: '',
    };
  });
}

function generateInitialSchedule(date, time) {
  const participatingTeams = teams.filter((team) => team.status === 'approved');
  if (participatingTeams.length < 2) {
    showToast('أضف فريقين على الأقل لإنشاء المواجهات');
    return;
  }
  if (matches.length && !window.confirm('سيتم استبدال جدول المواجهات الحالي بجدول تلقائي جديد. هل أنت متأكد؟')) return;
  const pairs = [];
  for (let first = 0; first < participatingTeams.length; first += 1) {
    for (let second = first + 1; second < participatingTeams.length; second += 1) {
      pairs.push([participatingTeams[first].id, participatingTeams[second].id]);
    }
  }
  matches = createStageMatches(pairs, 'league', 'مرحلة الدوري', date, time);
  winners = [];
  syncTeamStats();
  save();
  renderAll();
  showToast(`تم إنشاء ${matches.length} مباراة بفاصل 15 دقيقة`);
}

function currentUnresolvedPhase() {
  const order = ['league', 'playoffs', 'semi_final', 'third_place', 'final'];
  return order.find((phase) => {
    const phaseMatches = matches.filter((match) => match.phase === phase);
    return phaseMatches.length && phaseMatches.some((match) => !isResolved(match));
  });
}

function allPhaseMatchesResolved(phase) {
  const phaseMatches = matches.filter((match) => match.phase === phase);
  return phaseMatches.length > 0 && phaseMatches.every(isResolved);
}

function winnersOfPhase(phase) {
  return matches.filter((match) => match.phase === phase && isResolved(match) && match.winnerId).map((match) => match.winnerId);
}

function losersOfPhase(phase) {
  return matches.filter((match) => match.phase === phase && isResolved(match) && match.winnerId).map((match) => match.winnerId === match.teamOneId ? match.teamTwoId : match.teamOneId);
}

function advanceTournamentProgression() {
  const phase = currentUnresolvedPhase();
  if (phase) return;
  const phases = ['league', 'playoffs', 'semi_final', 'third_place', 'final'];
  const completedPhase = phases.slice().reverse().find((item) => allPhaseMatchesResolved(item));
  if (!completedPhase) return;

  const standings = calculateStandings().map((row) => row.team.id);
  const last = matches.slice().sort(matchSort).pop();
  const start = last ? localDateTime(last.date, last.time, 15) : null;
  let nextMatches = [];

  if (completedPhase === 'league') {
    if (teams.length >= 8) {
      const qualified = standings.slice(0, 8);
      nextMatches = createStageMatches([[qualified[0], qualified[7]], [qualified[1], qualified[6]], [qualified[2], qualified[5]], [qualified[3], qualified[4]]], 'playoffs', 'التصفيات', start?.date, start?.time);
    } else if (teams.length >= 4) {
      const qualified = standings.slice(0, 4);
      nextMatches = createStageMatches([[qualified[0], qualified[3]], [qualified[1], qualified[2]]], 'semi_final', 'نصف النهائي', start?.date, start?.time);
    } else if (teams.length === 2) {
      nextMatches = createStageMatches([[standings[0], standings[1]]], 'final', 'النهائي', start?.date, start?.time);
    }
  } else if (completedPhase === 'playoffs') {
    const qualified = winnersOfPhase('playoffs');
    nextMatches = createStageMatches([[qualified[0], qualified[3]], [qualified[1], qualified[2]]], 'semi_final', 'نصف النهائي', start?.date, start?.time);
  } else if (completedPhase === 'semi_final') {
    const finalists = winnersOfPhase('semi_final');
    const thirdPlace = losersOfPhase('semi_final');
    const nextNumber = matches.reduce((max, match) => Math.max(max, Number(match.number || 0)), 0) + 1;
    const thirdStart = start ? localDateTime(start.date, start.time, 15) : null;
    const finalMatches = createStageMatches([[finalists[0], finalists[1]]], 'final', 'النهائي', start?.date, start?.time, nextNumber);
    const thirdMatches = createStageMatches([[thirdPlace[0], thirdPlace[1]]], 'third_place', 'مباراة المركز الثالث', thirdStart?.date, thirdStart?.time, nextNumber + finalMatches.length);
    nextMatches = [
      ...finalMatches,
      ...thirdMatches,
    ];
  } else if ((completedPhase === 'final' || completedPhase === 'third_place') && allPhaseMatchesResolved('final') && allPhaseMatchesResolved('third_place')) {
    finalizeWinners();
    return;
  }

  if (nextMatches.length) {
    const existingPhases = new Set(matches.map((match) => match.phase));
    if (!nextMatches.some((match) => existingPhases.has(match.phase) && matches.some((old) => old.phase === match.phase))) {
      matches.push(...nextMatches);
    }
  }
}

function syncTeamStats() {
  const rows = calculateStandings();
  rows.forEach((row) => {
    row.team.wins = row.wins;
    row.team.losses = row.losses;
    row.team.draws = row.draws;
    row.team.points = row.points;
    row.team.rank = rows.indexOf(row) + 1;
  });
}

function finalizeWinners() {
  const final = matches.find((match) => match.phase === 'final' && isResolved(match));
  const third = matches.find((match) => match.phase === 'third_place' && isResolved(match));
  const second = final?.winnerId === final?.teamOneId ? final?.teamTwoId : final?.teamOneId;
  winners = [
    { id: makeId(), place: 1, teamId: final?.winnerId },
    { id: makeId(), place: 2, teamId: second },
    { id: makeId(), place: 3, teamId: third?.winnerId },
  ].filter((winner) => winner.teamId);
}

function openMatchAction(matchId, action) {
  const match = matches.find((item) => item.id === matchId);
  if (!match || !getTeam(match.teamOneId) || !getTeam(match.teamTwoId)) {
    showToast('لا يمكن تنفيذ الإجراء قبل تحديد فريقي المباراة');
    return;
  }
  pendingMatchAction = { matchId, action };
  $('matchActionTitle').textContent = action === 'win' ? 'تسجيل فوز' : 'تسجيل انسحاب';
  $('actionTeam').innerHTML = `<option value="${match.teamOneId}">${escapeHtml(getTeam(match.teamOneId).name)}</option><option value="${match.teamTwoId}">${escapeHtml(getTeam(match.teamTwoId).name)}</option>`;
  $('matchActionPanel').classList.remove('hidden');
  $('matchActionPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function applyMatchAction() {
  if (!pendingMatchAction) return;
  const match = matches.find((item) => item.id === pendingMatchAction.matchId);
  const selectedId = $('actionTeam').value;
  if (!match || !selectedId) return;
  const otherId = selectedId === match.teamOneId ? match.teamTwoId : match.teamOneId;
  match.winnerId = pendingMatchAction.action === 'win' ? selectedId : otherId;
  match.loserId = pendingMatchAction.action === 'win' ? otherId : selectedId;
  match.withdrawnTeamId = pendingMatchAction.action === 'withdraw' ? selectedId : '';
  match.status = pendingMatchAction.action === 'win' ? 'completed' : 'withdrawn';
  match.result = pendingMatchAction.action === 'win' ? 'فوز' : 'انسحاب';
  match.scoreOne = match.winnerId === match.teamOneId ? '1' : '0';
  match.scoreTwo = match.winnerId === match.teamTwoId ? '1' : '0';
  pendingMatchAction = null;
  $('matchActionPanel').classList.add('hidden');
  advanceTournamentProgression();
  syncTeamStats();
  save();
  renderAll();
  showToast('تم حفظ نتيجة المباراة وتحديث الترتيب');
}

$('menuToggle').addEventListener('click', () => $('mainNav').classList.toggle('open'));
document.querySelectorAll('nav a').forEach((link) => link.addEventListener('click', (event) => {
  $('mainNav').classList.remove('open');
  if (link.getAttribute('href') === '#register') {
    event.preventDefault();
    showRegistrationPage();
  }
}));
$('footerAdminButton').addEventListener('click', () => openAdmin(true));
$('maintenanceAdminButton').addEventListener('click', () => openAdmin(true));
$('applyButton').addEventListener('click', showRegistrationPage);
$('backFromRegistration').addEventListener('click', showHomepage);
$('addRegistrationPlayer').addEventListener('click', addRegistrationPlayer);
$('registrationPlayers').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-registration-player]');
  if (!button) return;
  const row = button.closest('[data-registration-player]');
  const players = getRegistrationPlayers().filter((_, index) => index !== [...document.querySelectorAll('[data-registration-player]')].indexOf(row));
  renderRegistrationPlayers(players);
});
$('closeAdmin').addEventListener('click', closeAdmin);
modal.addEventListener('click', (event) => { if (event.target === modal) closeAdmin(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeAdmin(); });

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = passwordOnlyMode ? ADMIN_USERNAME : $('adminUser').value.trim();
  const password = $('adminPassword').value;
  let authenticated = username === ADMIN_USERNAME && credentialHash(password) === ADMIN_PASSWORD_HASH;
  if (serverMode) {
    const result = await apiRequest('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    authenticated = result.response.ok;
  }
  if (authenticated) {
    loggedIn = true;
    startSession();
    serverAuthenticated = true;
    $('loginMessage').textContent = '';
    loginView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    showDashboardHome();
    await syncFromServer();
    showToast('تم الدخول إلى لوحة المشرفين');
  } else {
    $('loginMessage').textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة.';
  }
});

$('logoutButton').addEventListener('click', async () => {
  loggedIn = false;
  serverAuthenticated = false;
  endSession();
  if (serverMode) await apiRequest('/api/logout', { method: 'POST' });
  closeAdmin();
  if (settings.maintenance) setMaintenanceVisibility(true);
  showToast('تم تسجيل الخروج');
});

document.querySelectorAll('[data-admin-section]').forEach((button) => {
  button.addEventListener('click', () => showAdminSection(button.dataset.adminSection));
});
document.querySelectorAll('[data-back-dashboard]').forEach((button) => button.addEventListener('click', showDashboardHome));

$('settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const willStart = $('settingsStarted').checked;
  const startingNow = willStart && !settings.started;
  const startDate = $('settingsStartDate').value;
  const startTime = $('settingsStartTime').value;
  if (startingNow && (!startDate || !startTime)) {
    showToast('حدد تاريخ ووقت أول مباراة قبل بدء البطولة');
    return;
  }
  if (startingNow && teams.filter((team) => team.status === 'approved').length < 2) {
    showToast('يجب قبول فريقين على الأقل قبل بدء البطولة');
    return;
  }
  settings = {
    ...settings,
    title: $('settingsTitle').value.trim(),
    description: $('settingsDescription').value.trim(),
    rules: $('settingsRules').value.trim(),
    registration: $('settingsRegistration').value,
    started: willStart,
    finished: $('settingsFinished').checked,
    startDate,
    startTime,
  };
  if (startingNow && !matches.length) {
    generateInitialSchedule(startDate, startTime);
  } else {
    save();
  }
  renderAll();
  showToast(startingNow ? 'بدأت البطولة وتم إنشاء الجدول تلقائيًا' : 'تم حفظ إعدادات البطولة');
});

$('registrationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (settings.started || settings.finished || settings.registration !== 'open') {
    syncRegistrationState();
    showToast('التسجيل مقفول حاليًا');
    return;
  }
  const team = {
    id: makeId(),
    name: $('registrationTeamName').value.trim(),
    owner: $('registrationOwner').value.trim(),
    players: getRegistrationPlayers(),
    status: 'pending',
  };
  if (serverMode) {
    const result = await apiRequest('/api/registration', {
      method: 'POST',
      body: JSON.stringify(team),
    });
    if (!result.response.ok) {
      $('registrationMessage').textContent = result.data.error === 'already_registered'
        ? 'أنت مشارك بالفعل في هذه البطولة.'
        : 'تعذر إرسال التسجيل. تأكد من أن التسجيل ما زال مفتوحًا.';
      return;
    }
    registeredTeam = { id: result.data.team.id, token: result.data.token };
    localStorage.setItem(KEYS.registeredTeam, JSON.stringify(registeredTeam));
    await syncFromServer();
  } else {
    teams.push(team);
    save();
  }
  event.target.reset();
  renderRegistrationPlayers();
  $('registrationMessage').textContent = 'تم إرسال طلب فريقك بنجاح، وسيتم مراجعته من المشرفين.';
  renderAll();
  showToast('تم إرسال طلب التسجيل');
});

$('withdrawRegistration').addEventListener('click', async () => {
  if (!registeredTeam) return;
  if (settings.started || settings.finished) {
    showToast('لا يمكن الانسحاب بعد بدء البطولة');
    return;
  }
  if (serverMode) {
    const result = await apiRequest('/api/registration/withdraw', {
      method: 'POST',
      body: JSON.stringify(registeredTeam),
    });
    if (!result.response.ok) {
      showToast('لا يمكن الانسحاب من التسجيل حاليًا');
      return;
    }
  } else {
    teams = teams.filter((team) => team.id !== registeredTeam.id);
    save();
  }
  registeredTeam = null;
  localStorage.removeItem(KEYS.registeredTeam);
  await syncFromServer();
  renderAll();
  showToast('تم الانسحاب من البطولة');
});

$('adminTeamForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const players = [...document.querySelectorAll('[data-player-row]')].map((row) => ({
    name: row.querySelector('[data-player-name]').value.trim(),
    id: String(row.querySelector('[data-player-id]').value).trim(),
  })).filter((player) => player.name || player.id);
  if (players.length < 2 || players.some((player) => !player.name || !player.id)) {
    showToast('أضف لاعبين اثنين على الأقل مع الاسم والـ ID');
    return;
  }
  const team = {
    id: editingTeamId || makeId(),
    name: $('adminTeamName').value.trim(),
    owner: $('adminOwner').value.trim(),
    players,
    status: 'approved',
  };
  if (editingTeamId) {
    teams = teams.map((item) => item.id === editingTeamId ? { ...item, ...team } : item);
  } else {
    teams.push(team);
  }
  const wasEditing = Boolean(editingTeamId);
  save();
  resetTeamEditor();
  renderAll();
  showToast(wasEditing ? 'تم تحديث بيانات الفريق' : 'تمت إضافة الفريق');
});

$('addPlayerRow').addEventListener('click', addPlayerRow);
$('cancelTeamEdit').addEventListener('click', resetTeamEditor);

$('teamPlayersEditor').addEventListener('click', (event) => {
  if (!event.target.closest('[data-remove-player]')) return;
  const row = event.target.closest('[data-player-row]');
  const rows = [...document.querySelectorAll('[data-player-row]')].filter((item) => item !== row).map((item) => ({
    name: item.querySelector('[data-player-name]').value,
    id: item.querySelector('[data-player-id]').value,
  }));
  if (rows.length < 2) {
    showToast('يجب أن يبقى لاعبان أساسيان على الأقل');
    return;
  }
  renderTeamPlayerRows(rows);
});

$('generateMatchesForm').addEventListener('submit', (event) => {
  event.preventDefault();
  generateInitialSchedule($('firstMatchDate').value, $('firstMatchTime').value);
});

$('adminMatchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if ($('teamOne').value === $('teamTwo').value) {
    showToast('اختر فريقين مختلفين للمواجهة');
    return;
  }
  const existingMatch = editingMatchId ? matches.find((item) => item.id === editingMatchId) : null;
  const match = {
    ...(existingMatch || {}),
    id: editingMatchId || makeId(),
    number: existingMatch?.number || matches.reduce((max, item) => Math.max(max, Number(item.number || 0)), 0) + 1,
    teamOneId: $('teamOne').value,
    teamTwoId: $('teamTwo').value,
    date: $('matchDate').value,
    time: $('matchTime').value,
    round: $('matchRound').value.trim(),
    map: $('matchMap').value,
    status: $('matchStatus').value,
    scoreOne: $('scoreOne').value,
    scoreTwo: $('scoreTwo').value,
    phase: existingMatch?.phase || 'manual',
    phaseLabel: $('matchRound').value.trim(),
  };
  if (editingMatchId) {
    matches = matches.map((item) => item.id === editingMatchId ? match : item);
    showToast('تم تحديث المواجهة');
  } else {
    matches.push(match);
    showToast('تم حفظ المواجهة');
  }
  save();
  resetMatchEditor();
  renderAll();
});

$('confirmMatchAction').addEventListener('click', applyMatchAction);
$('cancelMatchAction').addEventListener('click', () => {
  pendingMatchAction = null;
  $('matchActionPanel').classList.add('hidden');
});

$('winnerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const team = getTeam($('winnerTeamId').value);
  if (!team) return;
  winners = winners.filter((winner) => Number(winner.place) !== Number($('winnerPlace').value));
  winners.push({ id: makeId(), place: Number($('winnerPlace').value), teamId: team.id, teamName: team.name });
  save();
  event.target.reset();
  renderAll();
  showToast('تمت إضافة الفائز');
});

document.addEventListener('click', (event) => {
  const teamButton = event.target.closest('[data-delete-team]');
  const editTeamButton = event.target.closest('[data-edit-team]');
  const matchButton = event.target.closest('[data-delete-match]');
  const editButton = event.target.closest('[data-edit-match]');
  const approveButton = event.target.closest('[data-approve-team]');
  const winButton = event.target.closest('[data-win-match]');
  const withdrawButton = event.target.closest('[data-withdraw-match]');
  const winnerButton = event.target.closest('[data-delete-winner]');

  if (editTeamButton) editTeam(editTeamButton.dataset.editTeam);
  if (winButton) openMatchAction(winButton.dataset.winMatch, 'win');
  if (withdrawButton) openMatchAction(withdrawButton.dataset.withdrawMatch, 'withdraw');
  if (approveButton) {
    const team = getTeam(approveButton.dataset.approveTeam);
    if (team) team.status = 'approved';
    save();
    renderAll();
    showToast('تم قبول طلب التسجيل');
  }
  if (teamButton) {
    teams = teams.filter((team) => team.id !== teamButton.dataset.deleteTeam);
    matches = matches.filter((match) => match.teamOneId !== teamButton.dataset.deleteTeam && match.teamTwoId !== teamButton.dataset.deleteTeam);
    save();
    renderAll();
    showToast('تم حذف الفريق والمواجهات المرتبطة به');
  }
  if (matchButton) {
    matches = matches.filter((match) => match.id !== matchButton.dataset.deleteMatch);
    save();
    renderAll();
    showToast('تم حذف المواجهة');
  }
  if (winnerButton) {
    winners = winners.filter((winner) => winner.id !== winnerButton.dataset.deleteWinner);
    save();
    renderAll();
    showToast('تم حذف الفائز');
  }
  if (editButton) {
    const match = matches.find((item) => item.id === editButton.dataset.editMatch);
    if (!match) return;
    editingMatchId = match.id;
    showAdminSection('matchesSection');
    $('teamOne').value = match.teamOneId;
    $('teamTwo').value = match.teamTwoId;
    $('matchDate').value = match.date;
    $('matchTime').value = match.time;
    $('matchRound').value = match.round;
    $('matchMap').value = match.map;
    $('matchStatus').value = match.status || 'scheduled';
    $('scoreOne').value = match.scoreOne ?? '';
    $('scoreTwo').value = match.scoreTwo ?? '';
    $('matchEditorTitle').textContent = 'تعديل المواجهة';
    $('adminMatchForm').querySelector('button[type="submit"]').textContent = 'تحديث المواجهة';
  }
});

$('resetData').addEventListener('click', () => {
  if (!window.confirm('سيتم حذف جميع الفرق والمواجهات والفائزين وإعادة إعدادات البطولة. هل أنت متأكد؟')) return;
  teams = [];
  matches = [];
  winners = [];
  settings = { ...DEFAULT_SETTINGS };
  save();
  renderAll();
  showToast('تم تصفير بيانات البطولة بالكامل');
});

$('toggleMaintenance').addEventListener('click', () => {
  settings = { ...settings, maintenance: !settings.maintenance };
  save();
  renderAll();
  if (!settings.maintenance) setMaintenanceVisibility(false);
  showToast(settings.maintenance ? 'تم تفعيل وضع الصيانة' : 'تم إلغاء وضع الصيانة');
});

$('exportData').addEventListener('click', () => {
  const payload = JSON.stringify({ teams, matches, winners, settings }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'clash-squad-backup.json';
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('تم تجهيز نسخة البيانات');
});

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3200);
}

renderTeamPlayerRows();
renderRegistrationPlayers();
renderAll();
if (!serverMode && settings.maintenance && !loggedIn) setMaintenanceVisibility(true);
syncFromServer();