'use client'

import { queryOptions, useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useStore as useAppStore } from '@/app/components/app/store'
import { useNodesReadOnly } from '@/app/components/workflow/hooks/use-workflow'
import {
  completeAgentNetworkGraphCommand,
  fetchPendingAgentNetworkGraphCommand,
} from './command-client'
import { AGENT_NETWORK_COMMAND_POLL_INTERVAL } from './constants'
import { useAgentNetworkWorkflow } from './use-agent-network-workflow'

export function AgentNetworkCommandConsumer() {
  const appId = useAppStore(state => state.appDetail?.id)
  const { nodesReadOnly } = useNodesReadOnly()
  const { applyCompiledGraph } = useAgentNetworkWorkflow()
  const processingCommandIdRef = useRef<string | null>(null)
  const canConsume = Boolean(appId) && !nodesReadOnly

  const { data: command } = useQuery(queryOptions({
    queryKey: ['agent-network', 'compiled-graph-command', appId],
    queryFn: ({ signal }) => appId
      ? fetchPendingAgentNetworkGraphCommand(appId, signal)
      : Promise.resolve(null),
    enabled: canConsume,
    refetchInterval: AGENT_NETWORK_COMMAND_POLL_INTERVAL,
    refetchIntervalInBackground: true,
    retry: false,
  }))

  useEffect(() => {
    if (!command || processingCommandIdRef.current === command.command_id)
      return

    processingCommandIdRef.current = command.command_id
    const applyCommand = async () => {
      let completion: Parameters<typeof completeAgentNetworkGraphCommand>[1]
      try {
        await applyCompiledGraph(command.graph, {
          preservePositions: command.preserve_positions,
          saveDraft: command.save_draft,
        })
        completion = { status: 'completed' }
      }
      catch (error) {
        completion = {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }
      }
      await completeAgentNetworkGraphCommand(command.command_id, completion)
    }

    void applyCommand()
  }, [applyCompiledGraph, command])

  return null
}
