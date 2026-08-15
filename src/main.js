import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = url && key ? createClient(url, key) : null;
const $ = (id) => document.getElementById(id);
let participant = null;
let activeSession = null;
let activeStartedAt = null;
let timerIsRunning = false;
let progressResetAt = null;

function notice(message) { window.toast(message); }
function isConfigured() { return Boolean(supabase); }
function codeEmail(code) { return `${code.toLowerCase()}@participant.studyflow.invalid`; }
function pending() { return JSON.parse(localStorage.getItem('studyflow-pending') || '[]'); }
function queue(item) { localStorage.setItem('studyflow-pending', JSON.stringify([...pending(), item])); }
async function flushPending() { for (const item of pending()) { const { error } = item.kind === 'task' ? await supabase.from('tasks').insert(item.data) : await supabase.from('focus_sessions').update(item.data).eq('id', item.id).eq('completed', false); if (!error) localStorage.setItem('studyflow-pending', JSON.stringify(pending().filter(x => JSON.stringify(x) !== JSON.stringify(item)))); } }
async function loadUiState() { const { data } = await supabase.from('participant_ui_state').select('progress_reset_at').maybeSingle(); progressResetAt = data?.progress_reset_at || null; }

function addAuthFields() {
  const privacy = document.querySelector('.privacy');
  const pin = document.createElement('div');
  pin.innerHTML = '<label class="label" for="studyPin">Enter your private study PIN ♡</label><input class="input" id="studyPin" type="password" inputmode="numeric" minlength="8" maxlength="72" autocomplete="current-password" placeholder="Given to you by the researcher">';
  privacy.before(pin);
  privacy.textContent = 'Your study activity is recorded under this anonymous code for the approved school research study. This wording will be replaced with the school-approved notice.';
  const researcher = document.createElement('a');
  researcher.href = '/researcher.html'; researcher.textContent = 'Researcher sign in →'; researcher.style.cssText = 'margin-top:14px;color:var(--pink);font-size:12px;font-weight:900;text-decoration:none';
  document.querySelector('.welcome .btn').after(researcher);
}

async function loadTasks() {
  const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
  if (error) return notice('Could not load your tasks. Please retry.');
  const visibleTasks = progressResetAt ? data.filter(task => task.created_at >= progressResetAt) : data;
  const list = $('taskList'); list.replaceChildren();
  visibleTasks.forEach(drawTask);
  const current = visibleTasks.find(t => !t.completed);
  if (current) setCurrentTask(current);
  await loadProductivity(visibleTasks);
}
async function loadProductivity(tasks) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from('daily_productivity').select('*').eq('participant_id', participant.id).eq('date', today).maybeSingle();
  if (error) return;
  let daily = data || { tasks_completed: 0, focused_minutes: 0, pomodoro_sessions: 0 };
  if (progressResetAt) {
    const start = new Date(Math.max(new Date(progressResetAt).getTime(), new Date(`${today}T00:00:00`).getTime())).toISOString();
    const { data: sessions } = await supabase.from('focus_sessions').select('actual_duration').eq('completed', true).gte('ended_at', start);
    daily = {
      tasks_completed: tasks.filter(task => task.completed && task.completed_at && task.completed_at >= start).length,
      focused_minutes: (sessions || []).reduce((total, session) => total + Math.ceil(session.actual_duration / 60), 0),
      pomodoro_sessions: (sessions || []).length,
    };
  }
  $('completedStat').textContent = daily.tasks_completed;
  $('remainingStat').textContent = tasks.filter(t => !t.completed).length;
  $('focusedStat').textContent = daily.focused_minutes;
  $('sessionStat').textContent = daily.pomodoro_sessions;
  $('progressTasks').textContent = daily.tasks_completed;
  $('progressFocused').textContent = daily.focused_minutes;
  $('progressSessions').textContent = `${daily.pomodoro_sessions} 🍅`;
  $('progressNote').textContent = daily.tasks_completed ? 'today' : 'no completed tasks yet';
  $('progressChart').innerHTML = daily.tasks_completed ? `<div class="bar-wrap"><i class="bar hot" style="height:100%"></i>Today</div>` : '<p class="sub">No study activity yet.</p>';
}
function drawTask(task) {
  const item = document.createElement('article'); item.className = `task card${task.completed ? ' done' : ''}`; item.dataset.id = task.id;
  item.innerHTML = `<button class="check">${task.completed ? '✓' : ''}</button><div class="task-main"><div class="task-name"></div><div class="task-sub"></div><span class="badge">🍅 ${task.estimated_pomodoros} session${task.estimated_pomodoros === 1 ? '' : 's'}</span></div>`;
  item.querySelector('.task-name').textContent = task.title; item.querySelector('.task-sub').textContent = task.subject || 'General';
  item.querySelector('.check').onclick = () => updateTask(task, !task.completed);
  $('taskList').append(item);
}
function setCurrentTask(task) {
  document.querySelector('.current strong').textContent = task.title;
  document.querySelector('.current .task-sub').textContent = task.subject || 'General';
  document.querySelector('.current').dataset.taskId = task.id;
}
async function updateTask(task, completed) {
  const { error } = await supabase.from('tasks').update({ completed, completed_at: completed ? new Date().toISOString() : null }).eq('id', task.id);
  if (error) return notice('Could not save this change. Please retry.');
  await loadTasks(); notice(completed ? 'Task complete! ✨' : 'Task reopened');
}

