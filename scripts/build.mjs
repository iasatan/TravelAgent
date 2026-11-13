import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("index.html", "dist/index.html");
await cp("style.css", "dist/style.css");
await cp(".build-temp/src", "dist/src", { recursive: true });
await rm(".build-temp", { recursive: true, force: true });
console.log("Static site written to dist/");