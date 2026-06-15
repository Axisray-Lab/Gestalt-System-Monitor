/**
 * Wire constants for the game's LAN-discovery beacon, so the monitor speaks the
 * same dialect as the matches it watches:
 *   DISCOVERY_PORT       = 7999
 *   BROADCAST_INTERVAL   = 1.0s
 *   ROOM_EXPIRY          = 5.0s
 *   MAGIC                = 0x4543484F  // "ECHO"
 */

/** UDP port the LAN-discovery beacon broadcasts/listens on. */
export const DISCOVERY_PORT = 7999;

/** 4-byte little-endian magic that prefixes every beacon packet ("ECHO"). */
export const DISCOVERY_MAGIC = 0x4543484f;

/** A discovered process is dropped if no beacon is seen for this long. */
export const ROOM_EXPIRY_MS = 5000;

/** Cadence at which a (patched) host re-broadcasts its beacon. */
export const BROADCAST_INTERVAL_MS = 1000;

/** Default port the discovery agent serves the browser process-list on. */
export const AGENT_BROWSER_PORT = 7788;
