import { z } from 'zod'
import {
  claimNextAgentNetworkCommand,
  completeAgentNetworkCommand,
  enqueueAgentNetworkCommand,
  getAgentNetworkCommand,
} from '@/features/agent-network-workflow/command-store'
import { compileAgentNetworkPseudocode } from '@/features/agent-network-workflow/compiler'
import { AGENT_NETWORK_DEFAULT_MODEL } from '@/features/agent-network-workflow/constants'
import { AgentNetworkCompileError } from '@/features/agent-network-workflow/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const modelSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  mode: z.string().min(1),
  completion_params: z.record(z.string(), z.unknown()).optional(),
}).strict()

const postBodySchema = z.object({
  app_id: z.string().trim().min(1),
  source: z.string().trim().min(1).max(256 * 1024),
  model: modelSchema.optional(),
  preserve_positions: z.boolean().default(true),
  save_draft: z.boolean().default(true),
}).strict()

const patchBodySchema = z.object({
  command_id: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  error: z.string().optional(),
}).strict()

function json(data: unknown, status: number): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function isAuthorized(request: Request): boolean {
  const configuredKey = process.env.AGENT_NETWORK_API_KEY
  if (!configuredKey)
    return process.env.NODE_ENV !== 'production'
  return request.headers.get('authorization') === `Bearer ${configuredKey}`
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request))
    return json({ error: 'unauthorized' }, 401)

  let rawBody: unknown
  try {
    rawBody = await request.json()
  }
  catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const parsedBody = postBodySchema.safeParse(rawBody)
  if (!parsedBody.success) {
    return json({
      error: 'invalid_request',
      details: parsedBody.error.flatten(),
    }, 400)
  }

  const body = parsedBody.data
  try {
    const result = compileAgentNetworkPseudocode(body.source, {
      model: body.model ?? AGENT_NETWORK_DEFAULT_MODEL,
    })
    const command = enqueueAgentNetworkCommand({
      appId: body.app_id,
      graph: result.graph,
      warnings: result.warnings,
      preservePositions: body.preserve_positions,
      saveDraft: body.save_draft,
    })

    return json({
      command_id: command.id,
      status: command.status,
      warnings: command.warnings,
      node_count: command.graph.nodes.length,
      edge_count: command.graph.edges.length,
    }, 202)
  }
  catch (error) {
    if (error instanceof AgentNetworkCompileError) {
      return json({
        error: 'compile_failed',
        message: error.message,
        line: error.line,
      }, 422)
    }
    throw error
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const commandId = url.searchParams.get('command_id')
  if (commandId) {
    const command = getAgentNetworkCommand(commandId)
    if (!command)
      return json({ error: 'command_not_found' }, 404)
    return json({
      command_id: command.id,
      app_id: command.appId,
      status: command.status,
      warnings: command.warnings,
      error: command.error,
    }, 200)
  }

  const appId = url.searchParams.get('app_id')?.trim()
  if (!appId)
    return json({ error: 'app_id_required' }, 400)

  const command = claimNextAgentNetworkCommand(appId)
  if (!command)
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })

  return json({
    command_id: command.id,
    app_id: command.appId,
    status: command.status,
    graph: command.graph,
    warnings: command.warnings,
    preserve_positions: command.preservePositions,
    save_draft: command.saveDraft,
  }, 200)
}

export async function PATCH(request: Request): Promise<Response> {
  let rawBody: unknown
  try {
    rawBody = await request.json()
  }
  catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const parsedBody = patchBodySchema.safeParse(rawBody)
  if (!parsedBody.success)
    return json({ error: 'invalid_request' }, 400)

  const command = completeAgentNetworkCommand(parsedBody.data.command_id, {
    status: parsedBody.data.status,
    error: parsedBody.data.error,
  })
  if (!command)
    return json({ error: 'command_not_found' }, 404)

  return json({
    command_id: command.id,
    status: command.status,
    error: command.error,
  }, 200)
}
