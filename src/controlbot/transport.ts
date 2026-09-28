import type { ExecutionEvent } from '../event.ts';
import type { RunnerHeartbeat } from '../runner.ts';

export type ControlBotPollRequest = {
  version: 1;
  runner_id: string;
  capabilities: string[];
  cursor: string | null;
  limit: number;
};

export type ControlBotAckRequest = {
  version: 1;
  order_id: string;
  runner_id: string;
  fingerprint: string;
};

export type ControlBotEventsRequest = {
  version: 1;
  runner_id: string;
  events: ExecutionEvent[];
};

export type ControlBotHeartbeatRequest = {
  version: 1;
  runner_id: string;
  heartbeat: RunnerHeartbeat;
};

export interface ControlBotTransport {
  poll(request: ControlBotPollRequest): Promise<unknown>;
  ack(request: ControlBotAckRequest): Promise<void>;
  publishEvents(request: ControlBotEventsRequest): Promise<void>;
  publishHeartbeat(request: ControlBotHeartbeatRequest): Promise<void>;
}
