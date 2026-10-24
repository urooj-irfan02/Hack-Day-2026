# Hisaab

> Your WhatsApp chaos, reconciled.

Upload an exported WhatsApp chat plus payment screenshots. Hisaab extracts orders, reads each payment, flags mismatches, and exports a verified sheet. The seller approves everything.

## Hard Rules
- Every AI API call goes through `server/gemma.ts` with model constant `process.env.GEMMA_MODEL ?? "gemma-4-26b-a4b-it"`.
- All arithmetic, price lookup, matching and flagging is deterministic code (`server/reconcile.ts`).
- Zod schema validation on every model output with automatic retry.
- Replay mode via `cache/` keyed by SHA-256 hash. `REPLAY=1` serves completely offline.

## License
Apache-2.0