async function signIn() {
  const code = $('anon').value.trim().toUpperCase(); const pin = $('studyPin').value;
  if (!/^[A-Z0-9-]{3,32}$/.test(code) || pin.length < 8) return notice('Enter your participant code and private PIN.');
  if (!isConfigured()) return notice('Supabase is not configured yet. See README.');
  const { error } = await supabase.auth.signInWithPassword({ email: codeEmail(code), password: pin });
  if (error) return notice('We could not sign you in. Check your code and PIN.');
  const { data, error: participantError } = await supabase.from('participants').select('*').single();
  if (participantError) { await supabase.auth.signOut(); return notice('This account is not enrolled as a participant.'); }
  participant = data; $('userName').textContent = participant.participant_code; $('welcome').classList.remove('active'); window.show('home'); await loadUiState(); await loadTasks(); await researchPanel();
}

async function createTask() {
  const title = $('newTitle').value.trim(); const subject = $('newSubject').value.trim(); const estimated = Number($('pomCount').textContent);
  if (!title) return notice('Add a task title first ♡');
  const data = { client_event_id: crypto.randomUUID(), participant_id: participant.id, title, subject: subject || null, estimated_pomodoros: estimated };
  const { error } = await supabase.from('tasks').insert(data);
  if (error) { queue({ kind: 'task', data }); return notice('Task saved as pending sync. It will retry when you reconnect.'); }
  $('newTitle').value = ''; $('newSubject').value = ''; window.show('tasks'); await loadTasks(); notice('New task added! ✨');
}

