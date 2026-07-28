import type { AgentNetworkExecuteResult } from './types'
// eslint-disable-next-line no-restricted-imports
import { get, post } from '@/service/base'

export type AgentNetworkConversation = {
  id: string
  tenant_id: string
  app_id: string
  created_by: string
  applied_message_id?: string | null
  applied_task?: string | null
  created_at: number
  updated_at: number
}

export type AgentNetworkMessageRole = 'user' | 'assistant' | 'error'
export type AgentNetworkMessageStatus = 'success' | 'failed'
export type AgentNetworkApplyStatus = 'not_applied' | 'applied' | 'apply_failed'

export type AgentNetworkMessage = {
  id: string
  conversation_id: string
  parent_message_id?: string | null
  role: AgentNetworkMessageRole
  status: AgentNetworkMessageStatus
  apply_status?: AgentNetworkApplyStatus | null
  content: string
  pseudocode?: string | null
  nodes_count?: number | null
  edges_count?: number | null
  draft_hash_before?: string | null
  draft_hash_after?: string | null
  error_code?: string | null
  error_message?: string | null
  meta?: Record<string, unknown> & {
    agent_network_execution?: {
      final_result: unknown
      context: Record<string, unknown>
      trace: AgentNetworkExecuteResult['trace']
      calls: number
    }
  }
  created_at: number
  updated_at: number
}

export type AgentNetworkMessagesResponse = {
  conversation: AgentNetworkConversation
  data: AgentNetworkMessage[]
  has_more?: boolean
}

export type CreateAgentNetworkMessagePayload = {
  role: AgentNetworkMessageRole
  status?: AgentNetworkMessageStatus
  apply_status?: Exclude<AgentNetworkApplyStatus, 'applied'> | null
  content: string
  parent_message_id?: string | null
  pseudocode?: string | null
  nodes_count?: number | null
  edges_count?: number | null
  draft_hash_before?: string | null
  draft_hash_after?: string | null
  error_code?: string | null
  error_message?: string | null
  meta?: Record<string, unknown>
}

export type ApplyFailedAgentNetworkMessagePayload = {
  error_code?: string
  error_message: string
}

export type ApplyAgentNetworkMessagePayload = {
  nodes_count: number
  edges_count: number
  draft_hash_before?: string | null
  draft_hash_after?: string | null
}

export async function fetchAgentNetworkConversation(appId: string) {
  return get<AgentNetworkConversation>(
    `/apps/${appId}/agent-network/conversation`,
    {},
    { silent: true },
  )
}

export async function fetchAgentNetworkMessages(appId: string) {
  return get<AgentNetworkMessagesResponse>(
    `/apps/${appId}/agent-network/conversation/messages`,
    {},
    { silent: true },
  )
}

export async function createAgentNetworkMessage(
  appId: string,
  payload: CreateAgentNetworkMessagePayload,
) {
  return post<AgentNetworkMessage>(
    `/apps/${appId}/agent-network/conversation/messages`,
    { body: payload },
    { silent: true },
  )
}

export async function markAgentNetworkMessageApplied(
  appId: string,
  messageId: string,
  payload: ApplyAgentNetworkMessagePayload,
) {
  return post<{
    conversation: AgentNetworkConversation
    message: AgentNetworkMessage
  }>(
    `/apps/${appId}/agent-network/conversation/messages/${messageId}/apply`,
    { body: payload },
    { silent: true },
  )
}

export async function markAgentNetworkMessageApplyFailed(
  appId: string,
  messageId: string,
  payload: ApplyFailedAgentNetworkMessagePayload,
) {
  return post<{ message: AgentNetworkMessage }>(
    `/apps/${appId}/agent-network/conversation/messages/${messageId}/apply-failed`,
    { body: payload },
    { silent: true },
  )
}

export async function saveAgentNetworkExecutionResult(
  appId: string,
  messageId: string,
  execution: AgentNetworkExecuteResult,
) {
  return post<{ message: AgentNetworkMessage }>(
    `/apps/${appId}/agent-network/conversation/messages/${messageId}/execution-result`,
    {
      body: {
        final_result: execution.finalResult,
        context: execution.context,
        trace: execution.trace,
        calls: execution.calls,
      },
    },
    { silent: true },
  )
}

export async function clearAgentNetworkMessages(appId: string) {
  return post<AgentNetworkMessagesResponse>(
    `/apps/${appId}/agent-network/conversation/messages/clear`,
    { body: {} },
    { silent: true },
  )
}
