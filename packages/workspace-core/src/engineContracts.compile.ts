import type {
  VersionedFileWorkspaceOptions,
  VersionedFileWriteResult,
} from "@dohc/workspace-contracts/engine";
import type {
  BoundaryCrossing,
  ChangeAuthor,
  ChangeProvenance,
  ChangeSetKind,
  FileChange,
} from "./changeSet";

type IsSame<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;

type AssertSame<A, B> = IsSame<A, B>;

type HistoryDriftChecks = [
  AssertSame<VersionedFileWriteResult["history"]["kind"], ChangeSetKind>,
  AssertSame<VersionedFileWriteResult["history"]["files"][number], FileChange>,
  AssertSame<
    VersionedFileWriteResult["history"]["boundaryCrossings"][number],
    BoundaryCrossing
  >,
  AssertSame<
    NonNullable<VersionedFileWriteResult["history"]["provenance"]>,
    ChangeProvenance
  >,
  AssertSame<NonNullable<VersionedFileWorkspaceOptions["author"]>, ChangeAuthor>,
];

type AssertAllSame<T extends readonly true[]> = T;
type VerifiedHistoryDriftChecks = AssertAllSame<HistoryDriftChecks>;

export const engineHistoryContractCompileCheck: VerifiedHistoryDriftChecks[number] = true;
