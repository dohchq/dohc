export interface ChatListFixtureApi {
  append(): void;
  grow(id: string): void;
  prepend(): void;
  reorder(): void;
  jump(id: string): boolean;
  end(): void;
}

declare global {
  interface Window {
    chatListFixture: ChatListFixtureApi;
  }
}
