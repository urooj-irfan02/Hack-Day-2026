import fs from "fs";
import path from "path";
import sharp from "sharp";

interface ReceiptTemplateOptions {
  fileName: string;
  amount: string;
  txnId: string;
  senderName: string;
  senderAccount: string;
  dateTime: string;
  status: string;
  isBlurry?: boolean;
}

const RECEIPTS: ReceiptTemplateOptions[] = [
  {
    fileName: "PAY-20261021-WA0001.jpg",
    amount: "Rs. 1,800.00",
    txnId: "TXN-8001",
    senderName: "Ahmed Khan",
    senderAccount: "PK92 BANK 0019 4481 0021",
    dateTime: "21 Oct 2026, 10:24 AM",
    status: "SUCCESSFUL",
  },
  {
    fileName: "PAY-20261021-WA0002.jpg",
    amount: "Rs. 3,600.00",
    txnId: "TXN-8002",
    senderName: "Bilal Sheikh",
    senderAccount: "PK34 ALFD 0081 2291 8832",
    dateTime: "21 Oct 2026, 02:34 PM",
    status: "SUCCESSFUL",
  },
  {
    fileName: "PAY-20261022-WA0003.jpg",
    amount: "Rs. 2,500.00",
    txnId: "TXN-8003",
    senderName: "Daniyal Mir",
    senderAccount: "PK71 HABB 0023 9912 3341",
    dateTime: "22 Oct 2026, 03:28 PM",
    status: "SUCCESSFUL",
  },
  {
    fileName: "PAY-20261022-WA0004.jpg",
    amount: "Rs. 1,800.00",
    txnId: "TXN-DUPL-990011",
    senderName: "Fatima Tariq",
    senderAccount: "PK55 MCIB 0098 7765 1123",
    dateTime: "22 Oct 2026, 10:14 AM",
    status: "SUCCESSFUL",
  },
  {
    fileName: "PAY-20261023-WA0005.jpg",
    amount: "Rs. 1,900.00",
    txnId: "TXN-BLUR-991823",
    senderName: "Sana Javed",
    senderAccount: "PK11 UNIL 0092 1102 4432",
    dateTime: "23 Oct 2026, 04:31 PM",
    status: "SUCCESSFUL",
    isBlurry: true,
  },
];

