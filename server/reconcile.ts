import {
  Flag,
  FlagCode,
  Item,
  Message,
  Order,
  Payment,
} from "./schemas.ts";

export interface CatalogItem {
  name: string;
  aliases: string[];
  unitPrice: number;
}

export interface ReconciledOrder extends Order {
  total: number;
  paid: number;
  linkedPayments: Payment[];
  flags: Flag[];
}

export interface ReconciliationResult {
  orders: ReconciledOrder[];
  payments: Payment[];
  unmatchedPayments: Payment[];
  flags: Flag[];
  totals: {
    totalOrdersCount: number;
    activeOrdersCount: number;
    cancelledOrdersCount: number;
    totalOrderAmount: number;
    totalPaidAmount: number;
    shortAmount: number;
  };
}

/**
 * Normalizes text for case-insensitive, punctuation-resilient matching.
 */
export function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses catalog.csv into typed CatalogItem objects.
 * Format: item,aliases,unit_price (aliases are pipe-separated)
 */
export function parseCatalog(csvText: string): CatalogItem[] {
  if (!csvText || !csvText.trim()) return [];

  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  // Skip header line if present
  const startIndex = lines[0].toLowerCase().startsWith("item") ? 1 : 0;
  const items: CatalogItem[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    // Split by comma: item,aliases,unit_price
    const parts = line.split(",");
    if (parts.length < 3) continue;

    const name = parts[0].trim();
    const rawAliases = parts[1].trim();
    const rawPrice = parts[parts.length - 1].trim();

    const unitPrice = parseFloat(rawPrice);
    if (isNaN(unitPrice)) continue;

    const aliases = rawAliases
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean);

    items.push({
      name,
      aliases,
      unitPrice,
    });
  }

  return items;
}

/**
 * Looks up an item price in the catalog by exact or alias matching.
 */
export function lookupItemPrice(
  itemName: string,
  catalog: CatalogItem[]
): { item: CatalogItem; price: number } | null {
  const normSearch = normalizeString(itemName);
  if (!normSearch) return null;

  // 1. Direct match on main catalog item name
  for (const cat of catalog) {
    if (normalizeString(cat.name) === normSearch) {
      return { item: cat, price: cat.unitPrice };
    }
  }

  // 2. Match against item aliases
  for (const cat of catalog) {
    for (const alias of cat.aliases) {
      if (normalizeString(alias) === normSearch) {
        return { item: cat, price: cat.unitPrice };
      }
    }
  }

  // 3. Substring / word-containment matching (e.g. "chocolate cake" matches "Chocolate Fudge Cake")
  for (const cat of catalog) {
    const catNorm = normalizeString(cat.name);
    if (catNorm.includes(normSearch) || normSearch.includes(catNorm)) {
      return { item: cat, price: cat.unitPrice };
    }
    for (const alias of cat.aliases) {
      const aliasNorm = normalizeString(alias);
      if (aliasNorm.includes(normSearch) || normSearch.includes(aliasNorm)) {
        return { item: cat, price: cat.unitPrice };
      }
    }
  }

  return null;
}

/**
 * Computes deterministic order total from catalog items.
 */
export function computeOrderTotal(
  items: Item[],
  catalog: CatalogItem[]
): { total: number; unknownItems: string[] } {
  let total = 0;
  const unknownItems: string[] = [];

  for (const item of items) {
    const match = lookupItemPrice(item.name, catalog);
    if (match) {
      total += match.price * item.qty;
    } else {
      unknownItems.push(item.name);
    }
  }

  return { total, unknownItems };
}

/**
 * Links payment screenshots to orders using chat attachments and sender matching.
 */