async function startSession() {
  if (window.running || activeSession) return;
  const taskId = document.querySelector('.current').dataset.taskId || null;
  activeStartedAt = new Date(); const clientEventId = crypto.randomUUID();
  const { data, error } = await supabase.from('focus_sessions').insert({ client_event_id: clientEventId, participant_id: participant.id, task_id: taskId, session_number: 1, planned_duration: 1500, actual_duration: 0, completed: false, started_at: activeStartedAt.toISOString() }).select().single();
  if (error) return notice('Session could not start online. Please reconnect before focusing.');
  activeSession = data; timerIsRunning = true; originalPause();
}
async function finishSession() {
  if (!activeSession) return originalToggleBreak();
  const actual = Math.min(1500, Math.max(1, Math.round((Date.now() - activeStartedAt.getTime()) / 1000)));
  const { error } = await supabase.from('focus_sessions').update({ actual_duration: actual, completed: true, ended_at: new Date().toISOString() }).eq('id', activeSession.id).eq('completed', false);
  if (error) { queue({ kind: 'session', id: activeSession.id, data: { actual_duration: actual, completed: true, ended_at: new Date().toISOString() } }); notice('Session completion is pending sync. Keep this tab open and reconnect.'); return; }
  activeSession = null; activeStartedAt = null; timerIsRunning = false; originalToggleBreak(); notice('Session complete! 🍅✨');
}
async function stopSession() {
  if (activeSession) { await supabase.from('focus_sessions').update({ actual_duration: Math.round((Date.now() - activeStartedAt.getTime()) / 1000), ended_at: new Date().toISOString() }).eq('id', activeSession.id); activeSession = null; activeStartedAt = null; }
}
async function baselineEntry() {
  const value = Number($('baselineCount').value);
  if (!Number.isInteger(value) || value < 0 || value > 99) return notice('Enter a whole number from 0 to 99.');
  const { error } = await supabase.rpc('record_baseline_tasks', { p_tasks_completed: value });
  if (error) return notice('Could not save your baseline entry. Please retry.');
  notice('Today’s baseline entry was saved! ✨');
}
async function resetMyProgress() {
  await stopSession(); timerIsRunning = false; originalStop();
  const { data, error } = await supabase.rpc('reset_my_progress');
  if (error) return notice(`Could not reset your progress: ${error.message}`);
  progressResetAt = data; await loadTasks(); window.show('home'); notice('Your StudyFlow progress has been reset. Research records were kept.');
}
function showProgressResetDialog() {
  let dialog = $('progressResetModal');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'progressResetModal';
    dialog.style.cssText = 'border:0;border-radius:22px;box-shadow:0 18px 55px #4a303066;max-width:390px;width:calc(100% - 32px);color:#4a3030;padding:24px;font-family:Nunito,sans-serif';
    dialog.innerHTML = '<h2 style="font-family:Patrick Hand,cursive;font-size:31px;line-height:1;margin:0">Reset your progress?</h2><p style="color:#8b7070;font-weight:700;line-height:1.5">Your StudyFlow progress will be reset. This will not sign you out.</p><div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px"><button class="btn btn-outline" id="progressResetCancel">Cancel</button><button class="btn btn-pink" id="progressResetConfirm">Reset My Progress</button></div>';
    document.body.append(dialog);
    $('progressResetCancel').onclick = () => dialog.close();
    $('progressResetConfirm').onclick = async () => { $('progressResetConfirm').disabled = true; await resetMyProgress(); $('progressResetConfirm').disabled = false; dialog.close(); };
  }
  dialog.showModal();
}
async function researchPanel() {
  const { data, error } = await supabase.rpc('current_period', { for_date: new Date().toISOString().slice(0, 10) });
  const panel = $('more');
  const baseline = !error && data === 'BASELINE';
  panel.innerHTML = `<h1 class="page-title">${baseline ? 'daily check-in ✿' : 'study privacy ♡'}</h1>${baseline ? '<div class="card"><h2 class="card-title">baseline period</h2><p class="sub">How many study tasks did you complete today?</p><input id="baselineCount" class="input" type="number" min="0" max="99" value="0" inputmode="numeric"><button class="btn btn-pink form-btn" id="baselineSave">Save today’s count ✨</button></div>' : ''}<div class="card"><h2 class="card-title">your study privacy</h2><p class="sub">Your activity is linked to an anonymous participant code and used only for the approved school research study. Researchers can view authorized study records; other participants cannot see your tasks or activity.</p><button class="btn btn-yellow form-btn" id="progressReset">Reset My Progress</button><button class="btn btn-outline form-btn" id="participantSignOut">Sign out</button></div>`;
  if (baseline) $('baselineSave').onclick = baselineEntry;
  $('progressReset').onclick = showProgressResetDialog;
  $('participantSignOut').onclick = async () => { await supabase.auth.signOut(); location.reload(); };
}

window.startApp = signIn;
window.addTask = () => isConfigured() ? createTask() : notice('Supabase is not configured yet.');
window.completeTask = () => notice('Please wait while tasks load.');
const originalPause = window.pauseTimer, originalStop = window.stopTimer, originalToggleBreak = window.toggleBreak;
window.pauseTimer = () => { if (!isConfigured()) return notice('Supabase is not configured yet.'); if (!timerIsRunning) startSession(); else { originalPause(); timerIsRunning = false; } };
window.stopTimer = async () => { await stopSession(); timerIsRunning = false; originalStop(); };
window.toggleBreak = finishSession;

addAuthFields();
if (supabase) supabase.auth.getSession().then(async ({ data: { session } }) => { if (!session) return; const { data } = await supabase.from('participants').select('*').maybeSingle(); if (data) { participant = data; $('userName').textContent = data.participant_code; $('welcome').classList.remove('active'); window.show('home'); await flushPending(); await loadUiState(); await loadTasks(); await researchPanel(); } });
