"use client";

import Image from "next/image";
import { useState, type CSSProperties } from "react";
import type { BoardToken } from "../_data/adapter";

export function TokenAvatar({
  token,
  size = "medium",
  descriptive = false,
}: {
  token: BoardToken;
  size?: "small" | "medium" | "large" | "xlarge";
  descriptive?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showArtwork = token.artworkUrl !== null && token.artworkUrl !== failedUrl;

  return (
    <span
      className={`token-avatar ${size}`}
      style={{ "--token-accent": token.accent } as CSSProperties}
      role={descriptive ? "img" : undefined}
      aria-hidden={descriptive ? undefined : "true"}
      aria-label={descriptive ? `${token.name} token artwork` : undefined}
    >
      {token.symbol.slice(0, 2)}
      {showArtwork ? (
        <Image
          className="token-avatar-art"
          src={token.artworkUrl!}
          alt=""
          fill
          sizes={
            size === "small"
              ? "38px"
              : size === "large"
                ? "78px"
                : size === "xlarge"
                  ? "118px"
                  : "52px"
          }
          onError={() => setFailedUrl(token.artworkUrl)}
        />
      ) : null}
    </span>
  );
}
