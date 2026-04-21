import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.3/+esm";

const CONTRACT_ADDRESS = "0x6807B8D9359E9AD03931715054b4d1500d3B2348";
const RPC_URL = "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha";
const BUFFER_SIZE = 360;
const POLL_INTERVAL_MS = 1000;
const MAX_PENDING_CHUNKS = 24;

const ABI = [
  "function getLatestIndex() view returns (uint256)",
  "function getChunk(uint256) view returns (uint256, uint256, bytes)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

const video = document.getElementById("video");
const status = document.getElementById("status");

const mediaSource = new MediaSource();
video.src = URL.createObjectURL(mediaSource);

let nextChunkIndex = 0;
let lastAppendedChunkIndex = -1;
let stopped = false;
const pendingChunks = [];

function updateStatus(message) {
  status.textContent = message;
}

function appendNextChunk(sourceBuffer) {
  if (stopped || video.error || sourceBuffer.updating || pendingChunks.length === 0) {
    return;
  }

  const { index, chunk } = pendingChunks.shift();
  try {
    sourceBuffer.appendBuffer(chunk);
    lastAppendedChunkIndex = index;
    updateStatus(`Playing chunk ${index}`);
  } catch (err) {
    stopped = true;
    pendingChunks.length = 0;
    updateStatus(`Playback stopped while appending chunk ${index}: ${err.message}`);
    console.error(err);
  }
}

function isUnavailableChunkError(err) {
  return (
    err?.code === "BAD_DATA" ||
    (
      typeof err?.message === "string" &&
      (
        err.message.includes("could not decode result data") ||
        err.message.includes("overwritten")
      )
    )
  );
}

mediaSource.addEventListener("sourceopen", () => {
  const mime = 'video/mp4; codecs="avc1.64001f, mp4a.40.2"';
  if (!MediaSource.isTypeSupported(mime)) {
    stopped = true;
    updateStatus(`Browser does not support ${mime}`);
    return;
  }

  const sourceBuffer = mediaSource.addSourceBuffer(mime);

  video.addEventListener("error", () => {
    stopped = true;
    pendingChunks.length = 0;
    updateStatus(`Video decoder error: ${video.error?.message ?? "media could not be decoded"}`);
  });

  sourceBuffer.addEventListener("error", () => {
    stopped = true;
    pendingChunks.length = 0;
    updateStatus("SourceBuffer error while decoding stream.");
  });

  sourceBuffer.addEventListener("updateend", () => {
    appendNextChunk(sourceBuffer);
  });

  updateStatus("Waiting for stream...");

  async function fetchLoop() {
    if (stopped) {
      return;
    }

    try {
      const latestIndex = Number(await contract.getLatestIndex());
      const oldestAvailableIndex = Math.max(0, latestIndex - BUFFER_SIZE);

      if (nextChunkIndex < oldestAvailableIndex) {
        pendingChunks.length = 0;
        nextChunkIndex = oldestAvailableIndex;
        lastAppendedChunkIndex = oldestAvailableIndex - 1;
        updateStatus(`Catching up to live stream at chunk ${oldestAvailableIndex}`);
      }

      while (nextChunkIndex < latestIndex && pendingChunks.length < MAX_PENDING_CHUNKS) {
        try {
          const currentIndex = nextChunkIndex;
          const [, , data] = await contract.getChunk(currentIndex);
          pendingChunks.push({
            index: currentIndex,
          chunk: new Uint8Array(ethers.getBytes(data))
          });
          nextChunkIndex = currentIndex + 1;
        } catch (err) {
          if (isUnavailableChunkError(err)) {
            pendingChunks.length = 0;
            nextChunkIndex = latestIndex;
            lastAppendedChunkIndex = latestIndex - 1;
            updateStatus(
              `Chunk ${currentIndex} is not readable from RPC. ` +
              "The contract has indexed chunks, but raw on-chain video payload fetch returned empty data."
            );
            break;
          }

          throw err;
        }
      }

      appendNextChunk(sourceBuffer);

      if (latestIndex === 0) {
        updateStatus("Waiting for first chunk...");
      } else if (pendingChunks.length === 0 && lastAppendedChunkIndex >= 0) {
        updateStatus(`Buffered through chunk ${lastAppendedChunkIndex}`);
      }
    } catch (err) {
      updateStatus(`Error: ${err.message}`);
      console.error(err);
    }

    if (!stopped) {
      setTimeout(fetchLoop, POLL_INTERVAL_MS);
    }
  }

  fetchLoop();
});
