/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Clock,
  Copy,
  Cpu,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  FileText,
  Flame,
  HelpCircle,
  Image as ImageIcon,
  Layers,
  MapPin,
  MessageSquare,
  Package,
  Phone,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";

// Types matching server/schemas.ts & server/reconcile.ts
interface Item {
  name: string;
  qty: number;
  unit?: string | null;
}

interface Flag {
  code:
    | "SHORT_PAYMENT"
    | "OVERPAYMENT"
    | "DUPLICATE_TXN"
    | "MISSING_ADDRESS"
    | "UNMATCHED_PAYMENT"
    | "UNPAID"
    | "UNKNOWN_ITEM"
    | "LOW_CONFIDENCE";
  severity: "error" | "warn";
  message: string;
  evidence: string[];
}

interface Payment {
  id: string;
  fileName: string;
  amount: number | null;
  currency: string | null;
  txnId: string | null;
  senderName?: string | null;
  timestamp?: string | null;
  status?: string | null;
  confidence: number;
}

interface ReconciledOrder {
  id: string;
  customerName: string;
  phone?: string;
  address?: string;
  items: Item[];
  status: "active" | "cancelled";
  sourceMessageIds: number[];
  notes?: string;
  total: number;
  paid: number;
  linkedPayments: Payment[];
  flags: Flag[];
}

interface RawMessage {
  id: number;
  ts: string;
  sender: string;
  text: string;
  attachments: string[];
}

interface ReconciliationTotals {
  totalOrdersCount: number;
  activeOrdersCount: number;
  cancelledOrdersCount: number;
  totalOrderAmount: number;
  totalPaidAmount: number;
  shortAmount: number;
}

type Step = "upload" | "review" | "export";

