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
  AssertSame<VersionedFileWriteResult["history"]["author"], ChangeAuthor>,
  AssertSame<VersionedFileWriteResult["history"]["files"], FileChange[]>,
  AssertSame<
    VersionedFileWriteResult["history"]["boundaryCrossings"],
    BoundaryCrossing[]
  >,
  AssertSame<
    VersionedFileWriteResult["history"]["provenance"],
    ChangeProvenance | undefined
  >,
  AssertSame<
    VersionedFileWorkspaceOptions["author"],
    ChangeAuthor | undefined
  >,
];

type AssertAllSame<T extends readonly true[]> = T;
type VerifiedHistoryDriftChecks = AssertAllSame<HistoryDriftChecks>;

export const engineHistoryContractCompileCheck: VerifiedHistoryDriftChecks[number] = true;
