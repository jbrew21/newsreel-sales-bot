// Newsreel Sales Bot v2 - Built on official Anthropic SDK + grammY
// Clawchief-style heartbeat: 2am prep, 7am briefing, 12pm midday, 5pm EOD

import Anthropic from '@anthropic-ai/sdk';
import { Bot } from 'grammy';
import cron from 'node-cron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getTodaySchedule, rotateState as rotateHBState,
  loadFeedback as loadHBFeedback, loadPriorityMap, loadTasks, loadState as loadHBState,
  buildMiddayPrompt, buildEveningPrompt, buildPrepPrompt,
} from './heartbeat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────
const client = new Anthropic();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const JACK_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6535760391';

// Load agent + environment IDs (env vars on Render, file locally)
let fileConfig = {};
try {
  const envFile = readFileSync(join(__dirname, '../agent-ids.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const m = line.match(/^(\w+)="(.+)"$/);
    if (m) fileConfig[m[1]] = m[2];
  });
} catch { /* On Render: no local file, use process.env */ }

const AGENTS = {
  library:  { id: process.env.LIBRARY_AGENT_ID  || fileConfig.LIBRARY_AGENT_ID,  name: 'Library Sales' },
  school:   { id: process.env.SCHOOL_AGENT_ID   || fileConfig.SCHOOL_AGENT_ID,   name: 'School Sales' },
  followup: { id: process.env.FOLLOWUP_AGENT_ID || fileConfig.FOLLOWUP_AGENT_ID, name: 'Follow-up' },
};
const ENV_ID = process.env.ENV_ID || fileConfig.ENV_ID;

// ── State ───────────────────────────────────────────────────────────────
const SESSIONS_FILE = join(__dirname, 'sessions.json');
const COSTS_FILE = join(__dirname, 'memory/costs.json');
const FEEDBACK_FILE = join(__dirname, 'memory/feedback.md');

function loadSessions() {
  try { return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveSessions(s) { writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2)); }

let sessions = loadSessions();
let lastAgent = sessions._lastAgent || null;
let isBusy = false;

// ── Core: Send message and stream response ──────────────────────────────
async function chat(sessionId, text, chatId) {
  // Inject feedback into every message so the agent always has it
  const feedback = loadFeedbackFile();
  const feedbackPrefix = feedback.trim() ? `[JACK'S RULES - follow these exactly:\n${feedback.slice(-500)}\n]\n\n` : '';
  const messageText = feedbackPrefix + text;

  // THE KEY PATTERN: open stream FIRST, then send message
  const stream = await client.beta.sessions.events.stream(sessionId);

  await client.beta.sessions.events.send(sessionId, {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: messageText }],
    }],
  });

  let fullText = '';
  let toolsUsed = [];
  let usage = { input: 0, output: 0 };

  // Keep typing indicator alive
  const typingInterval = setInterval(() => {
    bot.api.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'agent.message':
          if (event.content) {
            for (const block of event.content) {
              if (block.type === 'text') fullText += block.text;
            }
          }
          break;

        case 'agent.tool_use':
          toolsUsed.push(event.name);
          break;

        case 'span.model_request_end':
          if (event.model_usage) {
            usage.input += (event.model_usage.input_tokens || 0) + (event.model_usage.cache_read_input_tokens || 0);
            usage.output += event.model_usage.output_tokens || 0;
          }
          break;

        case 'session.status_idle':
          if (event.stop_reason?.type === 'end_turn') {
            clearInterval(typingInterval);
            trackCost(usage);
            return { text: fullText, tools: toolsUsed, usage };
          }
          if (event.stop_reason?.type === 'requires_action') continue;
          break;

        case 'session.error':
          console.error('Session error:', event.error?.message);
          clearInterval(typingInterval);
          return { text: fullText || `(Agent error: ${event.error?.message})`, tools: toolsUsed, usage };

        case 'session.status_terminated':
          clearInterval(typingInterval);
          return { text: fullText || '(Session terminated unexpectedly)', tools: toolsUsed, usage };
      }
    }
  } catch (err) {
    clearInterval(typingInterval);
    throw err;
  }

  clearInterval(typingInterval);
  return { text: fullText || '(No response)', tools: toolsUsed, usage };
}

