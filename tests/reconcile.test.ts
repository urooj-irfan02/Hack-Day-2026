import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  computeOrderTotal,
  detectOrderFlags,
  linkPaymentsToOrders,
  lookupItemPrice,
  parseCatalog,
  reconcile,
} from "../server/reconcile.ts";
import { Message, Order, Payment } from "../server/schemas.ts";

const SAMPLE_CATALOG_CSV = `
item,aliases,unit_price
Chocolate Fudge Cake,chocolate cake|fudge cake|choc cake,1800
Nutella Brownies,brownies|brownie box|nutella brownie,1200
Lotus Cheesecake,lotus cake|cheesecake,2200
Almond Tea Cake,tea cake|almond cake,950
Red Velvet Cake,red velvet|velvet cake,1900
Pistachio Tart,tart|pista tart,1400
`.trim();

test("parseCatalog: correctly parses CSV into items with aliases and prices", () => {
  const catalog = parseCatalog(SAMPLE_CATALOG_CSV);
  assert.strictEqual(catalog.length, 6);
  assert.strictEqual(catalog[0].name, "Chocolate Fudge Cake");
  assert.strictEqual(catalog[0].unitPrice, 1800);
  assert.deepStrictEqual(catalog[0].aliases, [
    "chocolate cake",
    "fudge cake",
    "choc cake",
  ]);
});

test("lookupItemPrice: matches by direct name, alias, and normalization", () => {
  const catalog = parseCatalog(SAMPLE_CATALOG_CSV);

  // Exact name
  const match1 = lookupItemPrice("Chocolate Fudge Cake", catalog);
  assert.strictEqual(match1?.price, 1800);

  // Alias
  const match2 = lookupItemPrice("choc cake", catalog);
  assert.strictEqual(match2?.price, 1800);

  // Case & whitespace insensitive
  const match3 = lookupItemPrice("  NUTELLA  BROWNIE  ", catalog);
  assert.strictEqual(match3?.price, 1200);

  // Unknown item
  const matchUnknown = lookupItemPrice("Gulab Jamun", catalog);
  assert.strictEqual(matchUnknown, null);
});

test("computeOrderTotal: deterministically computes total", () => {
  const catalog = parseCatalog(SAMPLE_CATALOG_CSV);
  const items = [
    { name: "Nutella Brownies", qty: 3 },
    { name: "Almond Tea Cake", qty: 1 },
  ];

  const { total, unknownItems } = computeOrderTotal(items, catalog);
  assert.strictEqual(total, 3 * 1200 + 1 * 950); // 3600 + 950 = 4550
  assert.deepStrictEqual(unknownItems, []);
});

// Unit tests for all 8 flag codes
test("Flag 1 - SHORT_PAYMENT: raises error flag when paid < total", () => {
  const order: Order = {
    id: "ord-test",
    customerName: "Daniyal Mir",
    address: "Lahore",
    items: [{ name: "Lotus Cheesecake", qty: 1 }],
    status: "active",
    sourceMessageIds: [1],
  };

  const payment: Payment = {
    id: "pay-1",
    fileName: "receipt.jpg",
    amount: 1500,
    currency: "PKR",
    txnId: "TXN-1",
    confidence: 1.0,
  };

  const flags = detectOrderFlags(order, 2200, 1500, [payment], [], new Map());
  const shortFlag = flags.find((f) => f.code === "SHORT_PAYMENT");
  assert.ok(shortFlag);
  assert.strictEqual(shortFlag.severity, "error");
  assert.ok(shortFlag.message.includes("1500"));
  assert.ok(shortFlag.message.includes("2200"));
});

test("Flag 2 - OVERPAYMENT: raises warn flag when paid > total", () => {
  const order: Order = {
    id: "ord-test",
    customerName: "Test User",
    address: "Islamabad",
    items: [{ name: "Red Velvet Cake", qty: 1 }],
    status: "active",
    sourceMessageIds: [1],
  };

  const payment: Payment = {
    id: "pay-1",
    fileName: "receipt.jpg",
    amount: 2500,
    currency: "PKR",
    txnId: "TXN-2",
    confidence: 1.0,
  };

  const flags = detectOrderFlags(order, 1900, 2500, [payment], [], new Map());
  const overFlag = flags.find((f) => f.code === "OVERPAYMENT");
  assert.ok(overFlag);
  assert.strictEqual(overFlag.severity, "warn");
  assert.ok(overFlag.message.includes("2500"));
  assert.ok(overFlag.message.includes("1900"));
});

