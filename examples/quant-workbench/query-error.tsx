import { Button, Callout } from "dohc/ui";

export function QueryError({
  error,
  reload,
  message,
}: {
  error: Error;
  reload: () => void;
  message: string;
}) {
  return (
    <Callout
      tone="danger"
      title={message}
      action={
        <Button size="sm" onClick={reload} variant="secondary">
          Try again
        </Button>
      }
    >
      {error.message}
    </Callout>
  );
}
