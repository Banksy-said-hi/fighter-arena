import type { TrackEventName } from './types';

const SESSION_ID = (() => {
  let id = sessionStorage.getItem('fa_sid');
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('fa_sid', id);
  }
  return id;
})();

interface AnalyticsEvent {
  session_id: string;
  event: TrackEventName;
  meta: string;
}

const eventQueue: AnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const PAGE_START = Date.now();

export function track(event: TrackEventName, meta?: Record<string, unknown>): void {
  eventQueue.push({
    session_id: SESSION_ID,
    event,
    meta: meta ? JSON.stringify(meta) : '',
  });
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushEvents, 2000); // batch within 2 s
}

function flushEvents(): void {
  if (!eventQueue.length) return;
  const batch = eventQueue.splice(0);
  const body  = JSON.stringify(batch);
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/analytics', body);
  } else {
    fetch('/analytics', { method: 'POST', body, keepalive: true }).catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    track('page_exit', { duration_sec: Math.round((Date.now() - PAGE_START) / 1000) });
    flushEvents();
  }
});

track('page_view');
