# Segly Agent

Official agent-facing CLI, local MCP server, and Codex/OpenAI plugin for [Segly](https://segly.io).

Turn PNG, JPEG, or WebP images into named layers, masks, ZIP, Spine PSD, Live2D PSD, and rig metadata.

## Three-command quickstart

```sh
npx @segly/cli auth login
npx @segly/cli layers predict ./character.png --workflow character-simple --json > layers.json
npx @segly/cli segment create ./character.png --workflow character-simple --layers-file layers.json --max-credits 5
```

Prediction is authenticated and costs zero credits. Segmentation starts only with an explicit layer list and `--max-credits 5`. Failed segmentation jobs return their reserved Segly credits. Insufficient balance never triggers an automatic purchase.

Run the local MCP server with:

```sh
npx @segly/cli mcp
```

The remote MCP endpoint is `https://api.segly.io/mcp`. See [segly.io/agents](https://segly.io/agents), [agents.md](https://segly.io/agents.md), and the [v1 OpenAPI description](https://api.segly.io/v1/openapi.json) for the full contract.

Machine accounts and native machine payments are not available. `credits buy` uses human-authorized hosted Checkout by default.

## Repository contents

- `packages/cli`: TypeScript CLI and local MCP server
- `plugins/segly`: Segly plugin, skill, MCP configuration, and tool-selection evals
- `server.json`: official MCP Registry metadata
- `.agents/plugins/marketplace.json`: repository marketplace metadata

## License

MIT. Segly's hosted service and underlying product technology remain governed by the Segly Terms of Service.
