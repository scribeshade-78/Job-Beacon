import { useState, type ImgHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export interface AvatarProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src?: string | null;
  /** Shown when `src` is absent or fails to load — e.g. initials. */
  fallback: string;
  size?: number;
}

export function Avatar({ src, fallback, size = 40, className, alt, ...props }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ios-bg text-ios-text-secondary",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <img
          src={src ?? undefined}
          alt={alt ?? ""}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
          {...props}
        />
      ) : (
        <span className="text-sm font-semibold" aria-hidden={alt === "" ? undefined : "true"}>
          {fallback}
        </span>
      )}
    </span>
  );
}
