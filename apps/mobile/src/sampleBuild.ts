// The app shows sample data, and controls that can't act yet, only in a sample build: a development build, or a build
// made with EXPO_PUBLIC_DOHC_SAMPLE=1, as the simulator tests are. Any other build signs in to a server first, and
// shows nothing of the sample, so an installable build never presents sample data as someone's work.
export const sampleBuild = __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1";

// A build without sample data leaves the sample out of its bundle too. A sample module (a `sample.ts`, or a screen in a
// `Sample*.tsx`) is imported elsewhere only as a type, or required behind this exact test, written out in place:
//
//   __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("./sample") as typeof import("./sample")) : null
//
// A production build inlines both values before Metro collects dependencies, folds the test to false, and drops the
// require. A test through `sampleBuild` would not fold, since Metro doesn't follow imports. src/routes.test.ts holds
// every sample module to this.
