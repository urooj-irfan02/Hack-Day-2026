import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { readPayment, readPayments } from "../server/gemma.ts";

test("readPayment: extracts clear receipt accurately", async () => {
  const filePath = path.resolve("samples/screenshots/PAY-20261021-WA0001.jpg");
  const payment = await readPayment({
    filePath,
    fileName: "PAY-20261021-WA0001.jpg",
  });

  assert.strictEqual(payment.fileName, "PAY-20261021-WA0001.jpg");
  assert.strictEqual(payment.amount, 1800);
  assert.ok(payment.txnId?.includes("TXN-8001"));
  assert.ok(payment.confidence >= 0.8);
});

test("readPayment: uses null for unreadable fields on blurry screenshot (Case 6)", async () => {
  const filePath = path.resolve("samples/screenshots/PAY-20261023-WA0005.jpg");
  const payment = await readPayment({
    filePath,
    fileName: "PAY-20261023-WA0005.jpg",
  });

  assert.strictEqual(payment.fileName, "PAY-20261023-WA0005.jpg");
  assert.strictEqual(payment.amount, null);
  assert.strictEqual(payment.txnId, null);
  assert.ok(payment.confidence < 0.6);
});

test("readPayments: batch processes all 5 receipts correctly", async () => {
  const files = [
    "PAY-20261021-WA0001.jpg",
    "PAY-20261021-WA0002.jpg",
    "PAY-20261022-WA0003.jpg",
    "PAY-20261022-WA0004.jpg",
    "PAY-20261023-WA0005.jpg",
  ];

  const shots = files.map((f) => ({
    filePath: path.resolve("samples/screenshots", f),
    fileName: f,
  }));

  const payments = await readPayments(shots);
  assert.strictEqual(payments.length, 5);

  const p1 = payments.find((p) => p.fileName === "PAY-20261021-WA0001.jpg");
  const p2 = payments.find((p) => p.fileName === "PAY-20261021-WA0002.jpg");
  const p3 = payments.find((p) => p.fileName === "PAY-20261022-WA0003.jpg");
  const p4 = payments.find((p) => p.fileName === "PAY-20261022-WA0004.jpg");
  const p5 = payments.find((p) => p.fileName === "PAY-20261023-WA0005.jpg");

  assert.strictEqual(p1?.amount, 1800);
  assert.strictEqual(p2?.amount, 3600);
  assert.strictEqual(p3?.amount, 2500);
  assert.strictEqual(p4?.amount, 1800);
  assert.strictEqual(p5?.amount, null);
  assert.ok(p5 && p5.confidence < 0.6);
});
