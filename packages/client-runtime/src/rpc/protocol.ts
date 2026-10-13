import { WsRpcGroup } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";

import type { PreparedConnection } from "../connection/model.ts";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

// Pings run every 5 seconds. Remote traffic gets more grace so a brief network
// stall does not tear down the session and repeat connection setup.
const LOCAL_PING_TIMEOUT = "15 seconds";
const REMOTE_PING_TIMEOUT = "60 seconds";

export function rpcPingTimeout(connection: PreparedConnection) {
  // An SSH tunnel's loopback socket still carries traffic to a remote host.
  if (
    connection.target._tag === "SshConnectionTarget" ||
    connection.target._tag === "RelayConnectionTarget"
  ) {
    return REMOTE_PING_TIMEOUT;
  }
  return isLocalLoopbackHost(new URL(connection.socketUrl).hostname)
    ? LOCAL_PING_TIMEOUT
    : REMOTE_PING_TIMEOUT;
}
