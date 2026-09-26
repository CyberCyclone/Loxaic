// Tells the renderer when this machine sleeps, wakes, locks and unlocks.
//
// The renderer's connection monitor replaces its sockets and re-checks the
// server whenever the app comes back to the foreground — on a phone, that is
// every unlock. A desktop window has no such moment: the page's visibility
// does not reliably change when a Mac sleeps with the window open, and nothing
// pings the sockets from either end, so a laptop waking up held sockets that
// still said "open" to a server that had restarted, or dropped them, while it
// slept. The first thing sent into one was lost. These are the same two
// moments, "going away" and "back", from the one process that is told.

const EVENTS = {
  suspend: "sleep",
  "lock-screen": "sleep",
  resume: "wake",
  "unlock-screen": "wake",
};

/** Calls `send("sleep" | "wake")` for each event. Returns an unsubscribe. */
export function forwardPowerEvents(powerMonitor, send) {
  const offs = Object.entries(EVENTS).map(([event, state]) => {
    const listener = () => { send(state); };
    powerMonitor.on(event, listener);
    return () => { powerMonitor.off(event, listener); };
  });
  return () => { for (const off of offs) off(); };
}
