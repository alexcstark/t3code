import { createProviderCapacityEnvironmentsAtom } from "@t3tools/client-runtime/state/provider-capacity";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentShell } from "./shell";

export const providerCapacityEnvironmentsAtom = createProviderCapacityEnvironmentsAtom({
  presentationsAtom: environmentPresentations.presentationsAtom,
  providersValueAtom: serverEnvironment.providersValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});
