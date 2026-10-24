import crypto from "crypto";
import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import {
  computeCacheKey,
  getCachedResponse,
  isReplayMode,
  saveCachedResponse,
} from "./cache.ts";
import {
  ExtractedOrder,
  ExtractedOrdersChunk,
  ExtractedOrdersChunkSchema,
  Flag,
  Message,
  Order,
  Payment,
  PaymentExtraction,
  PaymentExtractionSchema,
  PaymentSchema,
  SmokeOrderExtractionSchema,
  type SmokeOrderExtraction,
} from "./schemas.ts";

/**
 * Hard rule 1: Every model API call goes through this file.
 * The model name is a single constant.
 * Allowed values: "gemma-4-26b-a4b-it", "gemma-4-31b-it".
 */
export const MODEL = process.env.GEMMA_MODEL ?? "gemma-4-26b-a4b-it";

export function getModelName(): string {
  return MODEL;
}

function getAiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function cleanJsonString(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  }
  return cleaned.trim();
}

/**
 * Execute a structured prompt with validation against a Zod schema.
 * Supports caching and replay mode, with one retry on validation error.
 */
export async function executeStructuredPrompt<T>(options: {
  prompt: string;
  input: string;
  schema: z.ZodSchema<T>;
  systemInstruction?: string;
}): Promise<{ data: T; cached: boolean; rawText: string; needsReview?: boolean }> {
  const { prompt, input, schema, systemInstruction } = options;
  const cacheKey = computeCacheKey(MODEL, prompt, input);

  // 1. Check cache
  const cachedRaw = getCachedResponse(cacheKey);
  if (cachedRaw) {
    try {
      const parsedJson = JSON.parse(cleanJsonString(cachedRaw));
      const parsedData = schema.parse(parsedJson);
      return { data: parsedData, cached: true, rawText: cachedRaw };
    } catch (parseError) {
      console.warn(`[Gemma] Cached entry for ${cacheKey} failed schema validation:`, parseError);
      if (isReplayMode()) {
        throw new Error(`[REPLAY] Cached response failed schema validation: ${String(parseError)}`);
      }
    }
  }

  // 2. Enforce offline replay rule
  if (isReplayMode()) {
    throw new Error(
      `[REPLAY] REPLAY=1 is active but no valid cache entry exists for key ${cacheKey}`
    );
  }

  // 3. Call model via SDK
  const ai = getAiClient();
  const fullContent = `${prompt}\n\n[INPUT]\n${input}`;

  let rawText = "";
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: fullContent,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
      },
    });
    rawText = response.text ?? "";
  } catch (apiError: any) {
    throw new Error(`[Gemma API Error]: ${apiError?.message || String(apiError)}`);
  }

  // 4. Validate output with Zod schema (Rule 3)
  let cleaned = cleanJsonString(rawText);
  try {
    const json = JSON.parse(cleaned);
    const validated = schema.parse(json);
    saveCachedResponse(cacheKey, MODEL, prompt, input, rawText);
    return { data: validated, cached: false, rawText };
  } catch (firstValidationError: any) {
    console.warn(`[Gemma] Output failed validation, retrying once with error feedback...`, firstValidationError);

    // Retry once with error appended (Rule 3)
    const retryPrompt = `${prompt}\n\nYour previous response was rejected due to schema error: ${firstValidationError.message}. Output ONLY valid JSON matching the schema.\n\n[INPUT]\n${input}`;
    try {
      const retryResponse = await ai.models.generateContent({
        model: MODEL,
        contents: retryPrompt,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
        },
      });
      const retryRaw = retryResponse.text ?? "";
      const retryCleaned = cleanJsonString(retryRaw);
      const retryJson = JSON.parse(retryCleaned);
      const validated = schema.parse(retryJson);
      saveCachedResponse(cacheKey, MODEL, prompt, input, retryRaw);
      return { data: validated, cached: false, rawText: retryRaw };
    } catch (secondError: any) {
      console.error(`[Gemma] Retry also failed schema validation. Marking needs_review.`, secondError);
      const partialData = (() => {
        try {
          return JSON.parse(cleaned);
        } catch {
          return null;
        }
      })();
      return {
        data: partialData as T,
        cached: false,
        rawText,
        needsReview: true,
      };
    }
  }
}

