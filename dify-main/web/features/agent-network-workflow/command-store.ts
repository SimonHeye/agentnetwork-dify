import type { AgentNetworkCompileResult } from './types'

export type AgentNetworkCommandStatus = 'pending' | 'processing' | 'completed' | 'failed'

export type AgentNetworkCompiledCommand = {
  id: string
  appId: string
  graph: AgentNetworkCompileResult['graph']
  warnings: string[]
  preservePositions: boolean
  saveDraft: boolean
  status: AgentNetworkCommandStatus
  error?: string
  createdAt: number
  updatedAt: number
}

type EnqueueCommandInput = Pick<
  AgentNetworkCompiledCommand,
  'appId' | 'graph' | 'warnings' | 'preservePositions' | 'saveDraft'
>

type CompleteCommandInput = {
  status: Extract<AgentNetworkCommandStatus, 'completed' | 'failed'>
  error?: string
}

type CommandStoreState = {
  commands: Map<string, AgentNetworkCompiledCommand>
}

const COMMAND_TTL_MS = 10 * 60 * 1000
const globalCommandStore = globalThis as typeof globalThis & {
  __difyAgentNetworkCommandStore?: CommandStoreState
}

function getStore(): CommandStoreState {
  globalCommandStore.__difyAgentNetworkCommandStore ??= { commands: new Map() }
  return globalCommandStore.__difyAgentNetworkCommandStore
}

function removeExpiredCommands(now: number): void {
  for (const [id, command] of getStore().commands) {
    if (now - command.updatedAt > COMMAND_TTL_MS)
      getStore().commands.delete(id)
  }
}

export function enqueueAgentNetworkCommand(input: EnqueueCommandInput): AgentNetworkCompiledCommand {
  const now = Date.now()
  removeExpiredCommands(now)
  const command: AgentNetworkCompiledCommand = {
    ...input,
    id: crypto.randomUUID(),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
  getStore().commands.set(command.id, command)
  return command
}

export function claimNextAgentNetworkCommand(appId: string): AgentNetworkCompiledCommand | undefined {
  const now = Date.now()
  removeExpiredCommands(now)
  const command = [...getStore().commands.values()]
    .find(item => item.appId === appId && item.status === 'pending')
  if (!command)
    return undefined

  command.status = 'processing'
  command.updatedAt = now
  return command
}

export function completeAgentNetworkCommand(
  commandId: string,
  result: CompleteCommandInput,
): AgentNetworkCompiledCommand | undefined {
  const command = getStore().commands.get(commandId)
  if (!command)
    return undefined

  command.status = result.status
  command.error = result.error
  command.updatedAt = Date.now()
  return command
}

export function getAgentNetworkCommand(commandId: string): AgentNetworkCompiledCommand | undefined {
  removeExpiredCommands(Date.now())
  return getStore().commands.get(commandId)
}

export function resetAgentNetworkCommandStore(): void {
  getStore().commands.clear()
}