test("Flag 3 - DUPLICATE_TXN: raises error when same txnId used across multiple orders", () => {
  const order1: Order = {
    id: "ord-1",
    customerName: "Fatima Tariq",
    address: "Islamabad",
    items: [{ name: "Chocolate Cake", qty: 1 }],
    status: "active",
    sourceMessageIds: [1],
  };

  const order2: Order = {
    id: "ord-2",
    customerName: "Hamza Ali",
    address: "Rawalpindi",
    items: [{ name: "Chocolate Cake", qty: 1 }],
    status: "active",
    sourceMessageIds: [2],
  };

  const dupPayment: Payment = {
    id: "pay-dup",
    fileName: "receipt.jpg",
    amount: 1800,
    currency: "PKR",
    txnId: "TXN-DUPL-990011",
    confidence: 1.0,
  };

  const dupMap = new Map<string, Array<{ orderId: string; customerName: string }>>();
  dupMap.set("TXN-DUPL-990011", [
    { orderId: "ord-1", customerName: "Fatima Tariq" },
    { orderId: "ord-2", customerName: "Hamza Ali" },
  ]);

  const flags1 = detectOrderFlags(order1, 1800, 1800, [dupPayment], [], dupMap);
  const dupFlag1 = flags1.find((f) => f.code === "DUPLICATE_TXN");
  assert.ok(dupFlag1);
  assert.strictEqual(dupFlag1.severity, "error");
  assert.ok(dupFlag1.evidence[1].includes("ord-1 (Fatima Tariq)"));
  assert.ok(dupFlag1.evidence[1].includes("ord-2 (Hamza Ali)"));
});

test("Flag 4 - MISSING_ADDRESS: raises error when active order has no address", () => {
  const order: Order = {
    id: "ord-no-addr",
    customerName: "Sana Javed",
    address: undefined,
    items: [{ name: "Red Velvet Cake", qty: 1 }],
    status: "active",
    sourceMessageIds: [1],
  };

  const payment: Payment = {
    id: "pay-1",
    fileName: "receipt.jpg",
    amount: 1900,
    currency: "PKR",
    txnId: "TXN-1",
    confidence: 1.0,
  };

  const flags = detectOrderFlags(order, 1900, 1900, [payment], [], new Map());
  const addrFlag = flags.find((f) => f.code === "MISSING_ADDRESS");
  assert.ok(addrFlag);
  assert.strictEqual(addrFlag.severity, "error");
});

test("Flag 5 - UNPAID: raises error when active order has no payment linked", () => {
  const order: Order = {
    id: "ord-unpaid",
    customerName: "Asim Khan",
    address: "Karachi",
    items: [{ name: "Nutella Brownies", qty: 1 }],
    status: "active",
    sourceMessageIds: [1],
  };

  const flags = detectOrderFlags(order, 1200, 0, [], [], new Map());
  const unpaidFlag = flags.find((f) => f.code === "UNPAID");
  assert.ok(unpaidFlag);
  assert.strictEqual(unpaidFlag.severity, "error");
});

test("Flag 6 - UNMATCHED_PAYMENT: raises warn flag when payment is unlinked", () => {
  const result = reconcile({
    orders: [],
    messages: [],
    payments: [
      {
        id: "orphan-pay",
        fileName: "PAY-unlinked.jpg",
        amount: 2000,
        currency: "PKR",
        txnId: "TXN-UNKNOWN",
        confidence: 0.95,
      },
    ],
    catalogCsv: SAMPLE_CATALOG_CSV,
  });

  const unmatched = result.flags.find((f) => f.code === "UNMATCHED_PAYMENT");
  assert.ok(unmatched);
  assert.strictEqual(unmatched.severity, "warn");
});

test("Flag 7 - UNKNOWN_ITEM: raises error when item is not in catalog", () => {
  const order: Order = {
    id: "ord-unknown",
    customerName: "Ali",
    address: "Lahore",
    items: [{ name: "Special Birthday Pinata", qty: 1 }],
    status: "active",
    sourceMessageIds: [1],
  };

  const flags = detectOrderFlags(
    order,
    0,
    1000,
    [
      {
        id: "p1",
        fileName: "slip.jpg",
        amount: 1000,
        currency: "PKR",
        txnId: "T1",
        confidence: 1,
      },
    ],
    ["Special Birthday Pinata"],
    new Map()
  );

  const unknownFlag = flags.find((f) => f.code === "UNKNOWN_ITEM");
  assert.ok(unknownFlag);
  assert.strictEqual(unknownFlag.severity, "error");
});

