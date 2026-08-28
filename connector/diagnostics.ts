import { verifyBindingSession } from "./profileSync";
import type { ConnectorBinding, ConnectorState } from "./types";

export interface BindingDiagnosis {
  pairingId: string;
  bindingId?: string;
  agentId?: string;
  handle: string;
  runtime: ConnectorBinding["runtime"];
  serverUrl: string;
  configuredStatus: ConnectorBinding["status"];
  authenticated: boolean;
  error?: string;
}

export interface ConnectorDiagnosis {
  bindingCount: number;
  configuredConnectedCount: number;
  connectedCount: number;
  bindings: BindingDiagnosis[];
}

function publicBindingDiagnosis(
  binding: ConnectorBinding,
  authenticated: boolean,
  error?: string,
): BindingDiagnosis {
  return {
    pairingId: binding.pairingId,
    ...(binding.bindingId ? { bindingId: binding.bindingId } : {}),
    ...(binding.agentId ? { agentId: binding.agentId } : {}),
    handle: binding.requestedProfile.handle,
    runtime: binding.runtime,
    serverUrl: binding.serverUrl,
    configuredStatus: binding.status,
    authenticated,
    ...(error ? { error } : {}),
  };
}

export async function diagnoseConnectorBindings(
  state: ConnectorState,
): Promise<ConnectorDiagnosis> {
  const bindings = await Promise.all(
    state.bindings.map(async (binding): Promise<BindingDiagnosis> => {
      if (binding.status !== "connected" || !binding.agentToken) {
        return publicBindingDiagnosis(
          binding,
          false,
          binding.status === "connected"
            ? "Connected binding has no agent bearer token."
            : undefined,
        );
      }
      try {
        await verifyBindingSession(binding);
        return publicBindingDiagnosis(binding, true);
      } catch (error) {
        return publicBindingDiagnosis(
          binding,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );
  return {
    bindingCount: bindings.length,
    configuredConnectedCount: state.bindings.filter(
      (binding) => binding.status === "connected",
    ).length,
    connectedCount: bindings.filter((binding) => binding.authenticated).length,
    bindings,
  };
}
