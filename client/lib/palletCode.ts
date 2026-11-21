import QRCode from "qrcode";

const SHORT_CODE_PATTERN = /^(PLT|ORD)-([0-9A-F]{8})$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const shortId = (id: string) => id.slice(0, 8).toUpperCase();

export const palletBarcodeValue = (id: string) => `PLT-${shortId(id)}`;

export const orderBarcodeValue = (id: string) => `ORD-${shortId(id)}`;

export type ScannedCode =
  | { kind: "pallet"; value: string }
  | { kind: "order"; value: string }
  | { kind: "id"; value: string }
  | { kind: "unknown"; value: string };

export function parseScannedCode(raw: string): ScannedCode {
  const code = raw.trim();
  const short = SHORT_CODE_PATTERN.exec(code);
  if (short) {
    const kind = short[1].toUpperCase() === "PLT" ? "pallet" : "order";
    return { kind, value: short[2].toLowerCase() };
  }
  if (UUID_PATTERN.test(code)) return { kind: "id", value: code };
  return { kind: "unknown", value: code };
}

/** QR code encoding only the pallet ID. QR is far easier for phone cameras to read than a 36-character Code 128. */
export function palletQrDataUrl(id: string): Promise<string> {
  return QRCode.toDataURL(id, { errorCorrectionLevel: "M", margin: 2, width: 320 });
}
