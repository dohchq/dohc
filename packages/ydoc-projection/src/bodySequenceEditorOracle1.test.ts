// @vitest-environment jsdom
import { afterEach } from "vitest";
import { everyStepOracle } from "./bodySequenceEditorTestSupport.js";
import { stopEveryone } from "./bodySequenceTestSupport.js";

afterEach(stopEveryone);

everyStepOracle(0);
