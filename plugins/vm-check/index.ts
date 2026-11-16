import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Alive, aliveLine, type Plugin } from "@biscotti/core";

// Once a day, from VM_CHECK_HOUR (10) local time, the main agent asks the owner which of the VMs still around can go.

export function vmCheck(alive: Alive[], now = Date.now()) {
  if (!alive.length) return undefined;
  const lines = alive.map((v) => `- ${aliveLine(v, now)}`);
  return `[Daily VM check, from biscotti itself, not the owner] These VMs are still around:\n${lines.join("\n")}\n\nText the owner this list, a short line for each saying what it is (in plain words, from its goal) and how long since it was used, pointing out the ones unused for over a day, and ask which you can delete. Delete the ones they name with delete_vms and keep the rest; if they don't answer, keep them all.`;
}

export default {
  async start(ctx) {
    // The day it last asked, kept across restarts (the pool's file, from when the check was its).
    const checked = `${ctx.dir}/tasks.checked`;
    // TODO: into SQLite, instead of this file.
    let asked = existsSync(checked) ? readFileSync(checked, "utf8") : "";
    const hour = Number(process.env.VM_CHECK_HOUR ?? 10);
    const check = () => {
      const today = new Date().toDateString();
      if (new Date().getHours() >= hour && asked !== today) {
        writeFileSync(checked, (asked = today));
        const text = vmCheck(ctx.vms.alive());
        if (text) void ctx.deliver(text);
      }
      const next = new Date();
      next.setHours(hour, 0, 0, 0);
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
      setTimeout(check, next.getTime() - Date.now()).unref();
    };
    // A minute after starting, then at the hour each day.
    setTimeout(check, 60_000).unref();
  },
} satisfies Plugin;
