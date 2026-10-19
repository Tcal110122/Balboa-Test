// Minimal Microsoft Graph client for the reports@ shared mailbox.
//
// Auth: client-credentials flow for the "Balboa Portal Mail" app.
// Exchange RBAC for Applications limits this app to the one mailbox
// in MS_MAILBOX (Mail.ReadWrite + Mail.Send), so it cannot read any
// other mailbox in the tenant.
//
// Env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_MAILBOX

const GRAPH = 'https://graph.microsoft.com/v1.0'
let cached = null // { token, expiresAt }

const REQUIRED = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_MAILBOX']

// Names (never values) of the settings that are missing in this deployment.
export function missingSettings() {
  return REQUIRED.filter(name => !String(process.env[name] || '').trim())
}

export function isConfigured() {
  return missingSettings().length === 0
}

// Tolerate stray whitespace or quote marks from pasting into Vercel.
const setting = name => String(process.env[name] || '').trim().replace(/^["']|["']$/g, '').trim()

// Describes the stored secret without revealing it, for troubleshooting.
// Entra secret Values are ~40 characters and usually contain '~'; the
// Secret ID shown beside them is a 36-character GUID.
export function secretShape() {
  const raw = String(process.env.MS_CLIENT_SECRET || '')
  const v = setting('MS_CLIENT_SECRET')
  return {
    length: v.length,
    looks_like_secret_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
    contains_tilde: v.includes('~'),
    had_spaces_or_quotes: raw !== v,
  }
}

async function token() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  const res = await fetch(`https://login.microsoftonline.com/${setting('MS_TENANT_ID')}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: setting('MS_CLIENT_ID'),
      client_secret: setting('MS_CLIENT_SECRET'),
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Graph token request failed: ${data.error_description || data.error || res.status}`)
  cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return cached.token
}

const mailbox = () => encodeURIComponent(setting('MS_MAILBOX'))

async function graph(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`${GRAPH}/users/${mailbox()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  if (raw) return Buffer.from(await res.arrayBuffer())
  return res.status === 204 || res.status === 202 ? null : res.json()
}

// Oldest first, so packages are processed in the order they arrived.
export async function listInboxMessages(limit = 10) {
  const select = 'id,internetMessageId,subject,from,receivedDateTime,hasAttachments'
  const data = await graph(`/mailFolders/inbox/messages?$top=${limit}&$select=${select}&$orderby=receivedDateTime asc`)
  return data.value || []
}

export async function listAttachments(messageId) {
  const data = await graph(`/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`)
  return data.value || []
}

export async function downloadAttachment(messageId, attachmentId) {
  return graph(`/messages/${messageId}/attachments/${attachmentId}/$value`, { raw: true })
}

const folderIds = {}
export async function folderId(displayName) {
  if (folderIds[displayName]) return folderIds[displayName]
  const filter = encodeURIComponent(`displayName eq '${displayName.replace(/'/g, "''")}'`)
  const found = await graph(`/mailFolders?$filter=${filter}`)
  let id = found.value?.[0]?.id
  if (!id) id = (await graph('/mailFolders', { method: 'POST', body: { displayName } })).id
  folderIds[displayName] = id
  return id
}

export async function moveMessage(messageId, displayName) {
  await graph(`/messages/${messageId}/move`, { method: 'POST', body: { destinationId: await folderId(displayName) } })
}

// Sends from the reports@ mailbox. `to` is an array of addresses.
export async function sendMail({ to, cc = [], subject, html }) {
  const recipients = list => list.map(address => ({ emailAddress: { address } }))
  await graph('/sendMail', {
    method: 'POST',
    body: {
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: recipients(to), ccRecipients: recipients(cc) },
      saveToSentItems: true,
    },
  })
}
