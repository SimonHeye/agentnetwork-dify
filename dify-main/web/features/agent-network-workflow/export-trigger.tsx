'use client'

import type { AgentNetworkExecuteResult, AgentNetworkReverseResult } from './types'
import { Button } from '@langgenius/dify-ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@langgenius/dify-ui/dialog'
import { toast } from '@langgenius/dify-ui/toast'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNodesSyncDraft } from '@/app/components/workflow/hooks/use-nodes-sync-draft'
import {
  fetchAgentNetworkConversation,
  saveAgentNetworkExecutionResult,
} from './conversation-service'
import { executeAgentNetworkCode } from './execute-code'
import { AgentNetworkExecutionResult } from './execution-result'
import { formatAgentNetworkFinalResult } from './format-execute-result'
import { useAgentNetworkWorkflow } from './use-agent-network-workflow'

type AgentNetworkPseudocodeTriggerProps = {
  appId?: string
  workflowName?: string
}

export function AgentNetworkPseudocodeTrigger({ appId, workflowName }: AgentNetworkPseudocodeTriggerProps) {
  const { t } = useTranslation('common')
  const { doSyncWorkflowDraft } = useNodesSyncDraft()
  const { exportPseudocode } = useAgentNetworkWorkflow()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<AgentNetworkReverseResult | null>(null)
  const [executionResult, setExecutionResult] = useState<AgentNetworkExecuteResult | null>(null)
  const [activeAction, setActiveAction] = useState<'save' | 'execute' | null>(null)

  const handleOpen = useCallback(() => {
    setExecutionResult(null)
    setResult(exportPseudocode({ workflowName }))
    setOpen(true)
  }, [exportPseudocode, workflowName])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setResult(null)
      setExecutionResult(null)
    }
  }, [])

  const handleSave = useCallback(async () => {
    if (!appId || activeAction)
      return

    setActiveAction('save')
    try {
      let draftSaved = false
      await doSyncWorkflowDraft(false, {
        onSuccess: () => {
          draftSaved = true
        },
      })
      if (!draftSaved)
        throw new Error('DIFY_DRAFT_SAVE_FAILED')

      toast.success(t('api.saved'))
    }
    catch {
      toast.error(t('api.actionFailed'))
    }
    finally {
      setActiveAction(null)
    }
  }, [activeAction, appId, doSyncWorkflowDraft, t])

  const handleExecute = useCallback(async () => {
    if (!appId || activeAction)
      return
    setActiveAction('execute')
    try {
      const conversation = await fetchAgentNetworkConversation(appId)
      const executeTask = conversation.applied_task?.trim()
      if (!executeTask || !conversation.applied_message_id)
        throw new Error(t('agentNetworkChat.initialTaskMissing'))

      let draftSaved = false
      await doSyncWorkflowDraft(false, {
        onSuccess: () => {
          draftSaved = true
        },
      })
      if (!draftSaved)
        throw new Error('DIFY_DRAFT_SAVE_FAILED')

      const nextResult = exportPseudocode({ workflowName })
      setResult(nextResult)
      if (!nextResult.source) {
        setOpen(true)
        toast.error(t('api.actionFailed'))
        return
      }

      const nextExecutionResult = await executeAgentNetworkCode({
        task: executeTask,
        code: nextResult.source,
        params: {},
        need_task: false,
        need_match: false,
        include_agents: true,
      })
      setExecutionResult(nextExecutionResult)
      setOpen(true)
      await saveAgentNetworkExecutionResult(
        appId,
        conversation.applied_message_id,
        nextExecutionResult,
      )
      const finalResult = formatAgentNetworkFinalResult(nextExecutionResult.finalResult)
      toast.success(finalResult || t('api.success'))
    }
    catch (error) {
      const message = error instanceof Error ? error.message : t('api.actionFailed')
      toast.error(message === 'DIFY_DRAFT_SAVE_FAILED' ? t('api.actionFailed') : message)
    }
    finally {
      setActiveAction(null)
    }
  }, [activeAction, appId, doSyncWorkflowDraft, exportPseudocode, t, workflowName])

  const diagnostics = result?.diagnostics ?? []

  return (
    <>
      <Button variant="secondary" disabled={!appId || activeAction !== null} loading={activeAction === 'save'} onClick={handleSave}>
        <span aria-hidden="true" className="mr-1 i-ri-save-line size-4" />
        {t('operation.save')}
      </Button>
      <Button variant="secondary" disabled={!appId || activeAction !== null} loading={activeAction === 'execute'} onClick={handleExecute}>
        <span aria-hidden="true" className="mr-1 i-ri-play-line size-4" />
        {t('operation.execute')}
      </Button>
      <Button variant="secondary" disabled={!appId} onClick={handleOpen}>
        <span aria-hidden="true" className="mr-1 i-ri-file-code-line size-4" />
        {t('operation.view')}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(880px,calc(100vw-2rem))] max-w-none! flex-col overflow-hidden! p-0!">
          <div className="shrink-0 border-b border-divider-regular px-6 py-5">
            <DialogTitle className="title-2xl-semi-bold text-text-primary">
              Python
            </DialogTitle>
            <DialogDescription className="sr-only">
              Agent Network Python
            </DialogDescription>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {result?.source && (
              <pre className="overflow-x-auto rounded-lg bg-background-section-burn p-4 font-mono text-xs leading-5 text-text-primary">
                <code>{result.source}</code>
              </pre>
            )}

            {executionResult && (
              <section className={result?.source ? 'mt-5' : undefined}>
                <AgentNetworkExecutionResult result={executionResult.finalResult} />
                {executionResult.trace.length > 0 && (
                  <div className="mt-5">
                    <div className="mb-2 system-sm-semibold text-text-secondary">trace</div>
                    <ol className="space-y-2">
                      {executionResult.trace.map(item => (
                        <li key={`${item.identifier}-${item.vertex}-${item.scalar}`} className="rounded-lg bg-background-section px-4 py-3 font-mono text-xs text-text-secondary">
                          <span className="font-semibold text-text-primary">{item.identifier}</span>
                          <span>{`: ${item.scalar}`}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </section>
            )}

            {diagnostics.length > 0 && (
              <ul className="mt-5 space-y-2">
                {diagnostics.map(item => (
                  <li
                    key={`${item.code}-${item.nodeId ?? 'graph'}-${item.message}`}
                    className="flex gap-2 text-sm text-text-secondary"
                  >
                    <span
                      className={item.severity === 'error'
                        ? 'font-semibold text-text-destructive'
                        : 'font-semibold text-text-warning'}
                    >
                      {item.code}
                    </span>
                    <span>
                      {item.message}
                      {item.nodeId ? ` [${item.nodeId}]` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}

          </div>

          <div className="flex shrink-0 justify-end gap-2 border-t border-divider-regular px-6 py-4">
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              {t('operation.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
