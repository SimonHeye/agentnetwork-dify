import type {
  AgentNetworkReverseOptions,
  AgentNetworkReverseResult,
} from './types'
import type { WorkflowDataUpdater } from '@/app/components/workflow/types'
import { compileAllDifyNodesToAgentNetworkPseudocode } from './graph-to-pseudocode'

export function compileDifyGraphToAgentNetworkPseudocode(
  graph: WorkflowDataUpdater,
  options: AgentNetworkReverseOptions = {},
): AgentNetworkReverseResult {
  return compileAllDifyNodesToAgentNetworkPseudocode(graph, options)
}
