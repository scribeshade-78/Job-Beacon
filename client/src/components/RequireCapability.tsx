import type { ReactNode } from "react";
import { Redirect } from "wouter";
import { LoadingScreen } from "./LoadingScreen";
import { hasCapability, type Capabilities } from "../lib/capabilities";

/**
 * Renders a privileged surface only when the capability is held, and never
 * before the answer is known.
 *
 * THREE OUTCOMES, AND THE MIDDLE ONE IS THE POINT:
 *
 *   pending      capabilities are unresolved, so NOTHING is mounted — the user
 *                sees the loading screen. This is what stops privileged content
 *                from flashing: a component that mounts first and is hidden
 *                second has already fetched its data, and the fetch is the
 *                exposure. Rendering is not the boundary; mounting is.
 *
 *   unauthorized a resolved "no" redirects to the candidate Home rather than
 *                rendering a dead end. These routes are not in the candidate
 *                navigation, so reaching one means a typed URL or a stale link.
 *
 *   authorized   the children mount.
 *
 * THIS IS NOT THE SECURITY BOUNDARY. The matching API returns 403 and the
 * matching tables are protected by RLS; see lib/capabilities.ts. What this
 * prevents is the app rendering another persona's shell to the wrong person.
 */

interface RequireCapabilityProps {
  capability: keyof Capabilities;
  capabilities: Capabilities;
  /** True while the server-verified identity has not resolved yet. */
  pending: boolean;
  children: ReactNode;
}

export function RequireCapability({ capability, capabilities, pending, children }: RequireCapabilityProps) {
  if (pending) {
    return <LoadingScreen />;
  }

  if (!hasCapability(capabilities, capability)) {
    return <Redirect to="/" />;
  }

  return <>{children}</>;
}
