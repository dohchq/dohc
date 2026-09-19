import { AsyncLocalStorage } from "node:async_hooks";
import type { SendEmail } from "@dohc/workspace-auth/smtp";

/** Better Auth logs mail failures; retain them for the originating HTTP response. */
export function accountEmailDelivery(deliver: SendEmail) {
  const requests = new AsyncLocalStorage<{ failed: boolean }>();
  const sendEmail: SendEmail = async (message) => {
    try {
      await deliver(message);
    } catch (error) {
      const request = requests.getStore();
      if (request) request.failed = true;
      throw error;
    }
  };
  return {
    sendEmail,
    async handle(request: Request, handler: (request: Request) => Promise<Response>): Promise<Response> {
      return requests.run({ failed: false }, async () => {
        const response = await handler(request);
        if (!requests.getStore()!.failed) return response;
        // Signup can create a session before sending mail. Keep its cookie so
        // the person can resend verification without recreating their account.
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.set("content-type", "application/json");
        headers.set("cache-control", "no-store");
        await response.body?.cancel();
        return new Response(JSON.stringify({
          code: "EMAIL_DELIVERY_FAILED",
          message: "This server could not send the email. Try again, or contact the server owner.",
        }), { status: 503, headers });
      });
    },
  };
}
