'use client'

import type { AgentNetworkConversation, AgentNetworkMessage } from './conversation-service'
import type { AgentNetworkExecuteResult } from './types'
import { Button } from '@langgenius/dify-ui/button'
import { cn } from '@langgenius/dify-ui/cn'
import { Textarea } from '@langgenius/dify-ui/textarea'
import { toast } from '@langgenius/dify-ui/toast'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore as useAppStore } from '@/app/components/app/store'
import { useNodesSyncDraft } from '@/app/components/workflow/hooks/use-nodes-sync-draft'
import { useNodesReadOnly } from '@/app/components/workflow/hooks/use-workflow'
import { usePathname, useRouter } from '@/next/navigation'
import { AgentNetworkExecutionResult } from './execution-result'
import { executeAgentNetworkCode } from './execute-code'
import {

  clearAgentNetworkMessages,
  createAgentNetworkMessage,
  fetchAgentNetworkMessages,
  markAgentNetworkMessageApplied,
  markAgentNetworkMessageApplyFailed,
  saveAgentNetworkExecutionResult,
} from './conversation-service'
import { requestAgentNetworkPlan } from './request-plan'
import { formatAgentNetworkFinalResult } from './format-execute-result'
import { useAgentNetworkWorkflow } from './use-agent-network-workflow'

type Message = {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  pseudocode?: string | null
  state?: 'pending' | 'success' | 'error'
  apply_status?: 'not_applied' | 'applied' | 'apply_failed' | null
  nodes_count?: number | null
  edges_count?: number | null
  draft_hash_before?: string | null
  draft_hash_after?: string | null
  error_code?: string | null
  error_message?: string | null
  executionResult?: AgentNetworkExecuteResult
  created_at?: number
  updated_at?: number
}

function fromPersistedMessage(message: AgentNetworkMessage): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    pseudocode: message.pseudocode,
    state: message.role === 'error' || message.status === 'failed' ? 'error' : 'success',
    apply_status: message.apply_status,
    nodes_count: message.nodes_count,
    edges_count: message.edges_count,
    draft_hash_before: message.draft_hash_before,
    draft_hash_after: message.draft_hash_after,
    error_code: message.error_code,
    error_message: message.error_message,
    executionResult: message.meta?.agent_network_execution
      ? {
          finalResult: message.meta.agent_network_execution.final_result,
          context: message.meta.agent_network_execution.context,
          trace: message.meta.agent_network_execution.trace,
          calls: message.meta.agent_network_execution.calls,
        }
      : undefined,
    created_at: message.created_at,
    updated_at: message.updated_at,
  }
}

