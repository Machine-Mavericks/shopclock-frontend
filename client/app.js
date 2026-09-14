import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";

const STORAGE_KEY = "shopclock.credential.v2";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 8;

const enrollmentView = document.querySelector("#enrollment-view");
const codeView = document.querySelector("#code-view");
const enrollmentForm = document.querySelector("#enrollment-form");

const displayName = document.querySelector("#display-name");
const displayUuid = document.querySelector("#display-uuid");
const qrCanvas = document.querySelector("#qr-code");
const countdownElement = document.querySelector("#countdown");
const removeButton = document.querySelector("#remove-credential");
const statusElement = document.querySelector("#status");
const connectionStatus = document.querySelector("#connection-status");
const scanEnrollmentButton = document.querySelector("#scan-enrollment");
const scannerDialog = document.querySelector("#scanner-dialog");
const scannerVideo = document.querySelector("#scanner-video");
const scannerHelp = document.querySelector("#scanner-help");
const closeScannerButton = document.querySelector("#close-scanner");

const scannerCanvas = document.createElement("canvas");
const scannerContext = scannerCanvas.getContext("2d", {
  willReadFrequently: true,
});
let scannerStream = null;
let scannerAnimationFrame = null;
let processingScan = false;

let credential = loadCredential();
let lastCounter = null;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./service-worker.js");
    } catch (error) {
      console.error("Service worker registration failed:", error);
    }
  });
}

enrollmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideStatus();

  const formData = new FormData(enrollmentForm);

  try {
    await saveCredential({
      studentName: String(
        formData.get("studentName") ?? ""
      ),
      uuid: String(
        formData.get("studentUuid") ?? ""
      ),
      secret: String(
        formData.get("studentSecret") ?? ""
      ),
    });

    enrollmentForm.reset();
  } catch (error) {
    showStatus(
      error instanceof Error
        ? error.message
        : "Unable to save credential."
    );
  }
});

removeButton.addEventListener("click", () => {
  const confirmed = window.confirm(
    "Remove the ShopClock credential from this device?"
  );

  if (!confirmed) {
    return;
  }

  localStorage.removeItem(STORAGE_KEY);

  credential = null;
  lastCounter = null;

  render();
});

window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);

scanEnrollmentButton.addEventListener(
  "click",
  startEnrollmentScanner
);

closeScannerButton.addEventListener(
  "click",
  stopEnrollmentScanner
);

scannerDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  stopEnrollmentScanner();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && scannerStream) {
    stopEnrollmentScanner();
  }
});

setInterval(() => {
  updateCode().catch((error) => {
    console.error(error);
    showStatus("Unable to generate the rotating code.");
  });
}, 250);

updateConnectionStatus();
render();

async function render() {
  hideStatus();

  if (!credential) {
    enrollmentView.hidden = false;
    codeView.hidden = true;
    return;
  }

  enrollmentView.hidden = true;
  codeView.hidden = false;

  displayName.textContent = credential.studentName;
  displayUuid.textContent = credential.uuid;

  await updateCode();
}

async function updateCode() {
  if (!credential) {
    return;
  }

  const unixSeconds = Math.floor(Date.now() / 1000);
  const counter = Math.floor(unixSeconds / TOTP_PERIOD_SECONDS);
  const remaining =
    TOTP_PERIOD_SECONDS - (unixSeconds % TOTP_PERIOD_SECONDS);

  countdownElement.textContent = String(remaining);

  if (counter === lastCounter) {
    return;
  }

  lastCounter = counter;

  const totp = await generateTotp(credential.secret, counter);
  const payload = `shopclock:${credential.uuid}:${totp}`;

  await QRCode.toCanvas(qrCanvas, payload, {
    width: 512,
    margin: 2,
    errorCorrectionLevel: "M",
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });
}

async function generateTotp(
  base32Secret,
  counter = Math.floor(
    Date.now() / 1000 / TOTP_PERIOD_SECONDS
  )
) {
  const secretBytes = decodeBase32(base32Secret);
  const counterBytes = counterToBytes(counter);

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counterBytes)
  );

  const offset = signature[signature.length - 1] & 0x0f;

  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(
    TOTP_DIGITS,
    "0"
  );
}

function counterToBytes(counter) {
  let value = BigInt(counter);
  const bytes = new Uint8Array(8);

  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }

  return bytes;
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = normalizeBase32(value).replace(/=+$/g, "");

  let bits = 0;
  let buffer = 0;

  const bytes = [];

  for (const character of normalized) {
    const alphabetIndex = alphabet.indexOf(character);

    if (alphabetIndex === -1) {
      throw new Error("The TOTP secret is not valid Base32.");
    }

    buffer = (buffer << 5) | alphabetIndex;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  if (bytes.length === 0) {
    throw new Error("The TOTP secret cannot be empty.");
  }

  return new Uint8Array(bytes);
}

