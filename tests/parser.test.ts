import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanUnicode,
  detectFormat,
  extractAttachments,
  parseWhatsAppChat,
} from "../server/parser.ts";

test("detectFormat: correctly identifies export types", () => {
  const androidSample = "21/10/2026, 14:05 - Bilal: Salam bhai";
  const iosSample = "[21/10/26, 2:05:11 PM] Bilal: Salam bhai";
  const unknownSample = "Just some random text line without timestamps";

  assert.strictEqual(detectFormat(androidSample), "android");
  assert.strictEqual(detectFormat(iosSample), "ios");
  assert.strictEqual(detectFormat(unknownSample), "unknown");
});

test("extractAttachments: extracts Android and iOS attachment filenames", () => {
  const androidText = "IMG-20261021-WA0004.jpg (file attached)";
  const iosText = "<attached: 00000004-PHOTO-2026-10-21.jpg>";
  const multipleText =
    "Here is receipt: IMG-20261021-WA0005.jpg (file attached) and proof: <attached: doc_99.pdf>";

  assert.deepStrictEqual(extractAttachments(androidText), [
    "IMG-20261021-WA0004.jpg",
  ]);
  assert.deepStrictEqual(extractAttachments(iosText), [
    "00000004-PHOTO-2026-10-21.jpg",
  ]);
  assert.deepStrictEqual(extractAttachments(multipleText), [
    "IMG-20261021-WA0005.jpg",
    "doc_99.pdf",
  ]);
});

test("cleanUnicode: strips invisible directional marks", () => {
  const raw = "\u200e\u200f[21/10/26, 2:05:11 PM] Bilal: Test   ";
  assert.strictEqual(cleanUnicode(raw), "[21/10/26, 2:05:11 PM] Bilal: Test");
});

test("parseWhatsAppChat: Android 24h format with multi-line and attachments", () => {
  const chat = `
21/10/2026, 14:00 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.
21/10/2026, 14:05 - Bilal Khan: Salam bhai, 2 chocolate cakes chahiye.
Kal sham 5 baje tak deliver hosakta hai?
House 14, Street 5, F-7/2, Islamabad.
21/10/2026, 14:08 - Sweet Treats Bakery: Walaykum Assalam! Ji bilkul deliver hojaye ga.
21/10/2026, 14:15 - Bilal Khan: IMG-20261021-WA0004.jpg (file attached)
Maine Rs 3500 transfer kardiye hain dekh lein.
`.trim();

  const messages = parseWhatsAppChat(chat);

  assert.strictEqual(messages.length, 3);

  // Message 1 (Multi-line)
  assert.strictEqual(messages[0].id, 1);
  assert.strictEqual(messages[0].sender, "Bilal Khan");
  assert.strictEqual(messages[0].ts, "21/10/2026, 14:05");
  assert.ok(messages[0].text.includes("Salam bhai, 2 chocolate cakes chahiye."));
  assert.ok(messages[0].text.includes("Kal sham 5 baje tak deliver hosakta hai?"));
  assert.ok(messages[0].text.includes("House 14, Street 5, F-7/2, Islamabad."));
  assert.deepStrictEqual(messages[0].attachments, []);

  // Message 2
  assert.strictEqual(messages[1].id, 2);
  assert.strictEqual(messages[1].sender, "Sweet Treats Bakery");
  assert.strictEqual(
    messages[1].text,
    "Walaykum Assalam! Ji bilkul deliver hojaye ga."
  );
  assert.deepStrictEqual(messages[1].attachments, []);

  // Message 3 (Attachment + Caption continuation)
  assert.strictEqual(messages[2].id, 3);
  assert.strictEqual(messages[2].sender, "Bilal Khan");
  assert.deepStrictEqual(messages[2].attachments, ["IMG-20261021-WA0004.jpg"]);
  assert.ok(
    messages[2].text.includes("Maine Rs 3500 transfer kardiye hain dekh lein.")
  );
});

test("parseWhatsAppChat: Android 12h AM/PM format with narrow no-break spaces", () => {
  const chat = `
21/10/2026, 2:05\u202fpm - Sara Ali: Hi, 1 red velvet cake please.
21/10/2026, 2:06\u202fpm - Sara Ali: payment_receipt_102.png (file attached)
`.trim();

  const messages = parseWhatsAppChat(chat);
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].sender, "Sara Ali");
  assert.strictEqual(messages[0].text, "Hi, 1 red velvet cake please.");
  assert.strictEqual(messages[1].sender, "Sara Ali");
  assert.deepStrictEqual(messages[1].attachments, ["payment_receipt_102.png"]);
});

test("parseWhatsAppChat: iOS format with multi-line, LRM markers and attachments", () => {
  const chat = `
\u200e[21/10/26, 2:05:11 PM] Messages and calls are end-to-end encrypted.
\u200e[21/10/26, 2:05:11 PM] Usman Tariq: Bhai 3 brownies box aur 1 cheesecake.
Address: Flat 12B, Clifton, Karachi.
Phone: 03009988776.
\u200e[21/10/26, 2:07:44 PM] Usman Tariq: <attached: 00000004-PHOTO-2026-10-21.jpg>
Payment sent via Nayapay.
\u200e[21/10/26, 2:10:00 PM] Bakery: Order confirmed!
`.trim();

  const messages = parseWhatsAppChat(chat);

  assert.strictEqual(messages.length, 3);

  // Message 1
  assert.strictEqual(messages[0].id, 1);
  assert.strictEqual(messages[0].sender, "Usman Tariq");
  assert.strictEqual(messages[0].ts, "21/10/26, 2:05:11 PM");
  assert.ok(messages[0].text.includes("Bhai 3 brownies box aur 1 cheesecake."));
  assert.ok(messages[0].text.includes("Address: Flat 12B, Clifton, Karachi."));
  assert.ok(messages[0].text.includes("Phone: 03009988776."));
  assert.deepStrictEqual(messages[0].attachments, []);

  // Message 2 (iOS attachment)
  assert.strictEqual(messages[1].id, 2);
  assert.strictEqual(messages[1].sender, "Usman Tariq");
  assert.deepStrictEqual(messages[1].attachments, [
    "00000004-PHOTO-2026-10-21.jpg",
  ]);
  assert.ok(messages[1].text.includes("Payment sent via Nayapay."));

  // Message 3
  assert.strictEqual(messages[2].id, 3);
  assert.strictEqual(messages[2].sender, "Bakery");
  assert.strictEqual(messages[2].text, "Order confirmed!");
});

test("parseWhatsAppChat: handles empty or invalid input gracefully", () => {
  assert.deepStrictEqual(parseWhatsAppChat(""), []);
  assert.deepStrictEqual(parseWhatsAppChat("   \n\n  "), []);
});

test("parseWhatsAppChat: handles phone numbers as senders", () => {
  const chat = `
21/10/2026, 14:05 - +92 321 4567890: Ek vanilla cake order karna hai.
`.trim();

  const messages = parseWhatsAppChat(chat);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].sender, "+92 321 4567890");
  assert.strictEqual(messages[0].text, "Ek vanilla cake order karna hai.");
});
