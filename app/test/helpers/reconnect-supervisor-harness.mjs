// Deterministic clock / probe / fake-DOM harness for the reconnect supervisor tests.
//
// Extracted from reconnect-supervisor.test.js so both files fit the line budget.
import { createReconnectSupervisor } from "../../frontend/app/features/sync/reconnect-supervisor.js";

export const START = 1_000_000;

export function createClock(start = START) {
  let time = start;
  let sequence = 0;
  const scheduled = new Map();

  const timers = {
    setTimeout(callback, delay) {
      sequence += 1;
      const id = sequence;
      scheduled.set(id, { at: time + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
  };

  async function flush() {
    for (let index = 0; index < 8; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function advance(ms) {
    const target = time + Math.max(0, Number(ms) || 0);
    for (;;) {
      let nextId = null;
      let nextAt = Infinity;
      for (const [id, entry] of scheduled) {
        if (entry.at <= target && (entry.at < nextAt || (entry.at === nextAt && id < nextId))) {
          nextId = id;
          nextAt = entry.at;
        }
      }
      if (nextId === null) break;
      const entry = scheduled.get(nextId);
      scheduled.delete(nextId);
      time = entry.at;
      entry.callback();
      await flush();
    }
    time = target;
    await flush();
  }

  return { now: () => time, timers, advance, pending: () => scheduled.size };
}

export function createHarness({ statuses = [200], options = {} } = {}) {
  const clock = createClock();
  let index = 0;
  let forced = null;
  const probe = async () => {
    const value = forced !== null
      ? forced
      : typeof statuses === "function"
        ? statuses(index)
        : statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    probe.calls.push({ at: clock.now(), status: value });
    if (value instanceof Error) throw value;
    return { status: value };
  };
  probe.calls = [];
  probe.respond = (value) => { forced = value; };
  const supervisor = createReconnectSupervisor({
    probe,
    now: clock.now,
    timers: clock.timers,
    random: () => 1,
    ...options,
  });
  return { clock, supervisor, probe };
}

export function collect(supervisor) {
  const events = [];
  supervisor.subscribe((event) => events.push(event));
  return events;
}

export function countType(events, type) {
  return events.filter((event) => event.type === type).length;
}

export function createFakeElement(name) {
  const attributes = new Map();
  const element = {
    nodeName: String(name).toUpperCase(),
    className: "",
    hidden: false,
    textContent: "",
    children: [],
    parentNode: null,
    setAttribute(key, value) { attributes.set(String(key), String(value)); },
    getAttribute(key) { return attributes.has(String(key)) ? attributes.get(String(key)) : null; },
    removeAttribute(key) { attributes.delete(String(key)); },
    appendChild(child) { child.parentNode = element; element.children.push(child); return child; },
    removeChild(child) {
      const index = element.children.indexOf(child);
      if (index >= 0) element.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
  };
  return element;
}

export function createFakeDocument() {
  return { createElement: (name) => createFakeElement(name) };
}
