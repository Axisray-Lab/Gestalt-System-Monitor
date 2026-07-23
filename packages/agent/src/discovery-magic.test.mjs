import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCOVERY_MAGIC,
  MONITOR_DISCOVERY_MAGIC,
  ROOM_DISCOVERY_MAGIC,
} from '../../protocol/src/constants.ts';
import { isMonitorDiscoveryPacket } from './discovery-wire.ts';

function packetWithMagic(magic) {
  const packet = Buffer.alloc(8);
  packet.writeUInt32LE(magic, 0);
  return packet;
}

test('monitor wire accepts MONI and rejects legacy ECHO room packets', () => {
  assert.equal(DISCOVERY_MAGIC, ROOM_DISCOVERY_MAGIC);
  assert.notEqual(MONITOR_DISCOVERY_MAGIC, ROOM_DISCOVERY_MAGIC);
  assert.equal(
    isMonitorDiscoveryPacket(packetWithMagic(MONITOR_DISCOVERY_MAGIC)),
    true,
  );
  assert.equal(
    isMonitorDiscoveryPacket(packetWithMagic(ROOM_DISCOVERY_MAGIC)),
    false,
  );
  assert.equal(isMonitorDiscoveryPacket(Buffer.alloc(3)), false);
});

test('monitor wire reads the packet view offset instead of the backing buffer origin', () => {
  const backing = Buffer.alloc(12);
  backing.writeUInt32LE(ROOM_DISCOVERY_MAGIC, 0);
  backing.writeUInt32LE(MONITOR_DISCOVERY_MAGIC, 4);
  assert.equal(isMonitorDiscoveryPacket(backing.subarray(4)), true);
});
