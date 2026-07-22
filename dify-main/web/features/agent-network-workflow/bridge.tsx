'use client'

import type {
  AgentNetworkCompileResult,
} from './types'
import type { ApplyAgentNetworkPseudocodeOptions } from './use-agent-network-workflow'
import { useEffect } from 'react'
import { useAgentNetworkWorkflow } from './use-agent-network-workflow'

export type DifyAgentNetworkWorkflowApi = {
  applyPseudocode: (
    source: string,
    options?: ApplyAgentNetworkPseudocodeOptions,
  ) => Promise<AgentNetworkCompileResult>
}

type AgentNetworkWindow = Window & typeof globalThis & {
  difyAgentNetworkWorkflow?: DifyAgentNetworkWorkflowApi
}

export function AgentNetworkWorkflowBridge() {
  const { applyPseudocode } = useAgentNetworkWorkflow()

  useEffect(() => {
    const browserWindow = window as AgentNetworkWindow
    const api: DifyAgentNetworkWorkflowApi = { applyPseudocode }
    browserWindow.difyAgentNetworkWorkflow = api

    return () => {
      if (browserWindow.difyAgentNetworkWorkflow === api)
        delete browserWindow.difyAgentNetworkWorkflow
    }
  }, [applyPseudocode])

  return null
}