// ── Session management ──────────────────────────────────────────────────
async function getOrCreateSession(agentKey) {
  if (sessions[agentKey]) {
    try {
      const check = await client.beta.sessions.retrieve(sessions[agentKey]);
      if (check.status !== 'terminated') return sessions[agentKey];
    } catch { /* dead session */ }
  }

  const agent = AGENTS[agentKey];
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: ENV_ID,
    title: `${agent.name} - ${new Date().toLocaleDateString()}`,
  });

  sessions[agentKey] = session.id;
  sessions._lastAgent = agentKey;
  lastAgent = agentKey;
  saveSessions(sessions);
  return session.id;
}

// ── Smart routing ───────────────────────────────────────────────────────
function pickAgent(text) {
  const lower = text.toLowerCase();
  if (lower.match(/follow.?up|pipeline|stale|replied|reply|check.?in|bump|who needs/)) return 'followup';
  if (lower.match(/school|district|teacher|media specialist|k-12|university|college|campus|student|classroom|professor|mandate|journalism program/)) return 'school';
  return 'library';
}

function isNewTask(text) {
  return text.match(/find|research|search|look up|draft|email|prospect|outreach|new state|morning|switch to|run all/i);
}

function isCasual(text) {
  return /^(hey|hi|hello|yo|sup|huh|what|\?\?+|ok|thanks|cool|nice|got it|k|lol)[\s!?.]*$/i.test(text.trim());
}

// ── HEARTBEAT_OK quiet mode ─────────────────────────────────────────────
function isHeartbeatOk(text) {
  if (!text) return true;
  const cleaned = text.trim().toUpperCase();
  return cleaned === 'HEARTBEAT_OK' || cleaned.startsWith('HEARTBEAT_OK');
}

// ── Telegram message handling ───────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  if (String(ctx.chat.id) !== String(JACK_CHAT_ID)) return;

  const text = ctx.message.text;

  // Slash commands
  if (text === '/start') {
    return ctx.reply("Hey. What are we working on? Just text me like normal.\n\n/run - morning briefing\n/cost - API spend\n/reset - clear sessions\n/status - active sessions");
  }
  if (text === '/cost') return ctx.reply(formatCostReport());
  if (text === '/status') {
    const lines = Object.entries(sessions)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `${AGENTS[k]?.name || k}: ${v}`);
    return ctx.reply(lines.length ? lines.join('\n') : 'No active sessions.');
  }
  if (text === '/reset') {
    sessions = {};
    lastAgent = null;
    saveSessions(sessions);
    return ctx.reply("All sessions cleared. Next message starts fresh.");
  }
  if (text === '/run') return runMorningRoutine(ctx.chat.id);

  // Save feedback
  saveFeedback(text);

  // Casual chat
  if (isCasual(text)) return ctx.reply("I'm here. What do you need?");

  // Busy
  if (isBusy) return ctx.reply("Still working on the last one - give me a sec.");

  isBusy = true;

  // Route: continuation to last agent, new task gets routed
  let agentKey;
  if (isNewTask(text) || !lastAgent) {
    agentKey = pickAgent(text);
  } else {
    agentKey = lastAgent;
  }

  try {
    const placeholder = await ctx.reply('Thinking...');
    await ctx.replyWithChatAction('typing');

    const sessionId = await getOrCreateSession(agentKey);
    lastAgent = agentKey;
    sessions._lastAgent = agentKey;
    saveSessions(sessions);

    const response = await chat(sessionId, text, ctx.chat.id);

    const chunks = splitMessage(response.text);
    try {
      await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, chunks[0]);
    } catch {
      await ctx.reply(chunks[0]);
    }
    for (const chunk of chunks.slice(1)) {
      await ctx.reply(chunk);
    }

    saveDailyLog(agentKey, text, response.text);
  } catch (err) {
    console.error('Error:', err.message);
    await ctx.reply(`Hit an error: ${err.message}. Try again?`);
  }

  isBusy = false;
});

