export const AGENT_NETWORK_GROUPS = [
  'ReasoningGroup',
  'SearchGroup',
  'CalculatorGroup',
  'EmailGenerationGroup',
  'ClassificationGroup',
  'PlanningGroup',
  'ExtractionGroup',
  'SummarizationGroup',
] as const

export type AgentNetworkGroup = typeof AGENT_NETWORK_GROUPS[number]

export function isAgentNetworkGroup(value: unknown): value is AgentNetworkGroup {
  return typeof value === 'string' && AGENT_NETWORK_GROUPS.includes(value as AgentNetworkGroup)
}