test("Flag 8 - LOW_CONFIDENCE: raises error when confidence < 0.6 or amount is null", () => {
  const order: Order = {
    id: "ord-blur",
    customerName: "Sana Javed",
    address: "Islamabad",
    items: [{ name: "Red Velvet Cake", qty: 1 }],
    status: "active",
    sourceMessageIds: [1],
  };

  const blurryPayment: Payment = {
    id: "pay-blurry",
    fileName: "blurry.jpg",
    amount: null,
    currency: null,
    txnId: null,
    confidence: 0.35,
  };

  const flags = detectOrderFlags(order, 1900, 0, [blurryPayment], [], new Map());
  const lowConf = flags.find((f) => f.code === "LOW_CONFIDENCE");
  assert.ok(lowConf);
  assert.strictEqual(lowConf.severity, "error");
});

// Full end-to-end reconciliation test comparing against samples/expected.json
test("reconcile: full test matches expected.json and raises all planted flags", () => {
  const expectedRaw = fs.readFileSync("samples/expected.json", "utf8");
  const expected = JSON.parse(expectedRaw);

  const catalogCsv = fs.readFileSync("samples/catalog.csv", "utf8");

  // Reconstructed messages from samples/chat.txt attachments
  const messages: Message[] = [
    { id: 1, ts: "21/10/2026", sender: "Ahmed Khan", text: "1 Choc cake", attachments: [] },
    { id: 3, ts: "21/10/2026", sender: "Ahmed Khan", text: "slip", attachments: ["PAY-20261021-WA0001.jpg"] },
    { id: 4, ts: "21/10/2026", sender: "Bilal Sheikh", text: "2 brownies", attachments: [] },
    { id: 8, ts: "21/10/2026", sender: "Bilal Sheikh", text: "3600", attachments: ["PAY-20261021-WA0002.jpg"] },
    { id: 9, ts: "22/10/2026", sender: "Zainab Bibi", text: "red velvet", attachments: [] },
    { id: 11, ts: "22/10/2026", sender: "Zainab Bibi", text: "cancel please", attachments: [] },
    { id: 13, ts: "22/10/2026", sender: "Daniyal Mir", text: "cheesecake + tea cake", attachments: [] },
    { id: 15, ts: "22/10/2026", sender: "Daniyal Mir", text: "2500", attachments: ["PAY-20261022-WA0003.jpg"] },
    { id: 16, ts: "23/10/2026", sender: "Fatima Tariq", text: "choc cake", attachments: [] },
    { id: 17, ts: "23/10/2026", sender: "Fatima Tariq", text: "1800", attachments: ["PAY-20261022-WA0004.jpg"] },
    { id: 18, ts: "23/10/2026", sender: "Hamza Ali", text: "choc cake", attachments: [] },
    { id: 19, ts: "23/10/2026", sender: "Hamza Ali", text: "1800", attachments: ["PAY-20261022-WA0004.jpg"] },
    { id: 20, ts: "23/10/2026", sender: "Sana Javed", text: "red velvet", attachments: [] },
    { id: 21, ts: "23/10/2026", sender: "Sana Javed", text: "slip", attachments: ["PAY-20261023-WA0005.jpg"] },
  ];

  const orders: Order[] = [
    {
      id: "order-1",
      customerName: "Ahmed Khan",
      phone: "03001234567",
      address: "House 12, Street 4, Sector F-8/2, Islamabad",
      items: [{ name: "Chocolate Fudge Cake", qty: 1 }],
      status: "active",
      sourceMessageIds: [1, 3],
    },
    {
      id: "order-2",
      customerName: "Bilal Sheikh",
      phone: "03219876543",
      address: "Flat 4B, Gulshan-e-Iqbal, Karachi",
      items: [{ name: "Nutella Brownies", qty: 3 }],
      status: "active",
      sourceMessageIds: [4, 8],
    },
    {
      id: "order-3",
      customerName: "Zainab Bibi",
      phone: "03331122334",
      address: "House 5, DHA Phase 2, Lahore",
      items: [{ name: "Red Velvet Cake", qty: 1 }],
      status: "cancelled",
      sourceMessageIds: [9, 11],
    },
    {
      id: "order-4",
      customerName: "Daniyal Mir",
      phone: "03335551234",
      address: "House 55, DHA Phase 5, Lahore",
      items: [
        { name: "Lotus Cheesecake", qty: 1 },
        { name: "Almond Tea Cake", qty: 1 },
      ],
      status: "active",
      sourceMessageIds: [13, 15],
    },
    {
      id: "order-5",
      customerName: "Fatima Tariq",
      phone: "03451122334",
      address: "House 9, Sector G-11/3, Islamabad",
      items: [{ name: "Chocolate Fudge Cake", qty: 1 }],
      status: "active",
      sourceMessageIds: [16, 17],
    },
    {
      id: "order-6",
      customerName: "Hamza Ali",
      phone: "03129988776",
      address: "House 88, Bahria Town Phase 4, Rawalpindi",
      items: [{ name: "Chocolate cake", qty: 1 }],
      status: "active",
      sourceMessageIds: [18, 19],
    },
    {
      id: "order-7",
      customerName: "Sana Javed",
      phone: "03134455667",
      address: undefined, // Planted missing address
      items: [{ name: "Red Velvet Cake", qty: 1 }],
      status: "active",
      sourceMessageIds: [20, 21],
    },
  ];

  const payments: Payment[] = [
    {
      id: "pay-1",
      fileName: "PAY-20261021-WA0001.jpg",
      amount: 1800,
      currency: "PKR",
      txnId: "TXN-8001",
      confidence: 1.0,
    },
    {
      id: "pay-2",
      fileName: "PAY-20261021-WA0002.jpg",
      amount: 3600,
      currency: "PKR",
      txnId: "TXN-8002",
      confidence: 1.0,
    },
    {
      id: "pay-3",
      fileName: "PAY-20261022-WA0003.jpg",
      amount: 2500,
      currency: "PKR",
      txnId: "TXN-8003",
      confidence: 1.0,
    },
    {
      id: "pay-4",
      fileName: "PAY-20261022-WA0004.jpg",
      amount: 1800,
      currency: "PKR",
      txnId: "TXN-DUPL-990011",
      confidence: 1.0,
    },
    {
      id: "pay-5",
      fileName: "PAY-20261023-WA0005.jpg",
      amount: null,
      currency: null,
      txnId: null,
      confidence: 0.0, // Blurry
    },
  ];

  const result = reconcile({ orders, messages, payments, catalogCsv });

  // 1. Verify totals match expected.json exactly
  assert.strictEqual(result.totals.totalOrdersCount, expected.totals.totalOrdersCount);
  assert.strictEqual(result.totals.activeOrdersCount, expected.totals.activeOrdersCount);
  assert.strictEqual(result.totals.cancelledOrdersCount, expected.totals.cancelledOrdersCount);
  assert.strictEqual(result.totals.totalOrderAmount, expected.totals.totalOrderAmount);
  assert.strictEqual(result.totals.totalPaidAmount, expected.totals.totalPaidAmount);
  assert.strictEqual(result.totals.shortAmount, expected.totals.shortAmount);

  // 2. Verify all planted flags appear
  // Order 4: SHORT_PAYMENT
  const o4 = result.orders.find((o) => o.id === "order-4");
  assert.ok(o4);
  assert.ok(o4.flags.some((f) => f.code === "SHORT_PAYMENT"));

  // Order 5 & 6: DUPLICATE_TXN
  const o5 = result.orders.find((o) => o.id === "order-5");
  const o6 = result.orders.find((o) => o.id === "order-6");
  assert.ok(o5);
  assert.ok(o6);
  assert.ok(o5.flags.some((f) => f.code === "DUPLICATE_TXN"));
  assert.ok(o6.flags.some((f) => f.code === "DUPLICATE_TXN"));

  // Order 7: MISSING_ADDRESS and LOW_CONFIDENCE
  const o7 = result.orders.find((o) => o.id === "order-7");
  assert.ok(o7);
  assert.ok(o7.flags.some((f) => f.code === "MISSING_ADDRESS"));
  assert.ok(o7.flags.some((f) => f.code === "LOW_CONFIDENCE"));

  // Order 3: Cancelled, excluded from totals and exports
  const o3 = result.orders.find((o) => o.id === "order-3");
  assert.ok(o3);
  assert.strictEqual(o3.status, "cancelled");
  assert.strictEqual(o3.total, 0);
  assert.strictEqual(o3.paid, 0);
});
