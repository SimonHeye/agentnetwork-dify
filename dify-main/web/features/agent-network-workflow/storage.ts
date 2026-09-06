import { createLocalStorageState } from 'foxact/create-local-storage-state'

export type AgentNetworkTaskContext = {
  initialTask: string
  executeTask?: string
}

type AgentNetworkTaskContexts = Record<string, AgentNetworkTaskContext>

const [
  useAgentNetworkInitialTasks,
  _useAgentNetworkInitialTasksValue,
  _useSetAgentNetworkInitialTasks,
] = createLocalStorageState<AgentNetworkTaskContexts>('agent-network-task-contexts', {})

export {
  useAgentNetworkInitialTasks,
}

const SAVED_PSEUDOCODE_KEY = 'agent-network-saved-pseudocode'

export function getAgentNetworkSavedPseudocode(appId: string): string | undefined {
  if (typeof window === 'undefined') return undefined
  return window.localStorage.getItem(SAVED_PSEUDOCODE_KEY + `:${appId}`) ?? undefined
}

export function setAgentNetworkSavedPseudocode(appId: string, pseudocode: string): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(SAVED_PSEUDOCODE_KEY + `:${appId}`, pseudocode)
}
