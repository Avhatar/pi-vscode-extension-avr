/* ── DOM refs ── */
const $transcript = document.getElementById('transcript') as HTMLElement;
const $prompt = document.getElementById('prompt') as HTMLTextAreaElement;
const $btnSend = document.getElementById('btn-send') as HTMLButtonElement;
const $btnAbort = document.getElementById('btn-abort') as HTMLButtonElement;
const $statusConn = document.getElementById('status-connection') as HTMLElement;
const $statusModel = document.getElementById('status-model') as HTMLElement;
const $statusWorkspace = document.getElementById('status-workspace') as HTMLElement;
const $statusClock = document.getElementById('status-clock') as HTMLElement;
const $btnToggleFx = document.getElementById('btn-toggle-fx') as HTMLButtonElement;
const $btnToggleMute = document.getElementById('btn-toggle-mute') as HTMLButtonElement;
const $btnAudioInit = document.getElementById('btn-audio-init') as HTMLButtonElement;

/* ── State ── */
let ws: WebSocket | null = null;
let token: string | null = null;
let authenticated = false;
let agentActive = false;
let abortPending = false;
let hadAuthenticatedConnection = false;
let muted = false;
let reducedFx = false;
let audioCtx: AudioContext | null = null;
let lastTypingSound = 0;

/* Reconnect state */
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/* ── Clock ── */
function updateClock(): void {
  const now = new Date();
  $statusClock.textContent = now.toLocaleTimeString('en-US', { hour12: false });
}
updateClock();
setInterval(updateClock, 1000);

/* ── Transcript helpers ── */

function appendLine(text: string, className: string = ''): void {
  const div = document.createElement('div');
  div.className = 'line' + (className ? ' ' + className : '');
  div.textContent = text;
  $transcript.appendChild(div);
  $transcript.scrollTop = $transcript.scrollHeight;
}

function appendDelta(text: string, className: string): void {
  // Append to the last line if it has the same class; otherwise create a new line.
  const last = $transcript.lastElementChild as HTMLElement | null;
  if (last?.classList.contains(className)) {
    last.textContent += text;
  } else {
    appendLine(text, className);
  }
}

/* ── Status bar ── */

function setConnectionStatus(status: string, cssClass: string): void {
  $statusConn.textContent = '● ' + status;
  $statusConn.className = 'telemetry-item ' + cssClass;
}

function setReady(cwd: string, model: string | undefined, isStreaming: boolean): void {
  $statusWorkspace.textContent = cwd;
  $statusModel.textContent = model ?? 'UNLINKED';
  agentActive = isStreaming;
  abortPending = false;
  updateAbortButton();
}

/* ── Audio ── */

function initAudio(): void {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext();
    void audioCtx.resume();
    $btnAudioInit.textContent = '[ AUDIO ON ]';
    $btnAudioInit.disabled = true;
    playBlip(660, 0.05, 0.08);
  } catch {
    $btnAudioInit.textContent = '[ NO AUDIO ]';
    $btnAudioInit.disabled = true;
  }
}

function playBlip(frequency: number, volume: number, duration: number): void {
  if (muted || !audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + duration);
}

function playTypingSound(): void {
  const now = performance.now();
  if (now - lastTypingSound < 80) return;
  lastTypingSound = now;
  playBlip(145 + Math.random() * 80, 0.025, 0.035);
}

function playKeySound(): void {
  playBlip(90 + Math.random() * 40, 0.045, 0.045);
}

/* ── WebSocket ── */

function connect(): void {
  if (ws) return;

  // Determine WebSocket URL from current HTTP origin
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host;

  setConnectionStatus('CONNECTING', 'connecting');

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    setConnectionStatus('ERROR', 'error');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
    if (token) {
      sendMessage({ type: 'auth', token });
    }
  };

  ws.onmessage = (ev: MessageEvent) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    ws = null;
    authenticated = false;
    agentActive = false;
    abortPending = false;
    updateAbortButton();
    setConnectionStatus('DISCONNECTED', '');
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this; we just note the error
    setConnectionStatus('ERROR', 'error');
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
    RECONNECT_MAX_MS
  );
  // Add jitter: ±25%
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  const actualDelay = Math.max(500, delay + jitter);

  reconnectAttempt++;
  setConnectionStatus('RECONNECTING', 'connecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, actualDelay);
}