export function linkPaymentsToOrders(
  orders: Order[],
  messages: Message[],
  payments: Payment[]
): {
  orderPaymentMap: Map<string, Payment[]>;
  unmatchedPayments: Payment[];
} {
  const orderPaymentMap = new Map<string, Payment[]>();
  const matchedPaymentIds = new Set<string>();

  // Initialize empty arrays for all orders
  for (const order of orders) {
    orderPaymentMap.set(order.id, []);
  }

  // Index messages by ID
  const msgMap = new Map<number, Message>();
  for (const msg of messages) {
    msgMap.set(msg.id, msg);
  }

  // Find all attachment filenames associated with each order
  const orderAttachmentFiles = new Map<string, Set<string>>();
  for (const order of orders) {
    const files = new Set<string>();
    for (const msgId of order.sourceMessageIds) {
      const msg = msgMap.get(msgId);
      if (msg && msg.attachments.length > 0) {
        for (const att of msg.attachments) {
          files.add(att.toLowerCase());
        }
      }
    }
    orderAttachmentFiles.set(order.id, files);
  }

  // Match each payment to orders
  for (const payment of payments) {
    const cleanFileName = payment.fileName.toLowerCase();
    let matchedOrder = false;

    for (const order of orders) {
      const files = orderAttachmentFiles.get(order.id);
      if (files && files.has(cleanFileName)) {
        orderPaymentMap.get(order.id)!.push(payment);
        matchedPaymentIds.add(payment.id);
        matchedOrder = true;
      }
    }

    // Fallback: If not matched via message attachments, match by senderName if available
    if (!matchedOrder && payment.senderName) {
      const normSender = normalizeString(payment.senderName);
      for (const order of orders) {
        if (normalizeString(order.customerName) === normSender) {
          orderPaymentMap.get(order.id)!.push(payment);
          matchedPaymentIds.add(payment.id);
          matchedOrder = true;
          break;
        }
      }
    }
  }

  const unmatchedPayments = payments.filter((p) => !matchedPaymentIds.has(p.id));

  return { orderPaymentMap, unmatchedPayments };
}

/**
 * Builds a map of duplicate transaction IDs across different orders.
 */
export function buildDuplicateTxnMap(
  orders: Order[],
  orderPaymentMap: Map<string, Payment[]>
): Map<string, Array<{ orderId: string; customerName: string }>> {
  const txnToOrders = new Map<string, Array<{ orderId: string; customerName: string }>>();

  for (const order of orders) {
    const payments = orderPaymentMap.get(order.id) ?? [];
    for (const payment of payments) {
      if (payment.txnId && payment.txnId.trim() !== "") {
        const cleanTxn = payment.txnId.replace(/\s+/g, "").toUpperCase();
        if (!txnToOrders.has(cleanTxn)) {
          txnToOrders.set(cleanTxn, []);
        }
        const list = txnToOrders.get(cleanTxn)!;
        if (!list.some((item) => item.orderId === order.id)) {
          list.push({ orderId: order.id, customerName: order.customerName });
        }
      }
    }
  }

  return txnToOrders;
}

/**
 * Detects all deterministic flags for an order according to Section 5 of HISAAB_SPEC.md.
 */
export function detectOrderFlags(
  order: Order,
  total: number,
  paid: number,
  linkedPayments: Payment[],
  unknownItems: string[],
  duplicateTxnMap: Map<string, Array<{ orderId: string; customerName: string }>>
): Flag[] {
  const flags: Flag[] = [];

  // Cancelled orders are excluded from total/export checks
  if (order.status === "cancelled") {
    return flags;
  }

  // 1. UNKNOWN_ITEM: item not found in catalog
  for (const item of unknownItems) {
    flags.push({
      code: "UNKNOWN_ITEM",
      severity: "error",
      message: `Item '${item}' was not found in the catalog.`,
      evidence: [`Item: ${item}`, `Order: ${order.id}`],
    });
  }

  // 2. MISSING_ADDRESS: active order without an address
  if (!order.address || order.address.trim() === "") {
    flags.push({
      code: "MISSING_ADDRESS",
      severity: "error",
      message: "Active order has no delivery address.",
      evidence: [`Customer: ${order.customerName}`],
    });
  }

  // 3. UNPAID: active order with no linked payment
  if (linkedPayments.length === 0) {
    flags.push({
      code: "UNPAID",
      severity: "error",
      message: "Active order has no linked payment receipt.",
      evidence: [`Order: ${order.id}`, `Customer: ${order.customerName}`],
    });
    return flags;
  }

  // 4. LOW_CONFIDENCE: any linked payment confidence below 0.6 or unreadable amount
  for (const payment of linkedPayments) {
    if (payment.confidence < 0.6 || payment.amount === null) {
      flags.push({
        code: "LOW_CONFIDENCE",
        severity: "error",
        message: `Payment screenshot ${payment.fileName} has low confidence (${payment.confidence.toFixed(2)}) or unreadable amount.`,
        evidence: [
          `File: ${payment.fileName}`,
          `Confidence: ${payment.confidence.toFixed(2)}`,
        ],
      });
    }
  }

  // 5. SHORT_PAYMENT: paid < total (message states both numbers)
  if (paid > 0 && paid < total) {
    const diff = total - paid;
    flags.push({
      code: "SHORT_PAYMENT",
      severity: "error",
      message: `Payment of Rs ${paid} is short of total Rs ${total} by Rs ${diff}.`,
      evidence: [`Total: ${total}`, `Paid: ${paid}`, `Short: ${diff}`],
    });
  }

  // 6. OVERPAYMENT: paid > total
  if (paid > total) {
    const diff = paid - total;
    flags.push({
      code: "OVERPAYMENT",
      severity: "warn",
      message: `Payment of Rs ${paid} exceeds order total Rs ${total} by Rs ${diff}.`,
      evidence: [`Total: ${total}`, `Paid: ${paid}`, `Over: ${diff}`],
    });
  }

  // 7. DUPLICATE_TXN: the same txnId appears on payments linked to different orders
  for (const payment of linkedPayments) {
    if (payment.txnId) {
      const cleanTxn = payment.txnId.replace(/\s+/g, "").toUpperCase();
      const duplicateEntries = duplicateTxnMap.get(cleanTxn);
      if (duplicateEntries && duplicateEntries.length > 1) {
        const otherOrders = duplicateEntries
          .filter((e) => e.orderId !== order.id)
          .map((e) => `${e.orderId} (${e.customerName})`)
          .join(", ");

        flags.push({
          code: "DUPLICATE_TXN",
          severity: "error",
          message: `Duplicate transaction ID ${payment.txnId} also used by ${otherOrders}.`,
          evidence: [
            `TxnId: ${payment.txnId}`,
            `Used by: ${duplicateEntries.map((e) => `${e.orderId} (${e.customerName})`).join(", ")}`,
          ],
        });
      }
    }
  }

  return flags;
}

