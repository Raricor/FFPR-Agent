export function wrapClientModule(id: string, code: string): string;
export function bundleClient(): Promise<{ readonly id: string; readonly output: string }>;
