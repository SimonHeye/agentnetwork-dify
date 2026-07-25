import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
const expectedToken = process.env.AGENT_NETWORK_API_KEY?.trim()
const maxBodyBytes = 1_500_000
const supportedFunctions = new Set(['ReasoningGroup', 'CalculatorGroup', 'SearchGroup'])

const pseudocode = `# 命名空间已注入：各节点函数、task（用户任务字符串）、final_result（输出约定）
# The planner returns scalar kind; only existing AgentNetwork Group functions are called.
# Both branches include bounded for and while/break examples for Dify container rendering.

# 1. Decide the task kind.
kind = ReasoningGroup(
    task=f"判断下面的用户需求属于「事实查询」还是「数值计算」，"
         f"只返回 JSON：{{\\"kind\\": \\"search\\"}} 或 {{\\"kind\\": \\"calc\\"}}。\\n需求：{task}"
)

# 2. Branch and run bounded checks.
if kind == "calc":
    for calc_check_index in range(1):
        calc_check = ReasoningGroup(
            task=f"Verify that this request needs numeric calculation. Request: {task}"
        )

    while kind == "calc":
        calc_confirmation = ReasoningGroup(
            task=f"Confirm that calculation planning is complete. Request: {task}"
        )
        break

    answer = CalculatorGroup(task=task)
else:
    for search_check_index in range(1):
        search_check = ReasoningGroup(
            task=f"Verify that this request needs factual search. Request: {task}"
        )

    while kind == "search":
        search_confirmation = ReasoningGroup(
            task=f"Confirm that search planning is complete. Request: {task}"
        )
        break

    answer = SearchGroup(task=task)

# 3. Publish the final result.
final_result = answer
`

const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    respondText(response, 404, 'Not Found')
    return
  }
  if (expectedToken && request.headers.authorization !== `Bearer ${expectedToken}`) {
    respondText(response, 401, 'Unauthorized')
    return
  }

  const payload = await readJson(request)
  if (!payload) {
    respondText(response, 500, '请求体不是有效的 JSON')
    return
  }

  if (request.url === '/service/plan_code') {
    handlePlan(payload, response)
    return
  }

  if (request.url === '/service/execute_code') {
    handleExecute(payload, response)
    return
  }

  respondText(response, 404, 'Not Found')
})

function handlePlan(payload, response) {
  if (typeof payload.task !== 'string' || !payload.task.trim()) {
    respondText(response, 500, '缺少必填字段 task')
    return
  }
  if (payload.include_agents !== undefined && typeof payload.include_agents !== 'boolean') {
    respondText(response, 500, 'include_agents 必须是 boolean')
    return
  }
  if (payload.model !== undefined && (typeof payload.model !== 'string' || !payload.model.trim())) {
    respondText(response, 500, 'model 必须是非空字符串')
    return
  }
  if (payload.extra_instructions !== undefined && typeof payload.extra_instructions !== 'string') {
    respondText(response, 500, 'extra_instructions 必须是字符串')
    return
  }

  const normalized = {
    task: payload.task.trim(),
    include_agents: payload.include_agents ?? false,
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.extra_instructions ? { extra_instructions: payload.extra_instructions } : {}),
  }
  console.log('[plan_code]')
  console.log(JSON.stringify(normalized, null, 2))
  respondJson(response, 200, { pseudocode })
}

function handleExecute(payload, response) {
  if (typeof payload.task !== 'string' || !payload.task.trim()) {
    respondText(response, 500, '缺少必填字段 task')
    return
  }
  if (typeof payload.code !== 'string' || !payload.code.trim()) {
    respondText(response, 500, '伪代码为空')
    return
  }
  if (!isScalarRecord(payload.params ?? {})) {
    respondText(response, 500, 'params 只能包含字符串、数字或布尔值')
    return
  }
  for (const field of ['need_task', 'need_match', 'include_agents']) {
    if (payload[field] !== undefined && typeof payload[field] !== 'boolean') {
      respondText(response, 500, `${field} 必须是 boolean`)
      return
    }
  }

  const identifiers = [...payload.code.matchAll(/\b([A-Z][A-Za-z0-9_]*Group)\s*\(/g)]
    .map(match => match[1])
  const unsupported = identifiers.find(identifier => !supportedFunctions.has(identifier))
  if (unsupported) {
    respondText(response, 500, `NameError: name '${unsupported}' is not defined`)
    return
  }
  if (identifiers.length > 64) {
    respondText(response, 500, '伪代码节点调用次数超过上限')
    return
  }

  const normalized = {
    task: payload.task.trim(),
    code: payload.code,
    params: payload.params ?? {},
    need_task: payload.need_task ?? false,
    need_match: payload.need_match ?? false,
    include_agents: payload.include_agents ?? true,
  }
  const kind = /计算|算一下|calc/i.test(normalized.task) ? 'calc' : 'search'
  const value = kind === 'calc' ? '60' : `Mock search result for: ${normalized.task}`
  const trace = identifiers.map(identifier => ({
    identifier,
    vertex: identifier,
    params: { task: normalized.task },
    scalar: identifier === 'ReasoningGroup' ? kind : value,
  }))

  console.log('[execute_code]')
  console.log(JSON.stringify(normalized, null, 2))
  respondJson(response, 200, {
    final_result: { value, raw: value },
    context: { ...normalized.params, kind, result: value },
    trace,
    calls: trace.length,
  })
}

server.listen(port, host, () => {
  console.log(`Mock Agent Network plan endpoint: http://${host}:${port}/service/plan_code`)
  console.log(`Mock Agent Network execute endpoint: http://${host}:${port}/service/execute_code`)
})

async function readJson(request) {
  const chunks = []
  let size = 0

  try {
    for await (const chunk of request) {
      size += chunk.length
      if (size > maxBodyBytes)
        return null
      chunks.push(chunk)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  }
  catch {
    return null
  }
}

function isScalarRecord(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every(item => ['string', 'number', 'boolean'].includes(typeof item))
}

function respondJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function respondText(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(message)
}