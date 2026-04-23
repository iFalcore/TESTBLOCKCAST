import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.3/+esm";

const CONTRACT_ADDRESS = "0x6807B8D9359E9AD03931715054b4d1500d3B2348";
const RPC_URL = "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha";
const STREAM_ID = 1n;
const EVENT_SCAN_FROM_BLOCK = 1623931;
const LOG_BLOCK_WINDOW = 1900;
const POLL_INTERVAL_MS = 1000;
const MAX_PENDING_CHUNKS = 18;
const LIVE_BACKOFF_CHUNKS = 4;
const INIT_CHUNK_INDEX = 0;

const ABI = [
  "function getLatestIndex(uint256 id) view returns (uint256)",
  "event ChunkData(uint256 indexed id, uint256 indexed index, uint256 timestamp, bytes data)",
  "function streams(uint256 id) view returns (address creator, uint32 width, uint32 height, uint32 fps, uint32 chunkDurationMs, uint32 videoBitrateKbps, uint32 audioBitrateKbps, bool isLive, uint256 createdAt, uint256 totalChunks, string codec, string title)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
const chunkDataEvent = contract.interface.getEvent("ChunkData");

const video = document.getElementById("video");
const status = document.getElementById("status");
const detail = document.getElementById("detail");
const statContract = document.getElementById("stat-contract");
const statLatest = document.getElementById("stat-latest");
const statNext = document.getElementById("stat-next");
const statAppended = document.getElementById("stat-appended");
const statQueued = document.getElementById("stat-queued");
const statBuffer = document.getElementById("stat-buffer");
const retryButton = document.getElementById("retry-button");
const liveButton = document.getElementById("live-button");

const mime = 'video/mp4; codecs="avc1.64001f, mp4a.40.2"';
const mediaSource = new MediaSource();
const pendingChunks = [];

let sourceBuffer;
let nextChunkIndex = INIT_CHUNK_INDEX;
let latestKnownIndex = 0;
let lastAppendedChunkIndex = -1;
let currentAppend = null;
let hasInitSegment = false;
let stopped = false;
let pollTimer = null;

video.src = URL.createObjectURL(mediaSource);
statContract.textContent = `${CONTRACT_ADDRESS.slice(0, 6)}...${CONTRACT_ADDRESS.slice(-4)}`;

function updateStatus(message, tone = "info") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function updateDetail(message) {
  detail.textContent = message;
}

function getBufferedAheadSeconds() {
  if (video.buffered.length === 0) {
    return 0;
  }

  const currentTime = video.currentTime;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= currentTime && currentTime <= video.buffered.end(i)) {
      return Math.max(0, video.buffered.end(i) - currentTime);
    }
  }

  return Math.max(0, video.buffered.end(video.buffered.length - 1) - currentTime);
}

function renderStats() {
  statLatest.textContent = String(latestKnownIndex);
  statNext.textContent = String(nextChunkIndex);
  statAppended.textContent = lastAppendedChunkIndex >= 0 ? String(lastAppendedChunkIndex) : "-";
  statQueued.textContent = String(pendingChunks.length);
  statBuffer.textContent = `${getBufferedAheadSeconds().toFixed(1)}s`;
}

function schedulePoll(delay = POLL_INTERVAL_MS) {
  window.clearTimeout(pollTimer);
  if (!stopped) {
    pollTimer = window.setTimeout(fetchLoop, delay);
  }
}

function stopViewer(message, err) {
  stopped = true;
  pendingChunks.length = 0;
  window.clearTimeout(pollTimer);
  updateStatus(message, "error");
  renderStats();

  if (err) {
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
        err.message.includes("Chunk not found") ||
        err.message.includes("log not found") ||
        err.message.includes("overwritten")
      )
    )
  );
}

async function fetchChunk(index) {
  const filter = contract.filters.ChunkData(STREAM_ID, BigInt(index));
  const latestBlock = await provider.getBlockNumber();
  let toBlock = latestBlock;
  let logs = [];

  while (toBlock >= EVENT_SCAN_FROM_BLOCK && logs.length === 0) {
    const fromBlock = Math.max(EVENT_SCAN_FROM_BLOCK, toBlock - LOG_BLOCK_WINDOW + 1);
    logs = await contract.queryFilter(filter, fromBlock, toBlock);
    toBlock = fromBlock - 1;
  }

  if (logs.length === 0) {
    throw new Error(`Chunk ${index} log not found`);
  }

  const parsed = contract.interface.decodeEventLog(
    chunkDataEvent,
    logs[logs.length - 1].data,
    logs[logs.length - 1].topics
  );

  return {
    index,
    timestamp: Number(parsed.timestamp),
    bytes: new Uint8Array(ethers.getBytes(parsed.data))
  };
}

function queueChunk(chunk) {
  if (pendingChunks.some((entry) => entry.index === chunk.index)) {
    return;
  }

  pendingChunks.push(chunk);
  pendingChunks.sort((a, b) => a.index - b.index);
  renderStats();
}

function appendNextChunk() {
  if (stopped || !sourceBuffer || sourceBuffer.updating || currentAppend || pendingChunks.length === 0) {
    return;
  }

  if (video.error) {
    stopViewer(`Video decoder error: ${video.error.message ?? "media could not be decoded"}`);
    return;
  }

  currentAppend = pendingChunks.shift();

  try {
    sourceBuffer.appendBuffer(currentAppend.bytes);
    updateStatus(
      currentAppend.index === INIT_CHUNK_INDEX
        ? "Appending stream initialization segment..."
        : `Appending onchain chunk ${currentAppend.index}...`
    );
    renderStats();
  } catch (err) {
    const failedIndex = currentAppend.index;
    currentAppend = null;
    stopViewer(`Playback stopped while appending chunk ${failedIndex}: ${err.message}`, err);
  }
}

