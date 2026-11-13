// USB scanner (HID keyboard-wedge) capture layer.
// Scanner devices "type" the payload as an ultra-fast keystroke burst
// (inter-key ~5-15ms) terminated by Enter. Humans do not sustain <45ms/key,
// so timing classifies the burst; no drivers or WebUSB needed.

const MAX_GAP_MS = 45;      // a key belongs to the burst if it arrives this soon after the previous one
const RESET_GAP_MS = 120;   // longer silence means the burst is over / human typing
const MIN_SCAN_LENGTH = 4;  // shorter bursts stay plain keystrokes
const MAX_BUFFER = 64;

let buffer = '';
let lastKeyTime = 0;
let inBurst = false;
let started = false;

function reset() {
  buffer = '';
  lastKeyTime = 0;
  inBurst = false;
}

function isTextEntry(element) {
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable === true;
}

// The first burst keystroke is not suppressible (classification is only
// possible once a second fast key arrives), so it may have landed in the
// focused text field. Undo as much of the leaked prefix as we can find.
function stripFromFocusedInput(payload) {
  const element = document.activeElement;
  if (!isTextEntry(element)) return;
  const current = typeof element.value === 'string' ? element.value : '';
  let leaked = 0;
  if (current.endsWith(payload)) leaked = payload.length;
  else {
    const maxProbe = Math.min(4, payload.length - 1);
    for (let size = maxProbe; size >= 1; size -= 1) {
      if (current.endsWith(payload.slice(0, size))) { leaked = size; break; }
    }
  }
  if (!leaked) return;
  const next = current.slice(0, current.length - leaked);
  const proto = element.tagName === 'TEXTAREA'
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, next);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.isComposing) return;
  if (event.key !== 'Enter' && event.key.length !== 1) return; // Escape/Tab/navigation/F-keys

  const now = event.timeStamp || performance.now();

  if (event.key === 'Enter') {
    if (inBurst && buffer.length >= MIN_SCAN_LENGTH && now - lastKeyTime <= MAX_GAP_MS) {
      event.preventDefault();
      const payload = buffer;
      reset();
      stripFromFocusedInput(payload);
      window.dispatchEvent(new CustomEvent('bubble-scan', { detail: payload }));
    } else {
      reset();
    }
    return;
  }

  const gap = lastKeyTime ? now - lastKeyTime : Number.POSITIVE_INFINITY;
  if (buffer && gap > RESET_GAP_MS) reset();

  if (!buffer) {
    // Possible burst start — nothing to classify yet, let the key through.
    buffer = event.key;
    lastKeyTime = now;
    inBurst = false;
    return;
  }

  if (gap <= MAX_GAP_MS) {
    inBurst = true;
    event.preventDefault(); // swallow scanner keystrokes so forms/inputs stay clean
    buffer = (buffer + event.key).slice(-MAX_BUFFER);
    lastKeyTime = now;
  } else {
    // Human-paced typing: hand the key to the page and start over.
    buffer = event.key;
    lastKeyTime = now;
    inBurst = false;
  }
}

function onBlur() { reset(); }

export function startUsbScanner() {
  if (started) return stopUsbScanner;
  started = true;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur, true);
  document.addEventListener('visibilitychange', onBlur, true);
  reset();
  return stopUsbScanner;
}

export function stopUsbScanner() {
  if (!started) return;
  started = false;
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('blur', onBlur, true);
  document.removeEventListener('visibilitychange', onBlur, true);
  reset();
}