/**
 * Main Pure Reconciler Function:
 * Deterministically computes pricing, matching, flagging, and summary totals.
 */
export function reconcile(options: {
  orders: Order[];
  messages: Message[];
  payments: Payment[];
  catalogCsv: string;
}): ReconciliationResult {
  const { orders, messages, payments, catalogCsv } = options;

  const catalog = parseCatalog(catalogCsv);
  const { orderPaymentMap, unmatchedPayments } = linkPaymentsToOrders(
    orders,
    messages,
    payments
  );
  const duplicateTxnMap = buildDuplicateTxnMap(orders, orderPaymentMap);

  const reconciledOrders: ReconciledOrder[] = [];
  const allFlags: Flag[] = [];

  let totalOrderAmount = 0;
  let totalPaidAmount = 0;
  let shortAmount = 0;
  let activeOrdersCount = 0;
  let cancelledOrdersCount = 0;

  for (const order of orders) {
    const isCancelled = order.status === "cancelled";
    if (isCancelled) {
      cancelledOrdersCount++;
    } else {
      activeOrdersCount++;
    }

    const linkedPayments = orderPaymentMap.get(order.id) ?? [];

    // Compute pricing and total
    const { total, unknownItems } = computeOrderTotal(order.items, catalog);

    // Sum paid amounts (only non-null amounts)
    const paid = linkedPayments.reduce((acc, p) => acc + (p.amount ?? 0), 0);

    // Detect flags
    const flags = detectOrderFlags(
      order,
      total,
      paid,
      linkedPayments,
      unknownItems,
      duplicateTxnMap
    );

    allFlags.push(...flags);

    // Cancelled orders are excluded from totals and exports (Spec 5)
    if (!isCancelled) {
      totalOrderAmount += total;
      totalPaidAmount += paid;
      if (paid < total && paid > 0) {
        shortAmount += total - paid;
      }
    }

    reconciledOrders.push({
      ...order,
      total: isCancelled ? 0 : total,
      paid: isCancelled ? 0 : paid,
      linkedPayments,
      flags,
    });
  }

  // 8. UNMATCHED_PAYMENT: flag any payment that cannot be linked to any order
  for (const up of unmatchedPayments) {
    const flag: Flag = {
      code: "UNMATCHED_PAYMENT",
      severity: "warn",
      message: `Payment screenshot ${up.fileName} cannot be matched to any customer order.`,
      evidence: [
        `File: ${up.fileName}`,
        `Amount: ${up.amount ?? "unknown"}`,
        `TxnId: ${up.txnId ?? "none"}`,
      ],
    };
    allFlags.push(flag);
  }

  return {
    orders: reconciledOrders,
    payments,
    unmatchedPayments,
    flags: allFlags,
    totals: {
      totalOrdersCount: orders.length,
      activeOrdersCount,
      cancelledOrdersCount,
      totalOrderAmount,
      totalPaidAmount,
      shortAmount,
    },
  };
}