function sendMessage(obj: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

/* ── Message dispatch ── */

function handleMessage(msg: Record<string, unknown>): void {
  const type = msg.type as string | undefined;
  if (!type) return;

  switch (type) {
    case 'authenticated':
      authenticated = true;
      setConnectionStatus('CONNECTED', 'connected');
      appendLine(hadAuthenticatedConnection
        ? '[LINK RESTORED — OUTPUT DURING THE OUTAGE MAY BE MISSING]'
        : '[SECURE LOCAL CHANNEL ESTABLISHED]', 'system');
      hadAuthenticatedConnection = true;
      break;

    case 'ready': {
      const isStreaming = msg.isStreaming === true;
      setReady(
        (msg.cwd as string) ?? '—',
        msg.model as string | undefined,
        isStreaming
      );
      appendLine('[WORKSPACE READY] ' + ((msg.cwd as string) ?? '—'), 'system');
      if (msg.model) appendLine('[MODEL LINK] ' + (msg.model as string), 'system');
      if (isStreaming) appendLine('[ACTIVE TURN RESTORED — TRANSCRIPT REPLAY IS NOT AVAILABLE IN THIS SPIKE]', 'system');
      break;
    }

    case 'prompt_accepted':
      // User prompt has been accepted by the host.
      break;

    case 'abort_accepted':
      appendLine('[ABORT SIGNAL ACCEPTED]', 'system');
      break;

    case 'agent_start':
      agentActive = true;
      abortPending = false;
      updateAbortButton();
      appendLine('── AGENT START ──', 'system');
      break;

    case 'agent_settled':
      agentActive = false;
      abortPending = false;
      updateAbortButton();
      appendLine('── AGENT SETTLED ──', 'system');
      break;

    case 'text_delta':
      appendDelta(msg.delta as string, 'assistant');
      playTypingSound();
      break;

    case 'thinking_delta':
      appendDelta(msg.delta as string, 'thinking');
      playTypingSound();
      break;

    case 'tool_start':
      appendLine(
        '[TOOL] ' + (msg.toolName as string) +
        ' (' + (msg.toolCallId as string) + ')',
        'tool'
      );
      break;

    case 'tool_end': {
      const label = msg.isError ? '[TOOL ERROR]' : '[TOOL OK]';
      appendLine(
        label + ' ' + (msg.toolName as string) +
        ' (' + (msg.toolCallId as string) + ')',
        msg.isError ? 'error' : 'tool'
      );
      break;
    }

    case 'error':
      abortPending = false;
      updateAbortButton();
      appendLine('[ERROR] ' + (msg.message as string ?? 'Unknown error'), 'error');
      break;

    default:
      // Unknown message type — ignore silently
      break;
  }
}

function updateAbortButton(): void {
  $btnAbort.disabled = !agentActive || abortPending;
  $btnAbort.textContent = abortPending ? '[ ABORTING ]' : '[ ABORT ]';
}

/* ── User actions ── */

function sendPrompt(): void {
  const text = $prompt.value.trim();
  if (!text) return;
  appendLine('> ' + text, 'user');

  if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) {
    appendLine('[Cannot send: not connected]', 'error');
    return;
  }

  sendMessage({ type: 'prompt', text });
  playBlip(720, 0.045, 0.08);
  $prompt.value = '';
}

function doAbort(): void {
  if (!agentActive || abortPending) return;
  sendMessage({ type: 'abort' });
  abortPending = true;
  updateAbortButton();
  appendLine('[ABORT REQUESTED]', 'system');
}

function toggleReducedFx(): void {
  reducedFx = !reducedFx;
  document.body.classList.toggle('reduced-fx', reducedFx);
  $btnToggleFx.setAttribute('aria-pressed', String(reducedFx));
  $btnToggleFx.textContent = reducedFx ? '[ FX LOW ]' : '[ FX ]';
}

function toggleMute(): void {
  muted = !muted;
  $btnToggleMute.setAttribute('aria-pressed', String(muted));
  $btnToggleMute.textContent = muted ? '[ MUTED ]' : '[ MUTE ]';
}

/* ── Event bindings ── */

$btnSend.addEventListener('click', sendPrompt);
$btnAbort.addEventListener('click', doAbort);
$btnToggleFx.addEventListener('click', toggleReducedFx);
$btnToggleMute.addEventListener('click', toggleMute);
$btnAudioInit.addEventListener('click', initAudio);

$prompt.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  } else if (e.key === 'Backspace' || e.key.length === 1) {
    playKeySound();
  }
});

/* ── Bootstrap ── */

appendLine('ROBCO INDUSTRIES (TM) TERMLINK PROTOCOL', 'system');
appendLine('INITIALIZING PIP-OS........... STANDBY', 'system');
appendLine('LOADING pi.dev AGENT CORE .... STANDBY', 'system');

// Extract the per-launch token from the URL fragment. Keep it only in this tab's
// session storage so a normal refresh can reconnect without putting it in history.
const tokenStorageKey = 'pi-code.crt-spike.token';
const hash = location.hash.slice(1);
const params = new URLSearchParams(hash);
const hashToken = params.get('token');
if (hashToken) {
  token = hashToken;
  sessionStorage.setItem(tokenStorageKey, hashToken);
  history.replaceState(null, '', location.pathname + location.search);
} else {
  token = sessionStorage.getItem(tokenStorageKey);
}
if (!token) appendLine('[AUTH TOKEN MISSING — REOPEN THE URL PRINTED BY THE HOST]', 'error');

connect();
