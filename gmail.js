// Gmail integration - create drafts and send emails via Gmail API
// Uses Google OAuth2 - requires one-time setup

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = join(__dirname, 'gmail-token.json');
const CREDENTIALS_PATH = join(__dirname, 'gmail-credentials.json');

// Check if Gmail is configured
export function isGmailConfigured() {
  return existsSync(CREDENTIALS_PATH) && existsSync(TOKEN_PATH);
}

// Get access token (refresh if needed)
async function getAccessToken() {
  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  const { client_id, client_secret } = creds.installed || creds.web;

  // Check if token needs refresh
  if (token.expiry_date && Date.now() >= token.expiry_date) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id,
        client_secret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const refreshed = await res.json();
    token.access_token = refreshed.access_token;
    token.expiry_date = Date.now() + (refreshed.expires_in * 1000);
    writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
  }

  return token.access_token;
}

// Create a Gmail draft
export async function createDraft({ to, subject, body }) {
  const accessToken = await getAccessToken();

  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/html; charset=utf-8`,
    '',
    body.split('\n').map(line => `<p>${line}</p>`).join(''),
  ].join('\r\n');

  const encodedEmail = Buffer.from(email).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: { raw: encodedEmail },
    }),
  });

  if (!res.ok) throw new Error(`Gmail draft failed: ${await res.text()}`);
  return res.json();
}

// Send an email directly
export async function sendEmail({ to, subject, body }) {
  const accessToken = await getAccessToken();

  const email = [
    `To: ${to}`,
    `From: jack@newsreel.co`,
    `Subject: ${subject}`,
    `Content-Type: text/html; charset=utf-8`,
    '',
    body.split('\n').map(line => `<p>${line}</p>`).join(''),
  ].join('\r\n');

  const encodedEmail = Buffer.from(email).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      raw: encodedEmail,
    }),
  });

  if (!res.ok) throw new Error(`Gmail send failed: ${await res.text()}`);
  return res.json();
}

// Search Gmail for existing threads
export async function searchGmail(query) {
  const accessToken = await getAccessToken();

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  if (!res.ok) throw new Error(`Gmail search failed: ${await res.text()}`);
  const data = await res.json();
  return data.messages || [];
}
