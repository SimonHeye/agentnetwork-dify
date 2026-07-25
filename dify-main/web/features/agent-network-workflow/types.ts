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

export type AgentNetworkReverseDiagnostic = {
  severity: 'warning' | 'error'
  code: string
  message: string
  nodeId?: string
}

export type AgentNetworkReverseStats = {
  nodes: number
  edges: number
  agents: number
  branches: number
  skills: number
}

export type AgentNetworkReverseOptions = {
  workflowName?: string
}

export type AgentNetworkReverseResult = {
  source: string | null
  fileName: string
  diagnostics: AgentNetworkReverseDiagnostic[]
  stats: AgentNetworkReverseStats
}

export type AgentNetworkExecuteParam = string | number | boolean

export type AgentNetworkExecuteInput = {
  task: string
  code: string
  params?: Record<string, AgentNetworkExecuteParam>
  need_task?: boolean
  need_match?: boolean
  include_agents?: boolean
}

export type AgentNetworkExecuteTrace = {
  identifier: string
  vertex: string
  params: Record<string, unknown>
  scalar: string
}

export type AgentNetworkExecuteResult = {
  finalResult: unknown
  context: Record<string, unknown>
  trace: AgentNetworkExecuteTrace[]
  calls: number
}

export class AgentNetworkCompileError extends Error {
  line: number | null

  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `Line ${line}: ${message}`)
    this.name = 'AgentNetworkCompileError'
    this.line = line
  }
}
