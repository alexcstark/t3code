import { createProviderCapacityEnvironmentsAtom } from "@t3tools/client-runtime/state/provider-capacity";

import { environmentPresentations } from "./presentation";
import { environmentShell } from "./shell";

export const providerCapacityEnvironmentsAtom = createProviderCapacityEnvironmentsAtom({
  presentationsAtom: environmentPresentations.presentationsAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});
