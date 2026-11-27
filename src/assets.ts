import APP_CSS from "./app.css" with { type: "text" };

export { APP_CSS };

let bundle: Promise<string> | null = null;

/** Bundles the browser client (Applesauce/Nostr helpers + WebCrypto backup) once and caches it. */
export function clientBundle(): Promise<string> {
  bundle ??= (async () => {
    const result = await Bun.build({
      entrypoints: [new URL("./client/main.ts", import.meta.url).pathname],
      target: "browser",
      minify: true,
    });
    if (!result.success) throw new Error("Client bundle failed: " + result.logs.map(String).join("\n"));
    return await result.outputs[0].text();
  })().catch((e) => { bundle = null; throw e; });
  return bundle;
}
