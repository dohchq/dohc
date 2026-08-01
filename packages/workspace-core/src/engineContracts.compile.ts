import type {
  VersionedFileWorkspaceOptions,
  VersionedFileWriteResult,
} from "@dohc/workspace-contracts/engine";
import type {
  ChangeAuthor,
  ChangeSet,
} from "./changeSet";

type IsSame<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;

type AssertSame<A, B> = IsSame<A, B>;

type SharedHistoryField =
  | "kind"
  | "author"
  | "files"
  | "boundaryCrossings"
  | "provenance";

type HistoryDriftChecks = [
  AssertSame<
    Pick<VersionedFileWriteResult["history"], SharedHistoryField>,
    Pick<ChangeSet, SharedHistoryField>
  >,
  AssertSame<
    Pick<VersionedFileWorkspaceOptions, "author">,
    { author?: ChangeAuthor }
  >,
];

type AssertAllSame<T extends readonly true[]> = T;
type VerifiedHistoryDriftChecks = AssertAllSame<HistoryDriftChecks>;

export const engineHistoryContractCompileCheck: VerifiedHistoryDriftChecks[number] = true;
