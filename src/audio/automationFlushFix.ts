import { AutomationEventList } from 'automation-events';

/**
 * standardized-audio-context (inside Tone.js) keeps a JavaScript mirror of every AudioParam's
 * automation and trims it with AutomationEventList.flush(now). Upstream flush only trims when at
 * least one event still lies in the future; when every event is already in the past it keeps them
 * all. Parameters automated once per note (setValueAtTime / setTargetAtTime) therefore grew without
 * bound — about 17 000 objects per minute of playing. In Chrome the native param does the work and
 * the mirror only needs the latest state, so the last two past events are kept.
 */
type Ev = { startTime?: number; endTime?: number; cancelTime?: number; duration?: number };
const eventTime = (e: Ev): number => e.endTime ?? e.cancelTime ?? (e.startTime ?? 0) + (e.duration ?? 0);

const proto = AutomationEventList.prototype as unknown as { flush(time: number): void; _automationEvents: Ev[] };
const upstreamFlush = proto.flush;
proto.flush = function (this: typeof proto, time: number): void {
  const events = this._automationEvents;
  // events are kept sorted by time: if the last one is past, all of them are
  if (events.length > 2 && eventTime(events[events.length - 1]) <= time) this._automationEvents = events.slice(-2);
  else upstreamFlush.call(this, time);
};
