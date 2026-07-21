import type { WorkflowDataUpdater } from '@/app/components/workflow/types'

export type AgentNetworkModelConfig = {
  provider: string
  name: string
  mode: string
  completion_params?: Record<string, unknown>
}

export type AgentNetworkGroupOverride = {
  title?: string
  model?: AgentNetworkModelConfig
  defaultConfig?: Record<string, unknown>
}

export type AgentNetworkCompileOptions = {
  model?: AgentNetworkModelConfig
  llmDefaultConfig?: Record<string, unknown>
  groupOverrides?: Record<string, AgentNetworkGroupOverride>
  inputTypes?: Record<string, string>
  terminalFunctions?: string[]
}

export type AgentNetworkCompileResult = {
  graph: WorkflowDataUpdater
  warnings: string[]
}

export class AgentNetworkCompileError extends Error {
  line: number | null

  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `Line ${line}: ${message}`)
    this.name = 'AgentNetworkCompileError'
    this.line = line
  }
}
