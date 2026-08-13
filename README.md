# dsh-auto

English | [中文](README.zh.md)

`dsh-auto` adds an `Auto Approve` permission preset to the DeepSeek Harness Web UI. It keeps the agent inside the `workspace-write` sandbox while an independent model reviews each action that would otherwise require human approval.

The current release supports the Web UI only. It does not add a TUI surface.

## Behavior

- The plugin handles `approval/request` only when the current session explicitly selects `Auto Approve`. Every other preset continues through the Web UI's existing human approval flow.
- The reviewer uses the current session's provider and model by default. Set both `reviewerProvider` and `reviewerModel` to use a dedicated model.
- The reviewer receives bounded recent history, the exact tool-call arguments, and the working directory. Conversation and tool content are treated as untrusted data.
- Each approval applies only to the exact action under review. A timeout, model error, invalid JSON response, missing `callId` arguments, or oversized input rejects the action.
- The default total timeout is 30 seconds, with at most three attempts.

## Install

Install [simon300000/dsh-auto](https://github.com/simon300000/dsh-auto) from GitHub:

```sh
dsh plugin --profile web add github:simon300000/dsh-auto
```

Open the Web UI and select `Auto Approve` from the session Permissions selector. The preset also appears in the default-permission selector under General Settings.

## Configure a dedicated reviewer

Edit the `dsh-auto-approve` row in this package's `cordis.patch.yml`, or override the complete row with the same `id` in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-auto-approve
  name: dsh-auto
  config:
    reviewerProvider: deepseek-official
    reviewerModel: deepseek-v4-flash
    timeoutMs: 30000
    maxAttempts: 3
    maxMessages: 40
    maxMessageChars: 4000
    maxActionChars: 16000
    maxOutputTokens: 768
```

`reviewerProvider` and `reviewerModel` must be set together. A profile layer replaces the entire `config` value of a matching bundle row, so an override must repeat every setting it needs to retain.

## Policy files

The review policy has two files:

- `prompts/policy-template.zh.md` defines the reviewer role, authorization evidence, risk levels, and JSON protocol.
- `prompts/policy.zh.md` defines additional rules for secrets, exfiltration, destructive actions, production systems, and publication.

Restart dsh after changing either policy or the plugin code.

## License

[MIT](LICENSE)
