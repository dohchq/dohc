import { appWords } from "@dohc/interface-words/apps";
import { AppRunScreen } from "../src/apps/AppRunner";
import { canOpenApps } from "../src/apps/canOpenApps";
import { signedInOnly } from "../src/sampleOnly";
import { ScreenFailure } from "../src/workspace/ListStates";

// The running app, from its review. A link here opens nothing: the app comes only from the runner in memory. A build
// that can't run apps refuses the route.
export default signedInOnly(
  canOpenApps ? AppRunScreen : () => <ScreenFailure text={appWords.cantOpenHere} />,
);