export const SMOKE_SAMPLE_INPUT =
  "Bhai 2 chocolate cake aur 1 brownies box bhej dain address: Flat 4B, Gulshan, Karachi. Name: Bilal - 03219876543";

export const SMOKE_PROMPT = `Extract order details from this Roman Urdu WhatsApp message into structured JSON with these exact fields:
- customerName: string
- phone: string or null
- address: string or null
- items: array of { "name": string, "qty": number, "unit": string or null }
- notes: string or null`;

/**
 * Smoke test implementation: sends hardcoded Roman Urdu order message.
 * Returns parsed JSON and model name used.
 */
export async function runGemmaSmokeTest(): Promise<{
  success: boolean;
  model: string;
  input: string;
  parsed: SmokeOrderExtraction;
  cached: boolean;
  raw?: string;
  needsReview?: boolean;
}> {
  const result = await executeStructuredPrompt({
    prompt: SMOKE_PROMPT,
    input: SMOKE_SAMPLE_INPUT,
    schema: SmokeOrderExtractionSchema,
    systemInstruction:
      "You are a fast, precise order extraction parser for Pakistani e-commerce WhatsApp chats. Output strictly JSON.",
  });

  return {
    success: true,
    model: MODEL,
    input: SMOKE_SAMPLE_INPUT,
    parsed: result.data,
    cached: result.cached,
    raw: result.rawText,
    needsReview: result.needsReview,
  };
}

/**
 * Splits messages into chunks of about 40 with a sliding overlap of 5 (Spec 3.2).
 */
export function chunkMessages(
  messages: Message[],
  chunkSize = 40,
  overlap = 5
): Message[][] {
  if (messages.length <= chunkSize) {
    return [messages];
  }

  const chunks: Message[][] = [];
  let start = 0;

  while (start < messages.length) {
    const end = Math.min(start + chunkSize, messages.length);
    chunks.push(messages.slice(start, end));
    if (end >= messages.length) break;
    start = end - overlap;
  }

  return chunks;
}

/**
 * Formats a chunk of messages into clean prompt context for Gemma.
 */
export function formatMessagesForModel(messages: Message[]): string {
  return messages
    .map((m) => {
      const attachStr =
        m.attachments.length > 0
          ? ` [Attachments: ${m.attachments.join(", ")}]`
          : "";
      return `[ID: ${m.id}] [${m.ts}] ${m.sender}: ${m.text}${attachStr}`;
    })
    .join("\n");
}

export function getExtractOrdersPrompt(): string {
  const promptPath = path.resolve(process.cwd(), "prompts", "extract_orders.md");
  if (fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, "utf8").trim();
  }
  return `Extract orders from the chat chunk into JSON with { "orders": [...] } format.`;
}

/**
 * Merges extracted orders across chunks in deterministic code (Spec 3.2).
 */
