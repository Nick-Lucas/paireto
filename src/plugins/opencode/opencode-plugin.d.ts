// `@opencode-ai/plugin` is resolved from OpenCode's own Bun runtime at load time. It is deliberately
// NOT a dependency of this repo and is marked external in the bundle, so this declares the one member
// the adapter reads. Keep it in step with src/plugins/opencode/types.ts.

declare module "@opencode-ai/plugin" {
  export const tool: {
    schema: { string(): { describe(text: string): unknown } };
  };
}
