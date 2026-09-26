import { configure } from "@testing-library/dom";

// Testing Library's own 1 s default misses renders on a loaded gate host.
configure({ asyncUtilTimeout: 10_000 });
