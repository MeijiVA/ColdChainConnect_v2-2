import QRCode from "qrcode";

/** Short code shown to people; the label's QR code carries the full pallet ID. */
export const palletCode = (id: string) => `PLT-${id.slice(0, 8).toUpperCase()}`;

/** QR code encoding only the pallet ID. QR is far easier for phone cameras to read than a 36-character Code 128. */
export function palletQrDataUrl(id: string): Promise<string> {
  return QRCode.toDataURL(id, { errorCorrectionLevel: "M", margin: 2, width: 320 });
}
