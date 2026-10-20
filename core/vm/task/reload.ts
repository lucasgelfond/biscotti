// /biscotti-reload: re-list the gate's tools. This pi starts inside the VM's snapshot, and only learns the tools it
// had then; biscotti-task runs it at the start of each task.
export default function (pi: { registerCommand(name: string, options: { description: string; handler(args: string, ctx: { reload(): Promise<void> }): Promise<void> }): void }) {
  pi.registerCommand("biscotti-reload", { description: "Re-list the gate's tools", handler: (_, ctx) => ctx.reload() });
}
