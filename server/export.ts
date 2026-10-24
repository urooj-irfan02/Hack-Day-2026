import JSZip from "jszip";
import { ReconciledOrder } from "./reconcile.ts";

function escapeCsvField(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates orders.csv from approved orders.
 * Columns: name,phone,address,items,total,paid,status
 */
export function generateOrdersCsv(orders: ReconciledOrder[]): string {
  const headers = ["name", "phone", "address", "items", "total", "paid", "status"];
  const rows: string[] = [headers.join(",")];

  for (const order of orders) {
    const itemsStr = order.items
      .map((it) => `${it.qty}x ${it.name}${it.unit ? ` (${it.unit})` : ""}`)
      .join("; ");

    const row = [
      escapeCsvField(order.customerName),
      escapeCsvField(order.phone ?? ""),
      escapeCsvField(order.address ?? ""),
      escapeCsvField(itemsStr),
      escapeCsvField(order.total),
      escapeCsvField(order.paid),
      escapeCsvField(order.status),
    ];
    rows.push(row.join(","));
  }

  return rows.join("\n");
}

/**
 * Generates pick-list.csv from approved orders.
 * Aggregates active order items and sums quantities.
 * Columns: item,total_qty
 */
export function generatePickListCsv(orders: ReconciledOrder[]): string {
  const headers = ["item", "total_qty"];
  const rows: string[] = [headers.join(",")];

  const itemQtyMap = new Map<string, number>();

  for (const order of orders) {
    // Only active orders contribute to pick-list
    if (order.status !== "cancelled") {
      for (const it of order.items) {
        const current = itemQtyMap.get(it.name) ?? 0;
        itemQtyMap.set(it.name, current + it.qty);
      }
    }
  }

  for (const [itemName, totalQty] of itemQtyMap.entries()) {
    rows.push(`${escapeCsvField(itemName)},${escapeCsvField(totalQty)}`);
  }

  return rows.join("\n");
}

/**
 * Creates a zip archive buffer containing orders.csv and pick-list.csv.
 */
export async function createExportZip(orders: ReconciledOrder[]): Promise<Buffer> {
  const zip = new JSZip();

  const ordersCsv = generateOrdersCsv(orders);
  const pickListCsv = generatePickListCsv(orders);

  zip.file("orders.csv", ordersCsv);
  zip.file("pick-list.csv", pickListCsv);

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  return buffer;
}