function handleAppendComplete() {
  if (!currentAppend) {
    appendNextChunk();
    return;
  }

  lastAppendedChunkIndex = currentAppend.index;
  if (currentAppend.index === INIT_CHUNK_INDEX) {
    hasInitSegment = true;
    updateDetail("Init segment loaded from contract chunk 0. Media fragments are now safe to append.");
  }

  currentAppend = null;
  renderStats();

  if (!video.paused && video.buffered.length > 0 && video.currentTime === 0) {
    video.currentTime = video.buffered.start(0);
  }

  updateStatus(`Buffered through chunk ${lastAppendedChunkIndex}`, "ok");
  appendNextChunk();
}

async function ensureInitSegment() {
  if (hasInitSegment || pendingChunks.some((entry) => entry.index === INIT_CHUNK_INDEX)) {
    return true;
  }

  try {
    queueChunk(await fetchChunk(INIT_CHUNK_INDEX));
    nextChunkIndex = Math.max(nextChunkIndex, INIT_CHUNK_INDEX + 1);
    updateDetail("Fetched fMP4 initialization segment from contract chunk 0.");
    return true;
  } catch (err) {
    if (isUnavailableChunkError(err)) {
      stopViewer(
        "Cannot start playback: contract chunk 0 is unavailable, so the fMP4 init segment is missing.",
        err
      );
      updateDetail("Late viewers need the init segment preserved onchain separately, or repeated periodically.");
      return false;
    }

    throw err;
  }
}

async function fetchLoop() {
  if (stopped) {
    return;
  }

  try {
    latestKnownIndex = Number(await contract.getLatestIndex(STREAM_ID));
    renderStats();

    if (latestKnownIndex === 0) {
      updateStatus("Waiting for first onchain chunk...");
      schedulePoll();
      return;
    }

    if (!(await ensureInitSegment())) {
      return;
    }

    if (latestKnownIndex > MAX_PENDING_CHUNKS && nextChunkIndex < latestKnownIndex - MAX_PENDING_CHUNKS) {
      const catchUpIndex = Math.max(1, latestKnownIndex - LIVE_BACKOFF_CHUNKS);
      pendingChunks.splice(0, pendingChunks.length, ...pendingChunks.filter((entry) => entry.index === INIT_CHUNK_INDEX));
      nextChunkIndex = catchUpIndex;
      updateStatus(`Catching up near live chunk ${catchUpIndex}`, "warn");
      updateDetail("This stream keeps historical chunks, but the viewer skipped ahead to avoid building a huge local queue.");
    }

    while (nextChunkIndex < latestKnownIndex && pendingChunks.length < MAX_PENDING_CHUNKS) {
      const currentIndex = nextChunkIndex;

      try {
        queueChunk(await fetchChunk(currentIndex));
        nextChunkIndex = currentIndex + 1;
      } catch (err) {
        if (isUnavailableChunkError(err)) {
          const catchUpIndex = Math.max(1, latestKnownIndex - LIVE_BACKOFF_CHUNKS);
          nextChunkIndex = catchUpIndex;
          updateStatus(`Chunk ${currentIndex} is unavailable. Jumping to ${catchUpIndex}.`, "warn");
          updateDetail("The stream has a gap or the RPC could not return the chunk payload.");
          break;
        }

        throw err;
      }
    }

    appendNextChunk();

    if (pendingChunks.length === 0 && lastAppendedChunkIndex >= 0) {
      updateStatus(`Live edge reached at chunk ${lastAppendedChunkIndex}`, "ok");
    }
  } catch (err) {
    updateStatus(`RPC/viewer error: ${err.message}`, "error");
    console.error(err);
  }

  renderStats();
  schedulePoll();
}

mediaSource.addEventListener("sourceopen", () => {
  if (!MediaSource.isTypeSupported(mime)) {
    stopViewer(`Browser does not support ${mime}`);
    return;
  }

  sourceBuffer = mediaSource.addSourceBuffer(mime);
  sourceBuffer.mode = "segments";

  sourceBuffer.addEventListener("updateend", handleAppendComplete);
  sourceBuffer.addEventListener("error", () => {
    stopViewer("SourceBuffer error while decoding stream.");
  });

  video.addEventListener("error", () => {
    stopViewer(`Video decoder error: ${video.error?.message ?? "media could not be decoded"}`);
  });

  video.addEventListener("timeupdate", renderStats);
  video.addEventListener("progress", renderStats);

  updateStatus("Connecting to onchain stream...");
  updateDetail("Reading chunks directly from the SKALE Base Sepolia contract.");
  fetchLoop();
});

retryButton.addEventListener("click", () => {
  window.location.reload();
});

liveButton.addEventListener("click", () => {
  if (latestKnownIndex > 0) {
    nextChunkIndex = Math.max(1, latestKnownIndex - LIVE_BACKOFF_CHUNKS);
    pendingChunks.length = 0;
    updateStatus(`Jumping near live chunk ${nextChunkIndex}`, "warn");
    fetchLoop();
  }
});

renderStats();
