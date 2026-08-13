# dsh-auto

[English](README.md) | 中文

`dsh-auto` 为 DeepSeek Harness 的 WebUI 增加 `Auto Approve` 权限档位。每个需要审批的动作都会先交给一个全新且受限的 DSH 子 Agent 审查，再由插件允许或拒绝。

当前版本只支持 WebUI。

## 工作方式

- 只有会话选择 `Auto Approve` 时，插件才接管 `approval/request`；其他权限档位继续使用 DSH 原有审批链。
- 每次审批只启动一个 `spawn` Reviewer 会话。有限的 `read`、`glob`、`grep` 调查和最终结构化结果都由 DSH 自己的 agent loop 处理，插件不再实现另一套模型/工具循环。
- 子 Agent 创建时会被固定为只读沙箱与 `approval/policy = never`。执行层 guard 会拒绝 `read`、`glob`、`grep` 和当前会话专用结构化输出工具以外的一切工具；它不能继续创建子 Agent，最多执行四个调查步骤和一个最终回答步骤。只有最小范围的只读检查可能改变决定时，才可以检查敏感文件。
- Reviewer 会收到精确待审批动作、approval reason、当前权限、按预算截取的原始 session events、主 Agent 已装配的 system 指令，以及 AGENTS.md 等工作区指令。直接用户消息、`ask_user_question` 返回的人工回答、已装配的 system 指令和工作区指令都可以构成授权；assistant 内容和其他工具结果仍是不可信证据。
- 结构化结果只强制要求 `outcome`。简写 `{"outcome":"allow"}` 默认表示 low 风险、unknown 授权；deny 缺少其他字段时默认表示 high 风险、unknown 授权。完整结果还可以包含 `risk_level`、`user_authorization` 和 `rationale`。宿主一定拒绝 critical 风险，也会拒绝用户授权低于 medium 的 high 风险。无效输出、动作参数缺失、超时、非父请求取消导致的基础设施失败和工具失败全部按失败关闭。
- 正常返回的 deny 不重试，也不会回退到用户弹窗。默认 90 秒总时限覆盖子 Agent 创建、所有模型步骤、本地只读调查和最终结构化输出。
- 同一父 turn 连续拒绝三次后会中断该 turn；一次 allow 会清零计数。不同审批仍使用彼此隔离的 Reviewer 子会话。

主 session 会记录审批事件和简短插件通知。Reviewer 子 session 使用 `_auto-approve:<callId>` label，并记录消息、调查工具调用与结果、最终 assessment 和 turn end。Console 只记录 session/call 标识、模型路由、步骤数、停止原因、风险、授权和结果，不默认输出完整 prompt 或文件内容。

## 安装

从 GitHub 安装 [simon300000/dsh-auto](https://github.com/simon300000/dsh-auto)：

```sh
dsh plugin --profile web add github:simon300000/dsh-auto
```

重启 WebUI 后，在会话的 Permissions 选择器中选择 `Auto Approve`，也可以在 General Settings 中设为默认权限档位。

## 配置

随包配置默认使用 `deepseek-official/deepseek-v4-flash` 与 `high` 推理：

```yaml
- id: dsh-auto-approve
  name: dsh-auto
  config:
    reviewerProvider: deepseek-official
    reviewerModel: deepseek-v4-flash
    reviewerReasoningEffort: high
    timeoutMs: 90000
    maxInvestigationSteps: 4
    maxConsecutiveDenials: 3
    maxMessageTranscriptTokens: 10000
    maxToolTranscriptTokens: 10000
    maxMessageEntryTokens: 2000
    maxToolEntryTokens: 1000
    maxSystemInstructionTokens: 10000
    maxAgentInstructionTokens: 10000
    maxRecentNonUserEntries: 40
    maxActionChars: 16000
    maxOutputTokens: 8192
```

`reviewerProvider` 和 `reviewerModel` 必须同时设置。两者都省略时，Reviewer 使用父 session 当前的 provider/model。profile 覆盖会替换同一 bundle 行的完整 `config`，因此应重复写出所有需要保留的值。

Reviewer persona 和补充安全规则分别位于 `prompts/policy-template.md` 与 `prompts/policy.md`。修改配置、策略或插件代码后需要重启 DSH。

## 许可证

[MIT](LICENSE)
