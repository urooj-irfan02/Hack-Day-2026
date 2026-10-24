import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import {
  chunkMessages,
  extractOrders,
  formatMessagesForModel,
  mergeExtractedOrders,
} from "../server/gemma.ts";
import { parseWhatsAppChat } from "../server/parser.ts";
import { ExtractedOrder, Message } from "../server/schemas.ts";

test("chunkMessages: returns single chunk for messages <= 40", () => {
  const dummyMessages: Message[] = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    ts: "21/10/2026, 10:00",
    sender: "User",
    text: `Message ${i + 1}`,
    attachments: [],
  }));

  const chunks = chunkMessages(dummyMessages, 40, 5);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].length, 25);
});

test("chunkMessages: creates sliding overlap of 5 for messages > 40", () => {
  const dummyMessages: Message[] = Array.from({ length: 75 }, (_, i) => ({
    id: i + 1,
    ts: "21/10/2026, 10:00",
    sender: "User",
    text: `Message ${i + 1}`,
    attachments: [],
  }));

  const chunks = chunkMessages(dummyMessages, 40, 5);
  // Chunk 1: 0..40 (40 items)
  // Chunk 2: 35..75 (40 items)
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].length, 40);
  assert.strictEqual(chunks[0][0].id, 1);
  assert.strictEqual(chunks[0][39].id, 40);

  assert.strictEqual(chunks[1].length, 40);
  assert.strictEqual(chunks[1][0].id, 36); // Overlap of 5 from previous chunk
  assert.strictEqual(chunks[1][39].id, 75);
});

test("mergeExtractedOrders: merges overlapping orders across chunks", () => {
  const chunk1: ExtractedOrder[] = [
    {
      customerName: "Bilal Sheikh",
      phone: "03219876543",
      address: "Flat 4B, Karachi",
      items: [{ name: "Nutella Brownies", qty: 2 }],
      status: "active",
      sourceMessageIds: [4, 5],
      notes: null,
    },
  ];

  // Later chunk receives customer's edit: "2 nahi, 3 kardo"
  const chunk2: ExtractedOrder[] = [
    {
      customerName: "Bilal Sheikh",
      phone: "03219876543",
      address: "Flat 4B, Karachi",
      items: [{ name: "Nutella Brownies", qty: 3 }],
      status: "active",
      sourceMessageIds: [6, 8],
      notes: null,
    },
  ];

  const merged = mergeExtractedOrders([chunk1, chunk2]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].id, "order-1");
  assert.strictEqual(merged[0].customerName, "Bilal Sheikh");
  assert.strictEqual(merged[0].items[0].qty, 3);
  assert.deepStrictEqual(merged[0].sourceMessageIds, [4, 5, 6, 8]);
});

test("formatMessagesForModel: includes IDs, timestamps, senders and attachments", () => {
  const msgs: Message[] = [
    {
      id: 1,
      ts: "21/10/2026, 10:15",
      sender: "Ahmed",
      text: "Salam",
      attachments: ["slip.jpg"],
    },
  ];

  const formatted = formatMessagesForModel(msgs);
  assert.ok(formatted.includes("[ID: 1]"));
  assert.ok(formatted.includes("[21/10/2026, 10:15]"));
  assert.ok(formatted.includes("Ahmed: Salam"));
  assert.ok(formatted.includes("[Attachments: slip.jpg]"));
});

test("extractOrders: parses samples/chat.txt with correct orders and planted cases", async () => {
  const chatText = fs.readFileSync("samples/chat.txt", "utf8");
  const messages = parseWhatsAppChat(chatText);
  assert.strictEqual(messages.length, 21);

  const { orders, chunkCount, cachedAll } = await extractOrders(messages);

  assert.strictEqual(chunkCount, 1);
  assert.strictEqual(cachedAll, true);
  assert.strictEqual(orders.length, 7);

  // Case 1: Order edited later (Bilal Sheikh: 2 -> 3 Nutella Brownies)
  const bilal = orders.find((o) => o.customerName.includes("Bilal"));
  assert.ok(bilal);
  assert.strictEqual(bilal.status, "active");
  const brownieItem = bilal.items.find((i) =>
    i.name.toLowerCase().includes("brownie")
  );
  assert.ok(brownieItem);
  assert.strictEqual(brownieItem.qty, 3);

  // Case 2: Order cancelled (Zainab Bibi)
  const zainab = orders.find((o) => o.customerName.includes("Zainab"));
  assert.ok(zainab);
  assert.strictEqual(zainab.status, "cancelled");

  // Case 5: Missing address (Sana Javed)
  const sana = orders.find((o) => o.customerName.includes("Sana"));
  assert.ok(sana);
  assert.strictEqual(sana.status, "active");
  assert.strictEqual(sana.address, undefined);
});