function generateSvgReceipt(opts: ReceiptTemplateOptions): string {
  const displayAmount = opts.isBlurry ? "Rs. [UNREADABLE]" : opts.amount;
  const displayTxn = opts.isBlurry ? "TXN-?????????" : opts.txnId;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#090d16" />
      <stop offset="50%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#020617" />
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1e293b" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="800" height="1200" fill="url(#bg)" />

  <!-- Main Receipt Card -->
  <rect x="70" y="80" width="660" height="1040" rx="28" fill="url(#cardGrad)" stroke="#334155" stroke-width="2" filter="url(#cardShadow)"/>

  <!-- Top Accent Bar -->
  <path d="M 70 108 A 28 28 0 0 1 98 80 L 702 80 A 28 28 0 0 1 730 108 L 730 92 L 70 92 Z" fill="#10b981" />

  <!-- Success Icon -->
  <circle cx="400" cy="180" r="42" fill="#065f46" stroke="#10b981" stroke-width="3" />
  <path d="M 382 180 L 395 193 L 420 166" fill="none" stroke="#34d399" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Header Title -->
  <text x="400" y="255" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="bold" letter-spacing="3" fill="#94a3b8">
    ELECTRONIC PAYMENT RECEIPT
  </text>
  <text x="400" y="285" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#64748b">
    Transaction Verified &amp; Cleared
  </text>

  <!-- Amount -->
  <rect x="130" y="320" width="540" height="110" rx="16" fill="#020617" stroke="#1e293b" stroke-width="2" />
  <text x="400" y="360" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="#38bdf8">
    TOTAL AMOUNT TRANSFERRED
  </text>
  <text x="400" y="405" text-anchor="middle" font-family="Arial, sans-serif" font-size="38" font-weight="900" fill="#f8fafc">
    ${displayAmount}
  </text>

  <!-- Divider -->
  <line x1="120" y1="465" x2="680" y2="465" stroke="#334155" stroke-dasharray="6,6" stroke-width="2"/>

  <!-- Key Value Details Table -->
  <!-- Row 1: Status -->
  <text x="140" y="515" font-family="Arial, sans-serif" font-size="15" fill="#64748b">Status</text>
  <rect x="520" y="495" width="130" height="30" rx="15" fill="#064e3b" stroke="#059669" stroke-width="1.5"/>
  <text x="585" y="515" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="bold" fill="#34d399">${opts.status}</text>

  <!-- Row 2: Transaction ID -->
  <text x="140" y="575" font-family="Arial, sans-serif" font-size="15" fill="#64748b">Transaction ID</text>
  <text x="660" y="575" text-anchor="end" font-family="Courier, monospace" font-size="16" font-weight="bold" fill="#f1f5f9">${displayTxn}</text>

  <!-- Row 3: Date & Time -->
  <text x="140" y="635" font-family="Arial, sans-serif" font-size="15" fill="#64748b">Timestamp</text>
  <text x="660" y="635" text-anchor="end" font-family="Arial, sans-serif" font-size="15" fill="#cbd5e1">${opts.dateTime}</text>

  <!-- Row 4: Sender -->
  <text x="140" y="695" font-family="Arial, sans-serif" font-size="15" fill="#64748b">Sender Name</text>
  <text x="660" y="695" text-anchor="end" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#f1f5f9">${opts.senderName}</text>

  <!-- Row 5: Sender Account -->
  <text x="140" y="755" font-family="Arial, sans-serif" font-size="15" fill="#64748b">Sender Account</text>
  <text x="660" y="755" text-anchor="end" font-family="Courier, monospace" font-size="14" fill="#94a3b8">${opts.senderAccount}</text>

  <!-- Row 6: Recipient -->
  <text x="140" y="815" font-family="Arial, sans-serif" font-size="15" fill="#64748b">Recipient</text>
  <text x="660" y="815" text-anchor="end" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#10b981">The Sweet Treats Bakery</text>

  <!-- Row 7: Purpose -->
  <text x="140" y="875" font-family="Arial, sans-serif" font-size="15" fill="#64748b">Payment Mode</text>
  <text x="660" y="875" text-anchor="end" font-family="Arial, sans-serif" font-size="15" fill="#cbd5e1">Inter-Bank Transfer (IBFT)</text>

  <!-- Divider -->
  <line x1="120" y1="925" x2="680" y2="925" stroke="#334155" stroke-dasharray="6,6" stroke-width="2"/>

  <!-- Footer security notice -->
  <rect x="120" y="960" width="560" height="90" rx="12" fill="#0b1120" stroke="#1e293b" />
  <text x="400" y="995" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="600" fill="#94a3b8">
    Synthetic Test Voucher - Do Not Imitate Any Real Banking Entity
  </text>
  <text x="400" y="1025" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#475569">
    Hisaab Verification Suite • Reference Token: ${opts.fileName}
  </text>
</svg>`;
}

async function main() {
  const outDir = path.resolve(process.cwd(), "samples", "screenshots");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log(`[make-screenshots] Generating ${RECEIPTS.length} synthetic payment receipts in ${outDir}...`);

  for (const receipt of RECEIPTS) {
    const svg = generateSvgReceipt(receipt);
    const targetPath = path.join(outDir, receipt.fileName);

    let pipeline = sharp(Buffer.from(svg));

    if (receipt.isBlurry) {
      // Planted Case 6: Blurry / partially unreadable screenshot (tests LOW_CONFIDENCE)
      console.log(`[make-screenshots] Applying heavy Gaussian blur & noise to ${receipt.fileName}...`);
      pipeline = pipeline.blur(16);
    }

    await pipeline.jpeg({ quality: receipt.isBlurry ? 30 : 92 }).toFile(targetPath);
    console.log(`[make-screenshots] Created: ${receipt.fileName}`);
  }

  console.log("[make-screenshots] Done! All 5 screenshots generated successfully.");
}

main().catch((err) => {
  console.error("[make-screenshots] Error:", err);
  process.exit(1);
});
