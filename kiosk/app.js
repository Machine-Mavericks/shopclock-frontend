const CONFIG_STORAGE_KEY = "shopclock.kiosk-config.v2";

const QR_PAYLOAD_PATTERN =
  /^shopclock:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:\d{8}$/i;

const STATIC_CODE_PATTERN = /^shopclock-static:.+$/;

const SAME_CODE_SUPPRESS_MS = 35_000;
const RESULT_DISPLAY_MS = 4000;
const ERROR_DISPLAY_MS = 5000;
const FETCH_TIMEOUT_MS = 8000;
const DUPLICATE_HINT_DISPLAY_MS = 2500;

const STATE = Object.freeze({
  SETUP: "setup",
  SCANNING: "scanning",
  SUBMITTING: "submitting",
  RESULT: "result",
  ERROR: "error",
});

class PunchError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "PunchError";
    this.code = code;
  }
}

const setupView = document.querySelector("#setup-view");
const scannerView = document.querySelector("#scanner-view");
const resultView = document.querySelector("#result-view");
const errorView = document.querySelector("#error-view");

const allViews = [setupView, scannerView, resultView, errorView];

const viewForState = {
  [STATE.SETUP]: setupView,
  [STATE.SCANNING]: scannerView,
  [STATE.SUBMITTING]: scannerView,
  [STATE.RESULT]: resultView,
  [STATE.ERROR]: errorView,
};

const setupForm = document.querySelector("#setup-form");
const backendUrlInput = document.querySelector("#backend-url");
const setupStatus = document.querySelector("#setup-status");

const scannerVideo = document.querySelector("#scanner-video");
const cameraErrorMessage = document.querySelector("#camera-error-message");
const duplicateScanMessage = document.querySelector("#duplicate-scan-message");

const resultBadge = document.querySelector("#result-badge");
const resultDirectionLabel = document.querySelector("#result-direction-label");
const resultName = document.querySelector("#result-name");
const resultTime = document.querySelector("#result-time");

const errorMessage = document.querySelector("#error-message");

const settingsButton = document.querySelector("#settings-button");
const connectionBadge = document.querySelector("#connection-badge");

const scannerCanvas = document.createElement("canvas");
const scannerContext = scannerCanvas.getContext("2d", {
  willReadFrequently: true,
});

let scannerStream = null;
let scannerAnimationFrame = null;

let config = loadConfig();
let currentState = config ? STATE.SCANNING : STATE.SETUP;

let lastSubmittedCode = null;
let lastSubmittedAt = 0;
let returnTimer = null;
let duplicateHintTimer = null;

setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  hideSetupStatus();

  const formData = new FormData(setupForm);

  try {
    saveConfig({ backendUrl: String(formData.get("backendUrl") ?? "") });
  } catch (error) {
    showSetupStatus(
      error instanceof Error ? error.message : "Unable to save the endpoint URL."
    );
  }
});

settingsButton.addEventListener("click", openSettings);

window.addEventListener("online", updateConnectionBadge);
window.addEventListener("offline", updateConnectionBadge);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopCamera();
    return;
  }

  if (
    !scannerStream &&
    (currentState === STATE.SCANNING ||
      currentState === STATE.SUBMITTING ||
      currentState === STATE.RESULT ||
      currentState === STATE.ERROR)
  ) {
    startCamera();
  }
});

updateConnectionBadge();
render();

if (currentState === STATE.SCANNING) {
  startCamera();
}

function render() {
  const activeView = viewForState[currentState];

  for (const view of allViews) {
    view.hidden = view !== activeView;
  }
}

function setState(nextState) {
  currentState = nextState;
  render();
}

function scheduleReturnToScanning(ms) {
  clearTimeout(returnTimer);
  returnTimer = setTimeout(() => setState(STATE.SCANNING), ms);
}

/* Config (setup screen) */

function validateConfig({ backendUrl }) {
  let parsed;

  try {
    parsed = new URL(backendUrl);
  } catch {
    throw new Error("Enter a valid endpoint URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The endpoint URL must use http or https.");
  }
}

function loadConfig() {
  try {
    const storedValue = localStorage.getItem(CONFIG_STORAGE_KEY);

    if (!storedValue) {
      return null;
    }

    const storedConfig = JSON.parse(storedValue);

    validateConfig(storedConfig);

    return storedConfig;
  } catch {
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    return null;
  }
}

function saveConfig({ backendUrl }) {
  const nextConfig = { backendUrl: backendUrl.trim() };

  validateConfig(nextConfig);

  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(nextConfig));

  config = nextConfig;
  setupForm.reset();

  setState(STATE.SCANNING);
  startCamera();
}

