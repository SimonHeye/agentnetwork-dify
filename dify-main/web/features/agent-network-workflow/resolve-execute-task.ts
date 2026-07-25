import type { AgentNetworkTaskContext } from './storage'

export function resolveAgentNetworkExecuteTask(
  context: AgentNetworkTaskContext | undefined,
): string | null {
  const executeTask = context?.executeTask?.trim()
  if (executeTask)
    return executeTask
  return context?.initialTask.trim() || null
}