export default function App() {
  // Navigation & Pipeline State
  const [currentStep, setCurrentStep] = useState<Step>("upload");
  const [modelName, setModelName] = useState<string>("gemma-4-26b-a4b-it");
  const [isReplay, setIsReplay] = useState<boolean>(false);

  // Upload Step State
  const [chatFile, setChatFile] = useState<File | null>(null);
  const [chatText, setChatText] = useState<string>("");
  const [catalogFile, setCatalogFile] = useState<File | null>(null);
  const [catalogText, setCatalogText] = useState<string>("");
  const [screenshotFiles, setScreenshotFiles] = useState<File[]>([]);
  const [isSampleLoaded, setIsSampleLoaded] = useState<boolean>(false);
  const [sampleScreenshots, setSampleScreenshots] = useState<string[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // Review Step State
  const [orders, setOrders] = useState<ReconciledOrder[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [unmatchedPayments, setUnmatchedPayments] = useState<Payment[]>([]);
  const [allFlags, setAllFlags] = useState<Flag[]>([]);
  const [rawMessages, setRawMessages] = useState<RawMessage[]>([]);
  const [approvedOrderIds, setApprovedOrderIds] = useState<string[]>([]);

  // Side Panel / Modal State
  const [selectedOrder, setSelectedOrder] = useState<ReconciledOrder | null>(null);
  const [draftReplyModalOrder, setDraftReplyModalOrder] = useState<ReconciledOrder | null>(null);
  const [draftReplyText, setDraftReplyText] = useState<string>("");
  const [isDraftingReply, setIsDraftingReply] = useState<boolean>(false);
  const [copiedDraft, setCopiedDraft] = useState<boolean>(false);

  // Export Step State
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportPreviewTab, setExportPreviewTab] = useState<"orders" | "pick-list">("orders");

  // Fetch health info on load
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        if (data.model) setModelName(data.model);
        if (typeof data.replay === "boolean") setIsReplay(data.replay);
      })
      .catch((err) => console.error("Health check error:", err));
  }, []);

  // 1-Click Load Synthetic Sample Bakery Dataset
  const handleLoadSample = async () => {
    try {
      setIsAnalyzing(true);
      setAnalyzeError(null);
      const res = await fetch("/api/sample-data");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load sample data");

      setChatText(data.chat);
      setCatalogText(data.catalog);
      setSampleScreenshots(data.screenshots || []);
      setIsSampleLoaded(true);
      setChatFile(null);
      setCatalogFile(null);
      setScreenshotFiles([]);
    } catch (err: any) {
      setAnalyzeError(err.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Run full analysis pipeline
  const handleRunAnalysis = async () => {
    try {
      setIsAnalyzing(true);
      setAnalyzeError(null);

      let response: Response;
      if (isSampleLoaded && (!chatFile || !catalogFile)) {
        // Fast path: use synthetic samples on server
        response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            useSample: true,
            chat: chatText,
            catalog: catalogText,
          }),
        });
      } else {
        // Multipart upload form
        const formData = new FormData();
        if (chatFile) formData.append("chat", chatFile);
        else formData.append("chat", chatText);

        if (catalogFile) formData.append("catalog", catalogFile);
        else formData.append("catalog", catalogText);

        screenshotFiles.forEach((file) => {
          formData.append("screenshots", file);
        });

        response = await fetch("/api/analyze", {
          method: "POST",
          body: formData,
        });
      }

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Reconciliation analysis failed");
      }

      setOrders(data.orders || []);
      setPayments(data.payments || []);
      setUnmatchedPayments(data.unmatchedPayments || []);
      setAllFlags(data.flags || []);
      setRawMessages(data.rawMessages || []);

      // Auto-preselect active rows with no error flags for convenience
      const defaultApproved = (data.orders || [])
        .filter((o: ReconciledOrder) => o.status === "active" && o.flags.length === 0)
        .map((o: ReconciledOrder) => o.id);
      setApprovedOrderIds(defaultApproved);

      setCurrentStep("review");
    } catch (err: any) {
      setAnalyzeError(err.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Recompute summary totals dynamically based on current orders state
  const computedTotals: ReconciliationTotals = useMemo(() => {
    let totalOrderAmount = 0;
    let totalPaidAmount = 0;
    let shortAmount = 0;
    let activeOrdersCount = 0;
    let cancelledOrdersCount = 0;

    for (const order of orders) {
      if (order.status === "cancelled") {
        cancelledOrdersCount++;
      } else {
        activeOrdersCount++;
        totalOrderAmount += order.total;
        totalPaidAmount += order.paid;
        if (order.paid < order.total && order.paid > 0) {
          shortAmount += order.total - order.paid;
        }
      }
    }

    return {
      totalOrdersCount: orders.length,
      activeOrdersCount,
      cancelledOrdersCount,
      totalOrderAmount,
      totalPaidAmount,
      shortAmount,
    };
  }, [orders]);

  // Toggle order approval
  const handleToggleApprove = (orderId: string) => {
    setApprovedOrderIds((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId]
    );
  };

  const handleSelectAllApprovals = () => {
    const activeOrderIds = orders
      .filter((o) => o.status !== "cancelled")
      .map((o) => o.id);
    if (approvedOrderIds.length === activeOrderIds.length) {
      setApprovedOrderIds([]);
    } else {
      setApprovedOrderIds(activeOrderIds);
    }
  };

  // Edit order in side panel
  const handleSaveOrderEdits = (updated: ReconciledOrder) => {
    setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
    setSelectedOrder(updated);
  };

  // Trigger Gemma Draft Reply for flagged order
  const handleDraftReply = async (order: ReconciledOrder) => {
    setDraftReplyModalOrder(order);
    setDraftReplyText("");
    setIsDraftingReply(true);
    setCopiedDraft(false);

    try {
      const res = await fetch("/api/draft-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          order,
          flags: order.flags,
          total: order.total,
          paid: order.paid,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to draft reply");
      setDraftReplyText(data.text);
    } catch (err: any) {
      setDraftReplyText(`Draft error: ${err.message}`);
    } finally {
      setIsDraftingReply(false);
    }
  };

  const handleCopyDraft = () => {
    if (draftReplyText) {
      navigator.clipboard.writeText(draftReplyText);
      setCopiedDraft(true);
      setTimeout(() => setCopiedDraft(false), 2000);
    }
  };

  // Download verified sheets zip archive
  const handleDownloadZip = async () => {
    if (approvedOrderIds.length === 0) return;
    try {
      setIsExporting(true);
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orders,
          approvedOrderIds,
        }),
      });
      if (!res.ok) {
        const errorJson = await res.json();
        throw new Error(errorJson.error || "Export failed");
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hisaab-verified-export-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Export error: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Generated CSV previews for Export Step
  const previewOrdersCsv = useMemo(() => {
    const approved = orders.filter((o) => approvedOrderIds.includes(o.id));
    const headers = "name,phone,address,items,total,paid,status";
    const lines = approved.map((o) => {
      const itemsStr = o.items.map((i) => `${i.qty}x ${i.name}`).join("; ");
      return `"${o.customerName}","${o.phone || ""}","${o.address || ""}","${itemsStr}",${o.total},${o.paid},"${o.status}"`;
    });
    return [headers, ...lines].join("\n");
  }, [orders, approvedOrderIds]);

  const previewPickListCsv = useMemo(() => {
    const approved = orders.filter(
      (o) => approvedOrderIds.includes(o.id) && o.status !== "cancelled"
    );
    const itemMap = new Map<string, number>();
    for (const o of approved) {
      for (const it of o.items) {
        itemMap.set(it.name, (itemMap.get(it.name) || 0) + it.qty);
      }
    }
    const headers = "item,total_qty";
    const lines = Array.from(itemMap.entries()).map(
      ([name, qty]) => `"${name}",${qty}`
    );
    return [headers, ...lines].join("\n");
  }, [orders, approvedOrderIds]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-300">
      {/* Sticky Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          {/* Logo & Tagline */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center font-bold text-slate-950 shadow-lg shadow-emerald-500/20 text-xl font-serif">
              ح
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold tracking-tight text-xl text-white">
                  Hisaab
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono border border-emerald-500/20 font-medium">
                  v1.0 Reconcile
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Your WhatsApp chaos, reconciled.
              </p>
            </div>
          </div>

          {/* Model info & Replay badge */}
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/60 text-xs font-mono text-slate-300 shadow-inner">
              <Cpu className="w-3.5 h-3.5 text-emerald-400" />
              <span>Gemma 4: {modelName}</span>
            </div>
            {isReplay && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30 text-xs font-mono font-semibold">
                <RotateCcw className="w-3 h-3 animate-spin" />
                REPLAY ACTIVE
              </span>
            )}
          </div>
        </div>

        {/* Step Navigation Bar */}
        <div className="border-t border-slate-800/60 bg-slate-950/60">
          <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-12">
            <div className="flex items-center gap-1 sm:gap-2">
              <button
                onClick={() => setCurrentStep("upload")}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  currentStep === "upload"
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold">
                  1
                </span>
                Upload
              </button>

              <ChevronRight className="w-3.5 h-3.5 text-slate-600" />

              <button
                onClick={() => orders.length > 0 && setCurrentStep("review")}
                disabled={orders.length === 0}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  currentStep === "review"
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                    : orders.length > 0
                    ? "text-slate-400 hover:text-slate-200 cursor-pointer"
                    : "text-slate-600 cursor-not-allowed"
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold">
                  2
                </span>
                Review & Reconcile
                {orders.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded bg-slate-800 text-[10px] text-slate-300 font-mono">
                    {orders.length}
                  </span>
                )}
              </button>

              <ChevronRight className="w-3.5 h-3.5 text-slate-600" />

              <button
                onClick={() => orders.length > 0 && setCurrentStep("export")}
                disabled={orders.length === 0}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  currentStep === "export"
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                    : orders.length > 0
                    ? "text-slate-400 hover:text-slate-200 cursor-pointer"
                    : "text-slate-600 cursor-not-allowed"
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold">
                  3
                </span>
                Approve & Export
                {approvedOrderIds.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-400 text-[10px] font-mono border border-emerald-800/60 font-semibold">
                    {approvedOrderIds.length} approved
                  </span>
                )}
              </button>
            </div>

            {currentStep === "review" && (
              <button
                onClick={() => setCurrentStep("export")}
                disabled={approvedOrderIds.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-semibold text-xs tracking-wide transition-all shadow-sm shadow-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Proceed to Export ({approvedOrderIds.length})
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8">
        {/* ================= STEP 1: UPLOAD ================= */}
        {currentStep === "upload" && (
          <div className="max-w-4xl mx-auto space-y-8">
            {/* Header intro */}
            <div className="text-center space-y-3">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium">
                <Sparkles className="w-3.5 h-3.5" />
                Deterministic Arithmetic • Gemma 4 Vision OCR • Seller Verification
              </div>
              <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
                Upload WhatsApp Chat &amp; Payment Receipts
              </h1>
              <p className="text-sm text-slate-400 max-w-2xl mx-auto">
                Hisaab extracts customer orders, reads payment screenshot slips,
                matches items to your price catalog, and detects mismatches.
              </p>
            </div>

            {/* Quick-Action: Load Sample Dataset Card */}
            <div className="p-5 rounded-2xl bg-gradient-to-r from-emerald-950/40 via-slate-900 to-slate-900 border border-emerald-800/40 shadow-xl flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-white font-semibold text-sm">
                  <Flame className="w-4 h-4 text-amber-400" />
                  <span>Try Synthetic Bakery Sample (3 Days, 7 Orders, 5 Receipts)</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Includes all 6 planted edge-cases: order edits (&quot;2 nahi, 3 kardo&quot;),
                  cancellations, short payments, duplicate receipts, missing address, and blurry screenshot.
                </p>
              </div>
              <button
                onClick={handleLoadSample}
                disabled={isAnalyzing}
                className="whitespace-nowrap px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs uppercase tracking-wide transition-all shadow-lg shadow-emerald-600/20 flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {isSampleLoaded ? "Sample Loaded ✓" : "Load Sample Dataset"}
              </button>
            </div>

            {/* Upload Inputs Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Chat Input */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4 flex flex-col justify-between">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm text-white flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-emerald-400" />
                      1. WhatsApp Chat
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">.txt</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Android or iOS export (.txt). Supports multi-line chats and attachment tags.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block w-full border-2 border-dashed border-slate-700/80 hover:border-emerald-500/50 rounded-xl p-4 text-center cursor-pointer transition-colors bg-slate-950/40">
                    <UploadCloud className="w-6 h-6 mx-auto text-slate-400 mb-2" />
                    <span className="text-xs font-medium text-slate-300 block">
                      {chatFile
                        ? chatFile.name
                        : isSampleLoaded
                        ? "samples/chat.txt (Loaded)"
                        : "Choose chat.txt"}
                    </span>
                    <input
                      type="file"
                      accept=".txt"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          setChatFile(file);
                          setIsSampleLoaded(false);
                        }
                      }}
                    />
                  </label>
                  {isSampleLoaded && (
                    <span className="text-[11px] text-emerald-400 font-mono block text-center">
                      21 messages ready
                    </span>
                  )}
                </div>
              </div>

              {/* Screenshots Input */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4 flex flex-col justify-between">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm text-white flex items-center gap-2">
                      <ImageIcon className="w-4 h-4 text-emerald-400" />
                      2. Payment Receipts
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">images</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Transaction screenshots. Filenames match chat attachment tags.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block w-full border-2 border-dashed border-slate-700/80 hover:border-emerald-500/50 rounded-xl p-4 text-center cursor-pointer transition-colors bg-slate-950/40">
                    <UploadCloud className="w-6 h-6 mx-auto text-slate-400 mb-2" />
                    <span className="text-xs font-medium text-slate-300 block">
                      {screenshotFiles.length > 0
                        ? `${screenshotFiles.length} files selected`
                        : isSampleLoaded
                        ? `${sampleScreenshots.length} sample images (Loaded)`
                        : "Upload screenshots"}
                    </span>
                    <input
                      type="file"
                      multiple
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files) {
                          setScreenshotFiles(Array.from(e.target.files));
                          setIsSampleLoaded(false);
                        }
                      }}
                    />
                  </label>
                  {isSampleLoaded && (
                    <span className="text-[11px] text-emerald-400 font-mono block text-center">
                      5 screenshots ready
                    </span>
                  )}
                </div>
              </div>

              {/* Catalog Input */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4 flex flex-col justify-between">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm text-white flex items-center gap-2">
                      <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                      3. Price Catalog
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">.csv</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Item name, pipe-separated aliases (Roman Urdu), and unit price.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block w-full border-2 border-dashed border-slate-700/80 hover:border-emerald-500/50 rounded-xl p-4 text-center cursor-pointer transition-colors bg-slate-950/40">
                    <UploadCloud className="w-6 h-6 mx-auto text-slate-400 mb-2" />
                    <span className="text-xs font-medium text-slate-300 block">
                      {catalogFile
                        ? catalogFile.name
                        : isSampleLoaded
                        ? "samples/catalog.csv (Loaded)"
                        : "Choose catalog.csv"}
                    </span>
                    <input
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          setCatalogFile(file);
                          setIsSampleLoaded(false);
                        }
                      }}
                    />
                  </label>
                  {isSampleLoaded && (
                    <span className="text-[11px] text-emerald-400 font-mono block text-center">
                      6 bakery items loaded
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Error Message */}
            {analyzeError && (
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-3">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{analyzeError}</span>
              </div>
            )}

            {/* Submit CTA */}
            <div className="pt-2 flex justify-center">
              <button
                onClick={handleRunAnalysis}
                disabled={isAnalyzing || (!chatFile && !isSampleLoaded && !chatText)}
                className="w-full sm:w-auto min-w-[280px] py-3.5 px-8 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-extrabold text-sm tracking-wide uppercase transition-all shadow-xl shadow-emerald-600/25 flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isAnalyzing ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Running Extraction &amp; Reconciliation...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Analyze &amp; Reconcile WhatsApp Chat
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ================= STEP 2: REVIEW & RECONCILE ================= */}
        {currentStep === "review" && (
          <div className="space-y-6">
            {/* Top Toolbar & Summary Stat Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-[11px] text-slate-400 uppercase font-medium">
                  Active Orders
                </span>
                <div className="text-xl font-extrabold text-white font-mono">
                  {computedTotals.activeOrdersCount}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-[11px] text-slate-400 uppercase font-medium">
                  Order Total
                </span>
                <div className="text-xl font-extrabold text-white font-mono">
                  Rs {computedTotals.totalOrderAmount.toLocaleString()}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-[11px] text-slate-400 uppercase font-medium">
                  Total Paid
                </span>
                <div className="text-xl font-extrabold text-emerald-400 font-mono">
                  Rs {computedTotals.totalPaidAmount.toLocaleString()}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-[11px] text-slate-400 uppercase font-medium">
                  Short Amount
                </span>
                <div
                  className={`text-xl font-extrabold font-mono ${
                    computedTotals.shortAmount > 0 ? "text-rose-400" : "text-slate-400"
                  }`}
                >
                  Rs {computedTotals.shortAmount.toLocaleString()}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-[11px] text-slate-400 uppercase font-medium">
                  Flagged Rows
                </span>
                <div className="text-xl font-extrabold text-rose-400 font-mono">
                  {orders.filter((o) => o.flags.length > 0).length}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-[11px] text-slate-400 uppercase font-medium">
                  Approved Rows
                </span>
                <div className="text-xl font-extrabold text-emerald-400 font-mono">
                  {approvedOrderIds.length} / {orders.length}
                </div>
              </div>
            </div>

            {/* Reconciliation Table */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
              <div className="p-4 border-b border-slate-800 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-emerald-400" />
                    Orders Reconciliation Table
                  </h2>
                  <span className="text-xs text-slate-400 font-mono">
                    ({orders.length} orders extracted)
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSelectAllApprovals}
                    className="text-xs font-mono text-slate-300 hover:text-white px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700/80 transition-colors cursor-pointer"
                  >
                    {approvedOrderIds.length ===
                    orders.filter((o) => o.status !== "cancelled").length
                      ? "Deselect All"
                      : "Approve All Active"}
                  </button>

                  <button
                    onClick={() => setCurrentStep("export")}
                    disabled={approvedOrderIds.length === 0}
                    className="text-xs font-bold px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-slate-950 transition-all shadow shadow-emerald-600/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export Approved ({approvedOrderIds.length})
                  </button>
                </div>
              </div>

              {/* Table Body */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 font-mono uppercase text-[11px] border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4 w-12 text-center">Approve</th>
                      <th className="py-3 px-4">Customer</th>
                      <th className="py-3 px-4">Ordered Items</th>
                      <th className="py-3 px-4 text-right">Total (Rs)</th>
                      <th className="py-3 px-4 text-right">Paid (Rs)</th>
                      <th className="py-3 px-4 text-center">Status</th>
                      <th className="py-3 px-4">Flags &amp; Evidence</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-sans">
                    {orders.map((order) => {
                      const isApproved = approvedOrderIds.includes(order.id);
                      const isCancelled = order.status === "cancelled";
                      const hasFlags = order.flags.length > 0;

                      return (
                        <tr
                          key={order.id}
                          className={`hover:bg-slate-800/30 transition-colors ${
                            selectedOrder?.id === order.id
                              ? "bg-slate-800/50 ring-1 ring-emerald-500/40"
                              : ""
                          }`}
                        >
                          {/* Approve Checkbox */}
                          <td className="py-3.5 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={isApproved}
                              onChange={() => handleToggleApprove(order.id)}
                              className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-950 cursor-pointer"
                            />
                          </td>

                          {/* Customer Name & Phone */}
                          <td
                            className="py-3.5 px-4 cursor-pointer"
                            onClick={() => setSelectedOrder(order)}
                          >
                            <div className="font-semibold text-white hover:text-emerald-300 transition-colors">
                              {order.customerName}
                            </div>
                            {order.phone && (
                              <div className="text-[11px] text-slate-400 font-mono flex items-center gap-1 mt-0.5">
                                <Phone className="w-2.5 h-2.5 text-slate-500" />
                                {order.phone}
                              </div>
                            )}
                            {order.address && (
                              <div className="text-[11px] text-slate-500 truncate max-w-[200px] mt-0.5">
                                {order.address}
                              </div>
                            )}
                          </td>

                          {/* Items List */}
                          <td
                            className="py-3.5 px-4 cursor-pointer"
                            onClick={() => setSelectedOrder(order)}
                          >
                            <div className="space-y-1">
                              {order.items.map((it, idx) => (
                                <span
                                  key={idx}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800/70 text-slate-300 font-mono text-[11px] mr-1.5"
                                >
                                  <span className="font-bold text-emerald-400">
                                    {it.qty}x
                                  </span>{" "}
                                  {it.name}
                                </span>
                              ))}
                            </div>
                          </td>

                          {/* Total */}
                          <td
                            className="py-3.5 px-4 text-right font-mono font-bold text-white cursor-pointer"
                            onClick={() => setSelectedOrder(order)}
                          >
                            {isCancelled ? (
                              <span className="text-slate-500 line-through">0</span>
                            ) : (
                              order.total.toLocaleString()
                            )}
                          </td>

                          {/* Paid */}
                          <td
                            className="py-3.5 px-4 text-right font-mono font-bold cursor-pointer"
                            onClick={() => setSelectedOrder(order)}
                          >
                            <span
                              className={
                                order.paid < order.total && !isCancelled
                                  ? "text-rose-400 font-extrabold"
                                  : "text-emerald-400"
                              }
                            >
                              {order.paid.toLocaleString()}
                            </span>
                          </td>

                          {/* Status */}
                          <td
                            className="py-3.5 px-4 text-center cursor-pointer"
                            onClick={() => setSelectedOrder(order)}
                          >
                            <span
                              className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                isCancelled
                                  ? "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                                  : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                              }`}
                            >
                              {order.status}
                            </span>
                          </td>

                          {/* Flags Chips */}
                          <td className="py-3.5 px-4">
                            {hasFlags ? (
                              <div className="flex flex-wrap gap-1.5">
                                {order.flags.map((flag, idx) => (
                                  <span
                                    key={idx}
                                    title={flag.message}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30"
                                  >
                                    <AlertCircle className="w-2.5 h-2.5" />
                                    {flag.code}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400/80 font-mono">
                                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                                Matched
                              </span>
                            )}
                          </td>

                          {/* Actions */}
                          <td className="py-3.5 px-4 text-right space-x-2">
                            {hasFlags && (
                              <button
                                onClick={() => handleDraftReply(order)}
                                className="px-2.5 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-[11px] font-medium transition-colors cursor-pointer"
                              >
                                Draft Reply
                              </button>
                            )}

                            <button
                              onClick={() => setSelectedOrder(order)}
                              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-medium transition-colors cursor-pointer"
                            >
                              Inspect
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ================= STEP 3: EXPORT ================= */}
        {currentStep === "export" && (
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="space-y-1">
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <FileSpreadsheet className="w-5 h-5 text-emerald-400" />
                    Verified Sheets Export (orders.csv &amp; pick-list.csv)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Export verified rows approved by seller. Cancelled orders are excluded from totals and exports.
                  </p>
                </div>

                <button
                  onClick={handleDownloadZip}
                  disabled={approvedOrderIds.length === 0 || isExporting}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-extrabold text-xs tracking-wide uppercase transition-all shadow-lg shadow-emerald-600/20 flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isExporting ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  Download Verified Sheets (.zip)
                </button>
              </div>

              {/* Status Notice */}
              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">Approved rows ready for export:</span>
                <span className="font-bold text-emerald-400">
                  {approvedOrderIds.length} orders
                </span>
              </div>
            </div>

            {/* Live CSV Previews */}
            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setExportPreviewTab("orders")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-colors ${
                      exportPreviewTab === "orders"
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    orders.csv
                  </button>
                  <button
                    onClick={() => setExportPreviewTab("pick-list")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-colors ${
                      exportPreviewTab === "pick-list"
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    pick-list.csv
                  </button>
                </div>
                <span className="text-xs text-slate-500 font-mono">CSV Preview</span>
              </div>

              <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800/80 font-mono text-xs text-slate-300 overflow-x-auto max-h-72">
                {exportPreviewTab === "orders" ? previewOrdersCsv : previewPickListCsv}
              </pre>
            </div>
          </div>
        )}
      </main>

      {/* ================= INSPECT & EDIT SIDE PANEL ================= */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/80 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-4xl bg-slate-900 border-l border-slate-800 h-full overflow-y-auto flex flex-col shadow-2xl">
            {/* Panel Header */}
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/70 sticky top-0 z-10 backdrop-blur">
              <div className="flex items-center gap-3">
                <div className="font-extrabold text-base text-white">
                  Inspect &amp; Edit Order: {selectedOrder.customerName}
                </div>
                <span className="font-mono text-xs text-slate-500">
                  {selectedOrder.id}
                </span>
              </div>
              <button
                onClick={() => setSelectedOrder(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Panel Body Grid */}
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
              {/* Left Column: Source Chat Messages & Linked Screenshot */}
              <div className="space-y-6">
                {/* Source Chat Messages */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span className="flex items-center gap-1.5">
                      <MessageSquare className="w-4 h-4 text-emerald-400" />
                      Source WhatsApp Messages
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      IDs: {selectedOrder.sourceMessageIds.join(", ")}
                    </span>
                  </div>

                  <div className="space-y-2 max-h-60 overflow-y-auto p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-xs">
                    {rawMessages
                      .filter((m) => selectedOrder.sourceMessageIds.includes(m.id))
                      .map((msg) => (
                        <div
                          key={msg.id}
                          className="p-2.5 rounded-lg bg-slate-900/90 border border-emerald-500/20 space-y-1"
                        >
                          <div className="flex items-center justify-between text-[11px] text-emerald-400 font-semibold">
                            <span>{msg.sender}</span>
                            <span className="text-slate-500 font-normal">
                              [ID: {msg.id}] {msg.ts}
                            </span>
                          </div>
                          <p className="text-slate-300 text-xs font-sans whitespace-pre-wrap">
                            {msg.text}
                          </p>
                          {msg.attachments.length > 0 && (
                            <div className="text-[10px] text-amber-400 flex items-center gap-1 mt-1">
                              <ImageIcon className="w-3 h-3" />
                              {msg.attachments.join(", ")}
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </div>

                {/* Linked Payment Screenshot */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span className="flex items-center gap-1.5">
                      <ImageIcon className="w-4 h-4 text-emerald-400" />
                      Linked Payment Screenshot
                    </span>
                  </div>

                  {selectedOrder.linkedPayments.length > 0 ? (
                    <div className="space-y-3">
                      {selectedOrder.linkedPayments.map((p) => (
                        <div
                          key={p.id}
                          className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-slate-300 font-semibold">
                              {p.fileName}
                            </span>
                            <span
                              className={`font-mono text-[11px] px-2 py-0.5 rounded ${
                                p.confidence < 0.6
                                  ? "bg-rose-500/20 text-rose-400"
                                  : "bg-emerald-500/20 text-emerald-400"
                              }`}
                            >
                              Conf: {(p.confidence * 100).toFixed(0)}%
                            </span>
                          </div>

                          {/* Screenshot preview */}
                          <div className="rounded-lg overflow-hidden border border-slate-800 bg-slate-900 aspect-video flex items-center justify-center relative group">
                            <img
                              src={`/api/screenshot/${p.fileName}`}
                              alt={p.fileName}
                              className="w-full h-full object-contain"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = "none";
                              }}
                            />
                            <div className="absolute inset-0 bg-slate-950/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <a
                                href={`/api/screenshot/${p.fileName}`}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1.5 rounded-lg bg-slate-800 text-xs text-white flex items-center gap-1"
                              >
                                <ExternalLink className="w-3 h-3" />
                                View Full
                              </a>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-400 pt-1">
                            <div>Amount: Rs {p.amount ?? "Unreadable (null)"}</div>
                            <div>Txn: {p.txnId ?? "Unreadable (null)"}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-500 text-xs text-center font-mono">
                      No payment screenshot linked
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: Editable Order Fields */}
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                  <span className="flex items-center gap-1.5">
                    <Edit3 className="w-4 h-4 text-emerald-400" />
                    Editable Order Data
                  </span>
                  <span className="text-[10px] text-emerald-400 font-mono">
                    Editable by seller
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3 text-xs font-sans">
                  {/* Customer Name */}
                  <div className="space-y-1">
                    <label className="text-slate-400 text-[11px]">Customer Name</label>
                    <input
                      type="text"
                      value={selectedOrder.customerName}
                      onChange={(e) =>
                        handleSaveOrderEdits({
                          ...selectedOrder,
                          customerName: e.target.value,
                        })
                      }
                      className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  {/* Phone */}
                  <div className="space-y-1">
                    <label className="text-slate-400 text-[11px]">Phone</label>
                    <input
                      type="text"
                      value={selectedOrder.phone || ""}
                      onChange={(e) =>
                        handleSaveOrderEdits({
                          ...selectedOrder,
                          phone: e.target.value,
                        })
                      }
                      placeholder="e.g. 03001234567"
                      className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-white font-mono focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  {/* Delivery Address */}
                  <div className="space-y-1">
                    <label className="text-slate-400 text-[11px]">Delivery Address</label>
                    <input
                      type="text"
                      value={selectedOrder.address || ""}
                      onChange={(e) =>
                        handleSaveOrderEdits({
                          ...selectedOrder,
                          address: e.target.value,
                        })
                      }
                      placeholder="Add address here..."
                      className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  {/* Total and Paid amounts */}
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div className="space-y-1">
                      <label className="text-slate-400 text-[11px]">Total (Rs)</label>
                      <input
                        type="number"
                        value={selectedOrder.total}
                        onChange={(e) =>
                          handleSaveOrderEdits({
                            ...selectedOrder,
                            total: parseFloat(e.target.value) || 0,
                          })
                        }
                        className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-white font-mono focus:outline-none focus:border-emerald-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-slate-400 text-[11px]">Paid (Rs)</label>
                      <input
                        type="number"
                        value={selectedOrder.paid}
                        onChange={(e) =>
                          handleSaveOrderEdits({
                            ...selectedOrder,
                            paid: parseFloat(e.target.value) || 0,
                          })
                        }
                        className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-white font-mono focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                  </div>

                  {/* Status Toggle */}
                  <div className="space-y-1 pt-1">
                    <label className="text-slate-400 text-[11px]">Order Status</label>
                    <select
                      value={selectedOrder.status}
                      onChange={(e) =>
                        handleSaveOrderEdits({
                          ...selectedOrder,
                          status: e.target.value as "active" | "cancelled",
                        })
                      }
                      className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                    >
                      <option value="active">Active</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>

                  {/* Approve Checkbox inside Panel */}
                  <div className="pt-2 flex items-center justify-between border-t border-slate-800">
                    <span className="text-xs text-slate-300 font-medium">
                      Approve for Export
                    </span>
                    <button
                      onClick={() => handleToggleApprove(selectedOrder.id)}
                      className={`px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                        approvedOrderIds.includes(selectedOrder.id)
                          ? "bg-emerald-600 text-slate-950 font-bold"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      {approvedOrderIds.includes(selectedOrder.id) ? (
                        <>
                          <Check className="w-3.5 h-3.5" /> Approved
                        </>
                      ) : (
                        "Mark Approved"
                      )}
                    </button>
                  </div>
                </div>

                {/* Flags breakdown */}
                {selectedOrder.flags.length > 0 && (
                  <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-2 text-xs">
                    <div className="font-bold text-rose-300 flex items-center gap-1.5">
                      <AlertCircle className="w-4 h-4" />
                      Raised Issues:
                    </div>
                    {selectedOrder.flags.map((f, i) => (
                      <div key={i} className="text-rose-200/90 pl-5 text-[11px]">
                        • <strong>{f.code}</strong>: {f.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Panel Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-950/60 flex justify-end">
              <button
                onClick={() => setSelectedOrder(null)}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs uppercase tracking-wide cursor-pointer"
              >
                Close Panel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= DRAFT REPLY MODAL ================= */}
      {draftReplyModalOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden space-y-4 p-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-emerald-400" />
                <h3 className="font-bold text-sm text-white">
                  Draft WhatsApp Reply for {draftReplyModalOrder.customerName}
                </h3>
              </div>
              <button
                onClick={() => setDraftReplyModalOrder(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Auto-generated polite response in customer&apos;s Roman Urdu language register.
              (Copy to clipboard only. Never sent automatically).
            </p>

            <div className="relative">
              {isDraftingReply ? (
                <div className="h-32 flex items-center justify-center text-xs text-slate-400 gap-2">
                  <RotateCcw className="w-4 h-4 animate-spin text-emerald-400" />
                  Generating Roman Urdu reply draft via Gemma 4...
                </div>
              ) : (
                <textarea
                  readOnly
                  value={draftReplyText}
                  className="w-full h-32 p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-xs font-sans text-slate-200 resize-none focus:outline-none"
                />
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-[11px] text-slate-500 italic">
                Copy to clipboard and paste in WhatsApp chat
              </span>
              <button
                onClick={handleCopyDraft}
                disabled={isDraftingReply || !draftReplyText}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-40"
              >
                {copiedDraft ? (
                  <>
                    <Check className="w-3.5 h-3.5" /> Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" /> Copy to Clipboard
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mandatory Spec Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-4 px-4 mt-auto text-center">
        <p className="text-xs text-slate-500 font-sans">
          Hisaab checks that screenshots match orders. Confirm payments in your bank app.
        </p>
      </footer>
    </div>
  );
}