function openSettings() {
  if (currentState === STATE.SETUP) {
    return;
  }

  stopCamera();
  clearTimeout(returnTimer);

  if (config) {
    backendUrlInput.value = config.backendUrl;
  }

  setState(STATE.SETUP);
}

/* Camera / scanning */

async function startCamera() {
  hideCameraError();

  if (!window.jsQR) {
    showCameraError("The QR scanner could not be loaded.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError("Camera access is not supported by this browser.");
    return;
  }

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: {
          ideal: "environment",
        },
      },
    });

    scannerVideo.srcObject = scannerStream;
    await scannerVideo.play();

    scannerAnimationFrame = requestAnimationFrame(scanFrame);
  } catch (error) {
    console.error("Unable to start camera:", error);

    stopCamera();

    showCameraError(
      "Unable to access the camera. Check the browser's camera permission."
    );
  }
}

function stopCamera() {
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

  hideDuplicateHint();
}

function scanFrame() {
  if (!scannerStream) {
    return;
  }

  if (
    currentState === STATE.SCANNING &&
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

    const result = window.jsQR(image.data, image.width, image.height, {
      inversionAttempts: "dontInvert",
    });

    if (result?.data) {
      handleScan(result.data);
    }
  }

  scannerAnimationFrame = requestAnimationFrame(scanFrame);
}

function handleScan(scannedValue) {
  if (
    !QR_PAYLOAD_PATTERN.test(scannedValue) &&
    !STATIC_CODE_PATTERN.test(scannedValue)
  ) {
    return;
  }

  if (isSuppressed(scannedValue)) {
    showDuplicateHint();
    return;
  }

  hideDuplicateHint();

  lastSubmittedCode = scannedValue;
  lastSubmittedAt = Date.now();

  setState(STATE.SUBMITTING);

  submitPunch(scannedValue)
    .then((result) => showResult(result))
    .catch((error) => {
      console.error(error);
      showError(
        error instanceof PunchError
          ? error.message
          : "Unable to reach the ShopClock server."
      );
    });
}

function showDuplicateHint() {
  duplicateScanMessage.classList.add("visible");

  clearTimeout(duplicateHintTimer);
  duplicateHintTimer = setTimeout(hideDuplicateHint, DUPLICATE_HINT_DISPLAY_MS);
}

function hideDuplicateHint() {
  clearTimeout(duplicateHintTimer);
  duplicateScanMessage.classList.remove("visible");
}

function isSuppressed(code) {
  return (
    code === lastSubmittedCode &&
    Date.now() - lastSubmittedAt < SAME_CODE_SUPPRESS_MS
  );
}

/* Backend call */

async function submitPunch(code) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;

  try {
    response = await fetch(config.backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new PunchError(
      error?.name === "AbortError"
        ? "The request timed out. Check the kiosk's network connection."
        : "Can't reach the ShopClock server. Check the kiosk's network connection.",
      "network_error"
    );
  } finally {
    clearTimeout(timeout);
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    // Non-JSON or empty body — handled below.
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ??
      payload?.message ??
      `Request failed (${response.status}).`;

    throw new PunchError(message, payload?.error?.code ?? null);
  }

  if (
    !payload ||
    typeof payload.student?.fullName !== "string" ||
    typeof payload.timeIn !== "number"
  ) {
    throw new PunchError(
      "The kiosk received an unexpected response from the server.",
      "malformed_response"
    );
  }

  const direction = payload.timeOut != null ? "out" : "in";
  const timestamp = direction === "out" ? payload.timeOut : payload.timeIn;

  return {
    name: payload.student.fullName,
    direction,
    timestamp,
  };
}

/* Result / error display */

function showResult({ name, direction, timestamp }) {
  resultBadge.classList.remove("in", "out");
  resultBadge.classList.add(direction);
  resultDirectionLabel.textContent =
    direction === "in" ? "Punched In" : "Punched Out";

  resultName.textContent = name;
  resultTime.textContent = formatTimestamp(timestamp);

  setState(STATE.RESULT);
  scheduleReturnToScanning(RESULT_DISPLAY_MS);
}

function showError(message) {
  errorMessage.textContent = message;

  setState(STATE.ERROR);
  scheduleReturnToScanning(ERROR_DISPLAY_MS);
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/* Status helpers */

function showSetupStatus(message) {
  setupStatus.textContent = message;
  setupStatus.hidden = false;
}

function hideSetupStatus() {
  setupStatus.hidden = true;
  setupStatus.textContent = "";
}

function showCameraError(message) {
  cameraErrorMessage.textContent = message;
  cameraErrorMessage.hidden = false;
}

function hideCameraError() {
  cameraErrorMessage.hidden = true;
  cameraErrorMessage.textContent = "";
}

function updateConnectionBadge() {
  connectionBadge.hidden = navigator.onLine;
}
