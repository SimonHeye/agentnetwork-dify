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
