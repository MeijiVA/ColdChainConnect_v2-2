import { describe, expect, it } from "vitest";
import { orderBarcodeValue, palletBarcodeValue, parseScannedCode } from "./palletCode";

const id = "7f7ce403-82c1-42e6-90d4-bfc2369a47db";

describe("barcode short codes", () => {
  it("prints 12-character values", () => {
    expect(palletBarcodeValue(id)).toBe("PLT-7F7CE403");
    expect(orderBarcodeValue(id)).toBe("ORD-7F7CE403");
  });

  it("round-trips a pallet and an order code, ignoring case and spaces", () => {
    expect(parseScannedCode(palletBarcodeValue(id))).toEqual({ kind: "pallet", value: "7f7ce403" });
    expect(parseScannedCode(" ord-7f7ce403 ")).toEqual({ kind: "order", value: "7f7ce403" });
  });

  it("treats full IDs (old stickers, QR, manual entry) as plain ids", () => {
    expect(parseScannedCode(id)).toEqual({ kind: "id", value: id });
  });
});
