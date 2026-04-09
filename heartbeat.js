// Smart daily heartbeat - rotates states, tracks progress, compounds
// Clawchief-style: priority map drives decisions, feedback compounds, quiet when nothing to say

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'memory/heartbeat-state.json');
const FEEDBACK_FILE = join(__dirname, 'memory/feedback.md');
const PRIORITY_FILE = join(__dirname, 'memory/priority-map.md');
const TASKS_FILE = join(__dirname, 'memory/tasks.md');

// ── File loaders (all with error handling for Render) ───────────────────

export function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch {
    return {
      states_queue_libraries: ["Connecticut","New York","Massachusetts","Pennsylvania","California","Texas","Illinois","Ohio","Michigan","Colorado"],
      states_searched_libraries: [],
      states_queue_schools: ["New Jersey","Illinois","Texas","California","Florida","Colorado"],
      states_searched_schools: [],
      total_prospects_found: 0, total_emails_drafted: 0,
      total_emails_approved: 0, total_emails_rejected: 0,
      daily_log: [],
    };
  }
}

export function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('Save state error:', e.message); }
}

export function loadFeedback() {
  try { return readFileSync(FEEDBACK_FILE, 'utf8'); } catch { return ''; }
}

export function loadPriorityMap() {
  try { return readFileSync(PRIORITY_FILE, 'utf8'); } catch { return ''; }
}

export function loadTasks() {
  try { return readFileSync(TASKS_FILE, 'utf8'); } catch { return ''; }
}

// ── Schedule: returns { primary, followup } for today ───────────────────

export function getTodaySchedule() {
  const day = new Date().getDay();
  const state = loadState();

  const followupTask = {
    type: 'followup',
    prompt: buildFollowupPrompt(state),
  };

  switch (day) {
    case 1: case 4: { // Mon, Thu - library research + follow-ups
      const idx = day === 1 ? 0 : 1;
      const target = state.states_queue_libraries[idx] || 'Connecticut';
      return {
        primary: {
          type: 'library_research',
          state: target,
          prompt: buildLibraryPrompt(state, idx),
        },
        followup: followupTask,
      };
    }
    case 2: { // Tue - school research + follow-ups
      const target = state.states_queue_schools[0] || 'New Jersey';
      return {
        primary: {
          type: 'school_research',
          state: target,
          prompt: buildSchoolPrompt(state),
        },
        followup: followupTask,
      };
    }
    case 3: // Wed - deep follow-ups only
      return { primary: followupTask, followup: null };
    case 5: // Fri - pipeline review (includes follow-ups)
      return { primary: { type: 'pipeline_review', prompt: buildFridayPrompt(state) }, followup: null };
    default:
      return null;
  }
}

// ── Prompt builders ─────────────────────────────────────────────────────

function buildLibraryPrompt(state, queueIdx = 0) {
  const target = state.states_queue_libraries[queueIdx] || 'Connecticut';
  const feedback = loadFeedback();
  const priorities = loadPriorityMap();

  return `MORNING ROUTINE - Library Research

Target state: ${target}
States already searched: ${state.states_searched_libraries.join(', ') || 'none yet'}
Total prospects found so far: ${state.total_prospects_found}
Emails approved: ${state.total_emails_approved} | Rejected: ${state.total_emails_rejected}

PRIORITY MAP:
${priorities}

JACK'S FEEDBACK (read carefully - these are rules):
${feedback}

Find 5-10 library systems in ${target} with media literacy, civic engagement, or news literacy programs. Check Ducky CRM for each. Draft buyer-signal cold emails for the top prospects. Tell me which are strongest and why.`;
}

function buildSchoolPrompt(state) {
  const target = state.states_queue_schools[0] || 'New Jersey';
  const feedback = loadFeedback();

  return `MORNING ROUTINE - School Research

Target state: ${target}
States already searched: ${state.states_searched_schools.join(', ') || 'none'}

JACK'S FEEDBACK (read carefully):
${feedback}

Find 5 school districts in ${target} implementing media literacy mandates or programs. Find media specialists or curriculum coordinators. Check Ducky CRM. Draft cold emails. Lead with the strongest.`;
}

