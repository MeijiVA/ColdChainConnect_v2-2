import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { Folder, SwitchCamera, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AgentBarcodeScannerProps {
  onClose: () => void;
  onDetected: (code: string) => void;
}

// @zxing/library is only a transitive dependency, so its enum values are referenced numerically.
const HINT_POSSIBLE_FORMATS = 2; // DecodeHintType.POSSIBLE_FORMATS
const HINT_TRY_HARDER = 3; // DecodeHintType.TRY_HARDER
const SUPPORTED_FORMATS = [
  4, // CODE_128 (existing pallet and order stickers)
  11, // QR_CODE (new pallet stickers)
  2, // CODE_39
  7, // EAN_13
  6, // EAN_8
  14, // UPC_A
];

type ReaderHints = ConstructorParameters<typeof BrowserMultiFormatReader>[0];

function createReader() {
  const hints = new Map<number, unknown>([
    [HINT_POSSIBLE_FORMATS, SUPPORTED_FORMATS],
    [HINT_TRY_HARDER, true],
  ]) as unknown as ReaderHints;
  return new BrowserMultiFormatReader(hints);
}

function cameraUnavailableMessage(): string | null {
  if (!window.isSecureContext) {
    return "Camera access needs a secure (https://) connection. Open the app over HTTPS, or use the image picker or manual entry below.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser can't access the camera. Use the image picker or manual entry below.";
  }
  return null;
}

function cameraStartMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera permission was denied. Allow camera access in your browser settings and try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No usable camera was found on this device.";
  if (name === "NotReadableError")
    return "The camera is in use by another app. Close it and try again.";
  return error instanceof Error
    ? error.message
    : "Camera could not be started.";
}

/** Draws the bitmap scaled to `longestSide` on a white canvas with a quiet-zone border; crops and screenshots often have none. */
function drawScaled(bitmap: ImageBitmap, longestSide: number, padding = 0) {
  const scale = longestSide / Math.max(bitmap.width, bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const pad = Math.round(longestSide * padding);
  const canvas = document.createElement("canvas");
  canvas.width = width + pad * 2;
  canvas.height = height + pad * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not process selected image.");
  context.fillStyle = "#fff"; // transparent PNGs would otherwise decode as black
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, pad, pad, width, height);
  return canvas;
}

type NativeBarcodeDetector = {
  detect: (source: ImageBitmapSource) => Promise<{ rawValue: string }[]>;
};

/** The browser's built-in detector (Chrome/Android, Safari) copes with dense and blurry codes better than ZXing. */
async function decodeWithNativeDetector(bitmap: ImageBitmap): Promise<string | null> {
  const Detector = (
    window as unknown as {
      BarcodeDetector?: new (options?: { formats?: string[] }) => NativeBarcodeDetector;
    }
  ).BarcodeDetector;
  if (!Detector) return null;
  try {
    const detector = new Detector({
      formats: ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a"],
    });
    const found = await detector.detect(bitmap);
    return found.find((item) => item.rawValue)?.rawValue ?? null;
  } catch {
    return null;
  }
}

