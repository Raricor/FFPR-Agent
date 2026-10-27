/**
 * Only the browser globals this plugin bundle uses. The bundle has no imports; React and the
 * dsh client services arrive through the loader's `require` and `ctx`.
 */

interface ReactModule {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void];
  useEffect(effect: () => (() => void) | undefined, dependencies?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
}

declare const require: (name: "react") => ReactModule;

interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

interface OpenSidebarTab {
  readonly sessionId: string;
  readonly tabId: string;
  readonly kind: string;
  readonly contentId: string;
}

interface SlotsService {
  inject(name: string, callback: () => void): void;
  register(definition: Record<string, unknown>, component: () => unknown): () => void;
}

interface ClientContext {
  effect(callback: () => (() => void) | undefined, label?: string): void;
  slots: SlotsService;
  sidebarRightTabs: {
    register(definition: Record<string, unknown>): () => void;
  };
  sidebarRight: {
    readonly mounted: ObservableSnapshot<string | undefined>;
    readonly openTabs: ObservableSnapshot<readonly OpenSidebarTab[]>;
    openTab(kind: string): void;
  };
}

declare const exports: {
  inject: readonly string[];
  apply: (ctx: ClientContext) => void;
};
