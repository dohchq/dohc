import { expect, it } from "vitest";
import { createAppBackendAdmission } from "./appBackendAdmission";
it("bounds datasets, global work, large bodies and participant-map churn", () => {
  const admit = createAppBackendAdmission({maxKeys: 1, maxUploads: 1, maxRecovery: 1,
    dataset: {capacity: 2, refillPerSecond: 1}, global: {capacity: 3, refillPerSecond: 1}});
  const scope = (dataset: string, participant: string, organizer = false) => ({dataset, participant, organizer});
  admit(scope("a", "1"), "invoke", 0)();
  admit(scope("a", "2"), "invoke", 0)();
  expect(() => admit(scope("a", "3"), "invoke", 0)).toThrow();
  admit(scope("b", "4"), "invoke", 0)();
  expect(() => admit(scope("c", "5"), "invoke", 0)).toThrow();
  const upload = admit(scope("a", "owner", true), "upload", 0);
  expect(() => admit(scope("a", "helper", true), "upload", 0)).toThrow();
  const restore = admit(scope("a", "owner", true), "restore", 0);
  expect(() => admit(scope("b", "owner", true), "restore", 0)).toThrow();
  upload(); restore();
  admit(scope("a", "owner", true), "restore", 0)();
  admit(scope("c", "5"), "invoke", 1000)();
  expect(() => createAppBackendAdmission({maxPending: NaN})).toThrow();
  expect(() => createAppBackendAdmission({participant: {capacity: 1, refillPerSecond: Infinity}})).toThrow();
});
