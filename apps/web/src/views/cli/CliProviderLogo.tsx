import { cn } from "@/lib/cn";

/** Claude: claude.com/favicon.svg. Codex: OpenAI Cookbook's white Blossom SVG. */
export function CliProviderLogo(props: { providerId: string; className?: string }) {
  const logo = props.providerId === "claude" ? "claude.svg" : "codex.svg";
  return (
    <img
      src={`${import.meta.env.BASE_URL}provider-logos/${logo}`}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", props.className)}
    />
  );
}
