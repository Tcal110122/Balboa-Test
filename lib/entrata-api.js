// Entrata API client — thin wrapper around Entrata's JSON-RPC-style web services.
//
// This is ADDITIVE infrastructure for automating rent-roll / financial pulls.
// It does not run until the env vars below are set (see isConfigured()), so it
// cannot affect the existing manual-upload pipeline.
//
// Credentials (set in Vercel / .env.local once Entrata provisions API access):
//   ENTRATA_SUBDOMAIN   e.g. "balboa"  -> https://balboa.entrata.com/api/v1
//   ENTRATA_API_USER    API username from Entrata
//   ENTRATA_API_PW      API password from Entrata
//
// Entrata request shape (per Entrata API docs):
//   POST https://{subdomain}.entrata.com/api/v1/{webservice}
//   Headers: Authorization: Basic base64(user:pass), Content-Type: application/json
//   Body: { auth:{type:"basic"}, requestId:N, method:{ name, version, params } }
//   Reply: { response: { requestId, result } }  (errors arrive as { response:{ error } })
//
// NOTE: Exact report names, method versions, and result field keys must be
// confirmed against your account's live API once access is granted — every
// place that depends on them is marked CONFIRM. Keep those changes in
// entrata-rr-mapper.js where possible; this file stays format-agnostic.

export function isConfigured() {
  return Boolean(
    process.env.ENTRATA_SUBDOMAIN &&
    process.env.ENTRATA_API_USER &&
    process.env.ENTRATA_API_PW
  )
}

function baseUrl() {
  return `https://${process.env.ENTRATA_SUBDOMAIN}.entrata.com/api/v1`
}

function authHeader() {
  const raw = `${process.env.ENTRATA_API_USER}:${process.env.ENTRATA_API_PW}`
  return 'Basic ' + Buffer.from(raw).toString('base64')
}

let requestSeq = 0

// Core call: one Entrata web-service method. Returns the `result` object or throws.
export async function entrataRequest(webservice, methodName, params = {}, version = 'r1') {
  if (!isConfigured()) throw new Error('Entrata API not configured (missing ENTRATA_* env vars)')

  const res = await fetch(`${baseUrl()}/${webservice}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      auth: { type: 'basic' },
      requestId: ++requestSeq,
      method: { name: methodName, version, params },
    }),
  })

  if (!res.ok) {
    throw new Error(`Entrata ${webservice}.${methodName} HTTP ${res.status}: ${await res.text()}`)
  }

  const json = await res.json()
  const envelope = json?.response ?? json
  if (envelope?.error) {
    const e = envelope.error
    throw new Error(`Entrata ${webservice}.${methodName} error: ${e.code ?? ''} ${e.message ?? JSON.stringify(e)}`)
  }
  return envelope?.result ?? envelope
}

// List the properties on the account. Used to map Entrata property IDs -> your deals.
// CONFIRM: webservice/method names against live docs.
export async function getProperties() {
  const result = await entrataRequest('properties', 'getProperties', {}, 'r2')
  // CONFIRM: result.PhysicalProperty.Property is the documented path; normalize defensively.
  const list =
    result?.PhysicalProperty?.Property ??
    result?.properties?.property ??
    result?.properties ??
    []
  return Array.isArray(list) ? list : [list].filter(Boolean)
}

// Run a report and return its row data. Entrata reports are frequently ASYNC:
// the initial call returns a queueId, and you poll a queue endpoint for the
// finished payload. This handles both the sync and queued cases.
// CONFIRM: report name ("Rent Roll"), version, filter keys, and queue mechanics.
export async function runReport(reportName, filters = {}, { version = 'r3', maxPolls = 20, pollMs = 3000 } = {}) {
  const result = await entrataRequest('reports', 'getReportData', {
    reportName,
    reportVersion: version,
    filters,
  }, version)

  // Sync case: data came back immediately.
  if (result?.reportData) return result.reportData

  // Async case: a queue id was returned; poll until ready.
  const queueId = result?.queueId ?? result?.reportData?.queueId
  if (!queueId) {
    throw new Error(`Entrata report "${reportName}" returned no data and no queueId`)
  }

  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, pollMs))
    // CONFIRM: queue retrieval method/version. Entrata uses a "queue" service.
    const queued = await entrataRequest('queue', 'getResponse', { queueId }, 'r1')
    if (queued?.reportData) return queued.reportData
    if (queued?.status && /fail|error/i.test(String(queued.status))) {
      throw new Error(`Entrata report "${reportName}" failed in queue: ${queued.status}`)
    }
  }
  throw new Error(`Entrata report "${reportName}" not ready after ${maxPolls} polls`)
}