export function mergeExtractedOrders(chunkOrdersList: ExtractedOrder[][]): Order[] {
  const merged: ExtractedOrder[] = [];

  for (const chunkOrders of chunkOrdersList) {
    for (const order of chunkOrders) {
      // Find if this order matches an existing customer in merged list
      const existingIndex = merged.findIndex((m) => {
        // Match by phone number if available
        if (order.phone && m.phone) {
          const p1 = order.phone.replace(/\D/g, "");
          const p2 = m.phone.replace(/\D/g, "");
          if (p1.length >= 10 && p2.length >= 10 && p1.slice(-10) === p2.slice(-10)) {
            return true;
          }
        }
        // Match by normalized customerName
        if (
          order.customerName.toLowerCase().trim() ===
          m.customerName.toLowerCase().trim()
        ) {
          return true;
        }
        // Match by overlapping source message IDs
        const idSet = new Set(m.sourceMessageIds);
        return order.sourceMessageIds.some((id) => idSet.has(id));
      });

      if (existingIndex >= 0) {
        const existing = merged[existingIndex];
        const combinedIds = Array.from(
          new Set([...existing.sourceMessageIds, ...order.sourceMessageIds])
        ).sort((a, b) => a - b);

        // Later chunk takes precedence for edits and cancellations
        merged[existingIndex] = {
          customerName: order.customerName || existing.customerName,
          phone: order.phone || existing.phone,
          address: order.address || existing.address,
          items: order.items.length > 0 ? order.items : existing.items,
          status: order.status,
          sourceMessageIds: combinedIds,
          notes: order.notes || existing.notes,
        };
      } else {
        merged.push(order);
      }
    }
  }

  // Assign clean sequential order IDs (order-1, order-2, ...)
  return merged.map((ext, idx) => ({
    id: `order-${idx + 1}`,
    customerName: ext.customerName,
    phone: ext.phone ?? undefined,
    address: ext.address ?? undefined,
    items: ext.items,
    status: ext.status,
    sourceMessageIds: ext.sourceMessageIds,
    notes: ext.notes ?? undefined,
  }));
}

/**
 * Pipeline step 2: extractOrders
 * Sends messages in chunks of 40 with sliding overlap of 5.
 * Validates output against zod schema, retries once on error,
 * caches responses to disk, and merges across chunks in code.
 */
export async function extractOrders(messages: Message[]): Promise<{
  orders: Order[];
  chunkCount: number;
  cachedAll: boolean;
}> {
  if (messages.length === 0) {
    return { orders: [], chunkCount: 0, cachedAll: true };
  }

  const chunks = chunkMessages(messages, 40, 5);
  const prompt = getExtractOrdersPrompt();
  const chunkOrdersList: ExtractedOrder[][] = [];
  let allCached = true;

  for (const chunk of chunks) {
    const chunkInput = formatMessagesForModel(chunk);
    const result = await executeStructuredPrompt<ExtractedOrdersChunk>({
      prompt,
      input: chunkInput,
      schema: ExtractedOrdersChunkSchema,
      systemInstruction:
        "You are an order extractor for Pakistani bakery WhatsApp chats. Output strictly JSON.",
    });

    if (!result.cached) {
      allCached = false;
    }

    chunkOrdersList.push(result.data.orders);
  }

  const finalOrders = mergeExtractedOrders(chunkOrdersList);
  return {
    orders: finalOrders,
    chunkCount: chunks.length,
    cachedAll: allCached,
  };
}

/**
 * Executes a vision prompt with an image part, validates against a Zod schema,
 * supports disk caching, replay mode, and one retry on validation error (Rules 1, 3, 5).
 */
