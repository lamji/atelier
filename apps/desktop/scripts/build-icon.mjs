// Rasterise the app icon: apps/web/public/icon.svg -> build/icon.png (512px).
//
// The SVG is the master and lives with the renderer, which serves it as the
// favicon. electron-builder cannot read SVG — it wants a >=256px PNG and
// generates the Windows .ico from it — so the desktop build derives its copy
// here rather than keeping a second hand-maintained file.
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(desktopRoot, "..", "..");
const source = path.join(repoRoot, "apps", "web", "public", "icon.svg");
const target = path.join(desktopRoot, "build", "icon.png");

// sharp rasterises SVG at 72dpi by default, which would render a 512pt
// source at 512px and then resample it. Render oversized so the curves stay
// crisp at every size electron-builder derives from this.
await sharp(source, { density: 384 })
  .resize(512, 512, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toFile(target);

console.log(`[desktop] icon -> ${path.relative(desktopRoot, target)}`);