// ── Morning routine (uses heartbeat.js) ─────────────────────────────────
async function runMorningRoutine(chatId) {
  const day = new Date().getDay();
  if (day === 0 || day === 6) {
    return bot.api.sendMessage(chatId, "Weekend. /run again if you want to work anyway.");
  }

  const schedule = getTodaySchedule();
  if (!schedule) return;

  const agentMap = {
    library_research: 'library',
    school_research: 'school',
    followup: 'followup',
    pipeline_review: 'followup',
  };

  const primaryAgent = agentMap[schedule.primary.type] || 'library';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  await bot.api.sendMessage(chatId, `Morning. ${dayNames[day]}'s focus: ${schedule.primary.type.replace(/_/g, ' ')}${schedule.primary.state ? ` (${schedule.primary.state})` : ''}. Give me a few minutes.`);

  // Run primary task
  try {
    isBusy = true;
    const sessionId = await getOrCreateSession(primaryAgent);
    const response = await chat(sessionId, schedule.primary.prompt, chatId);
    const chunks = splitMessage(response.text);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk);
    }
    saveDailyLog(primaryAgent, 'morning_routine', response.text);

    if (schedule.primary.state) {
      rotateHBState(schedule.primary.type, schedule.primary.state);
    }
  } catch (err) {
    await bot.api.sendMessage(chatId, `Morning routine error: ${err.message}`);
  }

  // ALWAYS run follow-up check (unless primary IS the follow-up task)
  if (schedule.followup) {
    await bot.api.sendMessage(chatId, "Checking follow-ups...");
    try {
      const fuSessionId = await getOrCreateSession('followup');
      const fuResponse = await chat(fuSessionId, schedule.followup.prompt, chatId);
      const fuChunks = splitMessage(fuResponse.text);
      for (const chunk of fuChunks) {
        await bot.api.sendMessage(chatId, chunk);
      }
      saveDailyLog('followup', 'morning_followup', fuResponse.text);
    } catch (err) {
      await bot.api.sendMessage(chatId, `Follow-up error: ${err.message}`);
    }
  }

  isBusy = false;
  await bot.api.sendMessage(chatId, "Done. Reply to refine anything.");
}

// ── Midday check (quiet if nothing) ─────────────────────────────────────
async function runMiddayCheck(chatId) {
  if (isBusy) { console.log('Midday check skipped - busy'); return; }
  const day = new Date().getDay();
  if (day === 0 || day === 6) return;

  try {
    isBusy = true;
    const sessionId = await getOrCreateSession('followup');
    const response = await chat(sessionId, buildMiddayPrompt(), chatId);

    if (isHeartbeatOk(response.text)) {
      console.log('Midday: HEARTBEAT_OK - staying quiet');
      isBusy = false;
      return;
    }

    const chunks = splitMessage(response.text);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk);
    }
    saveDailyLog('followup', 'midday_check', response.text);
  } catch (err) {
    console.error('Midday check error:', err.message);
  }
  isBusy = false;
}

// ── Evening check (quiet if nothing) ────────────────────────────────────
async function runEveningCheck(chatId) {
  if (isBusy) { console.log('Evening check skipped - busy'); return; }
  const day = new Date().getDay();
  if (day === 0 || day === 6) return;

  try {
    isBusy = true;
    const sessionId = await getOrCreateSession('followup');
    const response = await chat(sessionId, buildEveningPrompt(), chatId);

    if (isHeartbeatOk(response.text)) {
      console.log('Evening: HEARTBEAT_OK - staying quiet');
      isBusy = false;
      return;
    }

    const chunks = splitMessage(response.text);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk);
    }
    saveDailyLog('followup', 'evening_check', response.text);
  } catch (err) {
    console.error('Evening check error:', err.message);
  }
  isBusy = false;
}

