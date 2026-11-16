// Until `check` holds, looking every 20 ms; an error once `ms` have gone by.
export async function until(check: () => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
