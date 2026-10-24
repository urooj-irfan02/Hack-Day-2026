import fs from "fs";
import path from "path";
import express, { Request, Response } from "express";
import multer from "multer";
import { isReplayMode } from "./cache.ts";
import { createExportZip } from "./export.ts";
import {
  draftReply,
  extractOrders,
  getModelName,
  MODEL,
  readPayments,
  runGemmaSmokeTest,
} from "./gemma.ts";
import { parseWhatsAppChat } from "./parser.ts";
import { ReconciledOrder, reconcile } from "./reconcile.ts";
import { Flag, Order, Payment } from "./schemas.ts";

export const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit per file
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

/**
 * GET /api/health
 * Returns service status, active model, and replay mode flag.
 */
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "hisaab",
    model: getModelName(),
    replay: isReplayMode(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/smoke
 * Sends a hard-coded Roman Urdu order message to Gemma and returns the parsed JSON.
 */
app.post("/api/smoke", async (_req: Request, res: Response) => {
  try {
    const result = await runGemmaSmokeTest();
    res.json(result);
  } catch (error: any) {
    console.error("[/api/smoke error]:", error);
    res.status(500).json({
      success: false,
      model: MODEL,
      error: error?.message || "Failed to execute smoke test",
    });
  }
});

/**
 * GET /api/sample-data
 * Returns the synthetic bakery chat, catalog text, and screenshots list for 1-click testing.
 */
app.get("/api/sample-data", (_req: Request, res: Response) => {
  try {
    const chatPath = path.resolve(process.cwd(), "samples", "chat.txt");
    const catalogPath = path.resolve(process.cwd(), "samples", "catalog.csv");
    const screenshotsDir = path.resolve(process.cwd(), "samples", "screenshots");

    const chat = fs.existsSync(chatPath) ? fs.readFileSync(chatPath, "utf8") : "";
    const catalog = fs.existsSync(catalogPath)
      ? fs.readFileSync(catalogPath, "utf8")
      : "";
    const screenshotFiles = fs.existsSync(screenshotsDir)
      ? fs.readdirSync(screenshotsDir)
      : [];

    res.json({
      chat,
      catalog,
      screenshots: screenshotFiles,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to load sample data" });
  }
});

/**
 * GET /api/screenshot/:fileName
 * Serves payment screenshot images to the UI side panel.
 */
app.get("/api/screenshot/:fileName", (req: Request, res: Response) => {
  const fileName = path.basename(req.params.fileName);
  const screenshotPath = path.resolve(process.cwd(), "samples", "screenshots", fileName);

  if (fs.existsSync(screenshotPath)) {
    const ext = path.extname(fileName).toLowerCase();
    const contentType = ext === ".png" ? "image/png" : "image/jpeg";
    res.setHeader("Content-Type", contentType);
    return res.sendFile(screenshotPath);
  }

  res.status(404).send("Screenshot file not found");
});

/**
 * POST /api/analyze
 * Multipart or JSON endpoint: parses WhatsApp chat, reads payment screenshots with Gemma vision,
 * deterministically computes pricing and flags, and returns reconciled state.
 */
app.post(
  "/api/analyze",
  upload.fields([
    { name: "chat", maxCount: 1 },
    { name: "catalog", maxCount: 1 },
    { name: "screenshots", maxCount: 20 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const body = req.body || {};

      let chatText = "";
      if (files?.chat?.[0]) {
        chatText = files.chat[0].buffer.toString("utf8");
      } else if (body.chat) {
        chatText = String(body.chat);
      } else if (body.useSample) {
        const p = path.resolve(process.cwd(), "samples", "chat.txt");
        chatText = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      }

      let catalogCsv = "";
      if (files?.catalog?.[0]) {
        catalogCsv = files.catalog[0].buffer.toString("utf8");
      } else if (body.catalog) {
        catalogCsv = String(body.catalog);
      } else if (body.useSample) {
        const p = path.resolve(process.cwd(), "samples", "catalog.csv");
        catalogCsv = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      }

      if (!chatText.trim()) {
        return res.status(400).json({ error: "No WhatsApp chat text provided" });
      }

      // Step 1: Parse WhatsApp chat text into typed Message[]
      const messages = parseWhatsAppChat(chatText);

      // Step 2: Extract orders using Gemma with chunking and zod validation
      const { orders } = await extractOrders(messages);

      // Step 3: Read payment screenshots using Gemma vision
      const screenshotInputs: Array<{
        buffer?: Buffer;
        filePath?: string;
        fileName: string;
      }> = [];

      if (files?.screenshots && files.screenshots.length > 0) {
        for (const file of files.screenshots) {
          screenshotInputs.push({
            buffer: file.buffer,
            fileName: file.originalname,
          });
        }
      } else if (body.useSample) {
        const screenshotsDir = path.resolve(process.cwd(), "samples", "screenshots");
        if (fs.existsSync(screenshotsDir)) {
          const sampleFiles = fs.readdirSync(screenshotsDir);
          for (const sFile of sampleFiles) {
            screenshotInputs.push({
              filePath: path.join(screenshotsDir, sFile),
              fileName: sFile,
            });
          }
        }
      }

      const payments: Payment[] =
        screenshotInputs.length > 0 ? await readPayments(screenshotInputs) : [];

      // Step 4: Deterministic reconciliation & flag detection (reconcile.ts)
      const reconciliation = reconcile({
        orders,
        messages,
        payments,
        catalogCsv,
      });

      res.json({
        success: true,
        orders: reconciliation.orders,
        payments: reconciliation.payments,
        unmatchedPayments: reconciliation.unmatchedPayments,
        flags: reconciliation.flags,
        totals: reconciliation.totals,
        rawMessages: messages,
      });
    } catch (err: any) {
      console.error("[/api/analyze error]:", err);
      res.status(500).json({
        success: false,
        error: err?.message || "Reconciliation pipeline failed",
      });
    }
  }
);

/**
 * POST /api/draft-reply
 * Generates a short, courteous reply draft in Roman Urdu for flagged orders.
 */
app.post("/api/draft-reply", async (req: Request, res: Response) => {
  try {
    const { order, flags, total, paid } = req.body;
    if (!order || !flags) {
      return res.status(400).json({ error: "Missing order or flags in request body" });
    }

    const text = await draftReply({
      order: order as Order,
      flags: flags as Flag[],
      total: typeof total === "number" ? total : undefined,
      paid: typeof paid === "number" ? paid : undefined,
    });

    res.json({ text });
  } catch (err: any) {
    console.error("[/api/draft-reply error]:", err);
    res.status(500).json({ error: err?.message || "Failed to generate reply draft" });
  }
});

/**
 * POST /api/export
 * Exports approved orders into a zip file with orders.csv and pick-list.csv.
 * Enforces Rule 4: Export is blocked until at least one row is approved.
 */
app.post("/api/export", async (req: Request, res: Response) => {
  try {
    const { orders, approvedOrderIds } = req.body;

    if (!Array.isArray(orders) || !Array.isArray(approvedOrderIds)) {
      return res.status(400).json({ error: "Invalid orders or approvedOrderIds payload" });
    }

    // Rule 4: Nothing is exported until the user approves rows in the UI
    const approvedOrders: ReconciledOrder[] = orders.filter((o: ReconciledOrder) =>
      approvedOrderIds.includes(o.id)
    );

    if (approvedOrders.length === 0) {
      return res.status(400).json({
        error: "Export blocked: You must approve at least one order row before exporting.",
      });
    }

    const zipBuffer = await createExportZip(approvedOrders);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="hisaab-verified-export.zip"'
    );
    res.send(zipBuffer);
  } catch (err: any) {
    console.error("[/api/export error]:", err);
    res.status(500).json({ error: err?.message || "Failed to generate export zip" });
  }
});

export default app;
