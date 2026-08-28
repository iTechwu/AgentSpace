// Remote daemons report every 15 seconds by default. Keep enough grace for one missed beat.
export const DEFAULT_DAEMON_HEARTBEAT_STALE_MS = 60_000;
