import { z } from 'zod'
import { isSameOriginRequest } from '../same-origin'

const requestSchema = z.object({
  appId: z.string().min(1).max(128),
  task: z.string().trim().min(1).max(100_000),
}).strict()

const agentNetworkResponseSchema = z.object({
  request_id: z.string().min(1).max(256).optional(),
  pseudocode: z.string().trim().min(1).max(1_000_000),
}).passthrough()

const DEFAULT_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000

export async function POST(request: Request) {
  if (!isSameOriginRequest(request))
    return json({ code: 'CROSS_ORIGIN_REQUEST' }, 403)

  const input = requestSchema.safeParse(await readJson(request))
  if (!input.success)
    return json({ code: 'INVALID_REQUEST' }, 400)

  const planUrl = resolveHttpUrl(process.env.AGENT_NETWORK_PLAN_URL)
  if (!planUrl)
    return json({ code: 'AGENT_NETWORK_NOT_CONFIGURED' }, 503)

  const requestId = crypto.randomUUID()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Dify-Request-Id': requestId,
  }
  const apiKey = (
    process.env.AGENT_NETWORK_PLAN_API_KEY
    || process.env.AGENT_NETWORK_PSEUDOCODE_API_KEY
  )?.trim()
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`

  try {
    const response = await fetch(planUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        schema_version: '1.0',
        request_id: requestId,
        app_id: input.data.appId,
        task: input.data.task,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(resolveTimeout()),
    })
    if (!response.ok)
      return json({ code: 'AGENT_NETWORK_REJECTED' }, 502)

    const result = agentNetworkResponseSchema.safeParse(await readJson(response))
    if (!result.success)
      return json({ code: 'AGENT_NETWORK_INVALID_RESPONSE' }, 502)

    return Response.json({
      request_id: result.data.request_id || requestId,
      pseudocode: result.data.pseudocode,
    }, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  catch {
    return json({ code: 'AGENT_NETWORK_UNAVAILABLE' }, 502)
  }
}

async function readJson(request: Request | Response): Promise<unknown> {
  try {
    return await request.json()
  }
  catch {
    return null
  }
}

function resolveHttpUrl(value: string | undefined): string | null {
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
  const configured = Number(process.env.AGENT_NETWORK_PLAN_TIMEOUT_MS)
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