function normalizeBase32(value) {
  return value
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

function validateCredential({ studentName, uuid, secret }) {
  if (!studentName) {
    throw new Error("Enter the student’s name.");
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(uuid)) {
    throw new Error("Enter a valid student UUID.");
  }

  if (!/^[A-Z2-7]+=*$/.test(secret)) {
    throw new Error("Enter a valid Base32 TOTP secret.");
  }
}

async function saveCredential({
  studentName,
  uuid,
  secret,
}) {
  const nextCredential = {
    studentName: studentName.trim(),
    uuid: uuid.trim().toLowerCase(),
    secret: normalizeBase32(secret),
  };

  validateCredential(nextCredential);

  // Ensure the supplied secret can generate a valid TOTP.
  await generateTotp(nextCredential.secret);

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(nextCredential)
  );

  credential = nextCredential;
  lastCounter = null;

  await render();
}

async function startEnrollmentScanner() {
  hideStatus();

  if (!window.jsQR) {
    showStatus("The QR scanner could not be loaded.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showStatus(
      "Camera access is not supported by this browser."
    );
    return;
  }

  try {
    scannerHelp.textContent =
      "Point the camera at the ShopClock enrollment QR.";

    scannerDialog.showModal();

    scannerStream =
      await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: {
            ideal: "environment",
          },
        },
      });

    scannerVideo.srcObject = scannerStream;
    await scannerVideo.play();

    processingScan = false;

    scannerAnimationFrame =
      requestAnimationFrame(scanEnrollmentFrame);
  } catch (error) {
    console.error("Unable to start camera:", error);

    stopEnrollmentScanner();

    showStatus(
      "Unable to access the camera. Check the browser’s camera permission."
    );
  }
}

async function scanEnrollmentFrame() {
  if (!scannerStream) {
    return;
  }

  if (
    !processingScan &&
    scannerVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    scannerVideo.videoWidth > 0 &&
    scannerVideo.videoHeight > 0
  ) {
    scannerCanvas.width = scannerVideo.videoWidth;
    scannerCanvas.height = scannerVideo.videoHeight;

    scannerContext.drawImage(
      scannerVideo,
      0,
      0,
      scannerCanvas.width,
      scannerCanvas.height
    );

    const image = scannerContext.getImageData(
      0,
      0,
      scannerCanvas.width,
      scannerCanvas.height
    );

    const result = window.jsQR(
      image.data,
      image.width,
      image.height,
      {
        inversionAttempts: "dontInvert",
      }
    );

    if (result?.data) {
      processingScan = true;

      try {
        const scannedCredential =
          parseEnrollmentCode(result.data);

        await saveCredential(scannedCredential);

        stopEnrollmentScanner();
        return;
      } catch (error) {
        scannerHelp.textContent =
          error instanceof Error
            ? error.message
            : "That is not a valid enrollment QR.";

        processingScan = false;
      }
    }
  }

  scannerAnimationFrame =
    requestAnimationFrame(scanEnrollmentFrame);
}

function stopEnrollmentScanner() {
  if (scannerAnimationFrame !== null) {
    cancelAnimationFrame(scannerAnimationFrame);
    scannerAnimationFrame = null;
  }

  if (scannerStream) {
    for (const track of scannerStream.getTracks()) {
      track.stop();
    }

    scannerStream = null;
  }

  scannerVideo.pause();
  scannerVideo.srcObject = null;
  processingScan = false;

  if (scannerDialog.open) {
    scannerDialog.close();
  }
}

function parseEnrollmentCode(scannedValue) {
  const prefix = "shopclock-enroll:";

  if (!scannedValue.startsWith(prefix)) {
    throw new Error(
      "This QR code is not a ShopClock enrollment code."
    );
  }

  const encodedPayload = scannedValue.slice(prefix.length);

  if (!encodedPayload || encodedPayload.length > 4096) {
    throw new Error("The enrollment code is invalid.");
  }

  let payload;

  try {
    const base64 = encodedPayload
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const paddedBase64 = base64.padEnd(
      Math.ceil(base64.length / 4) * 4,
      "="
    );

    const binary = atob(paddedBase64);

    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0)
    );

    payload = JSON.parse(
      new TextDecoder().decode(bytes)
    );
  } catch {
    throw new Error(
      "The enrollment QR contains invalid data."
    );
  }

  if (payload?.v !== 1) {
    throw new Error(
      "This enrollment QR version is not supported."
    );
  }

  return {
    studentName: String(payload.name ?? ""),
    uuid: String(payload.uuid ?? ""),
    secret: String(payload.secret ?? ""),
  };
}

function loadCredential() {
  try {
    const storedValue = localStorage.getItem(STORAGE_KEY);

    if (!storedValue) {
      return null;
    }

    const storedCredential = JSON.parse(storedValue);

    validateCredential(storedCredential);

    return storedCredential;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function updateConnectionStatus() {
  connectionStatus.textContent = navigator.onLine
    ? "Online"
    : "Offline — rotating codes remain available";
}

function showStatus(message) {
  statusElement.textContent = message;
  statusElement.hidden = false;
}

function hideStatus() {
  statusElement.hidden = true;
  statusElement.textContent = "";
}