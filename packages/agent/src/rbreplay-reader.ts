/**
 * TypeScript-facing adapter for the pure ESM native-world Attribute decoder.
 *
 * Keep the implementation in the .mjs module so repository-root Node analyzers
 * can import the exact same decoder without tsx or a Monitor build step.
 */
export {
  decodeWorldAttributePacket,
  projectCompactAttributeUpdates,
  readRbReplayWorldAttributes,
} from './rbreplay-world-attributes.mjs';

export type {
  NativeAttributeEvent,
  RbReplayAttributeFile,
  RbReplayAttributeInfo,
  RbReplayCompactUpdate,
  RbReplayFrame,
} from './rbreplay-world-attributes.mjs';
