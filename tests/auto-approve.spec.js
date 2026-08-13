import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  assessmentSchema,
  buildReviewEvidence,
  buildReviewPrompt,
  createAutoApprovalHandler,
  enforceHostPolicy,
  exactAction,
  parseAssessment,
  resolveConfig,
} from '../src/index.js'

function event(type, data, seq) {
  return { type, data, seq, time: seq }
}

function sessionWith(preset = 'auto-approve', overrides = {}) {
  const events = [
    event('permission/preset', { preset }, 0),
    event('user/message', {
      id: 'user-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '请运行测试' }],
    }, 1),
    event('user/message', {
      id: 'instructions-1',
      role: 'user',
      source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
      content: [{ type: 'text', text: 'Instructions from: AGENTS.md\n\n只运行项目测试。' }],
    }, 2),
    event('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'main', model: 'main' },
        content: [{ type: 'text', text: '我会运行测试。' }],
      },
    }, 3),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'ask-1',
      name: 'ask_user_question',
      arguments: '{"questions":[{"id":"confirm","question":"运行测试？"}]}',
    }, 4),
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'ask-1' },
        content: [{ type: 'text', text: '{"answers":[{"id":"confirm","selected":["允许"]}]}' }],
      },
    }, 5),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'bash',
      arguments: '{"command":"npm test","sandbox_permissions":"danger-full-access","justification":"运行项目测试"}',
    }, 6),
  ]
  return {
    id: 'session-1',
    events,
    header: { cwd: '/workspace' },
    requestHeader: () => ({
      config: { provider: 'reviewer', model: 'safe-model' },
      system: 'MAIN SYSTEM INSTRUCTIONS',
    }),
    ...overrides,
  }
}

function requestWith(preset = 'auto-approve', overrides = {}) {
  const agent = {
    session: sessionWith(preset),
    options: {},
    inject: vi.fn(),
    cancel: vi.fn(),
  }
  return {
    agent,
    toolName: 'bash',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access: 运行项目测试',
    ...overrides,
  }
}

