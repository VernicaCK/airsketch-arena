// Grab the elements we need from the page
const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const canvasCtx = canvas.getContext("2d");
const errorMessage = document.getElementById("error-message");

// ---------- Step 1: Set up MediaPipe Hands ----------
// This creates the hand-detection model and configures it.
const hands = new Hands({
  // Tells MediaPipe where to download its internal model files from
  locateFile: (file) =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});

hands.setOptions({
  maxNumHands: 1, // We only want to detect one hand
  modelComplexity: 1, // Balance between speed and accuracy
  minDetectionConfidence: 0.5, // How sure it must be to count as "detected"
  minTrackingConfidence: 0.5, // How sure it must be to keep tracking
});

// Whenever MediaPipe finishes analyzing a frame, this function runs
hands.onResults(onResults);

// This keeps track of the fingertip's last DRAWN position.
// null means "we weren't drawing last frame" (hand missing or finger folded).
let lastPoint = null;

// This keeps track of the last SMOOTHED position, used to reduce jitter.
// It's separate from lastPoint because we still want to smooth even
// across frames where we're not actively drawing a line.
let smoothedPoint = null;

// A short history of recent smoothed points. We use this to draw
// curves instead of straight segments, which makes the line look
// noticeably smoother without adding any extra delay.
let recentPoints = [];

// How much we trust the new raw position vs. the previous smoothed one.
// Lower = smoother but more "lag". Higher = snappier but more jittery.
// 0.4 is a sweet spot: enough smoothing to remove jitter, while still
// feeling responsive (no noticeable delay between moving and drawing).
const SMOOTHING_FACTOR = 0.4;

// Fixed visual style for the stroke, defined once so every segment
// we draw looks identical (consistent thickness, clean rounded ends).
const STROKE_COLOR = "#2cb67d"; // theme green
const STROKE_WIDTH = 4;

// ---------- Helper: midpoint between two points ----------
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// ---------- Helper: is the index finger extended (straight)? ----------
// We compare two distances from the wrist (landmark 0):
//   - distance to the index FINGERTIP (landmark 8)
//   - distance to the index finger's MIDDLE joint, the PIP (landmark 6)
// When the finger is straight, the tip is much farther from the wrist
// than the middle joint is. When the finger is folded/bent, the tip
// curls back in and ends up close to (or even closer than) the middle
// joint. Using distance-from-wrist (instead of just comparing Y values)
// means this still works even if the hand is tilted or rotated.
function isIndexFingerExtended(landmarks) {
  const wrist = landmarks[0];
  const pip = landmarks[6]; // middle joint of the index finger
  const tip = landmarks[8]; // index fingertip

  const distance = (a, b) =>
    Math.hypot(a.x - b.x, a.y - b.y); // simple straight-line distance

  const wristToTip = distance(wrist, tip);
  const wristToPip = distance(wrist, pip);

  // If the tip is noticeably farther from the wrist than the middle
  // joint is, we consider the finger "extended". The 1.2x margin avoids
  // false positives from small natural hand wobble.
  return wristToTip > wristToPip * 1.2;
}

// ---------- Step 2: Draw the results on the canvas ----------
function onResults(results) {
  // Note: we no longer clear or resize the canvas here.
  // Resizing/clearing every frame would erase the drawing we've
  // already made, so canvas setup now happens once in startDetectionLoop().

  const handFound =
    results.multiHandLandmarks && results.multiHandLandmarks.length > 0;

  if (handFound) {
    const landmarks = results.multiHandLandmarks[0];
    const indexFingertip = landmarks[8];

    // Landmark coordinates are normalized (0 to 1), so we multiply
    // by the canvas size to get the actual pixel position.
    const rawX = indexFingertip.x * canvas.width;
    const rawY = indexFingertip.y * canvas.height;

    // ---- Step A: Smoothing (exponential smoothing) ----
    // Instead of jumping straight to the new raw position, we move
    // partway from the last smoothed position toward it. This removes
    // small jittery movements while still tracking the real motion
    // closely, so there's no noticeable lag.
    if (!smoothedPoint) {
      smoothedPoint = { x: rawX, y: rawY };
    } else {
      smoothedPoint = {
        x: smoothedPoint.x + (rawX - smoothedPoint.x) * SMOOTHING_FACTOR,
        y: smoothedPoint.y + (rawY - smoothedPoint.y) * SMOOTHING_FACTOR,
      };
    }

    // ---- Only draw if the index finger is extended ----
    if (isIndexFingerExtended(landmarks)) {
      // Keep a short history of the last 3 smoothed points.
      recentPoints.push({ x: smoothedPoint.x, y: smoothedPoint.y });
      if (recentPoints.length > 3) recentPoints.shift();

      // ---- Step B: Curve smoothing ----
      // With 3 points (older -> middle -> newest), instead of drawing
      // two sharp straight segments, we draw ONE curve that bends
      // through the middle point. We do this by drawing a quadratic
      // curve between the midpoints of each pair, using the middle
      // point as the curve's "control point". This rounds off sharp
      // corners and makes the stroke look hand-drawn and smooth,
      // instead of jagged and segmented.
      if (recentPoints.length === 3 && lastPoint) {
        const [p1, p2, p3] = recentPoints;
        const startMid = midpoint(p1, p2);
        const endMid = midpoint(p2, p3);

        canvasCtx.beginPath();
        canvasCtx.moveTo(startMid.x, startMid.y);
        canvasCtx.quadraticCurveTo(p2.x, p2.y, endMid.x, endMid.y);
        canvasCtx.strokeStyle = STROKE_COLOR;
        canvasCtx.lineWidth = STROKE_WIDTH;
        canvasCtx.lineCap = "round";
        canvasCtx.lineJoin = "round";
        canvasCtx.stroke();
      }

      lastPoint = { x: smoothedPoint.x, y: smoothedPoint.y };
    } else {
      // Finger is folded: stop drawing, but keep what's already drawn.
      lastPoint = null;
      recentPoints = [];
    }
  } else {
    // No hand detected this frame. Forget all tracked points so that,
    // when the hand reappears, we don't draw a line across the gap.
    lastPoint = null;
    smoothedPoint = null;
    recentPoints = [];
  }
}

// ---------- Step 3: Start the webcam (same as Milestone 1) ----------
async function startWebcam() {
  try {
    // Ask the browser for permission to use the webcam
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
    });

    video.srcObject = stream;

    // Once the video is ready, start sending its frames to MediaPipe
    video.addEventListener("loadeddata", startDetectionLoop);
  } catch (error) {
    console.error("Webcam error:", error);
    showError();
  }
}

// ---------- Step 4: Feed video frames to MediaPipe, frame by frame ----------
function startDetectionLoop() {
  // Set the canvas size to match the video, ONCE.
  // We do this here (not in onResults) so that drawing the line
  // doesn't get wiped by a resize on every single frame.
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  // requestAnimationFrame keeps this loop running smoothly,
  // matching the browser's natural refresh rate.
  async function detectFrame() {
    await hands.send({ image: video });
    requestAnimationFrame(detectFrame);
  }
  detectFrame();
}

// Show the friendly error message and hide the video box
function showError() {
  video.classList.add("hidden");
  canvas.classList.add("hidden");
  errorMessage.classList.remove("hidden");
}

// Run the function as soon as the page loads
startWebcam();