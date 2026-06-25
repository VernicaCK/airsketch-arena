// Grab the elements we need from the page
const video = document.getElementById("webcam");
const errorMessage = document.getElementById("error-message");

// Ask the browser for access to the user's webcam
async function startWebcam() {
  try {
    // navigator.mediaDevices.getUserMedia asks the browser for permission
    // and gives us back a "stream" of video data if granted.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true, // we only need video, no audio
    });

    // Set the video element's source to our webcam stream
    video.srcObject = stream;
  } catch (error) {
    // This runs if the user denies permission, or no camera is found
    console.error("Webcam error:", error);
    showError();
  }
}

// Show the friendly error message and hide the video box
function showError() {
  video.classList.add("hidden");
  errorMessage.classList.remove("hidden");
}

// Run the function as soon as the page loads
startWebcam();
