export interface ChatListFixtureApi {
  append(): void;
  appendMarkdown(): void;
  markdown(id: string): void;
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
