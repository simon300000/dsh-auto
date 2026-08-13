import { describe, expect, it, vi } from 'vitest'
import {
  createAutoApprovalHandler,
  exactAction,
  frameTranscript,
  parseAssessment,
  resolveConfig,
} from '../src/index.js'

function sessionWith(preset, overrides = {}) {
  const events = [
    { type: 'permission/preset', data: { preset } },
    { type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: '{"cmd":"npm test"}' } },
  ]
  return {
    id: 'session-1',
    events,
    header: { cwd: '/workspace' },
    deriveMessages: () => [{
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '请运行测试' }],
    }],
    requestHeader: () => ({ config: { provider: 'reviewer', model: 'safe-model' } }),
    ...overrides,
  }
}

function requestWith(preset = 'auto-approve', overrides = {}) {
  return {
    agent: { session: sessionWith(preset), options: {} },
    toolName: 'bash',
    callId: 'call-1',
    reason: '需要执行命令',
    ...overrides,
  }
}

function contextWith(outputs) {
  let calls = 0
  const stream = vi.fn(() => (async function * () {
    const output = outputs[Math.min(calls, outputs.length - 1)]
    calls += 1
    yield { type: 'text-delta', index: 0, text: output }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  return {
    llm: { stream },
    logger: { info: vi.fn(), warn: vi.fn() },
  }
}

describe('审查协议', () => {
  it('解析严格的允许和拒绝结果', () => {
    expect(parseAssessment('{"outcome":"allow","risk_level":"low","rationale":"范围明确"}').outcome).toBe('allow')
    expect(parseAssessment('{"outcome":"deny","risk_level":"high","rationale":"缺少授权"}').outcome).toBe('deny')
  })

  it('拒绝缺字段、非法结果和非 JSON 文本', () => {
    expect(() => parseAssessment('{"outcome":"allow"}')).toThrow(/risk_level/)
    expect(() => parseAssessment('{"outcome":"maybe","risk_level":"low","rationale":"未知"}')).toThrow(/outcome/)
    expect(() => parseAssessment('允许')).toThrow(/JSON/)
  })
})

describe('Auto Approve 应答器', () => {
  it('只接管 auto-approve，其他档位继续走 Web 人工审批链', async () => {
    const ctx = contextWith(['{"outcome":"allow","risk_level":"low","rationale":"可以"}'])
    const next = vi.fn().mockResolvedValue('allowed-once')
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(requestWith('workspace-write'), next)
    expect(outcome).toBe('allowed-once')
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('允许审查器批准的精确工具调用，并使用中文提示词', async () => {
    const ctx = contextWith(['{"outcome":"allow","risk_level":"low","rationale":"用户明确要求运行测试"}'])
    const next = vi.fn()
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(requestWith(), next)
    expect(outcome).toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
    const options = ctx.llm.stream.mock.calls[0][0]
    expect(options.system).toContain('独立安全审批器')
    expect(options.system).toContain('不得批准读取、打印、上传或转发 API 密钥')
    expect(options.messages[0].content[0].text).toContain('npm test')
  })

  it('无效输出重试到上限后失败关闭', async () => {
    const ctx = contextWith(['不是 JSON'])
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig({ maxAttempts: 3 }))(requestWith(), vi.fn())
    expect(outcome).toBe('rejected')
    expect(ctx.llm.stream).toHaveBeenCalledTimes(3)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('失败关闭'))
  })

  it('有 callId 却找不到原始参数时直接拒绝', async () => {
    const ctx = contextWith(['{"outcome":"allow","risk_level":"low","rationale":"可以"}'])
    const request = requestWith('auto-approve', {
      agent: { session: sessionWith('auto-approve', { events: [{ type: 'permission/preset', data: { preset: 'auto-approve' } }] }), options: {} },
    })
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(request, vi.fn())
    expect(outcome).toBe('rejected')
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })
})

describe('输入边界', () => {
  it('默认总超时为 30 秒', () => {
    expect(resolveConfig().timeoutMs).toBe(30_000)
  })

  it('保留原始工具参数与工作目录', () => {
    expect(exactAction(requestWith())).toEqual({
      toolName: 'bash',
      callId: 'call-1',
      arguments: '{"cmd":"npm test"}',
      reason: '需要执行命令',
      cwd: '/workspace',
    })
  })

  it('限制交给审查器的历史数量和单条长度', () => {
    const messages = Array.from({ length: 4 }, (_, index) => ({
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${index}-${'x'.repeat(100)}` }],
    }))
    const framed = frameTranscript(messages, resolveConfig({ maxMessages: 2, maxMessageChars: 40 }))
    expect(framed).toHaveLength(2)
    expect(framed.every((item) => item.length === 40)).toBe(true)
  })
})
