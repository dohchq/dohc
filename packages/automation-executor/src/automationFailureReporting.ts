import type { NoticeRecipient } from "@dohc/workspace-contracts/relay";
import { NoticeNotSentError } from "./automationChat";
import { automationFailedElsewhereBody, automationFailedNotice, type AutomationFailedNotice, type FailureComputer } from "./automationFailedNotice";
import type { AutomationFailureReport } from "./collectionAutomations";

/** Both hosts use the Notice post boundary to check each recipient's current access. */
export async function reportAutomationFailure(
  dependencies: {
    computer: FailureComputer;
    primary?: NoticeRecipient;
    primaryUserId?: string | null;
    throughShare: boolean;
    post(notice: AutomationFailedNotice & Partial<NoticeRecipient>): Promise<void>;
    withdraw(): Promise<void>;
    lastChangedBy(automationId: string): Promise<string | null>;
    onError(context: string, error: unknown): void;
  },
  workspaceId: string,
  report: AutomationFailureReport,
): Promise<void> {
  const notice = automationFailedNotice({ workspaceId, computer: dependencies.computer, ...report });
  await dependencies.post({ ...notice, ...dependencies.primary });
  await dependencies.withdraw();
  let lastChangedBy: string | null = null;
  try {
    lastChangedBy = await dependencies.lastChangedBy(report.failure.automationId);
  } catch (error) {
    dependencies.onError("read who changed the automation last", error);
  }
  const people = new Set([report.startedBy, lastChangedBy].filter((person): person is string => person !== null));
  if (dependencies.primary?.recipientUserId !== undefined) people.delete(dependencies.primary.recipientUserId);
  if (dependencies.primaryUserId) people.delete(dependencies.primaryUserId);
  const recipients: NoticeRecipient[] = [
    ...(dependencies.throughShare ? [{ toWorkspaceOwner: true as const }] : []),
    ...[...people].map((recipientUserId) => ({ recipientUserId })),
  ];
  const { run: _run, ...target } = notice.target;
  const copy = { ...notice, body: automationFailedElsewhereBody(report.failure, report.name), target };
  for (const recipient of recipients) {
    try {
      await dependencies.post({ ...copy, ...recipient });
    } catch (error) {
      if (!(error instanceof NoticeNotSentError)) throw error;
      dependencies.onError(`send "${notice.title}" to another person involved`, error);
    }
  }
}
