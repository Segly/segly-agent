---
name: segly
description: Use Segly to predict named image layers, create paid animation-ready segmentations, track jobs, and download verified ZIP, mask, Spine PSD, Live2D PSD, or rig artifacts. Apply when the user wants to separate a PNG, JPEG, or WebP image into useful layers; do not use it for general image generation or editing.
---

# Segly

Use the bundled Segly MCP tools for local images. The CLI is an equivalent fallback through
`npx @segly/cli`.

## Workflow

1. Call `get_capabilities` when the workflow, limits, formats, current cost, or output kind is not
   already known. Use only a workflow ID the response advertises.
2. Call `predict_layers` when the user has not supplied explicit layers. Prediction is authenticated,
   separate from segmentation, and costs zero credits. Show the proposed layers without implying that
   a paid job has started.
3. Before `create_segmentation`, ensure the user has authorized exactly five credits for this image.
   A direct request to segment the image with five credits counts as authorization; otherwise ask.
   Supply the exact reviewed layer list, `max_credits: 5`, and a newly generated stable
   `operation_id`. Layer prediction is always a separate tool call.
4. Return the asynchronous job immediately unless the user asked to wait. For a wait, poll
   `get_segmentation` with a bounded deadline and respect server retry guidance. Treat `succeeded`,
   `failed`, and `cancelled` as terminal.
5. After success, use `download_artifact` to prepare, atomically download, and verify the checksum.

## Safety and recovery

- Reuse the identical `operation_id` after a timeout or interrupted paid call. Never create a new
  operation ID merely because the response was lost.
- Never buy credits automatically after `insufficient_credits`. Explain the shortfall. Call
  `begin_credit_purchase` only for an explicitly chosen pack, payment method, price cap, confirmation,
  and stable purchase operation ID.
- Do not request or expose an API key, recovery secret, payment credential, or signed artifact URL in
  model-visible arguments or prose. Authentication belongs in the CLI credential store or OAuth flow.
- Cancellation is for queued work. Do not repeatedly retry a processing cancellation.
- Do not invent layers, prices, output types, readiness, or refund status that the Segly response did
  not provide.
