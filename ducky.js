// Ducky CRM integration
const DUCKY_BASE = 'https://newsreel-crm.onrender.com';
let authToken = null;

// Login to Ducky
async function login() {
  const res = await fetch(`${DUCKY_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.DUCKY_PASSWORD || 'newsreel2026' }),
  });
  if (!res.ok) throw new Error(`Ducky login failed: ${res.status}`);
  const data = await res.json();
  authToken = data.token;
  return authToken;
}

async function duckyFetch(path, options = {}) {
  if (!authToken) await login();
  const res = await fetch(`${DUCKY_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      ...options.headers,
    },
  });
  if (res.status === 401) {
    // Token expired, re-login
    await login();
    return duckyFetch(path, options);
  }
  if (!res.ok) throw new Error(`Ducky ${res.status}: ${await res.text()}`);
  return res.json();
}

// Search leads by org name or person name
export async function searchLeads(query) {
  return duckyFetch(`/api/leads?search=${encodeURIComponent(query)}`);
}

// Get a single lead
export async function getLead(id) {
  return duckyFetch(`/api/leads/${id}`);
}

// Create a new lead
export async function createLead(data) {
  return duckyFetch('/api/leads', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Update a lead
export async function updateLead(id, data) {
  return duckyFetch(`/api/leads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// Get leads needing follow-up
export async function getFollowups() {
  return duckyFetch('/api/followups');
}

// Get all leads with optional filters
export async function listLeads({ status, type } = {}) {
  let path = '/api/leads?';
  if (status) path += `status=${status}&`;
  if (type) path += `type=${type}&`;
  return duckyFetch(path);
}

// Pre-outreach check: search by org AND person name AND email
export async function preOutreachCheck({ orgName, personName, email }) {
  const results = { exists: false, leads: [], warning: null };

  // Check 1: by org
  if (orgName) {
    const orgLeads = await searchLeads(orgName);
    if (orgLeads.length > 0) {
      results.exists = true;
      results.leads.push(...orgLeads);
      results.warning = `Found ${orgLeads.length} existing lead(s) for "${orgName}" in Ducky.`;
    }
  }

  // Check 2: by person name
  if (personName) {
    const personLeads = await searchLeads(personName);
    if (personLeads.length > 0) {
      results.exists = true;
      results.leads.push(...personLeads);
      results.warning = (results.warning || '') + ` Found lead(s) matching "${personName}".`;
    }
  }

  return results;
}

// Add lead after outreach
export async function logOutreach({ name, email, organization, type, notes, source }) {
  return createLead({
    name,
    email,
    organization,
    type: type || 'library',
    status: 'contacted',
    notes: notes || `Cold email sent ${new Date().toLocaleDateString()}`,
    source: source || 'managed-agent',
    last_contact_date: new Date().toISOString(),
  });
}
