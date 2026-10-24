import { z } from "zod";

export const ItemSchema = z.object({
  name: z.string().describe("Item name or description"),
  qty: z.number().positive().describe("Quantity ordered"),
  unit: z.string().nullable().optional().describe("Optional unit e.g. kg, pound, pcs, box"),
});
export type Item = z.infer<typeof ItemSchema>;

export const OrderStatusSchema = z.enum(["active", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  customerName: z.string(),
  phone: z.string().optional(),
  address: z.string().optional(),
  items: z.array(ItemSchema),
  status: OrderStatusSchema,
  sourceMessageIds: z.array(z.number()),
  notes: z.string().optional(),
});
export type Order = z.infer<typeof OrderSchema>;

export const PaymentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  txnId: z.string().nullable(),
  senderName: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const FlagCodeSchema = z.enum([
  "SHORT_PAYMENT",
  "OVERPAYMENT",
  "DUPLICATE_TXN",
  "MISSING_ADDRESS",
  "UNMATCHED_PAYMENT",
  "UNPAID",
  "UNKNOWN_ITEM",
  "LOW_CONFIDENCE",
]);
export type FlagCode = z.infer<typeof FlagCodeSchema>;

export const FlagSeveritySchema = z.enum(["error", "warn"]);
export type FlagSeverity = z.infer<typeof FlagSeveritySchema>;

export const FlagSchema = z.object({
  code: FlagCodeSchema,
  severity: FlagSeveritySchema,
  message: z.string(),
  evidence: z.array(z.string()),
});
export type Flag = z.infer<typeof FlagSchema>;

export const SmokeOrderExtractionSchema = z.object({
  customerName: z.string().default("Customer"),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  items: z.array(
    z.object({
      name: z.string(),
      qty: z.number(),
      unit: z.string().nullable().optional(),
    })
  ),
  notes: z.string().nullable().optional(),
});
export type SmokeOrderExtraction = z.infer<typeof SmokeOrderExtractionSchema>;

export const MessageSchema = z.object({
  id: z.number(),
  ts: z.string(),
  sender: z.string(),
  text: z.string(),
  attachments: z.array(z.string()),
});
export type Message = z.infer<typeof MessageSchema>;

export const ExtractedOrderSchema = z.object({
  customerName: z.string(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  items: z.array(ItemSchema),
  status: OrderStatusSchema.default("active"),
  sourceMessageIds: z.array(z.number()),
  notes: z.string().nullable().optional(),
});
export type ExtractedOrder = z.infer<typeof ExtractedOrderSchema>;

export const ExtractedOrdersChunkSchema = z.object({
  orders: z.array(ExtractedOrderSchema),
});
export type ExtractedOrdersChunk = z.infer<typeof ExtractedOrdersChunkSchema>;

export const PaymentExtractionSchema = z.object({
  amount: z.number().nullable(),
  currency: z.string().nullable().optional(),
  txnId: z.string().nullable().optional(),
  senderName: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});
export type PaymentExtraction = z.infer<typeof PaymentExtractionSchema>;



