# 停止与回执

- `requested`：已发出停止请求，尚未收到终止回执，继续占用工作区。
- `stopped`：原生回执为 `interrupted`，已确认停止并释放工作区。
- `finished`：正常完成或失败（`completed` 或 `failed`），回合已终止并释放工作区。
- `unknown`：回执 `lost`，结果未知，保留工作区占用，先核对原生端。

`hold` 在 `active`、`requested` 和 `unknown` 时为 `true`；在 `stopped` 和 `finished` 时为 `false`。

## 示例

```json
{"withoutReceipt":{"state":"requested","hold":true},"interrupted":{"state":"stopped","hold":false}}
```
