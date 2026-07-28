'use client'

import { Button } from '@langgenius/dify-ui/button'
import { cn } from '@langgenius/dify-ui/cn'
import { Textarea } from '@langgenius/dify-ui/textarea'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore as useAppStore } from '@/app/components/app/store'
import { useNodesReadOnly } from '@/app/components/workflow/hooks/use-workflow'
import { usePathname, useRouter } from '@/next/navigation'
import {
  clearAgentNetworkMessages,
  createAgentNetworkMessage,
  fetchAgentNetworkMessages,
  markAgentNetworkMessageApplied,
  type AgentNetworkConversation,
  type AgentNetworkMessage,
} from './conversation-service'
import { requestAgentNetworkPlan } from './request-plan'
import { useAgentNetworkInitialTasks } from './storage'
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
    created_at: message.created_at,
    updated_at: message.updated_at,
  }
}

export function AgentNetworkChatPanel() {
  const { t } = useTranslation('common')
  const pathname = usePathname()
  const router = useRouter()
  const appId = useAppStore(state => state.appDetail?.id)
  const { nodesReadOnly } = useNodesReadOnly()
  const { applyPseudocode } = useAgentNetworkWorkflow()
  const [, setInitialTasks] = useAgentNetworkInitialTasks()
  const [conversation, setConversation] = useState<AgentNetworkConversation | null>(null)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [applyingMessageId, setApplyingMessageId] = useState<string | null>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const isOpen = pathname.endsWith('/agent-network')

  const isBusy = isSubmitting || !!applyingMessageId

  const loadHistory = useCallback(async () => {
    if (!appId)
      return

    setIsLoadingHistory(true)
    try {
      const result = await fetchAgentNetworkMessages(appId)
      setConversation(result.conversation)
      setMessages(result.data.map(fromPersistedMessage))
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

    const assistantMessageId = crypto.randomUUID()
    setInput('')
    setIsSubmitting(true)

    try {
      const savedUserMessage = await createAgentNetworkMessage(appId, {
        role: 'user',
        status: 'success',
        content: task,
      })

      appendMessage(fromPersistedMessage(savedUserMessage))
      appendMessage({
        id: assistantMessageId,
        role: 'assistant',
        content: t('agentNetworkChat.planning'),
        state: 'pending',
      })

      /**
       * 注意：
       * 这里仍然保持原来的逻辑，只把当前 task 发给 Agent Network。
       * 现在还没有接真实多轮对话上下文，所以不要把历史 messages 传进去。
       */
      const plan = await requestAgentNetworkPlan({ appId, task })

      setInitialTasks(current => current?.[appId]?.initialTask
        ? current
        : { ...(current ?? {}), [appId]: { initialTask: task } })

      const savedAssistantMessage = await createAgentNetworkMessage(appId, {
        role: 'assistant',
        status: 'success',
        apply_status: 'not_applied',
        content: 'Agent Network 已返回规划，请确认是否应用到画布。',
        pseudocode: plan.pseudocode,
      })

      replaceMessage(assistantMessageId, fromPersistedMessage(savedAssistantMessage))
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)

      try {
        if (appId) {
          const savedErrorMessage = await createAgentNetworkMessage(appId, {
            role: 'error',
            status: 'failed',
            content: t('agentNetworkChat.failed', { reason }),
            error_code: reason,
            error_message: reason,
          })

          replaceMessage(assistantMessageId, fromPersistedMessage(savedErrorMessage))
        }
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

    const confirmed = window.confirm('这会用该轮伪代码更新当前画布并保存草稿，是否继续？')
    if (!confirmed)
      return

    setApplyingMessageId(message.id)

    try {
      const result = await applyPseudocode(message.pseudocode, {
        preservePositions: false,
        saveDraft: true,
      })

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

      try {
        const savedErrorMessage = await createAgentNetworkMessage(appId, {
          role: 'error',
          status: 'failed',
          content: `应用到画布失败：${reason}`,
          error_code: reason,
          error_message: reason,
        })

        appendMessage(fromPersistedMessage(savedErrorMessage))
      }
      catch {
        appendMessage({
          id: crypto.randomUUID(),
          role: 'error',
          content: `应用到画布失败：${reason}`,
          state: 'error',
          error_code: reason,
          error_message: reason,
        })
      }
    }
    finally {
      setApplyingMessageId(null)
    }
  }

  const clearHistory = async () => {
    if (!appId || isBusy || !hasMessages)
      return

    const confirmed = window.confirm('确定清空当前 Agent Network 对话记录吗？这不会删除当前画布。')
    if (!confirmed)
      return

    const result = await clearAgentNetworkMessages(appId)
    setConversation(result.conversation)
    setMessages([])
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
                      <div className="mt-2 flex items-center gap-2 text-left">
                        {isApplied ? (
                          <span className="rounded-full bg-state-success-bg px-2 py-1 system-xs-medium text-state-success-text">
                            已应用到当前画布
                          </span>
                        ) : (
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
                      </div>
                    )}

                    {message.apply_status === 'apply_failed' && message.error_message && (
                      <div className="mt-2 rounded-lg bg-state-destructive-bg px-3 py-2 text-left system-xs-regular text-text-destructive">
                        应用失败：{message.error_message}
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