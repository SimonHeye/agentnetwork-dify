import { z } from 'zod'
import { readAgentNetworkErrorMessage } from '../error-response'
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
const DIFY_GRAPH_COMPATIBILITY_INSTRUCTIONS = [
  'The pseudocode will be converted into a Dify workflow graph.',
  'AgentNetwork node calls return scalarized PseudoResult strings. Compare assigned variables directly; never access .value, .raw, or .get() on a node result.',
  'Do not use the json module. Use scalarized node results directly.',
  'For iteration, use exactly: results = []; for index, item in enumerate(iterator): ...; results.append(one_node_result).',
  'For a counted loop, use exactly: for index in range(POSITIVE_INTEGER): ... . Avoid while loops because their runtime semantics cannot be preserved by Dify.',
  'Do not use import, def, class, lambda, file, network, or system operations.',
  'Assign the final output to final_result.',
].join('\n')

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
        extra_instructions: mergeCompatibilityInstructions(input.data.extraInstructions),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(resolveTimeout()),
    })
    if (!response.ok) {
      const message = await readAgentNetworkErrorMessage(response)
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

function mergeCompatibilityInstructions(extraInstructions?: string): string {
  return extraInstructions
    ? `${DIFY_GRAPH_COMPATIBILITY_INSTRUCTIONS}\n\nAdditional planning constraints:\n${extraInstructions}`
    : DIFY_GRAPH_COMPATIBILITY_INSTRUCTIONS
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