export function AgentNetworkChatPanel() {
  const { t } = useTranslation('common')
  const pathname = usePathname()
  const router = useRouter()
  const appId = useAppStore(state => state.appDetail?.id)
  const { doSyncWorkflowDraft } = useNodesSyncDraft()
  const { nodesReadOnly } = useNodesReadOnly()
  const { applyPseudocode, exportPseudocode } = useAgentNetworkWorkflow()
  const [conversation, setConversation] = useState<AgentNetworkConversation | null>(null)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [applyingMessageId, setApplyingMessageId] = useState<string | null>(null)
  const [executingMessageId, setExecutingMessageId] = useState<string | null>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const isOpen = pathname.endsWith('/agent-network')

  const isBusy = isSubmitting || !!applyingMessageId || !!executingMessageId

  const loadHistory = useCallback(async () => {
    if (!appId)
      return

    setIsLoadingHistory(true)
    setHistoryError(null)
    try {
      const result = await fetchAgentNetworkMessages(appId)
      setConversation(result.conversation)
      setMessages(result.data.map(fromPersistedMessage))
    }
    catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error))
    }
    finally {
      setIsLoadingHistory(false)
    }
  }, [appId])

  useEffect(() => {
    if (!isOpen || !appId)
      return

    void loadHistory()
  }, [appId, isOpen, loadHistory])

  useEffect(() => {
    if (isOpen)
      messageEndRef.current?.scrollIntoView({ block: 'end' })
  }, [isOpen, messages])

  const appliedMessageId = conversation?.applied_message_id

  const hasMessages = messages.length > 0

  const canSend = useMemo(() => {
    return !!input.trim() && !!appId && !nodesReadOnly && !isBusy
  }, [appId, input, isBusy, nodesReadOnly])

  if (!isOpen)
    return null

  const close = () => {
    if (appId)
      router.push(`/app/${appId}/workflow`)
  }

  const replaceMessage = (id: string, next: Message) => {
    setMessages(current => current.map(message => message.id === id ? next : message))
  }

  const appendMessage = (message: Message) => {
    setMessages(current => [...current, message])
  }

  const submit = async () => {
    const task = input.trim()
    if (!task || !appId || isSubmitting || nodesReadOnly)
      return

    const userMessageId = crypto.randomUUID()
    const assistantMessageId = crypto.randomUUID()
    let savedUserMessageId: string | undefined

    setInput('')
    setIsSubmitting(true)
    appendMessage({
      id: userMessageId,
      role: 'user',
      content: task,
      state: 'success',
    })
    appendMessage({
      id: assistantMessageId,
      role: 'assistant',
      content: t('agentNetworkChat.planning'),
      state: 'pending',
    })

    try {
      const savedUserMessage = await createAgentNetworkMessage(appId, {
        role: 'user',
        status: 'success',
        content: task,
      })
      savedUserMessageId = savedUserMessage.id
      replaceMessage(userMessageId, fromPersistedMessage(savedUserMessage))

      const plan = await requestAgentNetworkPlan({ appId, task })
      const savedAssistantMessage = await createAgentNetworkMessage(appId, {
        role: 'assistant',
        status: 'success',
        apply_status: 'not_applied',
        content: t('agentNetworkChat.planReady'),
        pseudocode: plan.pseudocode,
        parent_message_id: savedUserMessage.id,
      })

      replaceMessage(assistantMessageId, fromPersistedMessage(savedAssistantMessage))
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)

      try {
        const savedErrorMessage = await createAgentNetworkMessage(appId, {
          role: 'error',
          status: 'failed',
          content: t('agentNetworkChat.failed', { reason }),
          parent_message_id: savedUserMessageId,
          error_code: reason,
          error_message: reason,
        })
        replaceMessage(assistantMessageId, fromPersistedMessage(savedErrorMessage))
      }
      catch {
        replaceMessage(assistantMessageId, {
          id: assistantMessageId,
          role: 'error',
          content: t('agentNetworkChat.failed', { reason }),
          state: 'error',
          error_code: reason,
          error_message: reason,
        })
      }
    }
    finally {
      setIsSubmitting(false)
    }
  }
  const applyMessageToCanvas = async (message: Message) => {
    if (!appId || !message.pseudocode || nodesReadOnly || applyingMessageId)
      return

    // eslint-disable-next-line no-alert
    const confirmed = window.confirm(t('agentNetworkChat.applyConfirm'))
    if (!confirmed)
      return

    setApplyingMessageId(message.id)

    try {
      let result
      try {
        result = await applyPseudocode(message.pseudocode, {
          preservePositions: false,
          saveDraft: true,
        })
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        try {
          const response = await markAgentNetworkMessageApplyFailed(appId, message.id, {
            error_code: 'APPLY_FAILED',
            error_message: reason,
          })
          replaceMessage(message.id, fromPersistedMessage(response.message))
        }
        catch {
          replaceMessage(message.id, {
            ...message,
            apply_status: 'apply_failed',
            error_code: 'APPLY_FAILED',
            error_message: reason,
          })
        }
        appendMessage({
          id: crypto.randomUUID(),
          role: 'error',
          content: t('agentNetworkChat.applyFailed', { reason }),
          state: 'error',
          error_code: 'APPLY_FAILED',
          error_message: reason,
        })
        return
      }

      try {
        const response = await markAgentNetworkMessageApplied(appId, message.id, {
          nodes_count: result.graph.nodes.length,
          edges_count: result.graph.edges.length,
          draft_hash_before: message.draft_hash_before ?? null,
          draft_hash_after: null,
        })

        setConversation(response.conversation)
        setMessages(current => current.map((item) => {
          if (item.id === response.message.id)
            return fromPersistedMessage(response.message)
          if (item.apply_status === 'applied')
            return { ...item, apply_status: 'not_applied' }
          return item
        }))
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        appendMessage({
          id: crypto.randomUUID(),
          role: 'error',
          content: t('agentNetworkChat.applyStateSaveFailed', { reason }),
          state: 'error',
          error_code: 'APPLY_STATE_SAVE_FAILED',
          error_message: reason,
        })
        try {
          await loadHistory()
        }
        catch {
          // The canvas is already saved. A later refresh can reconcile database state.
        }
      }
    }
    finally {
      setApplyingMessageId(null)
    }
  }
  const executeCurrentCanvas = async (message: Message) => {
    const executeTask = conversation?.applied_task?.trim()
    if (
      !appId
      || !executeTask
      || appliedMessageId !== message.id
      || nodesReadOnly
      || executingMessageId
    )
      return

    setExecutingMessageId(message.id)
    try {
      let draftSaved = false
      await doSyncWorkflowDraft(false, {
        onSuccess: () => {
          draftSaved = true
        },
      })
      if (!draftSaved)
        throw new Error('DIFY_DRAFT_SAVE_FAILED')

      const generated = exportPseudocode()
      if (!generated.source)
        throw new Error(t('api.actionFailed'))

      const execution = await executeAgentNetworkCode({
        task: executeTask,
        code: generated.source,
        params: {},
        need_task: false,
        need_match: false,
        include_agents: true,
      })

      replaceMessage(message.id, {
        ...message,
        executionResult: execution,
      })
      const response = await saveAgentNetworkExecutionResult(appId, message.id, execution)
      replaceMessage(message.id, fromPersistedMessage(response.message))

      const finalResult = formatAgentNetworkFinalResult(execution.finalResult)
      toast.success(finalResult || t('api.success'))
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : t('api.actionFailed')
      toast.error(reason === 'DIFY_DRAFT_SAVE_FAILED' ? t('api.actionFailed') : reason)
    }
    finally {
      setExecutingMessageId(null)
    }
  }

  const clearHistory = async () => {
    if (!appId || isBusy || !hasMessages)
      return

    // eslint-disable-next-line no-alert
    const confirmed = window.confirm(t('agentNetworkChat.clearConfirm'))
    if (!confirmed)
      return

    try {
      const result = await clearAgentNetworkMessages(appId)
      setConversation(result.conversation)
      setMessages([])
      setHistoryError(null)
    }
    catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error))
    }
  }
  const getDisplayContent = (message: Message) => {
    const isApplied = appliedMessageId === message.id || message.apply_status === 'applied'

    if (
      message.role === 'assistant'
      && isApplied
      && typeof message.nodes_count === 'number'
      && typeof message.edges_count === 'number'
    ) {
      return t('agentNetworkChat.success', {
        nodes: message.nodes_count,
        edges: message.edges_count,
      })
    }

    return message.content
  }

  return (
    <aside
      className="absolute inset-y-0 right-0 z-40 flex w-full max-w-[440px] flex-col border-l border-divider-regular bg-background-default shadow-xl"
      aria-label={t('agentNetworkChat.title')}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-divider-regular px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate system-md-semibold text-text-primary">
            {t('agentNetworkChat.title')}
          </h2>
          <p className="truncate system-xs-regular text-text-tertiary">
            {t('agentNetworkChat.subtitle')}
          </p>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="small"
            className="px-2"
            disabled={!hasMessages || isBusy}
            onClick={() => {
              void clearHistory()
            }}
          >
            清空
          </Button>
          <Button
            variant="ghost"
            size="small"
            className="size-8 p-0"
            aria-label={t('agentNetworkChat.close')}
            onClick={close}
          >
            <span className="i-ri-close-line size-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5" aria-live="polite">
        {isLoadingHistory && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="system-sm-regular text-text-tertiary">
              正在加载 Agent Network 对话记录……
            </div>
          </div>
        )}

        {!isLoadingHistory && historyError && (
          <div className="mb-4 rounded-lg bg-state-destructive-hover px-3 py-2 system-xs-regular text-text-destructive">
            {t('agentNetworkChat.historyFailed', { reason: historyError })}
          </div>
        )}

        {!isLoadingHistory && messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-components-icon-bg-blue-solid text-text-primary-on-surface">
              <span className="i-ri-robot-2-line size-5" aria-hidden="true" />
            </div>
            <h3 className="system-md-semibold text-text-primary">
              {t('agentNetworkChat.emptyTitle')}
            </h3>
            <p className="mt-1 max-w-72 system-sm-regular text-text-tertiary">
              {t('agentNetworkChat.emptyDescription')}
            </p>
          </div>
        )}

        {!isLoadingHistory && (
          <div className="space-y-5">
            {messages.map((message) => {
              const isUser = message.role === 'user'
              const isError = message.role === 'error'
              const isPending = message.state === 'pending'
              const isApplied = appliedMessageId === message.id || message.apply_status === 'applied'
              const canApply = message.role === 'assistant' && !!message.pseudocode && !isPending

              return (
                <article key={message.id} className={cn('flex gap-2.5', isUser && 'flex-row-reverse')}>
                  <div className={cn(
                    'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                    isUser
                      ? 'bg-components-icon-bg-blue-solid text-text-primary-on-surface'
                      : 'bg-background-section-burn text-text-secondary',
                  )}
                  >
                    {isUser
                      ? <span className="i-ri-user-3-line size-4" aria-hidden="true" />
                      : <span className="i-ri-robot-2-line size-4" aria-hidden="true" />}
                  </div>

                  <div className={cn('max-w-[85%] min-w-0', isUser && 'text-right')}>
                    <div className={cn(
                      'inline-block rounded-xl px-3 py-2 text-left system-sm-regular wrap-break-word whitespace-pre-wrap',
                      isUser
                        ? 'bg-components-button-primary-bg text-components-button-primary-text'
                        : 'bg-background-section-burn text-text-secondary',
                      (message.state === 'error' || isError) && 'text-text-destructive',
                    )}
                    >
                      {getDisplayContent(message)}
                    </div>

                    {message.executionResult && (
                      <AgentNetworkExecutionResult result={message.executionResult.finalResult} />
                    )}

                    {message.pseudocode && !isPending && (
                      <details className="mt-2 text-left">
                        <summary className="cursor-pointer system-xs-medium text-text-tertiary hover:text-text-secondary">
                          {t('agentNetworkChat.sourceTitle')}
                        </summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-background-section-burn p-3 font-mono text-xs leading-5 text-text-secondary">
                          <code>{message.pseudocode}</code>
                        </pre>
                      </details>
                    )}

                    {canApply && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-left">
                        {isApplied
                          ? (
                              <span className="rounded-full bg-state-success-hover px-2 py-1 system-xs-medium text-text-success">
                                已应用到当前画布
                              </span>
                            )
                          : (
                              <span className="rounded-full bg-background-section-burn px-2 py-1 system-xs-medium text-text-tertiary">
                                尚未应用
                              </span>
                            )}

                        <button
                          type="button"
                          className="rounded-lg border border-divider-regular px-3 py-1 system-xs-medium text-text-secondary hover:bg-background-section-burn disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={nodesReadOnly || !!applyingMessageId}
                          onClick={() => {
                            void applyMessageToCanvas(message)
                          }}
                        >
                          {applyingMessageId === message.id
                            ? '应用中……'
                            : isApplied
                              ? '重新应用'
                              : '应用到画布'}
                        </button>

                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          loading={executingMessageId === message.id}
                          disabled={!isApplied || nodesReadOnly || isBusy}
                          onClick={() => {
                            void executeCurrentCanvas(message)
                          }}
                        >
                          <span className="mr-1 i-ri-play-fill size-3.5" aria-hidden="true" />
                          {t('operation.execute')}
                        </Button>
                      </div>
                    )}

                    {message.apply_status === 'apply_failed' && message.error_message && (
                      <div className="mt-2 rounded-lg bg-state-destructive-hover px-3 py-2 text-left system-xs-regular text-text-destructive">
                        应用失败：
                        {message.error_message}
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
            <div ref={messageEndRef} />
          </div>
        )}
      </div>

      <form
        className="shrink-0 border-t border-divider-regular p-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {nodesReadOnly && (
          <p className="mb-2 system-xs-regular text-text-warning">
            {t('agentNetworkChat.readOnly')}
          </p>
        )}
        <div className="rounded-xl border border-components-input-border-active bg-components-input-bg-normal p-2 shadow-xs focus-within:ring-1 focus-within:ring-components-input-border-active">
          <Textarea
            value={input}
            onValueChange={setInput}
            rows={3}
            maxLength={100_000}
            disabled={nodesReadOnly || isSubmitting}
            placeholder={t('agentNetworkChat.placeholder')}
            aria-label={t('agentNetworkChat.placeholder')}
            className="min-h-20 resize-none border-0 bg-transparent p-1 shadow-none hover:border-0 hover:bg-transparent focus:border-0 focus:bg-transparent focus:shadow-none"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <div className="mt-2 flex justify-end">
            <Button
              type="submit"
              variant="primary"
              size="small"
              loading={isSubmitting}
              disabled={!canSend}
            >
              <span className="mr-1 i-ri-send-plane-2-fill size-3.5" aria-hidden="true" />
              {t('agentNetworkChat.send')}
            </Button>
          </div>
        </div>
      </form>
    </aside>
  )
}