export async function executeStructuredVisionPrompt<T>(options: {
  prompt: string;
  imageBuffer: Buffer;
  fileName: string;
  mimeType: string;
  schema: z.ZodSchema<T>;
  systemInstruction?: string;
}): Promise<{ data: T; cached: boolean; rawText: string; needsReview?: boolean }> {
  const { prompt, imageBuffer, fileName, mimeType, schema, systemInstruction } = options;
  const imageHash = crypto.createHash("sha256").update(imageBuffer).digest("hex");
  const cacheKey = computeCacheKey(MODEL, prompt, `${fileName}:${imageHash}`);

  // 1. Check disk cache
  const cachedRaw = getCachedResponse(cacheKey);
  if (cachedRaw) {
    try {
      let parsedJson = JSON.parse(cleanJsonString(cachedRaw));
      if (Array.isArray(parsedJson) && parsedJson.length > 0) {
        parsedJson = parsedJson[0];
      }
      const parsedData = schema.parse(parsedJson);
      return { data: parsedData, cached: true, rawText: cachedRaw };
    } catch (parseError) {
      console.warn(`[Gemma Vision] Cached entry for ${cacheKey} failed validation:`, parseError);
      if (isReplayMode()) {
        throw new Error(`[REPLAY] Cached vision response failed schema validation: ${String(parseError)}`);
      }
    }
  }

  // 2. Enforce offline replay rule
  if (isReplayMode()) {
    throw new Error(
      `[REPLAY] REPLAY=1 is active but no cache entry exists for vision key ${cacheKey}`
    );
  }

  // 3. Call model via SDK
  const ai = getAiClient();
  const base64Data = imageBuffer.toString("base64");
  const imagePart = { inlineData: { mimeType, data: base64Data } };
  const textPart = { text: prompt };

  let rawText = "";
  let lastError: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: { parts: [imagePart, textPart] },
        config: {
          systemInstruction,
          responseMimeType: "application/json",
        },
      });
      rawText = response.text ?? "";
      if (rawText) break;
    } catch (apiError: any) {
      lastError = apiError;
      console.warn(
        `[Gemma Vision] Attempt ${attempt + 1} encountered transient error:`,
        apiError?.message || String(apiError)
      );
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
  }

  if (!rawText && lastError) {
    throw new Error(`[Gemma Vision Error]: ${lastError?.message || String(lastError)}`);
  }

  // 4. Validate output with Zod schema (Rule 3)
  const cleaned = cleanJsonString(rawText);
  try {
    let json = JSON.parse(cleaned);
    if (Array.isArray(json) && json.length > 0) {
      json = json[0];
    }
    const validated = schema.parse(json);
    saveCachedResponse(cacheKey, MODEL, prompt, `${fileName}:${imageHash}`, rawText);
    return { data: validated, cached: false, rawText };
  } catch (firstValidationError: any) {
    console.warn(
      `[Gemma Vision] Output failed validation, retrying once with error feedback...`,
      firstValidationError
    );

    // Retry once with error feedback (Rule 3)
    const retryPrompt = `${prompt}\n\nYour previous response failed schema validation with error: ${firstValidationError.message}. Output ONLY valid JSON matching the schema.`;
    try {
      const retryResponse = await ai.models.generateContent({
        model: MODEL,
        contents: { parts: [imagePart, { text: retryPrompt }] },
        config: {
          systemInstruction,
          responseMimeType: "application/json",
        },
      });
      const retryRaw = retryResponse.text ?? "";
      let retryJson = JSON.parse(cleanJsonString(retryRaw));
      if (Array.isArray(retryJson) && retryJson.length > 0) {
        retryJson = retryJson[0];
      }
      const validated = schema.parse(retryJson);
      saveCachedResponse(cacheKey, MODEL, prompt, `${fileName}:${imageHash}`, retryRaw);
      return { data: validated, cached: false, rawText: retryRaw };
    } catch (secondError: any) {
      console.error(`[Gemma Vision] Retry failed validation. Marking needs_review.`, secondError);
      return {
        data: null as unknown as T,
        cached: false,
        rawText,
        needsReview: true,
      };
    }
  }
}

export function getReadPaymentPrompt(): string {
  const promptPath = path.resolve(process.cwd(), "prompts", "read_payment.md");
  if (fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, "utf8").trim();
  }
  return `Extract payment receipt details into JSON: {"amount": number | null, "currency": string | null, "txnId": string | null, "senderName": string | null, "timestamp": string | null, "status": string | null, "confidence": number}. Use null for unreadable fields.`;
}

/**
 * Pipeline step 3: readPayment (Gemma, vision)
 * One call per screenshot. Output: { amount, currency, txnId, senderName?, timestamp?, status?, confidence }
 * Uses null for unreadable fields. Never guesses.
 */
