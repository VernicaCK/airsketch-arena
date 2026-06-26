// Grab the elements we need from the page
const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const canvasCtx = canvas.getContext("2d");
const cursorCanvas = document.getElementById("cursor-overlay");
const cursorCtx = cursorCanvas.getContext("2d");
const errorMessage = document.getElementById("error-message");

// Toolbar elements
const colorSwatches = document.querySelectorAll(".color-swatch");
const eraserBtn = document.getElementById("eraser-btn");
const clearBtn = document.getElementById("clear-btn");

// All toolbar buttons together, so the fingertip-hover check can
// loop over every one of them (colors + eraser + clear) the same way.
const allToolbarButtons = [...colorSwatches, eraserBtn, clearBtn];

// ---------- Air toolbar selection state ----------
let hoveredButton = null; // the button the fingertip is currently over
let hoverStartTime = null; // timestamp when that hover began
const HOVER_DURATION_MS = 1000; // ~1 second to auto-activate
const HOVER_TOLERANCE_PX = 12; // small "buffer zone" added around each button

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
// currentColor changes when the user picks a swatch from the toolbar.
let currentColor = "#2cb67d"; // theme green, matches the default active swatch
let isErasing = false; // true while the eraser tool is selected
const STROKE_WIDTH = 4;

// ---------- Resizable eraser ----------
// The eraser size is controlled by the "pinch distance" between the
// thumb tip (landmark 4) and the index fingertip (landmark 8). We
// keep the radius in a variable (instead of a constant) so it can
// change in real time as the user pinches in/out.
let eraserRadius = 18; // starting size, in pixels
const MIN_ERASER_RADIUS = 8; // smallest the eraser can shrink to
const MAX_ERASER_RADIUS = 60; // largest the eraser can grow to
const ERASER_SMOOTHING = 0.3; // same idea as fingertip smoothing, but for size

// ---------- Eraser resize "lock" state ----------
// isResizingEraser is true ONLY while the user is actively performing
// the pinch gesture. Outside of that window, the size never changes,
// no matter how the hand moves - it stays locked at whatever it was.
let isResizingEraser = false;

// Two different thresholds (instead of one) create "hysteresis" - a
// gap between the start and stop triggers. This avoids flickering
// in/out of resize mode if the pinch distance sits right at one
// borderline value.
const RESIZE_ENGAGE_DISTANCE = 35; // bring thumb+index this close to START resizing
const RESIZE_RELEASE_DISTANCE = 130; // spread this far apart to FINISH and lock

// ---------- Toolbar wiring ----------
// Clicking a color swatch selects it for drawing and turns off the eraser.
colorSwatches.forEach((swatch) => {
  swatch.addEventListener("click", () => {
    currentColor = swatch.dataset.color;
    isErasing = false;

    // Update which swatch/button looks "active"
    colorSwatches.forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");
    eraserBtn.classList.remove("active");
  });
});

// Clicking the eraser switches to erase mode (toggle on/off)
eraserBtn.addEventListener("click", () => {
  isErasing = !isErasing;
  eraserBtn.classList.toggle("active", isErasing);
});

// Clicking "Clear Canvas" wipes only the drawing layer.
// (The video keeps playing underneath, untouched.)
clearBtn.addEventListener("click", () => {
  canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
});

// ---------- Helper: convert a fingertip canvas position to a real ----------
// ---------- on-screen (page) position, so we can test it against -------
// ---------- toolbar buttons' actual positions. --------------------------
// The canvas is mirrored with CSS (transform: scaleX(-1)), so a point at
// internal x=0 visually appears on the RIGHT edge of the canvas, and
// x=canvas.width appears on the LEFT edge. We flip the x-axis to account
// for that, then scale from canvas-pixel space into the canvas's actual
// rendered size on the page.
function fingertipToScreenPoint(x, y) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;

  const screenX = rect.left + rect.width - x * scaleX; // flipped for mirror
  const screenY = rect.top + y * scaleY;

  return { screenX, screenY };
}