function reviewerRun(structured, overrides = {}) {
  return {
    id: 'reviewer-session-1',
    localAgent: {
      session: {
        events: [
          event('step/start', { turn: 1, step: 1 }, 0),
          event('tool/call', { turn: 1, step: 1, callId: 'r1', name: 'read', arguments: '{}' }, 1),
          event('step/start', { turn: 1, step: 2 }, 2),
        ],
      },
    },
    result: Promise.resolve({ stopReason: 'completed', structured, output: [] }),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function contextWith(runs) {
  const queue = Array.isArray(runs) ? [...runs] : [runs]
  return {
    subagents: {
      start: vi.fn().mockImplementation(() => Promise.resolve(queue.shift())),
    },
    get: vi.fn(name => name === 'sandboxPolicy'
      ? { resolve: () => ({ mode: 'workspace-write' }) }
      : name === 'approval'
        ? { config: { policy: 'ask' }, overrideOf: () => undefined }
        : undefined),
    logger: { info: vi.fn(), warn: vi.fn() },
  }
}

const allow = Object.freeze({
  risk_level: 'low',
  user_authorization: 'high',
  outcome: 'allow',
  rationale: '用户明确要求运行范围内的测试。',
})

const deny = Object.freeze({
  risk_level: 'high',
  user_authorization: 'low',
  outcome: 'deny',
  rationale: '提权范围超过运行测试所需。',
})

describe('结构化审查协议', () => {
  it('只要求 outcome，并为省略字段采用保守且与 Codex 一致的默认值', () => {
    expect(parseAssessment(allow)).toEqual(allow)
    expect(parseAssessment({ outcome: 'allow' })).toEqual({
      risk_level: 'low',
      user_authorization: 'unknown',
      outcome: 'allow',
      rationale: '自动审查返回低风险允许决定。',
    })
    expect(parseAssessment({ outcome: 'deny' })).toEqual({
      risk_level: 'high',
      user_authorization: 'unknown',
      outcome: 'deny',
      rationale: '自动审查返回拒绝决定，但没有提供理由。',
    })
    expect(() => parseAssessment({ ...allow, risk_level: 'urgent' })).toThrow(/risk_level/)
    expect(() => parseAssessment({ ...allow, user_authorization: 'yes' })).toThrow(/user_authorization/)
    expect(parseAssessment({ ...allow, rationale: ' ' }).rationale).toBe('自动审查返回低风险允许决定。')
    expect(() => parseAssessment({ ...allow, confidence: 1 })).toThrow(/未知字段 confidence/)
  })

  it('schema 包含完整字段，但只把 outcome 设为必填', () => {
    expect(assessmentSchema.properties.risk_level.enum).toContain('critical')
    expect(assessmentSchema.properties.user_authorization.enum).toEqual(['unknown', 'low', 'medium', 'high'])
    expect(assessmentSchema.required).toEqual(['outcome'])
  })

  it('宿主把不一致的 allow 降级，但不升级 deny', () => {
    expect(enforceHostPolicy({ ...allow, risk_level: 'critical' }).outcome).toBe('deny')
    expect(enforceHostPolicy({ ...allow, risk_level: 'high', user_authorization: 'low' }).outcome).toBe('deny')
    expect(enforceHostPolicy({ ...allow, risk_level: 'high', user_authorization: 'medium' }).outcome).toBe('allow')
    expect(enforceHostPolicy(deny)).toBe(deny)
  })
})

describe('Auto Approve Reviewer 子 Agent', () => {
  it('只接管 auto-approve，其他档位继续走 Web 人工审批链', async () => {
    const ctx = contextWith(reviewerRun(allow))
    const next = vi.fn().mockResolvedValue('allowed-once')
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(requestWith('workspace-write'), next)
    expect(outcome).toBe('allowed-once')
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.subagents.start).not.toHaveBeenCalled()
  })

  it('为一次审批启动一个受限 spawn Reviewer，并读取 structured 结果', async () => {
    const run = reviewerRun(allow)
    const ctx = contextWith(run)
    const request = requestWith()
    const config = resolveConfig({
      reviewerProvider: 'deepseek-official',
      reviewerModel: 'deepseek-v4-flash',
      reviewerReasoningEffort: 'high',
    })
    const outcome = await createAutoApprovalHandler(ctx, config)(request, vi.fn())

    expect(outcome).toBe('allowed-once')
    expect(ctx.subagents.start).toHaveBeenCalledOnce()
    const [provider, start] = ctx.subagents.start.mock.calls[0]
    expect(provider).toBe('spawn')
    expect(start).toMatchObject({
      label: '_auto-approve:call-1',
      parent: request.agent,
      agentOptions: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        maxTokens: 8_192,
      },
      persona: expect.stringContaining('独立安全审批 Reviewer'),
      toolFilter: { allow: ['read', 'glob', 'grep'] },
      outputSchema: assessmentSchema,
      maxDepth: 1,
    })
    expect(start.prompt[0].text).toContain('MAIN SYSTEM INSTRUCTIONS')
    expect(start.prompt[0].text).toContain('Instructions from: AGENTS.md')
    expect(start.prompt[0].text).toContain('justification')
    expect(start.prompt[0].text).toContain('trusted_for_authorization')
    expect(start.prompt[0].text).not.toContain('CACHEABLE')
    expect(start.prompt[0].text).not.toContain('cacheable')
    expect(start.prompt[0].text.indexOf('审查上下文'))
      .toBeLessThan(start.prompt[0].text.indexOf('本次审批'))
    expect(start.prompt[0].text.indexOf('MAIN SYSTEM INSTRUCTIONS'))
      .toBeLessThan(start.prompt[0].text.indexOf('session-1'))
    expect(run.dispose).toHaveBeenCalledOnce()
    expect(request.agent.inject).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: expect.stringContaining('Reviewer 会话：reviewer-session-1') }],
      source: expect.objectContaining({ summary: 'Auto Approve：允许' }),
    }))
  })

  it('一次 Reviewer 正常 deny 后直接拒绝，不重新审查或转人工', async () => {
    const ctx = contextWith(reviewerRun(deny))
    const next = vi.fn()
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(requestWith(), next)
    expect(outcome).toBe('rejected')
    expect(ctx.subagents.start).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it('子 Agent 异常、无 structured 输出或缺少精确动作时失败关闭', async () => {
    const failedRun = reviewerRun(undefined, {
      result: Promise.resolve({ stopReason: 'error', output: [] }),
    })
    const ctx = contextWith(failedRun)
    expect(await createAutoApprovalHandler(ctx, resolveConfig())(requestWith(), vi.fn())).toBe('rejected')
    expect(ctx.subagents.start).toHaveBeenCalledOnce()

    const missing = requestWith('auto-approve', { callId: undefined })
    expect(await createAutoApprovalHandler(ctx, resolveConfig())(missing, vi.fn())).toBe('rejected')
    expect(ctx.subagents.start).toHaveBeenCalledOnce()
  })

  it('连续三次有效拒绝会在当前 turn 结束后中断父 Agent', async () => {
    vi.useFakeTimers()
    const runs = [reviewerRun(deny), reviewerRun(deny), reviewerRun(deny)]
    const ctx = contextWith(runs)
    const request = requestWith()
    const handler = createAutoApprovalHandler(ctx, resolveConfig({ maxConsecutiveDenials: 3 }))

    await handler(request, vi.fn())
    await handler(request, vi.fn())
    await handler(request, vi.fn())
    expect(request.agent.cancel).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(request.agent.cancel).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hook',
      reason: expect.stringContaining('连续拒绝了 3 次'),
    }))
    expect(request.agent.inject.mock.calls.at(-1)[0].content[0].text).toContain('3/3')
    vi.useRealTimers()
  })
})

