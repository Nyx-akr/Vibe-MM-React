import { createTapeEvent } from '../data/event-tape';

export function nextTape(tape, seq, update, setState, random = Math.random) {
  const event = createTapeEvent(random);
  event.seq = seq;
  const next = [event, ...tape].slice(0, 9);
  if (update) setState({ tape: next });
  return next;
}