// ---------- Helper: is a screen point inside a button's box, with a ----------
// ---------- small tolerance margin added around its edges? ------------------
// The tolerance makes selection feel more forgiving - the fingertip doesn't
// need to sit on the exact pixel edge of a button for it to still count.
function isPointInButton(screenX, screenY, button) {
  const rect = button.getBoundingClientRect();
  return (
    screenX >= rect.left - HOVER_TOLERANCE_PX &&
    screenX <= rect.right + HOVER_TOLERANCE_PX &&
    screenY >= rect.top - HOVER_TOLERANCE_PX &&
    screenY <= rect.bottom + HOVER_TOLERANCE_PX
  );
}

// ---------- Helper: check if the fingertip is hovering a toolbar button ----------
// Key idea for stability: we give the CURRENTLY hovered button priority.
// As long as the fingertip is still within its (tolerance-padded) box, we
// keep the timer running on it - we don't even look at other buttons. Only
// once the fingertip truly leaves that button's area do we search for a
// new one. This stops the cursor from "flickering" between two buttons
// that happen to sit close together.
function checkToolbarHover(screenX, screenY) {
  // 1. If we're already hovering a button, see if we're still inside it.
  if (hoveredButton && isPointInButton(screenX, screenY, hoveredButton)) {
    const elapsed = performance.now() - hoverStartTime;
    if (elapsed >= HOVER_DURATION_MS) {
      hoveredButton.click(); // triggers the same logic as a mouse click
      hoveredButton.classList.remove("finger-hover");
      hoveredButton = null;
      hoverStartTime = null;
    }
    return; // still on the same button - nothing else to do
  }

  // 2. We left the previous button (or never had one) - clear its highlight
  if (hoveredButton) {
    hoveredButton.classList.remove("finger-hover");
    hoveredButton = null;
    hoverStartTime = null;
  }

  // 3. Look for a new button under the fingertip, starting a fresh timer
  const target = allToolbarButtons.find((button) =>
    isPointInButton(screenX, screenY, button)
  );

  if (target) {
    hoveredButton = target;
    hoverStartTime = performance.now();
    target.classList.add("finger-hover");
  }
}
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// ---------- Helper: keep a number within a min/max range ----------
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ---------- Helper: update eraser size from the thumb-index pinch ----------
// distance (only while a resize gesture is active), and draw the ---------
// circular outline showing the exact erase area. --------------------------
// This runs every frame while the eraser tool is selected, so the
// circle always reflects the current locked/active size.
function updateEraserCursor(landmarks, fingertipX, fingertipY) {
  const thumbTip = landmarks[4]; // thumb tip
  const indexTip = landmarks[8]; // index fingertip (same point we draw with)

  // Measure the pinch distance in canvas-pixel space (not normalized
  // 0-1 space), so the size feels consistent regardless of math details.
  const dx = (thumbTip.x - indexTip.x) * canvas.width;
  const dy = (thumbTip.y - indexTip.y) * canvas.height;
  const pinchDistance = Math.hypot(dx, dy);

  // ---- Resize gesture lock/unlock ----
  if (!isResizingEraser && pinchDistance < RESIZE_ENGAGE_DISTANCE) {
    // Thumb and index just came close together - begin resizing.
    isResizingEraser = true;
  } else if (isResizingEraser && pinchDistance > RESIZE_RELEASE_DISTANCE) {
    // Hand has spread back out wide - the gesture is finished.
    // We simply stop updating eraserRadius here, which locks it at
    // whatever value it last reached.
    isResizingEraser = false;
  }

  // Only change the size while actively resizing. Otherwise, the
  // size variable is left completely untouched (locked).
  if (isResizingEraser) {
    const targetRadius = clamp(
      pinchDistance * 0.5,
      MIN_ERASER_RADIUS,
      MAX_ERASER_RADIUS
    );

    // Smooth the radius the same way we smooth position - move only
    // partway toward the target each frame, so resizing feels fluid
    // instead of snapping instantly on every small wobble.
    eraserRadius += (targetRadius - eraserRadius) * ERASER_SMOOTHING;
  }

  // Draw the outline circle at the fingertip. This ALWAYS uses the
  // current eraserRadius directly (locked or actively changing), and
  // is the exact same radius used for the real erasing below - so
  // the preview always matches the real erase area, pixel for pixel.
  cursorCtx.beginPath();
  cursorCtx.arc(fingertipX, fingertipY, eraserRadius, 0, 2 * Math.PI);
  cursorCtx.strokeStyle = isResizingEraser ? "#2cb67d" : "#ffffff";
  cursorCtx.lineWidth = 2;
  cursorCtx.stroke();
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

  // The cursor canvas only ever shows temporary info (the eraser
  // outline), so we clear it fresh every single frame - unlike the
  // main drawing canvas, this one should never accumulate anything.
  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

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

    // ---- Air toolbar selection: check this every frame, regardless ----
    // ---- of whether the finger is "extended" for drawing purposes. ----
    // We use smoothedPoint (not the raw rawX/rawY) here, since hover
    // detection benefits even more from stability than drawing does -
    // a jittery cursor could otherwise flicker across nearby buttons.
    const { screenX, screenY } = fingertipToScreenPoint(
      smoothedPoint.x,
      smoothedPoint.y
    );
    checkToolbarHover(screenX, screenY);

    // ---- Eraser cursor: while the eraser is selected, show the ----
    // ---- circular outline and let pinch distance resize it. ----
    if (isErasing) {
      updateEraserCursor(landmarks, smoothedPoint.x, smoothedPoint.y);
    }

    // ---- Only draw if the index finger is extended AND it's not ----
    // ---- currently hovering a toolbar button (so selecting a color ----
    // ---- doesn't also draw a stroke underneath the toolbar). ----
    if (isIndexFingerExtended(landmarks) && !hoveredButton) {
      if (isErasing) {
        // ---- Erasing: stamp a filled circle every single frame ----
        // We intentionally do NOT reuse the curve-stroke logic used for
        // colored drawing below. A stroked path only erases along the
        // line itself, and needs at least a little motion (3 tracked
        // points) to draw anything - so holding the eraser still, or
        // using a very small radius, could fail to erase reliably.
        // Stamping a filled circle at the current position every frame
        // guarantees the erased area is always EXACTLY a circle of
        // eraserRadius, matching the preview outline pixel for pixel,
        // and it works correctly even with zero movement.
        canvasCtx.globalCompositeOperation = "destination-out";

        // If we have a previous position, also connect it to the
        // current one with a thick round-capped line. This fills any
        // gap between frames during fast hand movement - the line's
        // width exactly matches the circle's diameter, so it blends
        // seamlessly with the stamped circles instead of leaving a
        // thinner "tunnel" through the erased area.
        if (lastPoint) {
          canvasCtx.beginPath();
          canvasCtx.moveTo(lastPoint.x, lastPoint.y);
          canvasCtx.lineTo(smoothedPoint.x, smoothedPoint.y);
          canvasCtx.lineWidth = eraserRadius * 2;
          canvasCtx.lineCap = "round";
          canvasCtx.stroke();
        }

        canvasCtx.beginPath();
        canvasCtx.arc(
          smoothedPoint.x,
          smoothedPoint.y,
          eraserRadius,
          0,
          2 * Math.PI
        );
        canvasCtx.fill();

        lastPoint = { x: smoothedPoint.x, y: smoothedPoint.y };
      } else {
        // ---- Drawing with color: keep the existing curve-smoothing ----
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
          canvasCtx.globalCompositeOperation = "source-over";
          canvasCtx.strokeStyle = currentColor;
          canvasCtx.lineWidth = STROKE_WIDTH;
          canvasCtx.lineCap = "round";
          canvasCtx.lineJoin = "round";
          canvasCtx.stroke();
        }

        lastPoint = { x: smoothedPoint.x, y: smoothedPoint.y };
      }
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

    // Also clear any toolbar hover-highlight, since there's no
    // fingertip to be hovering with anymore.
    if (hoveredButton) hoveredButton.classList.remove("finger-hover");
    hoveredButton = null;
    hoverStartTime = null;
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

  // The cursor canvas must match the same size/coordinate space,
  // so the eraser outline lines up exactly with the drawing canvas.
  cursorCanvas.width = video.videoWidth;
  cursorCanvas.height = video.videoHeight;

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
  cursorCanvas.classList.add("hidden");
  errorMessage.classList.remove("hidden");
}

// Run the function as soon as the page loads
startWebcam();