// ── Overnight prep (silent, no message to Jack) ─────────────────────────
async function runPrepTask() {
  const day = new Date().getDay();
  if (day === 6) return; // Skip Saturday night

  try {
    const state = loadHBState();
    const nextState = state.states_queue_libraries[0] || 'Connecticut';
    const sessionId = await getOrCreateSession('library');
    await chat(sessionId, buildPrepPrompt(nextState), JACK_CHAT_ID);
    console.log('2am prep complete for:', nextState);
  } catch (err) {
    console.error('2am prep error:', err.message);
  }
}

// ── Feedback ────────────────────────────────────────────────────────────
function loadFeedbackFile() {
  try { return readFileSync(FEEDBACK_FILE, 'utf8'); } catch { return ''; }
}

function saveFeedback(text) {
  const lower = text.toLowerCase();
  let feedbackType = null;

  if (lower.match(/never say|don't use|stop using|don't say|stop saying|don't ever/)) {
    feedbackType = 'voice_rule';
  } else if (lower.match(/too long|too short|too formal|sounds like ai|rewrite|redo|not great|weak/)) {
    feedbackType = 'rejected';
  } else if (lower.match(/^(good one|perfect|send it|love it|that works|looks good|ship it|send that|great)[\s!.]*$/i)) {
    feedbackType = 'approved';
  }

  if (feedbackType) {
    try {
      const date = new Date().toISOString().split('T')[0];
      let current = '';
      try { current = readFileSync(FEEDBACK_FILE, 'utf8'); } catch {}
      writeFileSync(FEEDBACK_FILE, current + `\n${date} | ${feedbackType} | ${text}`);
    } catch (e) {
      console.error('Feedback save error:', e.message);
    }
  }
}

// ── Cost tracking ───────────────────────────────────────────────────────
function trackCost(usage) {
  if (!usage.input && !usage.output) return;
  try {
    let costs;
    try { costs = JSON.parse(readFileSync(COSTS_FILE, 'utf8')); } catch { costs = { total_input: 0, total_output: 0, sessions: 0, daily: {} }; }
    const date = new Date().toISOString().split('T')[0];
    costs.total_input += usage.input;
    costs.total_output += usage.output;
    costs.sessions++;
    if (!costs.daily[date]) costs.daily[date] = { input: 0, output: 0, sessions: 0 };
    costs.daily[date].input += usage.input;
    costs.daily[date].output += usage.output;
    costs.daily[date].sessions++;
    writeFileSync(COSTS_FILE, JSON.stringify(costs, null, 2));
  } catch (e) {
    console.error('Cost tracking error:', e.message);
  }
}

function formatCostReport() {
  try {
    const costs = JSON.parse(readFileSync(COSTS_FILE, 'utf8'));
    const inputCost = (costs.total_input / 1000000) * 3;
    const outputCost = (costs.total_output / 1000000) * 15;
    const total = inputCost + outputCost;
    const today = new Date().toISOString().split('T')[0];
    const td = costs.daily[today] || { input: 0, output: 0, sessions: 0 };
    const todayTotal = (td.input / 1000000 * 3) + (td.output / 1000000 * 15);
    return `Cost Report\n\nToday: $${todayTotal.toFixed(2)} (${td.sessions} turns)\nAll time: $${total.toFixed(2)} (${costs.sessions} turns)\nTokens: ${(costs.total_input/1000).toFixed(0)}K in / ${(costs.total_output/1000).toFixed(0)}K out`;
  } catch {
    return 'No cost data yet.';
  }
}

// ── Daily log ───────────────────────────────────────────────────────────
function saveDailyLog(agent, userMsg, botResponse) {
  try {
    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const logFile = join(__dirname, `memory/${date}.md`);
    let existing = '';
    try { existing = readFileSync(logFile, 'utf8'); } catch {}
    writeFileSync(logFile, existing + `\n## ${time} - ${agent}\n**User:** ${userMsg.slice(0, 200)}\n**Agent:** ${botResponse.slice(0, 500)}\n---\n`);
  } catch (e) {
    console.error('Log error:', e.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function splitMessage(text, maxLen = 4000) {
  if (!text) return ['(No response)'];
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ── Cron: Clawchief-style multi-heartbeat ───────────────────────────────
// 2am: Overnight prep (silent)
cron.schedule('0 2 * * 1-5', () => {
  console.log('Running 2am prep...');
  runPrepTask();
}, { timezone: 'America/New_York' });

// 7am: Morning briefing (always messages Jack)
cron.schedule('0 7 * * 1-5', () => {
  console.log('Running morning routine...');
  runMorningRoutine(JACK_CHAT_ID);
}, { timezone: 'America/New_York' });

// 12pm: Midday check (quiet if nothing actionable)
cron.schedule('0 12 * * 1-5', () => {
  console.log('Running midday check...');
  runMiddayCheck(JACK_CHAT_ID);
}, { timezone: 'America/New_York' });

// 5pm: End of day (quiet if nothing actionable)
cron.schedule('0 17 * * 1-5', () => {
  console.log('Running evening check...');
  runEveningCheck(JACK_CHAT_ID);
}, { timezone: 'America/New_York' });

// ── Bootstrap memory directory ──────────────────────────────────────────
function bootstrapMemory() {
  const memDir = join(__dirname, 'memory');
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  const defaults = {
    'priority-map.md': '# Newsreel Sales Priority Map\n## P0 - Close These Now\n## P1 - Active Pipeline\n## P2 - Research\n## P3 - Long-Term\n',
    'tasks.md': '# Newsreel Sales Tasks\n## Today\n## This Week\n## Waiting For Reply\n## Hot Deals\n## Completed\n',
    'feedback.md': '# Jack\'s Feedback\n',
    'costs.json': '{"total_input":0,"total_output":0,"sessions":0,"daily":{}}',
    'heartbeat-state.json': JSON.stringify({
      states_queue_libraries: ["Connecticut","New York","Massachusetts","Pennsylvania","California","Texas","Illinois","Ohio","Michigan","Colorado","Washington","Oregon","Minnesota","Virginia","Maryland","Georgia","North Carolina","Florida","Arizona","New Mexico","Wisconsin","Iowa","Missouri","Indiana","Tennessee","Kentucky","Louisiana","Alabama","South Carolina","Nevada","Utah","Oklahoma","Kansas","Nebraska","Montana","Idaho","Wyoming","New Hampshire","Vermont","Maine","Rhode Island","Delaware","Hawaii","Alaska","West Virginia","Mississippi","Arkansas","North Dakota","South Dakota"],
      states_searched_libraries: [],
      states_queue_schools: ["New Jersey","Illinois","Texas","California","Florida","Colorado","Washington","Connecticut","Delaware","Ohio","Minnesota","New York","Pennsylvania","Massachusetts","Virginia","Maryland","Georgia","North Carolina","Michigan","Oregon","Arizona","Wisconsin","Iowa","Missouri","Indiana"],
      states_searched_schools: [],
      total_prospects_found: 0, total_emails_drafted: 0,
      total_emails_approved: 0, total_emails_rejected: 0,
      daily_log: [],
    }, null, 2),
  };

  for (const [file, content] of Object.entries(defaults)) {
    const path = join(memDir, file);
    if (!existsSync(path)) {
      writeFileSync(path, content);
      console.log(`Created default: ${file}`);
    }
  }
}

bootstrapMemory();

// ── Start ───────────────────────────────────────────────────────────────
bot.start();
console.log('Newsreel Sales Bot v2 started!');
console.log(`Agents: ${Object.values(AGENTS).map(a => `${a.name} (${a.id})`).join(', ')}`);
console.log(`Environment: ${ENV_ID}`);
console.log(`Locked to chat: ${JACK_CHAT_ID}`);
console.log('Schedule: 2am prep | 7am briefing | 12pm midday | 5pm EOD');
if (Object.keys(sessions).filter(k => !k.startsWith('_')).length > 0) {
  console.log('Restored sessions:', Object.keys(sessions).filter(k => !k.startsWith('_')).join(', '));
}
