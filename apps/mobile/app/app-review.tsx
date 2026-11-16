import { AppReviewScreen } from "../src/apps/AppReview";
import { signedInOnly } from "../src/sampleOnly";

// A published app's review, from Home. It needs the signed-in account's open workspace.
export default signedInOnly(AppReviewScreen);
