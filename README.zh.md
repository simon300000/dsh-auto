# dsh-auto

[English](README.md) | 中文

`dsh-auto` 为 DeepSeek Harness 的 WebUI 增加一个 `Auto Approve` 权限档位。它保留 `workspace-write` 沙箱，并把原本需要人工确认的每个动作交给独立模型审查。

当前版本只支持 WebUI，不包含 TUI 界面。

## 行为

- 只有当前会话明确选择 `Auto Approve` 时，插件才接管 `approval/request`；其他档位继续使用 WebUI 原有的人工确认。
- 默认沿用当前会话的 provider/model 作为审查模型。也可以同时设置 `reviewerProvider` 与 `reviewerModel`，使用独立模型。
- 审查器收到最近的有界会话记录、精确工具调用参数和工作目录。会话和工具内容均视为不可信数据。
- 每次授权只对一个精确动作生效。超时、模型异常、无效 JSON、找不到 `callId` 对应参数或输入超过上限时一律拒绝。
- 默认总超时 30 秒，最多尝试 3 次。

## 安装

从 GitHub 安装 [simon300000/dsh-auto](https://github.com/simon300000/dsh-auto)：

```sh
dsh plugin --profile web add github:simon300000/dsh-auto
```

打开 WebUI 后，在会话的 Permissions 选择器中选择 `Auto Approve`。该档位也会出现在 General Settings 的默认权限选项中。

## 配置独立审查模型

编辑本包 `cordis.patch.yml` 的 `dsh-auto-approve` 行，或在 profile 自己的 `cordis.patch.yml` 中用同一个 `id` 覆盖完整配置：

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

`reviewerProvider` 和 `reviewerModel` 必须同时设置。profile 层会替换 bundle 层中同一行的整个 `config`，所以覆盖时必须重述所有需要保留的配置项。

## 策略文件

审查策略位于两个文件中：

- `prompts/policy-template.zh.md` 定义审查角色、授权证据、风险等级和 JSON 协议。
- `prompts/policy.zh.md` 定义秘密、外传、破坏性操作、生产环境和公开发布等补充规则。

修改策略或插件代码后，应重启 dsh。

## 许可证

[MIT](LICENSE)
