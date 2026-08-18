import { NextResponse } from "next/server";

const platformLabels: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

export function GET(
  _request: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  return params.then(({ platform }) => {
    const label = platformLabels[platform] ?? "your platform";
    return new NextResponse(
      [
        `Atelier download request: ${label}`,
        "",
        "This landing page is wired to a real Next.js route.",
        "Connect this endpoint to the signed release artifact when publishing.",
      ].join("\n"),
      {
        headers: {
          "Content-Disposition": `attachment; filename="atelier-${platform}-download.txt"`,
          "Content-Type": "text/plain; charset=utf-8",
        },
      }
    );
  });
}
