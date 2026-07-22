'use client'

import type { AgentNetworkReverseResult } from './types'
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
import { sendPseudocodeToAgentNetwork } from './send-pseudocode'
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
  const [activeAction, setActiveAction] = useState<'save' | 'execute' | null>(null)

  const handleOpen = useCallback(() => {
    setResult(exportPseudocode({ workflowName }))
    setOpen(true)
  }, [exportPseudocode, workflowName])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen)
      setResult(null)
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

      await sendPseudocodeToAgentNetwork({
        appId,
        appName: workflowName,
        pseudocode: nextResult.source,
        diagnostics: nextResult.diagnostics,
        stats: nextResult.stats,
      })
      toast.success(t('api.success'))
    }
    catch {
      toast.error(t('api.actionFailed'))
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
