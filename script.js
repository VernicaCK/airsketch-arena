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

// ---------- Step 2: Draw the results on the canvas ----------
function onResults(results) {
  // Make sure the canvas is the same size as the video
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  // Clear the previous frame's drawing
  canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

  // If MediaPipe found at least one hand, draw its landmarks
  if (results.multiHandLandmarks) {
    for (const landmarks of results.multiHandLandmarks) {
      // Draws the lines connecting the 21 landmarks (the "hand skeleton")
      drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {
        color: "#2cb67d",
        lineWidth: 3,
      });
      // Draws each of the 21 landmark points as small dots
      drawLandmarks(canvasCtx, landmarks, {
        color: "#7f5af0",
        lineWidth: 1,
        radius: 4,
      });
    }
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
