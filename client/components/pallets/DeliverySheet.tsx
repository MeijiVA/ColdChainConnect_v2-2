import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState } from "react";
import JsBarcode from "jsbarcode";
import { orderBarcodeValue, palletBarcodeValue } from "@/lib/palletCode";
import { Printer } from "lucide-react";
import type { Booking, InventoryBatch, Pallet } from "@shared/api";

export interface DeliverySheetSection {
  order: Booking;
  pallets: Pallet[];
}

interface DeliverySheetProps {
  sections: DeliverySheetSection[];
  batches: InventoryBatch[];
}

interface PickLine {
  key: string;
  productName: string;
  batchName: string;
  qty: number;
}

/**
 * Barcodes carry a short code (e.g. PLT-7F7CE403), not the 36-character ID. A long Code 128 gets shrunk
 * until its bars are under one pixel wide and nothing can read it; 12 characters stay scannable at label size.
 * The scanner resolves the short code back to the full pallet or order.
 */
function barcodeDataUrl(value: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  JsBarcode(svg, value, { format: "CODE128", displayValue: false, margin: 12, height: 64, width: 3 });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

function orderLabels(order: Booking) {
  return {
    storeName: order.customer?.store_name ?? "Customer",
    deliveryDate: order.prepared_delivery_date
      ? new Date(order.prepared_delivery_date).toLocaleDateString()
      : "Not scheduled",
  };
}

function usePickLines(section: DeliverySheetSection, batches: InventoryBatch[]) {
  return useMemo<PickLine[]>(() => {
    const batchNameByItemId = new Map(
      batches.flatMap((batch) => (batch.items ?? []).map((item) => [item.id, batch.name] as const)),
    );
    const productNameById = new Map(
      (section.order.booking_items ?? []).map((item) => [item.product_id, item.product?.name ?? item.product_id] as const),
    );
    const lines = new Map<string, PickLine>();

    for (const pallet of section.pallets) {
      for (const item of pallet.items ?? []) {
        const batchName = batchNameByItemId.get(item.batch_item_id) ?? "Unknown batch";
        const productName = productNameById.get(item.product_id) ?? item.product_id;
        const key = `${item.product_id}|${item.batch_item_id}`;
        const line = lines.get(key) ?? { key, productName, batchName, qty: 0 };
        line.qty += item.qty_units;
        lines.set(key, line);
      }
    }

    return [...lines.values()].sort((a, b) => a.productName.localeCompare(b.productName));
  }, [batches, section]);
}

function PalletLabel({
  pallet,
  index,
  total,
  storeName,
  deliveryDate,
  barcode,
}: {
  pallet: Pallet;
  index: number;
  total: number;
  storeName: string;
  deliveryDate: string;
  barcode?: string;
}) {
  const units = (pallet.items ?? []).reduce((sum, item) => sum + item.qty_units, 0);
  return (
    <div className="label-card flex flex-col items-center gap-1 border border-black p-2 text-center">
      <p className="text-xs font-bold">Pallet {index + 1} of {total} · {units} units</p>
      <p className="text-xs">{storeName}</p>
      <p className="text-2xs">Delivery: {deliveryDate}</p>
      {barcode && <img src={barcode} alt={`Barcode for pallet ${index + 1}`} className="h-auto w-full object-contain" />}
      <p className="font-mono text-2xs">{palletBarcodeValue(pallet.id)}</p>
    </div>
  );
}

function SheetSection({ section, batches }: { section: DeliverySheetSection; batches: InventoryBatch[] }) {
  const { order, pallets } = section;
  const pickLines = usePickLines(section, batches);
  const orderBarcode = useMemo(() => barcodeDataUrl(orderBarcodeValue(order.id)), [order.id]);
  const { storeName, deliveryDate } = orderLabels(order);

  return (
    <div className="order-section">
      <header className="sheet-header border-b border-black pb-2">
        <h1 className="text-lg font-bold">Delivery Sheet</h1>
        <p className="text-xs">Order {order.id.slice(0, 8)} · {storeName}{order.customer?.location ? ` · ${order.customer.location}` : ""}</p>
        <p className="text-xs">Delivery date: {deliveryDate} · Pallets: {pallets.length}</p>
        <img src={orderBarcode} alt={`Barcode for order ${order.id.slice(0, 8)}`} className="mt-2 h-auto w-full object-contain" />
        <p className="font-mono text-2xs">{orderBarcodeValue(order.id)}</p>
      </header>

      <section className="pick-list mt-3">
        <h2 className="mb-1 text-sm font-bold">Pick List</h2>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-black text-left">
              <th className="py-0.5">Product</th>
              <th className="py-0.5">Take from batch</th>
              <th className="py-0.5 text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {pickLines.map((line) => (
              <tr key={line.key} className="border-b border-border">
                <td className="py-0.5">{line.productName}</td>
                <td className="py-0.5">{line.batchName}</td>
                <td className="py-0.5 text-right">{line.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

    </div>
  );
}

const SHEETS_PER_PAGE = 6;
const CARDS_PER_PAGE = 9;

export function DeliverySheet({ sections, batches }: DeliverySheetProps) {
  const [barcodes, setBarcodes] = useState<Record<string, string>>({});
  const [cardMode, setCardMode] = useState(true);
  const allPallets = useMemo(() => sections.flatMap((section) => section.pallets), [sections]);
  const sheetPages = Array.from({ length: Math.ceil(sections.length / SHEETS_PER_PAGE) }, (_, index) =>
    sections.slice(index * SHEETS_PER_PAGE, (index + 1) * SHEETS_PER_PAGE),
  );
  const cards = useMemo(
    () =>
      sections.flatMap((section) => {
        const { storeName, deliveryDate } = orderLabels(section.order);
        return section.pallets.map((pallet, index) => ({
          pallet,
          index,
          total: section.pallets.length,
          storeName,
          deliveryDate,
        }));
      }),
    [sections],
  );
  const cardPages = Array.from({ length: Math.ceil(cards.length / CARDS_PER_PAGE) }, (_, index) =>
    cards.slice(index * CARDS_PER_PAGE, (index + 1) * CARDS_PER_PAGE),
  );

  useEffect(() => {
    setBarcodes(Object.fromEntries(allPallets.map((pallet) => [pallet.id, barcodeDataUrl(palletBarcodeValue(pallet.id))])));
  }, [allPallets]);

  return (
    <div className="delivery-sheet-overlay flex-1 flex flex-col gap-6 p-6">
      <div className="delivery-sheet-dialog flex w-full max-w-3xl flex-col gap-4">
        <div className="no-print page-header">
          <div>
            <h1 className="page-title">Delivery Sheet</h1>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={() => setCardMode((mode) => !mode)}
              variant="outline"
            >
              {cardMode ? "Switch to letter" : "Switch to 5×3 card"}
            </Button>
            <Button
              type="button"
              onClick={() => window.print()}
              variant="default"
            >
              <Printer size={16} /> Print
            </Button>
          </div>
        </div>

        <div id="delivery-sheet" className="overflow-y-auto rounded-2xl border border-border bg-white p-5 font-sans text-black">
          <style>{`
            @media print {
              @page {
                size: ${cardMode ? "letter landscape" : "letter"};
                margin: 0;
              }
              html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
              body > *:not(:has(#delivery-sheet)) { display: none !important; }
              body:has(#delivery-sheet) .fixed.inset-0 { display: none !important; }
              body:has(#delivery-sheet) [role="dialog"] {
                position: static !important; display: block !important; width: 100% !important; max-width: none !important;
                max-height: none !important; overflow: visible !important; transform: none !important; border: 0 !important;
                padding: 0 !important; margin: 0 !important; box-shadow: none !important; background: transparent !important;
              }
              body:has(#delivery-sheet) [role="dialog"] > button { display: none !important; }
              .delivery-sheet-overlay {
                position: static !important;
                display: block !important;
                width: 100% !important;
                padding: 0 !important;
                background: transparent !important;
              }
              .delivery-sheet-dialog {
                display: block !important;
                width: 100% !important;
                max-width: none !important;
                max-height: none !important;
                overflow: visible !important;
                border: 0 !important;
                border-radius: 0 !important;
              }
              #delivery-sheet {
                position: relative !important;
                width: 100% !important;
                max-width: none !important;
                margin: 0 !important;
                max-height: none !important;
                overflow: visible !important;
                padding: 0 !important;
                border: 0 !important;
                border-radius: 0 !important;
                background: #fff !important;
                color: #111 !important;
              }
              .sheet-page.letter-page {
                display: grid !important;
                grid-template-columns: 1fr 1fr;
                grid-template-rows: repeat(3, minmax(0, 1fr));
                gap: 0.12in;
                box-sizing: border-box;
                padding: 0.35in;
                height: 10.95in;
                break-after: page;
              }
              .sheet-page.letter-page:last-child { break-after: auto; }
              .sheet-page.letter-page .order-section {
                border: 1px solid #000;
                padding: 0.08in;
                box-sizing: border-box;
                overflow: hidden;
                min-width: 0;
              }
              .sheet-page.letter-page .sheet-header img { height: 0.3in !important; }
              .sheet-page.letter-page .label-card { padding: 0.04in !important; gap: 0.02in !important; }
              .sheet-page.letter-page .label-card img { height: 0.5in !important; width: auto !important; max-width: 100%; }
              .sheet-page.letter-page .pick-list { margin-top: 0.06in !important; }
              .sheet-page.letter-page .text-lg { font-size: 10pt; }
              .sheet-page.letter-page .text-xs { font-size: 6.5pt; }
              .sheet-page.letter-page .text-2xs { font-size: 6pt; }
              .sheet-page.letter-page .text-sm { font-size: 7.5pt; }
              .card-page {
                display: grid !important;
                grid-template-columns: repeat(3, minmax(0, 3.4in));
                grid-template-rows: repeat(3, 2.04in);
                gap: 0.2in;
                justify-content: center;
                align-content: center;
                width: 100%;
                height: 8.5in;
                break-after: page;
              }
              .card-page:last-child { break-after: auto; }
              .card-page .label-card {
                width: 3.4in !important;
                height: 2.04in !important;
                border: 1px solid #000 !important;
                padding: 0.08in !important;
                gap: 0.03in !important;
                box-sizing: border-box;
                justify-content: center;
              }
              .card-page .label-card img { height: 1in !important; width: 92% !important; max-width: none !important; object-fit: fill; }
              .card-page .text-xs { font-size: 6.5pt; }
              .card-page .text-2xs { font-size: 5.5pt; }
              .no-print { display: none !important; }
              .label-card { break-inside: avoid; color: #111 !important; background: #fff !important; }
            }
          `}</style>

          {cardMode
            ? cardPages.map((page, pageIndex) => (
                <div key={pageIndex} className="card-page grid grid-cols-2 gap-4">
                  {page.map((card) => (
                    <PalletLabel
                      key={card.pallet.id}
                      pallet={card.pallet}
                      index={card.index}
                      total={card.total}
                      storeName={card.storeName}
                      deliveryDate={card.deliveryDate}
                      barcode={barcodes[card.pallet.id]}
                    />
                  ))}
                </div>
              ))
            : sheetPages.map((page, pageIndex) => (
                <div key={pageIndex} className="sheet-page letter-page">
                  {page.map((section) => (
                    <SheetSection
                      key={section.order.id}
                      section={section}
                      batches={batches}
                    />
                  ))}
                </div>
              ))}
        </div>
      </div>
    </div>
  );
}
