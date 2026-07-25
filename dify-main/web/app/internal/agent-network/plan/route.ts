import { z } from 'zod'
import { isSameOriginRequest } from '../same-origin'

const requestSchema = z.object({
  appId: z.string().min(1).max(128),
  task: z.string().trim().min(1).max(100_000),
  includeAgents: z.boolean().optional().default(false),
  model: z.string().trim().min(1).max(200).optional(),
  extraInstructions: z.string().trim().min(1).max(100_000).optional(),
}).strict()

const agentNetworkResponseSchema = z.object({
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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = (
    process.env.AGENT_NETWORK_PLAN_API_KEY
    || process.env.AGENT_NETWORK_API_KEY
  )?.trim()
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`

  try {
    const response = await fetch(planUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        task: input.data.task,
        include_agents: input.data.includeAgents,
        ...(input.data.model ? { model: input.data.model } : {}),
        ...(input.data.extraInstructions ? { extra_instructions: input.data.extraInstructions } : {}),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(resolveTimeout()),
    })
    if (!response.ok) {
      const message = await readErrorMessage(response)
      return json({ code: 'AGENT_NETWORK_REJECTED', ...(message ? { message } : {}) }, 502)
    }

    const result = agentNetworkResponseSchema.safeParse(await readJson(response))
    if (!result.success)
      return json({ code: 'AGENT_NETWORK_INVALID_RESPONSE' }, 502)

    return Response.json({
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


async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const message = (await response.text()).trim()
    return message ? message.slice(0, 10_000) : null
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
