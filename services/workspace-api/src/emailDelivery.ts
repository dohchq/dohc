import { AsyncLocalStorage } from "node:async_hooks";
import type { SendEmail } from "@dohc/workspace-auth/smtp";

/** Better Auth logs mail failures; retain them for the originating HTTP response. */
export function accountEmailDelivery(deliver: SendEmail) {
  const requests = new AsyncLocalStorage<{ failedTo?: string }>();
  const privateEmailRoutes = new Set(["/api/auth/request-password-reset", "/api/auth/send-verification-email"]);
  const sendEmail: SendEmail = async (message) => {
    try {
      await deliver(message);
    } catch (error) {
      const request = requests.getStore();
      if (request) request.failedTo = message.to;
      throw error;
    }
  };
  return {
    sendEmail,
    async handle(request: Request, handler: (request: Request) => Promise<Response>, signedInEmail: () => Promise<string | null> = async () => null): Promise<Response> {
      return requests.run({}, async () => {
        const response = await handler(request);
        const failedTo = requests.getStore()!.failedTo;
        if (!failedTo) return response;
        // An anonymous reset/resend response must not reveal whether the address exists.
        const path = new URL(request.url).pathname;
        if (privateEmailRoutes.has(path) && await signedInEmail() !== failedTo) {
          await response.body?.cancel();
          const body = path.endsWith("/send-verification-email") ? { status: true } : {
            status: true, message: "If this email exists in our system, check your email for the reset link",
          };
          return Response.json(body, { headers: { "cache-control": "no-store" } });
        }
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
