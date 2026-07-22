import type { AgentNetworkModelConfig } from './types'

export const AGENT_NETWORK_DEFAULT_MODEL: AgentNetworkModelConfig = {
  provider: 'langgenius/deepseek/deepseek',
  name: 'deepseek-chat',
  mode: 'chat',
  completion_params: {},
}

export const AGENT_NETWORK_COMMAND_POLL_INTERVAL = 1000
