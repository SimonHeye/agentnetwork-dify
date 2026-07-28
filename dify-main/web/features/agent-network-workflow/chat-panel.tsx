'use client'

import { Button } from '@langgenius/dify-ui/button'
import { cn } from '@langgenius/dify-ui/cn'
import { Textarea } from '@langgenius/dify-ui/textarea'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore as useAppStore } from '@/app/components/app/store'
import { useNodesReadOnly } from '@/app/components/workflow/hooks/use-workflow'
import { usePathname, useRouter } from '@/next/navigation'
import { requestAgentNetworkPlan } from './request-plan'
import { runGeneratedAgentNetworkWorkflow } from './run-generated-workflow'
import { useAgentNetworkInitialTasks } from './storage'
import { useAgentNetworkWorkflow } from './use-agent-network-workflow'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  pseudocode?: string
  finalResult?: string
  state?: 'pending' | 'success' | 'error'
}

export function AgentNetworkChatPanel() {
  const { t } = useTranslation('common')
  const pathname = usePathname()
  const router = useRouter()
  const appId = useAppStore(state => state.appDetail?.id)
  const { nodesReadOnly } = useNodesReadOnly()
  const { applyPseudocode } = useAgentNetworkWorkflow()
  const [, setInitialTasks] = useAgentNetworkInitialTasks()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const isOpen = pathname.endsWith('/agent-network')

  useEffect(() => {
    if (isOpen)
      messageEndRef.current?.scrollIntoView({ block: 'end' })
  }, [isOpen, messages])

  if (!isOpen)
    return null

  const close = () => {
    if (appId)
      router.push(`/app/${appId}/workflow`)
  }

  const submit = async () => {
    const task = input.trim()
    if (!task || !appId || isSubmitting || nodesReadOnly)
      return

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: task,
    }
    const assistantMessageId = crypto.randomUUID()
    setMessages(current => [...current, userMessage, {
      id: assistantMessageId,
      role: 'assistant',
      content: t('agentNetworkChat.planning'),
      state: 'pending',
    }])
    setInput('')
    setIsSubmitting(true)

    try {
      const plan = await requestAgentNetworkPlan({ appId, task })
      setInitialTasks(current => current?.[appId]?.initialTask
        ? current
        : { ...(current ?? {}), [appId]: { initialTask: task } })

      setMessages(current => current.map(message => message.id === assistantMessageId
        ? { ...message, content: t('agentNetworkChat.applying'), pseudocode: plan.pseudocode }
        : message))

      const result = await applyPseudocode(plan.pseudocode, {
        preservePositions: false,
        saveDraft: true,
      })

      setMessages(current => current.map(message => message.id === assistantMessageId
        ? { ...message, content: t('agentNetworkChat.executing'), pseudocode: plan.pseudocode }
        : message))

      try {
        const execution = await runGeneratedAgentNetworkWorkflow({
          task,
          pseudocode: plan.pseudocode,
        })
        setMessages(current => current.map(message => message.id === assistantMessageId
          ? {
              ...message,
              content: t('agentNetworkChat.success', {
                nodes: result.graph.nodes.length,
                edges: result.graph.edges.length,
              }),
              pseudocode: plan.pseudocode,
              finalResult: execution.finalResult,
              state: 'success',
            }
          : message))
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        setMessages(current => current.map(message => message.id === assistantMessageId
          ? {
              ...message,
              content: t('agentNetworkChat.executionFailed', { reason }),
              pseudocode: plan.pseudocode,
              state: 'error',
            }
          : message))
      }
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setMessages(current => current.map(message => message.id === assistantMessageId
        ? {
            ...message,
            content: t('agentNetworkChat.failed', { reason }),
            state: 'error',
          }
        : message))
    }
    finally {
      setIsSubmitting(false)
    }
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
        <Button
          variant="ghost"
          size="small"
          className="size-8 p-0"
          aria-label={t('agentNetworkChat.close')}
          onClick={close}
        >
          <span className="i-ri-close-line size-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5" aria-live="polite">
        {messages.length === 0 && (
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

        <div className="space-y-5">
          {messages.map(message => (
            <article key={message.id} className={cn('flex gap-2.5', message.role === 'user' && 'flex-row-reverse')}>
              <div className={cn(
                'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                message.role === 'user'
                  ? 'bg-components-icon-bg-blue-solid text-text-primary-on-surface'
                  : 'bg-background-section-burn text-text-secondary',
              )}
              >
                {message.role === 'user'
                  ? <span className="i-ri-user-3-line size-4" aria-hidden="true" />
                  : <span className="i-ri-robot-2-line size-4" aria-hidden="true" />}
              </div>
              <div className={cn('max-w-[85%] min-w-0', message.role === 'user' && 'text-right')}>
                <div className={cn(
                  'inline-block rounded-xl px-3 py-2 text-left system-sm-regular wrap-break-word whitespace-pre-wrap',
                  message.role === 'user'
                    ? 'bg-components-button-primary-bg text-components-button-primary-text'
                    : 'bg-background-section-burn text-text-secondary',
                  message.state === 'error' && 'text-text-destructive',
                )}
                >
                  {message.content}
                </div>
                {message.finalResult !== undefined && (
                  <section
                    className="mt-2 overflow-hidden rounded-xl border border-divider-regular bg-background-default text-left"
                    aria-label={t('agentNetworkChat.resultTitle')}
                  >
                    <div className="flex items-center gap-1.5 border-b border-divider-regular bg-background-section px-3 py-2 system-xs-semibold text-text-secondary">
                      <span className="i-ri-checkbox-circle-line size-3.5 text-text-success" aria-hidden="true" />
                      {t('agentNetworkChat.resultTitle')}
                    </div>
                    <pre className="max-h-72 overflow-auto p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-text-primary">
                      <code>{message.finalResult || 'null'}</code>
                    </pre>
                  </section>
                )}
                {message.pseudocode && message.state !== 'pending' && (
                  <details className="mt-2 text-left">
                    <summary className="cursor-pointer system-xs-medium text-text-tertiary hover:text-text-secondary">
                      {t('agentNetworkChat.sourceTitle')}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-background-section-burn p-3 font-mono text-xs leading-5 text-text-secondary">
                      <code>{message.pseudocode}</code>
                    </pre>
                  </details>
                )}
              </div>
            </article>
          ))}
          <div ref={messageEndRef} />
        </div>
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
              disabled={!input.trim() || !appId || nodesReadOnly}
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
