import { Message, MessageSchema } from "./schemas.ts";

/**
 * Android message header regex:
 * e.g.: "21/10/2026, 14:05 - Name: message"
 * or: "21/10/26, 2:05 pm - Name: message"
 * or: "10/21/2026, 02:05:11 PM - +92 300 1234567: message"
 */
const ANDROID_HEADER_REGEX =
  /^(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},\s+\d{1,2}:\d{2}(?::\d{2})?(?:[\s\u202f\u00a0]?[AaPp][Mm])?)\s+-\s+([^:\r\n]+?):\s*(.*)$/;

/**
 * Android system notification regex:
 * Matches timestamp and dash, but lacks a colon-separated sender.
 */
const ANDROID_SYSTEM_REGEX =
  /^(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},\s+\d{1,2}:\d{2}(?::\d{2})?(?:[\s\u202f\u00a0]?[AaPp][Mm])?)\s+-\s+[^:\r\n]+$/;

/**
 * iOS message header regex:
 * e.g.: "[21/10/26, 2:05:11 PM] Name: message"
 * or: "[21/10/2026, 14:05:11] Name: message"
 */
const IOS_HEADER_REGEX =
  /^\[(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},\s+\d{1,2}:\d{2}(?::\d{2})?(?:[\s\u202f\u00a0]?[AaPp][Mm])?)\]\s+([^:\r\n]+?):\s*(.*)$/;

/**
 * iOS system notification regex:
 * e.g.: "[21/10/26, 2:05:11 PM] Messages and calls are end-to-end encrypted..."
 */
const IOS_SYSTEM_REGEX =
  /^\[(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},\s+\d{1,2}:\d{2}(?::\d{2})?(?:[\s\u202f\u00a0]?[AaPp][Mm])?)\]\s+[^:\r\n]+$/;

/**
 * Attachment filename patterns
 * Android: "IMG-20261021-WA0004.jpg (file attached)"
 * iOS: "<attached: 00000004-PHOTO-2026-10-21.jpg>"
 */
const ANDROID_ATTACHMENT_REGEX =
  /([\w\-. ]+\.(?:jpe?g|png|webp|gif|pdf|mp4|opus|m4a|aac|heic|docx?|xlsx?))\s+\(file attached\)/gi;

const IOS_ATTACHMENT_REGEX =
  /<attached:\s*([^>\r\n]+)>/gi;

/**
 * Cleans invisible and directional unicode characters from lines.
 */
export function cleanUnicode(str: string): string {
  return str.replace(/^[\u200e\u200f\ufeff]+/, "").trimEnd();
}

/**
 * Extracts attachment filenames from message text.
 */
export function extractAttachments(text: string): string[] {
  const attachments: string[] = [];

  // Match Android attachment pattern
  const androidMatches = text.matchAll(ANDROID_ATTACHMENT_REGEX);
  for (const match of androidMatches) {
    if (match[1]) {
      attachments.push(match[1].trim());
    }
  }

  // Match iOS attachment pattern
  const iosMatches = text.matchAll(IOS_ATTACHMENT_REGEX);
  for (const match of iosMatches) {
    if (match[1]) {
      attachments.push(match[1].trim());
    }
  }

  return attachments;
}

export type WhatsAppFormat = "android" | "ios" | "unknown";

/**
 * Detects whether a chat export is Android or iOS format.
 */
export function detectFormat(rawText: string): WhatsAppFormat {
  const lines = rawText.split(/\r?\n/).slice(0, 50);
  for (const rawLine of lines) {
    const line = cleanUnicode(rawLine);
    if (IOS_HEADER_REGEX.test(line) || IOS_SYSTEM_REGEX.test(line)) {
      return "ios";
    }
    if (ANDROID_HEADER_REGEX.test(line) || ANDROID_SYSTEM_REGEX.test(line)) {
      return "android";
    }
  }
  return "unknown";
}

interface RawDraftMessage {
  ts: string;
  sender: string;
  lines: string[];
}

/**
 * Parses a raw WhatsApp export into a typed array of Message objects.
 * Supports both Android and iOS exports, multi-line continuations,
 * and attachment extraction.
 */
export function parseWhatsAppChat(rawText: string): Message[] {
  if (!rawText || !rawText.trim()) {
    return [];
  }

  const lines = rawText.split(/\r?\n/);
  const draftMessages: RawDraftMessage[] = [];
  let current: RawDraftMessage | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const cleanedLine = cleanUnicode(rawLine);

    // Skip empty lines before the first message
    if (!current && cleanedLine.trim() === "") {
      continue;
    }

    // Check for iOS header
    const iosMatch = cleanedLine.match(IOS_HEADER_REGEX);
    if (iosMatch) {
      if (current) draftMessages.push(current);
      current = {
        ts: iosMatch[1].trim(),
        sender: iosMatch[2].trim(),
        lines: [iosMatch[3]],
      };
      continue;
    }

    // Check for Android header
    const androidMatch = cleanedLine.match(ANDROID_HEADER_REGEX);
    if (androidMatch) {
      if (current) draftMessages.push(current);
      current = {
        ts: androidMatch[1].trim(),
        sender: androidMatch[2].trim(),
        lines: [androidMatch[3]],
      };
      continue;
    }

    // Check for system notices to ignore (e.g. security codes, encryption notes)
    if (IOS_SYSTEM_REGEX.test(cleanedLine) || ANDROID_SYSTEM_REGEX.test(cleanedLine)) {
      if (current) {
        draftMessages.push(current);
        current = null;
      }
      continue;
    }

    // Multi-line continuation of current message
    if (current) {
      current.lines.push(rawLine);
    }
  }

  if (current) {
    draftMessages.push(current);
  }

  // Convert draft messages into validated Message objects
  const messages: Message[] = draftMessages.map((draft, index) => {
    const fullText = draft.lines.join("\n").trim();
    const attachments = extractAttachments(fullText);

    return MessageSchema.parse({
      id: index + 1,
      ts: draft.ts,
      sender: draft.sender,
      text: fullText,
      attachments,
    });
  });

  return messages;
}
