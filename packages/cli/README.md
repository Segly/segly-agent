# `@segly/cli`

Agent-friendly CLI and local MCP server for the Segly v1 API.

```bash
npx @segly/cli auth use-key
npx @segly/cli layers predict character.png \
  --workflow character-simple > layers.json
npx @segly/cli segment create character.png \
  --workflow character-simple \
  --layers-file layers.json \
  --max-credits 5
```

Review `layers.json` before the paid command. Prediction is authenticated but
costs zero credits; segmentation starts only after the exact reviewed layer
list and the explicit five-credit limit are supplied.

As a journaled alternative, `segment create --predict-layers --max-credits 5`
uploads and predicts but deliberately stops before paid submission. Review the
returned layers and retain its `operation_id`, then rerun the same command with
that `--operation-id` plus `--accept-predicted-layers`. The acceptance flag
submits the stored proposal exactly once; it never silently accepts a fresh
prediction.

Browser OAuth is available through `segly auth login` when Segly's OAuth discovery metadata reports
an active authorization server. Dark-gated machine enrollment and recovery are exposed through
`segly machine create` and `segly auth recover`; they report unavailable until the payment and legal
launch gates are enabled.

`segment create` is asynchronous by default. Add `--wait` to wait for a
terminal result, and `--download ./results` to prepare and download an artifact
after a successful result.

## Authentication

Set `SEGLY_API_KEY`, pipe a key into `segly auth use-key`, or enter it at the
hidden interactive prompt. The CLI uses the Linux desktop secret service when
`secret-tool` is available. Its fallback is a mode-0600 file inside a mode-0700
Segly config directory on Unix systems and current-user Windows DPAPI encryption
on Windows. Recovery and webhook signing secrets are stored separately from the
normal credential.

The default API is `https://api.segly.io`. Override it with
`SEGLY_API_URL` or `--api-url` for staging and local development.

## Safe automation

- Output is JSON on stdout; progress goes to stderr.
- Every paid request requires `--max-credits 5`.
- Multiple images also require `--max-total-credits`.
- Explicit layers can be repeated with `--layer` or loaded from a JSON array, prediction response, or
  newline list with `--layers-file`.
- `--predict-layers` is preview-only until the same operation is resumed with
  `--accept-predicted-layers`.
- Retriable paid requests reuse a journaled idempotency key.
- Use `--operation-id` to resume a command after a process or network failure.
- Purchases are explicit and never triggered by an insufficient-credit error.

Run `npx @segly/cli mcp` to expose the same operations over stdio MCP.
