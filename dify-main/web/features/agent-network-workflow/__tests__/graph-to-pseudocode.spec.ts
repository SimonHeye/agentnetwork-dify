import type { Edge, Node, WorkflowDataUpdater } from '@/app/components/workflow/types'
import { BlockEnum } from '@/app/components/workflow/types'
import { compileAgentNetworkPseudocode } from '../compiler'
import {
  AGENT_NETWORK_PSEUDOCODE_NODE_SUPPORT,
  compileAllDifyNodesToAgentNetworkPseudocode,
} from '../graph-to-pseudocode'

type NodePayload = Record<string, unknown>

function makeNode(
  id: string,
  type: BlockEnum,
  payload: NodePayload = {},
  parentId?: string,
): Node {
  return {
    id,
    type: 'custom',
    position: { x: 0, y: 0 },
    data: {
      title: id,
      desc: '',
      type,
      ...payload,
    },
    ...(parentId ? { parentId } : {}),
  } as Node
}

function makeEdge(
  source: string,
  target: string,
  sourceHandle?: string,
): Edge {
  return {
    id: `${source}-${sourceHandle ?? 'source'}-${target}`,
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
  } as Edge
}

function makeGraph(nodes: Node[], edges: Edge[]): WorkflowDataUpdater {
  return {
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

function startNode() {
  return makeNode('start', BlockEnum.Start, {
    variables: [{ variable: 'task', type: 'text-input', required: true }],
  })
}

function endNode(id: string, selector: string[], variable = 'answer') {
  return makeNode(id, BlockEnum.End, {
    outputs: [{
      variable,
      value_selector: selector,
      value_type: 'string',
    }],
  })
}

function linearGraph(type: BlockEnum, payload: NodePayload): WorkflowDataUpdater {
  return makeGraph(
    [
      startNode(),
      makeNode('work', type, payload),
      endNode('end', ['work', 'result']),
    ],
    [
      makeEdge('start', 'work'),
      makeEdge('work', 'end'),
    ],
  )
}

describe('all-node graph to pseudocode contracts', () => {
  it('classifies every BlockEnum exactly once', () => {
    const classified = Object.values(AGENT_NETWORK_PSEUDOCODE_NODE_SUPPORT).flat()
    const allBlockTypes = Object.values(BlockEnum)

    expect(new Set(classified).size).toBe(classified.length)
    expect(new Set(classified)).toEqual(new Set(allBlockTypes))
  })

  it('resolves Chatflow system variables in prompts and start-node selectors', () => {
    const chatflow = makeGraph(
      [
        makeNode('start', BlockEnum.Start, { variables: [] }),
        makeNode('llm', BlockEnum.LLM, {
          model: { provider: 'provider', name: 'model' },
          prompt_template: [{ role: 'user', text: 'Answer: {{#sys.query#}}' }],
        }),
        makeNode('answer', BlockEnum.Answer, { answer: '{{#llm.text#}}' }),
      ],
      [
        makeEdge('start', 'llm'),
        makeEdge('llm', 'answer'),
      ],
    )
    const chatflowResult = compileAllDifyNodesToAgentNetworkPseudocode(chatflow)

    expect(chatflowResult.source).toContain('task=f"Answer: {query}"')
    expect(chatflowResult.source).toContain('reply(llm_result.get("text"))')
    expect(chatflowResult.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_SELECTOR_SOURCE' }),
    ]))

    const retrieval = linearGraph(BlockEnum.KnowledgeRetrieval, {
      query_variable_selector: ['start', 'sys.query'],
      dataset_ids: ['dataset-1'],
      retrieval_mode: 'multiple',
    })
    const retrievalResult = compileAllDifyNodesToAgentNetworkPseudocode(retrieval)

    expect(retrievalResult.source).toContain('query=query')
    expect(retrievalResult.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_SELECTOR_SOURCE' }),
    ]))
  })

  it.each([
    {
      name: 'native LLM',
      type: BlockEnum.LLM,
      payload: {
        model: { provider: 'provider', name: 'model', completion_params: { temperature: 0.2 } },
        prompt_template: [{ role: 'user', text: 'Question: {{#start.task#}}' }],
        skills: ['browser-control'],
      },
      expected: ['answer = LLM(', 'task=f"Question: {task}"', 'skills=["browser-control"]'],
    },
    {
      name: 'Knowledge Retrieval',
      type: BlockEnum.KnowledgeRetrieval,
      payload: {
        query_variable_selector: ['start', 'task'],
        dataset_ids: ['dataset-1'],
        retrieval_mode: 'multiple',
      },
      expected: ['answer = KnowledgeRetrieval(', 'query=task', 'dataset_ids=["dataset-1"]'],
    },
    {
      name: 'Code',
      type: BlockEnum.Code,
      payload: {
        variables: [{ variable: 'query', value_selector: ['start', 'task'] }],
        code_language: 'python3',
        code: 'result = query.upper()',
        outputs: { result: { type: 'string' } },
      },
      expected: ['answer = CodeExecution(', 'inputs={"query": task}', 'language="python3"'],
    },
    {
      name: 'Template Transform',
      type: BlockEnum.TemplateTransform,
      payload: {
        variables: [{ variable: 'query', value_selector: ['start', 'task'] }],
        template: 'Result: {{ query }}',
      },
      expected: ['answer = TemplateTransform(', 'template="Result: {{ query }}"'],
    },
    {
      name: 'HTTP Request',
      type: BlockEnum.HttpRequest,
      payload: {
        method: 'get',
        url: 'https://example.com?q={{#start.task#}}',
        headers: 'Accept: application/json',
        params: '',
        body: { type: 'none', data: [] },
        authorization: { type: 'no-auth' },
        timeout: { connect: 10, read: 30, write: 30 },
        ssl_verify: true,
      },
      expected: ['answer = HTTPRequest(', 'method="get"', 'url=f"https://example.com?q={task}"'],
    },
    {
      name: 'legacy Variable Aggregator',
      type: BlockEnum.VariableAssigner,
      payload: {
        variables: [['start', 'task']],
        advanced_settings: { group_enabled: false },
      },
      expected: ['answer = VariableAggregator(', 'values=[task]'],
    },
    {
      name: 'Variable Aggregator',
      type: BlockEnum.VariableAggregator,
      payload: {
        variables: [['start', 'task']],
        advanced_settings: { group_enabled: false },
      },
      expected: ['answer = VariableAggregator(', 'values=[task]'],
    },
    {
      name: 'Tool',
      type: BlockEnum.Tool,
      payload: {
        provider_id: 'provider',
        tool_name: 'search',
        tool_parameters: {
          query: { type: 'variable', value: ['start', 'task'] },
        },
        tool_configurations: { safe_mode: true },
        plugin_unique_identifier: 'provider/search:1.0.0',
      },
      expected: ['answer = Tool(', 'tool="search"', 'arguments={"query": task}'],
    },
    {
      name: 'Parameter Extractor',
      type: BlockEnum.ParameterExtractor,
      payload: {
        query: ['start', 'task'],
        parameters: [{ name: 'city', type: 'string', required: true }],
        reasoning_mode: 'prompt',
        instruction: 'Extract the city',
        model: { provider: 'provider', name: 'model', mode: 'chat' },
      },
      expected: ['answer = ParameterExtractor(', 'query=task', 'reasoning_mode="prompt"'],
    },
    {
      name: 'Document Extractor',
      type: BlockEnum.DocExtractor,
      payload: {
        variable_selector: ['start', 'task'],
        is_array_file: false,
      },
      expected: ['answer = DocumentExtractor(', 'document=task', 'is_array=False'],
    },
    {
      name: 'List Operator',
      type: BlockEnum.ListFilter,
      payload: {
        variable: ['start', 'task'],
        filter_by: { enabled: true, conditions: [] },
        extract_by: { enabled: false },
        order_by: { enabled: false },
        limit: { enabled: true, size: 10 },
      },
      expected: ['answer = ListOperator(', 'items=task', '"size": 10'],
    },
    {
      name: 'Agent',
      type: BlockEnum.Agent,
      payload: {
        agent_strategy_provider_name: 'provider',
        agent_strategy_name: 'react',
        agent_parameters: {
          instruction: { type: 'mixed', value: 'Solve {{#start.task#}}' },
          query: { type: 'string', value: '{{#start.task#}}' },
          max_iteration: { type: 'number', value: 5 },
        },
        output_schema: [{ name: 'text', type: 'string' }],
      },
      expected: [
        'answer = Agent(',
        'strategy="react"',
        '"instruction": f"Solve {task}"',
        '"query": task',
        '"maximum_iterations": 5',
      ],
    },
    {
      name: 'Agent V2',
      type: BlockEnum.AgentV2,
      payload: {
        agent_node_kind: 'dify_agent',
        version: '2',
        agent_task: 'Solve {{#start.task#}}',
        agent_binding: { binding_type: 'roster_agent', agent_id: 'agent-1' },
        agent_declared_outputs: [{ name: 'text', type: 'string' }],
      },
      expected: ['answer = AgentV2(', 'task=f"Solve {task}"', '"agent_id": "agent-1"'],
    },
  ])('exports $name with its semantic fields', ({ type, payload, expected }) => {
    const result = compileAllDifyNodesToAgentNetworkPseudocode(linearGraph(type, payload))

    expect(result.source).not.toBeNull()
    for (const fragment of expected)
      expect(result.source).toContain(fragment)
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ severity: 'error' }))
  })

  it.each([
    {
      type: BlockEnum.TriggerSchedule,
      payload: {
        mode: 'cron',
        cron_expression: '0 9 * * *',
        timezone: 'Asia/Shanghai',
      },
      expected: ['# Entry: ScheduleTrigger', 'answer = ScheduleTrigger(', 'cron_expression="0 9 * * *"'],
    },
    {
      type: BlockEnum.TriggerWebhook,
      payload: {
        method: 'post',
        content_type: 'application/json',
        headers: [{ name: 'x-token', value: 'demo' }],
        params: [],
        body: [{ name: 'task', type: 'string' }],
        async_mode: false,
        status_code: 200,
        response_body: 'ok',
      },
      expected: ['# Entry: WebhookTrigger', 'answer = WebhookTrigger(', 'method="post"'],
    },
    {
      type: BlockEnum.TriggerPlugin,
      payload: {
        provider_id: 'provider',
        event_name: 'message.created',
        event_parameters: {
          channel: { type: 'constant', value: 'demo' },
        },
        event_configurations: {},
        plugin_unique_identifier: 'provider/trigger:1.0.0',
      },
      expected: ['# Entry: PluginTrigger', 'answer = PluginTrigger(', 'event="message.created"'],
    },
    {
      type: BlockEnum.DataSource,
      payload: {
        provider_name: 'local-files',
        datasource_name: 'upload',
        datasource_parameters: {
          path: { type: 'constant', value: '/documents' },
        },
        datasource_configurations: {},
      },
      expected: ['# Entry: DataSource (knowledge pipeline)', 'answer = DataSource(', 'datasource="upload"'],
    },
  ])('exports the $type entry contract', ({ type, payload, expected }) => {
    const graph = makeGraph(
      [
        makeNode('entry', type, payload),
        endNode('end', ['entry', 'result']),
      ],
      [makeEdge('entry', 'end')],
    )

    const result = compileAllDifyNodesToAgentNetworkPseudocode(graph)

    expect(result.source).not.toBeNull()
    for (const fragment of expected)
      expect(result.source).toContain(fragment)
  })

  it('keeps User Input as an injected namespace instead of inventing a function call', () => {
    const graph = makeGraph(
      [startNode(), endNode('end', ['start', 'task'])],
      [makeEdge('start', 'end')],
    )

    const result = compileAllDifyNodesToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('# Entry: UserInput(task: text-input)')
    expect(result.source).toContain('final_result = task')
    expect(result.source).not.toContain('Start(')
  })

  it('reads Webhook body variables from the trigger result', () => {
    const graph = makeGraph(
      [
        makeNode('webhook', BlockEnum.TriggerWebhook, {
          method: 'POST',
          content_type: 'application/json',
          headers: [],
          params: [],
          body: [{ name: 'task', type: 'string', required: true }],
          async_mode: true,
          status_code: 200,
          response_body: 'accepted',
          variables: [{
            variable: 'task',
            label: 'body',
            value_type: 'string',
            value_selector: [],
            required: true,
          }],
        }),
        makeNode('template', BlockEnum.TemplateTransform, {
          variables: [{ variable: 'task', value_selector: ['webhook', 'task'] }],
          template: 'webhook received: {{ task }}',
        }),
        endNode('end', ['template', 'output']),
      ],
      [
        makeEdge('webhook', 'template'),
        makeEdge('template', 'end'),
      ],
    )

    const result = compileAllDifyNodesToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('# Entry: WebhookTrigger')
    expect(result.source).toContain('inputs={"task": trigger_event.get("task")}')
    expect(result.source).not.toContain('inputs={"task": task}')
  })

  it('exports If/Else, Question Classifier, and Human Input as explicit branches', () => {
    const ifElse = makeNode('if', BlockEnum.IfElse, {
      cases: [{
        case_id: 'calc',
        logical_operator: 'and',
        conditions: [{
          variable_selector: ['start', 'task'],
          comparison_operator: 'contains',
          value: 'calculate',
        }],
      }],
    })
    const classifier = makeNode('classifier', BlockEnum.QuestionClassifier, {
      query_variable_selector: ['start', 'task'],
      classes: [
        { id: 'search', name: 'search' },
        { id: 'other', name: 'other' },
      ],
      instruction: 'Classify',
      model: { provider: 'provider', name: 'model', mode: 'chat' },
    })
    const human = makeNode('human', BlockEnum.HumanInput, {
      form_content: 'Approve {{#start.task#}}?',
      inputs: [],
      user_actions: [
        { id: 'approve', title: 'Approve' },
        { id: 'reject', title: 'Reject' },
      ],
      delivery_methods: ['web'],
      timeout: 10,
      timeout_unit: 'minute',
    })

    const graph = makeGraph(
      [
        startNode(),
        ifElse,
        classifier,
        human,
        endNode('end-1', ['start', 'task']),
        endNode('end-2', ['start', 'task']),
        endNode('end-3', ['start', 'task']),
        endNode('end-4', ['start', 'task']),
      ],
      [
        makeEdge('start', 'if'),
        makeEdge('if', 'classifier', 'calc'),
        makeEdge('if', 'human', 'false'),
        makeEdge('classifier', 'end-1', 'search'),
        makeEdge('classifier', 'end-2', 'other'),
        makeEdge('human', 'end-3', 'approve'),
        makeEdge('human', 'end-4', 'reject'),
      ],
    )

    const result = compileAllDifyNodesToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('if "calculate" in task:')
    expect(result.source).toContain('classification_result = QuestionClassifier(')
    expect(result.source).toContain('if classification_result.get("class_name") == "search":')
    expect(result.source).toContain('human_input_result = HumanInput(')
    expect(result.source).toContain('form=f"Approve {task}?"')
    expect(result.source).toContain('human_input_result.get("action") == "approve"')
    expect(result.stats.branches).toBe(3)
  })

  it('exports Answer, multi-output End, KnowledgeBase, and assignment operations', () => {
    const answerGraph = makeGraph(
      [
        startNode(),
        makeNode('answer', BlockEnum.Answer, { answer: 'Result: {{#start.task#}}' }),
      ],
      [makeEdge('start', 'answer')],
    )
    const answerResult = compileAllDifyNodesToAgentNetworkPseudocode(answerGraph)
    expect(answerResult.source).toContain('reply(f"Result: {task}")')

    const multiOutputGraph = makeGraph(
      [
        startNode(),
        makeNode('llm', BlockEnum.LLM, {
          model: { provider: 'provider', name: 'model' },
          prompt_template: [{ role: 'user', text: '{{#start.task#}}' }],
        }),
        makeNode('end', BlockEnum.End, {
          outputs: [
            { variable: 'answer', value_selector: ['llm', 'text'] },
            { variable: 'structured', value_selector: ['llm', 'structured_output'] },
          ],
        }),
      ],
      [makeEdge('start', 'llm'), makeEdge('llm', 'end')],
    )
    const multiOutputResult = compileAllDifyNodesToAgentNetworkPseudocode(multiOutputGraph)
    expect(multiOutputResult.source).toContain('final_result = {')
    expect(multiOutputResult.source).toContain('"answer": answer.get("text"),')
    expect(multiOutputResult.source).toContain('"structured": answer.get("structured_output"),')

    const knowledgeGraph = makeGraph(
      [
        startNode(),
        makeNode('knowledge', BlockEnum.KnowledgeBase, {
          index_chunk_variable_selector: ['start', 'task'],
          indexing_technique: 'high_quality',
        }),
      ],
      [makeEdge('start', 'knowledge')],
    )
    const knowledgeResult = compileAllDifyNodesToAgentNetworkPseudocode(knowledgeGraph)
    expect(knowledgeResult.source).toContain('final_result = KnowledgeBase(')
    expect(knowledgeResult.source).toContain('chunks=task')

    const assignerGraph = makeGraph(
      [
        startNode(),
        makeNode('assign', BlockEnum.Assigner, {
          items: [{
            variable_selector: ['start', 'task'],
            input_type: 'constant',
            operation: 'set',
            value: 'updated',
          }],
        }),
        endNode('end', ['start', 'task']),
      ],
      [makeEdge('start', 'assign'), makeEdge('assign', 'end')],
    )
    const assignerResult = compileAllDifyNodesToAgentNetworkPseudocode(assignerGraph)
    expect(assignerResult.source).toContain('task = "updated"')
  })

  it('always exports Iteration as for/enumerate and Loop as bounded range', () => {
    const iterationGraph = makeGraph(
      [
        startNode(),
        makeNode('iteration', BlockEnum.Iteration, {
          iterator_selector: ['start', 'task'],
          output_selector: ['iteration-code', 'result'],
          start_node_id: 'iteration-start',
          is_parallel: false,
          error_handle_mode: 'terminated',
          flatten_output: false,
        }),
        makeNode('iteration-start', BlockEnum.IterationStart, {}, 'iteration'),
        makeNode('iteration-code', BlockEnum.Code, {
          variables: [
            { variable: 'item', value_selector: ['iteration', 'item'] },
            { variable: 'index', value_selector: ['iteration', 'index'] },
          ],
          code_language: 'python3',
          code: 'result = item',
          outputs: { result: { type: 'string' } },
        }, 'iteration'),
        endNode('end', ['iteration', 'output']),
      ],
      [
        makeEdge('start', 'iteration'),
        makeEdge('iteration', 'end'),
        makeEdge('iteration-start', 'iteration-code'),
      ],
    )

    const iterationResult = compileAllDifyNodesToAgentNetworkPseudocode(iterationGraph)
    expect(iterationResult.source).toContain('for iteration_index, iteration_item in enumerate(task):')
    expect(iterationResult.source).toContain('inputs={"item": iteration_item, "index": iteration_index}')
    expect(iterationResult.source).toContain('answer.append(iteration_code_result.get("result"))')
    expect(iterationResult.source).toContain('final_result = answer')
    expect(iterationResult.source).not.toContain('answer.get("output")')
    expect(iterationResult.source).not.toContain('while ')
    const iterationRoundTrip = compileAgentNetworkPseudocode(iterationResult.source!)
    expect(iterationRoundTrip.graph.nodes.filter(node => node.data.type === BlockEnum.Iteration)).toHaveLength(1)
    expect(iterationRoundTrip.graph.nodes.filter(node => node.data.type === BlockEnum.Code)).toHaveLength(1)
    expect(iterationRoundTrip.graph.nodes.find(node => node.data.type === BlockEnum.Code)?.parentId)
      .toBe(iterationRoundTrip.graph.nodes.find(node => node.data.type === BlockEnum.Iteration)?.id)

    const loopGraph = makeGraph(
      [
        startNode(),
        makeNode('loop', BlockEnum.Loop, {
          loop_count: 5,
          loop_variables: [{
            id: 'counter',
            label: 'counter',
            var_type: 'number',
            value_type: 'constant',
            value: '0',
          }],
          break_conditions: [{
            variable_selector: ['loop', 'counter'],
            comparison_operator: '>=',
            value: 3,
          }],
          logical_operator: 'and',
          start_node_id: 'loop-start',
          error_handle_mode: 'terminated',
        }),
        makeNode('loop-start', BlockEnum.LoopStart, {}, 'loop'),
        makeNode('loop-code', BlockEnum.Code, {
          variables: [{ variable: 'counter', value_selector: ['loop', 'counter'] }],
          code_language: 'python3',
          code: 'result = counter + 1',
          outputs: { result: { type: 'number' } },
        }, 'loop'),
        endNode('end', ['loop', 'counter'], 'counter'),
      ],
      [
        makeEdge('start', 'loop'),
        makeEdge('loop', 'end'),
        makeEdge('loop-start', 'loop-code'),
      ],
    )

    const loopResult = compileAllDifyNodesToAgentNetworkPseudocode(loopGraph)
    expect(loopResult.source).toContain('counter = 0')
    expect(loopResult.source).toContain('for loop_index in range(5):')
    expect(loopResult.source).toContain('if counter >= 3:')
    expect(loopResult.source).toContain('break')
    expect(loopResult.source).toContain('loop_result = {')
    expect(loopResult.source).toContain('final_result = counter')
    expect(loopResult.source).not.toContain('counter = {')
    expect(loopResult.source).not.toContain('while ')
    const loopRoundTrip = compileAgentNetworkPseudocode(loopResult.source!)
    expect(loopRoundTrip.graph.nodes.filter(node => node.data.type === BlockEnum.Loop)).toHaveLength(1)
    expect(loopRoundTrip.graph.nodes.filter(node => node.data.type === BlockEnum.Code)).toHaveLength(1)
    expect(loopRoundTrip.graph.nodes.find(node => node.data.type === BlockEnum.Code)?.parentId)
      .toBe(loopRoundTrip.graph.nodes.find(node => node.data.type === BlockEnum.Loop)?.id)
  })

  it('exports parallel Iteration, explicit LoopEnd, retry, default, and fail branches', () => {
    const parallelGraph = makeGraph(
      [
        startNode(),
        makeNode('iteration', BlockEnum.Iteration, {
          iterator_selector: ['start', 'task'],
          output_selector: ['iteration-code', 'result'],
          start_node_id: 'iteration-start',
          is_parallel: true,
          parallel_nums: 4,
          error_handle_mode: 'continue-on-error',
          flatten_output: true,
        }),
        makeNode('iteration-start', BlockEnum.IterationStart, {}, 'iteration'),
        makeNode('iteration-code', BlockEnum.Code, {
          variables: [],
          code_language: 'python3',
          code: 'result = 1',
          outputs: { result: { type: 'number' } },
        }, 'iteration'),
        endNode('end', ['iteration', 'output']),
      ],
      [
        makeEdge('start', 'iteration'),
        makeEdge('iteration', 'end'),
        makeEdge('iteration-start', 'iteration-code'),
      ],
    )
    const parallelResult = compileAllDifyNodesToAgentNetworkPseudocode(parallelGraph)
    expect(parallelResult.source).toContain('for iteration_index, iteration_item in enumerate(task):')
    expect(parallelResult.source).not.toContain('def ')
    expect(parallelResult.source).not.toContain('parallel_map(')
    expect(parallelResult.diagnostics).toContainEqual(expect.objectContaining({ code: 'PARALLEL_ITERATION_SERIALIZED' }))

    const loopEndGraph = makeGraph(
      [
        startNode(),
        makeNode('loop', BlockEnum.Loop, {
          loop_count: 2,
          loop_variables: [],
          break_conditions: [],
          start_node_id: 'loop-start',
        }),
        makeNode('loop-start', BlockEnum.LoopStart, {}, 'loop'),
        makeNode('loop-end', BlockEnum.LoopEnd, {}, 'loop'),
        endNode('end', ['loop', 'index']),
      ],
      [
        makeEdge('start', 'loop'),
        makeEdge('loop', 'end'),
        makeEdge('loop-start', 'loop-end'),
      ],
    )
    const loopEndResult = compileAllDifyNodesToAgentNetworkPseudocode(loopEndGraph)
    expect(loopEndResult.source).toContain('for loop_index in range(2):')
    expect(loopEndResult.source).toContain('    break')

    const defaultGraph = linearGraph(BlockEnum.HttpRequest, {
      method: 'get',
      url: 'https://example.com',
      headers: '',
      params: '',
      body: {},
      authorization: {},
      timeout: {},
      retry_config: {
        retry_enabled: true,
        max_retries: 3,
        retry_interval: 1000,
      },
      error_strategy: 'default-value',
      default_value: { status_code: 599 },
    })
    const defaultResult = compileAllDifyNodesToAgentNetworkPseudocode(defaultGraph)
    expect(defaultResult.source).toContain('retry={"max_retries": 3, "interval_ms": 1000}')
    expect(defaultResult.source).toContain('on_error="default-value"')
    expect(defaultResult.source).toContain('default={"status_code": 599}')

    const failNode = makeNode('http', BlockEnum.HttpRequest, {
      method: 'get',
      url: 'https://example.com',
      headers: '',
      params: '',
      body: {},
      authorization: {},
      timeout: {},
      error_strategy: 'fail-branch',
    })
    const failureGraph = makeGraph(
      [
        startNode(),
        failNode,
        endNode('normal-end', ['start', 'task']),
        endNode('failure-end', ['start', 'task']),
      ],
      [
        makeEdge('start', 'http'),
        makeEdge('http', 'normal-end'),
        makeEdge('http', 'failure-end', 'fail-branch'),
      ],
    )
    const failureResult = compileAllDifyNodesToAgentNetworkPseudocode(failureGraph)
    expect(failureResult.source).toContain('try:')
    expect(failureResult.source).toContain('except Exception as error:')
  })

  it('keeps skills only on LLM nodes and does not reinterpret Tool or Agent configuration', () => {
    const graph = linearGraph(BlockEnum.Agent, {
      agent_strategy_provider_name: 'provider',
      agent_strategy_name: 'react',
      agent_parameters: {},
      output_schema: [],
      skills: ['browser-control'],
    })

    const result = compileAllDifyNodesToAgentNetworkPseudocode(graph)

    expect(result.source).not.toContain('skills=')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'SKILLS_NOT_SUPPORTED',
      nodeId: 'work',
    }))
    expect(result.stats.skills).toBe(0)
  })
})
