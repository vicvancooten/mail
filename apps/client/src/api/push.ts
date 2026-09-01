import {
  type PushConfigResponse,
  pushConfigResponseSchema,
  type RegisterPushSubscriptionRequest,
} from "@mail/shared";
import { deleteNoContent, getJson, postNoContent } from "./auth.js";

/**
 * Web Push's device-registration endpoints (#53, ADR-0015). `pwa/push.ts`
 * is the caller — everything about *when* to subscribe/unsubscribe lives
 * there; this file is plain request plumbing.
 */

export function fetchPushConfig(): Promise<PushConfigResponse> {
  return getJson("/push/config", (data) => pushConfigResponseSchema.parse(data));
}

export function registerPushSubscription(input: RegisterPushSubscriptionRequest): Promise<void> {
  return postNoContent("/push/subscriptions", input);
}

export function unregisterPushSubscription(endpoint: string): Promise<void> {
  return deleteNoContent("/push/subscriptions", { endpoint });
}