describe('Reviewer 创建期隔离', () => {
  it('在首次请求前钉死只读沙箱、工具 guard、推理等级和 step 上限', async () => {
    const listeners = new Map()
    const ctx = {
      on: vi.fn((name, listener) => {
        listeners.set(name, listener)
        return vi.fn()
      }),
    }
    apply(ctx, {
      reviewerProvider: 'deepseek-official',
      reviewerModel: 'deepseek-v4-flash',
      reviewerReasoningEffort: 'high',
      maxInvestigationSteps: 4,
    })

    const approval = contextWith(reviewerRun(allow))
    const request = requestWith()
    await createAutoApprovalHandler(approval, resolveConfig({ reviewerReasoningEffort: 'high' }))(request, vi.fn())
    const start = approval.subagents.start.mock.calls[0][1]
    const scopedListeners = new Map()
    let guard
    const reviewer = {
      options: start.agentOptions,
      session: { append: vi.fn() },
      ctx: {
        tools: { guard: vi.fn(candidate => { guard = candidate }) },
        on: vi.fn((name, listener) => { scopedListeners.set(name, listener); return vi.fn() }),
      },
    }
    listeners.get('agent/created')({ agent: reviewer })

    expect(reviewer.session.append).toHaveBeenCalledWith('sandbox/mode', {
      mode: 'read-only',
      source: 'delegation',
    })
    expect(reviewer.session.append).toHaveBeenCalledWith('approval/policy', {
      policy: 'never',
      source: 'delegation',
    })
    expect(guard({ name: 'read', arguments: { file_path: 'src/index.js' } })).toBeUndefined()
    expect(guard({ name: 'structured_output' })).toBeUndefined()
    expect(guard({ name: 'write' })).toMatch(/只允许只读/)
    expect(guard({ name: 'read', arguments: { file_path: '.env' } })).toBeUndefined()
    expect(guard({ name: 'grep', arguments: { pattern: 'token', path: '.ssh' } })).toBeUndefined()
    expect(guard({ name: 'grep', arguments: { pattern: 'token', include: '*.ts' } })).toBeUndefined()
    await expect(scopedListeners.get('agent/request')({}, () => Promise.resolve({ provider: 'p', model: 'm' })))
      .resolves.toMatchObject({ reasoningEffort: 'high' })
    await expect(scopedListeners.get('agent/pre-step')({ step: 5 }, () => Promise.resolve({ kind: 'enter' })))
      .resolves.toEqual({ kind: 'enter' })
    await expect(scopedListeners.get('agent/pre-step')({ step: 6 }, vi.fn()))
      .resolves.toEqual({ kind: 'reject' })
  })
})

