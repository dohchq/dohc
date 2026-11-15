// Whether a signed-in build may write to chats: the composer, New post, and Send and Discard on messages waiting on this
// phone. Off until a published desktop build includes #3836, which keeps each account's read place in a thread as an
// owner-private record; a desktop without it shouldn't meet the phone's writes. Ice decides when this turns on.
//
// Every write control reads this one value. A build made with EXPO_PUBLIC_DOHC_PHONE_WRITES=1, as a real-server
// simulator round is, turns it on; any other signed-in build stays read-only. The sample build shows its composer
// whatever this says, over its own in-memory outbox, and never reaches a server.
export const phoneWrites = process.env.EXPO_PUBLIC_DOHC_PHONE_WRITES === "1";
