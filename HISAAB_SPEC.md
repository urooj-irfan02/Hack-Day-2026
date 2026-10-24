# Hisaab: build spec (paste into your coding tool and commit to the repo)

**Tagline:** Your WhatsApp chaos, reconciled.
**One line:** Upload an exported WhatsApp chat plus payment screenshots. Hisaab extracts orders, reads each payment, flags mismatches, and exports a verified sheet. The seller approves everything.

## 0. Hard rules (never violate)
1. Every Gemini API call goes through ONE file: `server/gemma.ts`. The model name is a single constant: `const MODEL = process.env.GEMMA_MODEL ?? "gemma-4-26b-a4b-it"`. Allowed values: `gemma-4-26b-a4b-it`, `gemma-4-31b-it`. NEVER use any `gemini-*` model anywhere in the code. This is a prize requirement.
2. All arithmetic, price lookup, matching and flagging is deterministic code (`server/reconcile.ts`). The model never computes totals.
3. Every model output is validated against a zod schema. On failure: retry once with the validation error appended to the prompt, then mark the item `needs_review`.
4. Nothing is exported until the user approves rows in the UI.
5. Replay mode: every model response is cached on disk in `cache/` keyed by sha256(model + prompt + input). `REPLAY=1` serves only from cache and never calls the network.
6. No real customer data anywhere in the repo. Synthetic data only.
7. The app must never claim a payment is real. It only checks that screenshots are consistent with orders.
8. Secrets only in env vars. `.env.example` is committed, `.env` is gitignored.

## 1. Stack
TypeScript, Node, Express server, React (Vite) single page, zod, `@google/genai` SDK, multer for uploads. No database: in-memory state plus JSON files. License: Apache-2.0.

## 2. Inputs
- `chat.txt`: WhatsApp export. Support both formats:
  - Android: `21/10/2026, 14:05 - Name: message`
  - iOS: `[21/10/26, 2:05:11 PM] Name: message`
  - Multi-line messages continue on lines that do not start with a timestamp.
  - Attachment lines contain a filename: Android `IMG-20261021-WA0004.jpg (file attached)`, iOS `<attached: 00000004-PHOTO-2026-10-21.jpg>`. The parser records `attachments: string[]` per message.
  - Verify these formats against a real export from a phone (names changed) before trusting them.
- `screenshots/*`: payment images. Their filenames match the attachment filenames in the chat, so each screenshot is linked to the customer who sent it.
- `catalog.csv`: `item,aliases,unit_price` (aliases are pipe-separated, include Roman Urdu spellings).

## 3. Pipeline
1. `parser.ts` (code): chat text to `Message[]` `{id, ts, sender, text, attachments[]}`. Unit tests for both formats.
2. `extractOrders` (Gemma, text): send messages in chunks of about 40 with a sliding overlap of 5. Output zod-validated JSON, then merge across chunks in code. Instruct the model to handle edits ("2 nahi 3 kardo"), cancellations, and add-ons that refer to earlier messages. Each order carries `sourceMessageIds`.
3. `readPayment` (Gemma, vision): one call per screenshot. Output: `{amount, currency, txnId, senderName?, timestamp?, status?, confidence}`. Use null for unreadable fields. Never guess.
4. `reconcile.ts` (code): price lines from the catalog (match item names and aliases, flag unknown items), compute totals, link each payment to a customer via the chat attachment filename, compare, and raise flags.
5. `draftReply` (Gemma, text): one short message per flagged order, in the customer's language register. Copy to clipboard only. Never send anything.
6. `export.ts` (code): approved rows to `orders.csv` (name, phone, address, items, total, paid, status) and `pick-list.csv` (item, total qty).