describe('输入装配与配置', () => {
  it('默认总时限为 90 秒并校验正整数', () => {
    expect(resolveConfig()).toMatchObject({
      timeoutMs: 90_000,
      maxInvestigationSteps: 4,
      maxMessageTranscriptTokens: 4_000,
      maxToolTranscriptTokens: 3_000,
      maxMessageEntryTokens: 1_000,
      maxToolEntryTokens: 512,
      maxSystemInstructionTokens: 6_000,
      maxAgentInstructionTokens: 6_000,
      maxRecentNonUserEntries: 20,
    })
    expect(() => resolveConfig({ maxConsecutiveDenials: 0 })).toThrow(/正整数/)
    expect(() => resolveConfig({ reviewerReasoningEffort: ' ' })).toThrow(/reviewerReasoningEffort/)
  })

  it('精确动作保留 turn、step、原始参数、审批原因和 cwd', () => {
    expect(exactAction(requestWith())).toEqual({
      toolName: 'bash',
      callId: 'call-1',
      turn: 1,
      step: 1,
      arguments: '{"command":"npm test","sandbox_permissions":"danger-full-access","justification":"运行项目测试"}',
      approvalReason: 'escalate sandbox to danger-full-access: 运行项目测试',
      cwd: '/workspace',
    })
  })

  it('从原始 events 分离 system、AGENTS、消息、工具和当前权限', () => {
    const request = requestWith()
    const ctx = contextWith(reviewerRun(allow))
    const evidence = buildReviewEvidence(ctx, request, exactAction(request), resolveConfig())
    expect(evidence.reviewer_context.main_agent_instructions.system).toEqual({
      trusted_for_policy: true,
      trusted_for_authorization: true,
      content: 'MAIN SYSTEM INSTRUCTIONS',
    })
    expect(evidence.reviewer_context.main_agent_instructions).not.toHaveProperty('developer')
    expect(evidence.reviewer_context.main_agent_instructions).not.toHaveProperty('developer_note')
    expect(evidence.reviewer_context.main_agent_instructions.workspace_instructions.records[0])
      .toContain('AGENTS.md')
    expect(evidence.reviewer_context.main_agent_instructions.workspace_instructions.records[0])
      .toContain('"trusted_for_authorization":true')
    expect(evidence.approval_request.transcript.messages.records
      .some(record => record.includes('trusted_for_authorization'))).toBe(true)
    expect(evidence.approval_request.transcript.tools.records
      .some(record => record.includes('tool_call'))).toBe(true)
    expect(evidence.approval_request.transcript.tools.records.some(record => record.includes('ask-1')
      && record.includes('"trusted_for_authorization":true'))).toBe(true)
    expect(evidence.approval_request.current_permissions).toEqual({
      permission_preset: 'auto-approve',
      sandbox_mode: 'workspace-write',
      approval_policy: 'ask',
    })
    expect(evidence.approval_request.reviewed_parent_session_id).toBe('session-1')
    expect(evidence.approval_request.exact_action.callId).toBe('call-1')
  })

  it('把稳定指令放在动态审批数据之前，并使用两个独立 JSON 区段', () => {
    const request = requestWith()
    const evidence = buildReviewEvidence(
      contextWith(reviewerRun(allow)),
      request,
      exactAction(request),
      resolveConfig(),
    )
    const prompt = buildReviewPrompt(evidence)
    const contextIndex = prompt.indexOf('审查上下文')
    const approvalIndex = prompt.indexOf('本次审批')

    expect(prompt).not.toMatch(/cacheable|dynamic/i)
    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(approvalIndex).toBeGreaterThan(contextIndex)
    expect(prompt.indexOf('MAIN SYSTEM INSTRUCTIONS')).toBeLessThan(approvalIndex)
    expect(prompt.indexOf('session-1')).toBeGreaterThan(approvalIndex)
    expect(prompt.indexOf('call-1')).toBeGreaterThan(approvalIndex)
  })
})
