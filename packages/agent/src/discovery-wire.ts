import { MONITOR_DISCOVERY_MAGIC } from '../../protocol/src/constants.ts';

/**
 * Recognize only process-monitor beacons. Room discovery shares udp/7999 but
 * deliberately retains the shipped ECHO magic, so accepting it here would
 * recreate room/process cross-talk.
 */
export function isMonitorDiscoveryPacket(packet: Uint8Array): boolean {
  if (packet.byteLength < 4) return false;
  const prefix = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  ).getUint32(0, true);
  return prefix === MONITOR_DISCOVERY_MAGIC;
}
