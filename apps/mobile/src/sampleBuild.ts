// The app shows sample data, and controls that can't act yet, only in a sample build: a development build, or a build
// made with EXPO_PUBLIC_DOHC_SAMPLE=1, as the simulator tests are. Any other build signs in to a server first, and
// shows nothing of the sample, so an installable build never presents sample data as someone's work.
export const sampleBuild = __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1";
