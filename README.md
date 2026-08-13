# dsh-auto

English | [中文](README.zh.md)

`dsh-auto` adds an `Auto Approve` permission preset to the DeepSeek Harness Web UI. Each action that requires approval is reviewed by a fresh, restricted DSH child Agent before the plugin allows or denies it.

The current release supports the Web UI only.

## How it works

- The plugin handles `approval/request` only when the session selects `Auto Approve`. Other permission presets continue through DSH's existing approval chain.
- Each approval starts one `spawn` Reviewer session. DSH's own agent loop handles any bounded `read`, `glob`, or `grep` investigation and captures the final structured result; the plugin does not implement a separate model/tool loop.
- The child is created with a read-only sandbox and `approval/policy = never`. An execution guard denies every tool except `read`, `glob`, `grep`, and the scoped structured-output tool, permits no further subagents, and allows at most four investigation steps plus the final response step. Sensitive files may be inspected only when a minimal read-only check can change the decision.
- The Reviewer receives the exact pending action, approval reason, current permissions, bounded raw session events, the main Agent's assembled system instructions, and AGENTS.md or equivalent workspace instructions. Stable instructions are serialized in a separate cacheable prefix before session identifiers, transcripts, permissions, and action data. Direct user messages, human answers returned by `ask_user_question`, assembled system instructions, and workspace instructions can establish authorization; assistant content and other tool results remain untrusted evidence.
- Only `outcome` is required in the structured result. A compact `{"outcome":"allow"}` defaults to low risk and unknown authorization; omitted fields on a denial default to high risk and unknown authorization. Explicit assessments may also contain `risk_level`, `user_authorization`, and `rationale`. The host always denies critical risk and denies high risk without at least medium user authorization. Invalid output, missing action data, timeout, cancellation-independent infrastructure failure, and tool failure all fail closed.
- A successful model denial is not retried and never falls back to a user prompt. The default 90-second deadline covers child creation, all model steps, local read-only investigation, and final structured output.
- Three consecutive denials in the same parent turn interrupt that turn. Any allowed action resets the counter. Each approval is still isolated in its own child session.

The parent session records the approval events and a compact plugin notice. The Reviewer child session uses an `_auto-approve:<callId>` label and contains its messages, investigation tool calls and results, final assessment, and turn end. Console logs contain identifiers, model route, step count, stop reason, risk, authorization, and outcome, but not full prompts or file contents.

## Install

Install [simon300000/dsh-auto](https://github.com/simon300000/dsh-auto) from GitHub:

```sh
dsh plugin --profile web add github:simon300000/dsh-auto
```

Restart the Web UI, then select `Auto Approve` in the session Permissions selector or as the default permission preset in General Settings.

## Configuration

The bundled defaults use `deepseek-official/deepseek-v4-flash` with `high` reasoning:

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
    maxMessageTranscriptTokens: 4000
    maxToolTranscriptTokens: 3000
    maxMessageEntryTokens: 1000
    maxToolEntryTokens: 512
    maxSystemInstructionTokens: 6000
    maxAgentInstructionTokens: 6000
    maxRecentNonUserEntries: 20
    maxActionChars: 16000
    maxOutputTokens: 8192
```

`reviewerProvider` and `reviewerModel` must be set together. If both are omitted, the Reviewer uses the parent session's current provider and model. A profile override replaces the complete matching bundle-row `config`, so repeat every value that should remain configured.

The Reviewer persona and the additional security rules live in `prompts/policy-template.md` and `prompts/policy.md`. Restart DSH after changing the configuration, policy, or plugin code.

## License

[MIT](LICENSE)
