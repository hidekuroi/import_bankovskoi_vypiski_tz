export type FileFormat = "pdf" | "csv";

// The server rejects bodies strictly larger than this (kit/mock-server.mjs).
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Enough for either signature below.
export const HEAD_BYTES = 32;

const PDF_MAGIC = "%PDF-";
const CSV_HEADER = "date,description,amount\n";

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

// Mirrors the mock's own content check byte for byte, so a file that passes
// here can't come back as 415 and a file that fails never leaves the device.
// The extension and the MIME type the picker reports are not consulted.
export function detectFormat(head: Uint8Array): FileFormat | null {
  if (latin1(head.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC) return "pdf";
  const csvHead = latin1(head.subarray(0, CSV_HEADER.length)).replace(/\r/g, "");
  if (csvHead.startsWith(CSV_HEADER)) return "csv";
  return null;
}

// Only to explain a rejection ("named .pdf, but it isn't one"), never to accept.
export function claimedFormat(name: string): FileFormat | null {
  const extension = name.toLowerCase().split(".").pop();
  return extension === "pdf" || extension === "csv" ? extension : null;
}
