/**
 * Event log — a live, categorized trail the rest of the app emits into.
 * The drawer subscribes and renders events with timestamps and category tags.
 * It is also the only place anything is allowed to "log": there is no
 * console.log anywhere in the shipped code.
 */

export type EventCategory = 'system' | 'mic' | 'engine' | 'render' | 'record' | 'export';
export type EventLevel = 'info' | 'ok' | 'warn' | 'err';

export interface LogEvent {
  ts: number;
  cat: EventCategory;
  level: EventLevel;
  msg: string;
}

const ALL_CATS: EventCategory[] = ['system', 'mic', 'engine', 'render', 'record', 'export'];
const MAX_EVENTS = 600;

let events: LogEvent[] = [];
let listeners: Array<(e: LogEvent) => void> = [];
const activeCats: Set<EventCategory> = new Set(ALL_CATS);
let listEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let autoScroll = true;

export function emit(cat: EventCategory, level: EventLevel, msg: string): void {
  const e: LogEvent = { ts: Date.now(), cat, level, msg };
  events.push(e);
  if (events.length > MAX_EVENTS) {
    events.shift();
    if (listEl) listEl.querySelector('.event')?.remove();
  }
  for (const l of listeners) l(e);
}

export function categoryLogger(cat: EventCategory) {
  return (msg: string, level: EventLevel = 'info') => emit(cat, level, msg);
}

export function clearLog(): void {
  events = [];
  if (listEl) listEl.innerHTML = '';
  if (countEl) countEl.textContent = '0';
}

export function eventCount(): number {
  return events.length;
}

export function mountEventDrawer(container: HTMLElement, onClose?: () => void): () => void {
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'drawer-head';
  head.innerHTML = `
    <div class="drawer-title">event trail</div>
    <div class="drawer-controls">
      <span class="count"><strong id="ev-count">0</strong>&nbsp;events</span>
      <button type="button" class="drawer-close" aria-label="Close event log">&times;</button>
    </div>
  `;
  head.querySelector('.drawer-close')?.addEventListener('click', () => onClose?.());
  container.appendChild(head);

  const filters = document.createElement('div');
  filters.className = 'drawer-filters';
  for (const c of ALL_CATS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-pill on';
    btn.dataset.cat = c;
    btn.textContent = c;
    btn.addEventListener('click', () => {
      if (activeCats.has(c)) {
        activeCats.delete(c);
        btn.classList.remove('on');
      } else {
        activeCats.add(c);
        btn.classList.add('on');
      }
      reflow();
    });
    filters.appendChild(btn);
  }
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'filter-pill clear';
  clearBtn.textContent = 'clear';
  clearBtn.addEventListener('click', () => clearLog());
  filters.appendChild(clearBtn);
  container.appendChild(filters);

  const list = document.createElement('div');
  list.className = 'drawer-list';
  container.appendChild(list);

  listEl = list;
  countEl = container.querySelector('#ev-count') as HTMLElement;

  list.addEventListener('scroll', () => {
    autoScroll = list.scrollTop + list.clientHeight >= list.scrollHeight - 32;
  });

  reflow();

  const onEvent = (e: LogEvent) => {
    if (activeCats.has(e.cat)) appendEvent(e);
    bumpCount();
  };
  listeners.push(onEvent);

  return () => {
    listeners = listeners.filter((l) => l !== onEvent);
    listEl = null;
    countEl = null;
  };
}

function bumpCount(): void {
  if (countEl) countEl.textContent = String(events.length);
}

function reflow(): void {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const e of events) {
    if (activeCats.has(e.cat)) appendEvent(e, false);
  }
  listEl.scrollTop = listEl.scrollHeight;
  bumpCount();
}

function appendEvent(e: LogEvent, scroll = true): void {
  if (!listEl) return;
  const row = document.createElement('div');
  row.className = 'event';
  row.dataset.cat = e.cat;
  row.dataset.level = e.level;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = formatTs(e.ts);
  const cat = document.createElement('span');
  cat.className = 'cat';
  cat.textContent = e.cat;
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = e.msg;

  row.append(ts, cat, msg);
  listEl.appendChild(row);
  if (scroll && autoScroll) listEl.scrollTop = listEl.scrollHeight;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
