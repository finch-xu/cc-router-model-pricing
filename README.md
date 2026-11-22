# cc-router-model-pricing

[cc-router](https://github.com/finch-xu/cc-router) 的全球模型价格表插件（`type: "pricing"`，`pricingApi: 1`，币种 `USD`，单位每百万 token）。

纯静态数据，零可执行代码，零运行时网络请求。安装后 cc-router 会在统计页、请求详情与使用小票中按价格表实时估算费用。

## 数据来源

本插件的 [`pricing.json`](./pricing.json) 由 [`scripts/sync.mjs`](./scripts/sync.mjs) 从以下开源数据源自动汇聚生成，按优先级合并：

1. **[models.dev](https://models.dev)**（`https://models.dev/api.json`）— 主数据源，覆盖绝大多数国际与国内直连厂商及缓存读写价格。
2. **[OpenRouter API](https://openrouter.ai/api/v1/models)** — 为 `openrouter` 厂商提供实时准确的聚合模型定价与缓存价。
3. **[LiteLLM](https://github.com/BerriAI/litellm)**（`model_prices_and_context_window.json`）— 仅用于补齐 `models.dev` 中已下线或缺失的历史模型快照（如 `deepseek-chat`、`deepseek-reasoner`、早期 Claude / OpenAI / Moonshot 快照等），不会覆盖 `models.dev` 已有条目。

## 覆盖范围与匹配说明

- **精准厂商规则**：覆盖 `anthropic`、`openai`、`openai_codex`、`google_ai_studio`、`google_gemini_interactions`、`deepseek`、`openrouter`、`requesty`、`xai`、`fireworks`、`cloudflare`、`cloudflare_clef`、`alibaba`、`zhipu`、`moonshot`、`minimax`、`volcengine`、`stepfun`、`tencent`、`xiaomi`。
- **通配兜底规则（`provider: "*"`）**：将主流一厂模型及常见版本号别名（如 `claude-sonnet-4.5*`、`claude-opus-4-6-*`、`minimax-m2.7` 等）写入 `*`，让自定义订阅（`custom*`）和第三方中转站也能正常估算费用，同时不干扰已匹配具体厂商的精确价格。
- **长上下文阶梯价说明**：`pricingApi: 1` 仅支持单一费率，存在长上下文分档涨价的模型（如 >200k tokens）均按基础档位单价估算。
- **免费模型**：上游标价为 `0` 的免费模型（如 `:free`）保留为 `0`，在统计页中显示为 `$0` 而非 `—`。

## 安装方式

- **从社区商店安装**：在 cc-router →「插件」→「社区」中搜索 **全球模型价格表（USD）** 安装。
- **从链接安装**：在 cc-router →「插件」→「从链接安装」粘贴本仓库链接。
- **本地加载调试**：克隆本仓库后，在 cc-router →「插件」→「从文件夹加载」选择本目录。

## 本地同步与校验

需要 Node.js 20+（零 npm 依赖）：

```bash
# 重新拉取上游开源价格数据并生成 pricing.json
node scripts/sync.mjs

# 使用 cc-router 官方 Rust 校验器校验
git clone --depth 1 https://github.com/finch-xu/cc-router .cc-router
cargo run --release --manifest-path .cc-router/src-tauri/Cargo.toml \
  -p cc-router-plugin-spec --bin ccr-plugin-check -- .
```

本仓库还配置了每周定时 GitHub Actions（[`.github/workflows/sync.yml`](./.github/workflows/sync.yml)），当上游价格发生变化时会自动校验并提 PR 更新。

## License

[MIT](./LICENSE)