function buildFollowupPrompt() {
  const feedback = loadFeedback();
  const priorities = loadPriorityMap();
  const tasks = loadTasks();

  return `FOLLOW-UP CHECK

PRIORITY MAP:
${priorities}

TASKS:
${tasks}

JACK'S FEEDBACK:
${feedback}

Login to Ducky CRM. Pull all leads. Find every lead needing follow-up based on cadence rules. For each, use Exa to find NEW value. Draft follow-up emails. Flag deals going cold. Give me a quick status - what's hot, what's dying, what needs attention.`;
}

function buildFridayPrompt(state) {
  const priorities = loadPriorityMap();
  const tasks = loadTasks();

  return `FRIDAY PIPELINE REVIEW

PRIORITY MAP:
${priorities}

TASKS:
${tasks}

Week stats: Prospects found: ${state.total_prospects_found} | Emails approved: ${state.total_emails_approved} | Rejected: ${state.total_emails_rejected}
States covered (libraries): ${state.states_searched_libraries.slice(-5).join(', ')}
States covered (schools): ${state.states_searched_schools.slice(-5).join(', ')}

Pull full Ducky pipeline. What closed? What moved forward? What's dying? Recommend next week's priorities. Keep it tight - Friday energy.`;
}

// ── Midday / Evening / Prep prompts (new) ───────────────────────────────

export function buildMiddayPrompt() {
  const priorities = loadPriorityMap();
  return `MIDDAY CHECK. It's noon.

PRIORITY MAP:
${priorities}

Check Ducky CRM for any NEW replies or activity since this morning. Check if any P0 deals have time-sensitive follow-ups due today.

RULES:
- If there is NOTHING new or actionable, respond with exactly: HEARTBEAT_OK
- If there IS something, be brief. One or two sentences per item.
- Only message Jack if it matters. No noise.`;
}

export function buildEveningPrompt() {
  const priorities = loadPriorityMap();
  const tasks = loadTasks();
  return `END OF DAY CHECK. 5pm.

PRIORITY MAP:
${priorities}

TASKS:
${tasks}

Quick scan:
1. Any replies today that haven't been addressed?
2. Any follow-ups due today that didn't happen?
3. Anything urgent for tomorrow?

RULES:
- If there is NOTHING actionable, respond with exactly: HEARTBEAT_OK
- Keep it to 3 sentences max. Just the headlines.`;
}

export function buildPrepPrompt(targetState) {
  const state = loadState();
  return `OVERNIGHT PREP (do not message Jack - this is background research).

Tomorrow's target state: ${targetState}
States already searched: ${state.states_searched_libraries.join(', ') || 'none'}

Preliminary research:
1. Search for library systems in ${targetState} with media literacy or civic engagement programs
2. Note recent news, grants, or legislation
3. Check if any existing Ducky leads are from ${targetState}

Save findings for the morning session.`;
}

// ── State rotation ──────────────────────────────────────────────────────

export function rotateState(type, targetState) {
  const state = loadState();

  if (type === 'library_research' && targetState) {
    if (!state.states_searched_libraries.includes(targetState)) {
      state.states_searched_libraries.push(targetState);
    }
    state.states_queue_libraries = state.states_queue_libraries.filter(s => s !== targetState);
  }

  if (type === 'school_research' && targetState) {
    if (!state.states_searched_schools.includes(targetState)) {
      state.states_searched_schools.push(targetState);
    }
    state.states_queue_schools = state.states_queue_schools.filter(s => s !== targetState);
  }

  state.last_run = new Date().toISOString();
  state.daily_log.push({
    date: new Date().toISOString().split('T')[0],
    type,
    state: targetState || null,
  });

  saveState(state);
}
