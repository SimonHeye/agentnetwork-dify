import { z } from 'zod'
import { readAgentNetworkErrorMessage } from '../error-response'
import { isSameOriginRequest } from '../same-origin'

const executeParamSchema = z.union([z.string(), z.number(), z.boolean()])

const requestSchema = z.object({
  task: z.string().trim().min(1).max(100_000),
  code: z.string().min(1).max(1_000_000),
  params: z.record(z.string(), executeParamSchema).optional().default({}),
  need_task: z.boolean().optional().default(false),
  need_match: z.boolean().optional().default(true),
  include_agents: z.boolean().optional().default(true),
}).strict()

const traceSchema = z.object({
  identifier: z.string(),
  vertex: z.string(),
  params: z.record(z.string(), z.unknown()),
  scalar: z.union([z.string(), z.number(), z.boolean()])
    .transform(value => typeof value === 'string' ? value : String(value)),
}).passthrough()

const agentNetworkResponseSchema = z.object({
  final_result: z.unknown(),
  context: z.record(z.string(), z.unknown()),
  trace: z.array(traceSchema),
  calls: z.number().int().nonnegative(),
}).passthrough()

const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 600_000

export async function POST(request: Request) {
  if (!isSameOriginRequest(request))
    return json({ code: 'CROSS_ORIGIN_REQUEST' }, 403)

  const input = requestSchema.safeParse(await readJson(request))
  if (!input.success)
    return json({ code: 'INVALID_REQUEST' }, 400)

  const executeUrl = resolveHttpUrl(process.env.AGENT_NETWORK_EXECUTE_URL)
  if (!executeUrl)
    return json({ code: 'AGENT_NETWORK_NOT_CONFIGURED' }, 503)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = (
    process.env.AGENT_NETWORK_EXECUTE_API_KEY
    || process.env.AGENT_NETWORK_API_KEY
  )?.trim()
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`

  try {
    const response = await fetch(executeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.data),
      cache: 'no-store',
      signal: AbortSignal.timeout(resolveTimeout()),
    })
    if (!response.ok) {
      const message = await readAgentNetworkErrorMessage(response)
      return json({
        code: 'AGENT_NETWORK_EXECUTION_FAILED',
        ...(message ? { message } : {}),
      }, 502)
    }

    const rawResult = await readJson(response)
    if (!isRecord(rawResult) || !Object.hasOwn(rawResult, 'final_result'))
      return json({ code: 'AGENT_NETWORK_INVALID_RESPONSE' }, 502)

    const result = agentNetworkResponseSchema.safeParse(rawResult)
    if (!result.success)
      return json({ code: 'AGENT_NETWORK_INVALID_RESPONSE' }, 502)

    return Response.json(result.data, {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  const configured = Number(process.env.AGENT_NETWORK_EXECUTE_TIMEOUT_MS)
  if (!Number.isFinite(configured))
    return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(configured)))
}

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}