/** Tries native detection, then ZXing at several sizes and quiet-zone paddings. */
async function decodeImageFile(file: File): Promise<string> {
  const reader = createReader();
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = null;
  }

  if (!bitmap) {
    const imageUrl = URL.createObjectURL(file);
    try {
      return (await reader.decodeFromImageUrl(imageUrl)).getText();
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  }

  try {
    const native = await decodeWithNativeDetector(bitmap);
    if (native) return native;

    const longest = Math.max(bitmap.width, bitmap.height);
    const sizes = [...new Set([Math.min(longest, 2400), 1600, 1000, 2400, 800])];
    let lastError: unknown = new Error("No barcode found.");
    for (const padding of [0.08, 0]) {
      for (const size of sizes) {
        try {
          return reader.decodeFromCanvas(drawScaled(bitmap, size, padding)).getText();
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError;
  } finally {
    bitmap.close();
  }
}

export function AgentBarcodeScanner({
  onClose,
  onDetected,
}: AgentBarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDetectedRef = useRef(onDetected);
  const [manualCode, setManualCode] = useState("");
  const [scanError, setScanError] = useState("");
  const [isDecodingImage, setIsDecodingImage] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">(
    "environment",
  );

  // Keep the latest callback without restarting the camera when the parent re-renders.
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    if (isDecodingImage) return;
    const video = videoRef.current;
    if (!video) return;

    const unavailable = cameraUnavailableMessage();
    if (unavailable) {
      setScanError(unavailable);
      return;
    }

    const reader = createReader();
    let active = true;
    let stopScanner: (() => void) | undefined;

    reader
      .decodeFromConstraints(
        {
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        },
        video,
        (result, _error, controls) => {
          if (!active || !result) return;
          active = false;
          controls.stop();
          onDetectedRef.current(result.getText().trim());
        },
      )
      .then((controls) => {
        stopScanner = controls.stop;
        if (!active) controls.stop();
      })
      .catch((error: unknown) => {
        if (active) setScanError(cameraStartMessage(error));
      });

    return () => {
      active = false;
      stopScanner?.();
    };
  }, [facingMode, isDecodingImage]);

  const handleImageSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.type && !file.type.startsWith("image/")) {
      setScanError("Choose an image file to scan.");
      return;
    }

    setScanError("");
    setIsDecodingImage(true);
    try {
      const code = (await decodeImageFile(file)).trim();
      onDetectedRef.current(code);
    } catch {
      setScanError(
        "Could not read a code in that image. Use a sharp, well-lit photo with the whole code in frame, or enter the code manually.",
      );
    } finally {
      setIsDecodingImage(false);
    }
  };

  const submitManualCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = manualCode.trim();
    if (code) onDetected(code);
  };

  return (
    <div className="fixed inset-x-0 bottom-16 top-16 z-30 flex flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pb-4 pt-5">
        <p className="font-rajdhani text-xl font-bold">Barcode Scanner</p>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={() => {
              setScanError("");
              setFacingMode((current) =>
                current === "environment" ? "user" : "environment",
              );
            }}
            disabled={isDecodingImage}
            aria-label={`Switch to ${facingMode === "environment" ? "front" : "rear"} camera`}
            variant="ghost"
            className="gap-2 bg-white/10 text-white hover:bg-white/20 hover:text-white"
          >
            <SwitchCamera size={18} />
            {facingMode === "environment" ? "Rear" : "Front"}
          </Button>
          <Button
            type="button"
            onClick={onClose}
            aria-label="Close scanner"
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white"
          >
            <X size={24} aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-6 py-4">
        <div className="relative w-full max-w-md overflow-hidden rounded-xl border-2 border-accent-2 bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="aspect-[4/3] w-full object-cover"
          />
          <div className="pointer-events-none absolute inset-[15%] rounded-xl border-2 border-white/90 shadow-[0_0_0_999px_hsl(var(--foreground)/0.25)]" />
        </div>
        <p className="max-w-md text-center text-sm text-white/80">
          {isDecodingImage
            ? "Scanning selected image…"
            : `Point the ${facingMode === "environment" ? "rear" : "front"} camera at a pallet or order code.`}
        </p>
        {scanError && (
          <p
            role="alert"
            className="max-w-md text-center text-sm text-destructive"
          >
            {scanError}
          </p>
        )}
        <form
          onSubmit={submitManualCode}
          className="flex w-full max-w-md items-center gap-2"
        >
          <Input
            value={manualCode}
            onChange={(event) => setManualCode(event.target.value)}
            aria-label="Enter barcode manually"
            placeholder="Enter barcode or order code"
            className="min-w-0 flex-1 rounded-lg border border-white/30 bg-card px-3 py-2 text-sm text-foreground placeholder:text-foreground/80 dark:placeholder:text-foreground/70"
          />
          <Input
            type="file"
            accept="image/*"
            aria-label="Choose barcode image"
            disabled={isDecodingImage}
            onChange={handleImageSelect}
            className="peer sr-only"
            id="barcode-image-input"
          />
          <label
            htmlFor="barcode-image-input"
            title="Choose barcode image"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/30 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-2 ${isDecodingImage ? "pointer-events-none opacity-50" : "cursor-pointer hover:bg-card/10"}`}
          >
            <Folder size={18} aria-hidden="true" />
            <span className="sr-only">Choose barcode image</span>
          </label>
          <Button type="submit" variant="accent" disabled={!manualCode.trim()}>
            Search
          </Button>
        </form>
      </div>
    </div>
  );
}