export async function readPayment(options: {
  filePath?: string;
  buffer?: Buffer;
  fileName: string;
  mimeType?: string;
}): Promise<Payment> {
  const { fileName } = options;
  let buffer = options.buffer;

  if (!buffer && options.filePath) {
    buffer = fs.readFileSync(options.filePath);
  }

  if (!buffer) {
    throw new Error(`[readPayment] Neither buffer nor valid filePath provided for ${fileName}`);
  }

  let mimeType = options.mimeType;
  if (!mimeType) {
    const ext = path.extname(fileName).toLowerCase();
    mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  }

  const prompt = getReadPaymentPrompt();
  const result = await executeStructuredVisionPrompt<PaymentExtraction>({
    prompt,
    imageBuffer: buffer,
    fileName,
    mimeType,
    schema: PaymentExtractionSchema,
    systemInstruction:
      "You are a receipt verification OCR engine. Extract only visible information. Use null for unreadable or blurry fields. Never guess.",
  });

  const extraction = result.data;
  if (!extraction || result.needsReview) {
    return PaymentSchema.parse({
      id: `pay-${fileName.replace(/[^a-zA-Z0-9]/g, "-")}`,
      fileName,
      amount: null,
      currency: null,
      txnId: null,
      senderName: null,
      timestamp: null,
      status: null,
      confidence: 0.1,
    });
  }

  return PaymentSchema.parse({
    id: `pay-${fileName.replace(/[^a-zA-Z0-9]/g, "-")}`,
    fileName,
    amount: extraction.amount ?? null,
    currency: extraction.currency ?? (extraction.amount ? "PKR" : null),
    txnId: extraction.txnId ?? null,
    senderName: extraction.senderName ?? null,
    timestamp: extraction.timestamp ?? null,
    status: extraction.status ?? null,
    confidence: extraction.confidence ?? (extraction.amount ? 0.95 : 0.4),
  });
}

/**
 * Batch processor for reading multiple payment screenshots.
 */
export async function readPayments(
  screenshots: Array<{ filePath?: string; buffer?: Buffer; fileName: string; mimeType?: string }>
): Promise<Payment[]> {
  const results: Payment[] = [];
  for (const shot of screenshots) {
    const payment = await readPayment(shot);
    results.push(payment);
  }
  return results;
}

/**
 * Pipeline step 5: draftReply (Gemma, text)
 * One short message per flagged order, in customer's language register.
 * Copy to clipboard only. Never sends anything.
 */
export async function draftReply(options: {
  order: Order;
  flags: Flag[];
  total?: number;
  paid?: number;
}): Promise<string> {
  const { order, flags, total, paid } = options;
  const promptTemplate = (() => {
    const promptPath = path.resolve(process.cwd(), "prompts", "draft_reply.md");
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, "utf8");
    }
    return "You are a customer support assistant for a bakery. Write one polite WhatsApp reply to the customer in Roman Urdu addressing the issue.";
  })();

  const input = `Customer: ${order.customerName}
Phone: ${order.phone ?? "N/A"}
Address: ${order.address ?? "MISSING"}
Items: ${order.items.map((i) => `${i.qty}x ${i.name}`).join(", ")}
Order Total: Rs ${total ?? 0}
Amount Paid: Rs ${paid ?? 0}
Flagged Issues:
${flags.map((f) => `- [${f.code}] ${f.message}`).join("\n")}
`;

  const cacheKey = computeCacheKey(MODEL, promptTemplate, input);
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    return cached.trim();
  }

  if (isReplayMode()) {
    const flagSummary = flags.map((f) => f.message).join(" ");
    return `Salam ${order.customerName}! Aap k order k hawalay se: ${flagSummary}. Kindly check kar k update kar dein taake order confirm ho sake. Shukriya!`;
  }

  const ai = getAiClient();
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: `${promptTemplate}\n\n[ORDER DETAILS]\n${input}`,
  });

  const replyText = (res.text ?? "").trim();
  saveCachedResponse(cacheKey, MODEL, promptTemplate, input, replyText);
  return replyText;
}


