import type { AgentNetworkExecuteResult } from './types'
import { executeAgentNetworkCode } from './execute-code'

export type GeneratedAgentNetworkExecution = {
  execution: AgentNetworkExecuteResult
  finalResult: unknown
}

type RunGeneratedAgentNetworkWorkflowInput = {
  task: string
  pseudocode: string
}

export async function runGeneratedAgentNetworkWorkflow({
  task,
  pseudocode,
}: RunGeneratedAgentNetworkWorkflowInput): Promise<GeneratedAgentNetworkExecution> {
  const execution = await executeAgentNetworkCode({
    task,
    code: pseudocode,
    params: {},
    need_task: false,
    need_match: false,
    include_agents: true,
  })

  return {
    execution,
    finalResult: execution.finalResult,
  }
}
