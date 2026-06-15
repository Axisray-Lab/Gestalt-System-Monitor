/**
 * JSON-RPC envelope, mirrored from the game's WebSocket bridge so the monitor
 * is just another WS client on the same socket the in-game UI uses.
 *
 * The server broadcasts notifications (no id) to every connected client, so a
 * passive monitor receives pushes without sending anything.
 */

export enum EJSONRPCType {
  Request = 0,
  Response = 1,
}

export interface JSONRPCRequest<P = unknown> {
  type: EJSONRPCType.Request;
  /** Present for request/response pairs; absent for fire-and-forget notifications. */
  id?: number;
  method: string;
  params?: P;
}

export interface JSONRPCResponse<R = unknown> {
  type: EJSONRPCType.Response;
  id: number;
  result?: R;
  error?: { code: number; message: string };
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse;

export function isNotification(
  m: JSONRPCMessage
): m is JSONRPCRequest & { method: string } {
  return m.type === EJSONRPCType.Request && typeof (m as JSONRPCRequest).method === 'string';
}
