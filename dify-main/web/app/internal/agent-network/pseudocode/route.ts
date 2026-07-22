import { z } from 'zod'

const diagnosticSchema = z.object({
  severity: z.enum(['warning', 'error']),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  nodeId: z.string().max(256).optional(),
}).strict()

const statsSchema = z.object({
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  branches: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
}).strict()

const deliverySchema = z.object({
  appId: z.string().min(1).max(128),
  appName: z.string().max(200).optional(),
  pseudocode: z.string().min(1).max(1_000_000),
  diagnostics: z.array(diagnosticSchema).max(1000),
  stats: statsSchema,
}).strict()

const DEFAULT_TIMEOUT_MS = 10_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 60_000

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return json({ code: 'CROSS_ORIGIN_REQUEST' }, 403)

  const input = deliverySchema.safeParse(await readJson(request))
  if (!input.success)
    return json({ code: 'INVALID_REQUEST' }, 400)

  const receiverUrl = resolveReceiverUrl(process.env.AGENT_NETWORK_PSEUDOCODE_URL)
  if (!receiverUrl)
    return json({ code: 'AGENT_NETWORK_NOT_CONFIGURED' }, 503)

  const deliveryId = crypto.randomUUID()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Dify-Delivery-Id': deliveryId,
  }
  const apiKey = process.env.AGENT_NETWORK_PSEUDOCODE_API_KEY?.trim()
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`

  const payload = {
    schema_version: '1.0',
    event: 'dify.workflow.pseudocode.generated',
    delivery_id: deliveryId,
    sent_at: new Date().toISOString(),
    app: {
      id: input.data.appId,
      ...(input.data.appName ? { name: input.data.appName } : {}),
    },
    pseudocode: input.data.pseudocode,
    diagnostics: input.data.diagnostics,
    stats: input.data.stats,
  }

  try {
    const response = await fetch(receiverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(resolveTimeout()),
    })
    if (!response.ok)
      return json({ code: 'AGENT_NETWORK_REJECTED' }, 502)
  }
  catch {
    return json({ code: 'AGENT_NETWORK_UNAVAILABLE' }, 502)
  }

  return json({ delivery_id: deliveryId, status: 'accepted' }, 202)
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(request.url).origin
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  }
  catch {
    return null
  }
}

function resolveReceiverUrl(value: string | undefined): string | null {
  if (!value?.trim())
    return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  }
  catch {
    return null
  }
}

function resolveTimeout(): number {
  const configured = Number(process.env.AGENT_NETWORK_PSEUDOCODE_TIMEOUT_MS)
  if (!Number.isFinite(configured))
    return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(configured)))
}

function json(body: Record<string, string>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}
