export declare function useDesktopAction(...args: unknown[]): readonly [(input: unknown) => unknown, boolean];
export declare function useDesktopLoad(...args: unknown[]): { pending: boolean };
export declare function useDesktopCommand(...args: unknown[]): readonly [(input: unknown) => unknown, boolean];
export declare function useDesktopEvent(...args: unknown[]): void;
export declare function desktopMetadata(): { platform: string; windowRole: string };