## 4. Schemas (zod)
```
Item    { name: string, qty: number, unit?: string }
Order   { id: string, customerName: string, phone?: string, address?: string,
          items: Item[], status: "active" | "cancelled",
          sourceMessageIds: number[], notes?: string }
Payment { id: string, fileName: string, amount: number | null, currency: string | null,
          txnId: string | null, senderName: string | null, timestamp: string | null,
          status: string | null, confidence: number }
Flag    { code: FlagCode, severity: "error" | "warn", message: string, evidence: string[] }
FlagCode = SHORT_PAYMENT | OVERPAYMENT | DUPLICATE_TXN | MISSING_ADDRESS
         | UNMATCHED_PAYMENT | UNPAID | UNKNOWN_ITEM | LOW_CONFIDENCE
```

## 5. Reconcile rules
- SHORT_PAYMENT: paid < total. Message states both numbers.
- OVERPAYMENT: paid > total.
- DUPLICATE_TXN: the same `txnId` appears on payments linked to different orders. Evidence lists both.
- MISSING_ADDRESS: active order without an address.
- UNPAID: active order with no linked payment.
- UNMATCHED_PAYMENT: payment that cannot be linked to any order.
- UNKNOWN_ITEM: item not found in the catalog.
- LOW_CONFIDENCE: any payment confidence below 0.6 or any extraction that failed validation.
- Cancelled orders are listed but excluded from totals and exports.

## 6. API
- `GET /api/health`
- `POST /api/smoke`: sends one hard-coded Roman Urdu order message to the model and returns the parsed JSON plus the model name used. Used for the first test.
- `POST /api/analyze` (multipart: chat, screenshots[], catalog): returns `{orders, payments, flags, totals}`.
- `POST /api/draft-reply` `{orderId}`: returns `{text}`.
- `POST /api/export` `{approvedOrderIds}`: returns a zip with the two CSVs.

## 7. UI (one page)
Three steps: Upload, Review, Export.
- Review is a table: customer, items, total, paid, status, flags. Flags are red chips.
- Clicking a row opens a side panel with the source chat messages (highlighted) and the linked screenshot beside the extracted fields.
- Every field is editable. Each row has an Approve checkbox. Export is disabled until at least one row is approved.
- "Draft reply" button per flagged row shows text with a Copy button.
- Footer line: "Hisaab checks that screenshots match orders. Confirm payments in your bank app."
- Show the model name in the header ("Gemma 4: gemma-4-26b-a4b-it") and a Replay badge when `REPLAY=1`.

## 8. Sample data (synthetic)
A bakery seller, 3 days, 7 orders, 5 payment screenshots, Roman Urdu / English / Urdu mixed. Plant these cases and record the right answers in `samples/expected.json`:
1. An order edited later ("2 nahi, 3 kardo").
2. An order cancelled.
3. A payment short by a known amount.
4. One transaction ID used for two different orders.
5. An order with no address.
6. A payment screenshot that is blurry or partly unreadable (tests LOW_CONFIDENCE).
Screenshots are generated by a script from a template with fake names and numbers. Do not imitate any real payment app's branding.

## 9. Repo layout
```
LICENSE  README.md  .env.example  HISAAB_SPEC.md
server/ index.ts gemma.ts parser.ts reconcile.ts export.ts schemas.ts cache.ts
web/    (React app)
prompts/ extract_orders.md read_payment.md draft_reply.md
samples/ chat.txt screenshots/ catalog.csv expected.json
scripts/ make-screenshots.ts
tests/  parser.test.ts reconcile.test.ts
cache/  (recorded model responses, committed for replay)
```

## 10. Acceptance criteria
- `samples/` produces the expected 7 orders with at most 1 manual fix.
- All planted flags are raised, and no extra error-level flags appear.
- Totals exactly match `expected.json`.
- Export is blocked until a row is approved.
- `REPLAY=1` works with the network disconnected.
- `grep -rn "gemini-" server/ web/` returns nothing.

## 11. Out of scope
WhatsApp API, login, database, voice notes, handwriting OCR, auto-sending messages, courier APIs, mobile app, fine-tuning.
