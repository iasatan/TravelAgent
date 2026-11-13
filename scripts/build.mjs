import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const html = await readFile("index.html", "utf8");
await writeFile("dist/index.html", html.replace('src="./dist/src/main.js"', 'src="./src/main.js"'));
await cp("style.css", "dist/style.css");
await cp(".build-temp/src", "dist/src", { recursive: true });
await rm(".build-temp", { recursive: true, force: true });
console.log("Static site written to dist/");