import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReceiptExt } from "@/pages/modules/DeliveryHistory";
import { ReceiptSheet } from "./ReceiptSheet";

export function ReceiptBatchPrint({ receipts, onDone }: { receipts: ReceiptExt[]; onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const finish = () => onDoneRef.current();
    window.addEventListener("afterprint", finish, { once: true });
    window.print();
    return () => window.removeEventListener("afterprint", finish);
  }, []);

  return createPortal(
    <div id="receipt-batch-print-area" aria-hidden="true" className="hidden print:block">
      <style>{`
        @media print {
          @page { size: auto; margin: 0.35in; }
          html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
          body:has(#receipt-batch-print-area) #root { display: none !important; }
          #receipt-batch-print-area { display: block !important; background: #fff; color: #111; }
          #receipt-batch-print-area .text-muted-foreground { color: #52525b !important; }
          #receipt-batch-print-area .receipt-page {
            width: 100%; max-width: 7.5in; margin: 0 auto; padding: 0.2in;
            break-after: page; page-break-after: always; break-inside: avoid;
          }
          #receipt-batch-print-area .receipt-page:last-child { break-after: auto; page-break-after: auto; }
        }
      `}</style>
      {receipts.map((receipt) => (
        <div key={receipt.id} className="receipt-page">
          <ReceiptSheet receipt={receipt} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
